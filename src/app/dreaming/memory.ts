import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { pilotCommand, readPilotJson, type PilotCommand } from '../../infra/pilot-cli.ts'
import type { MemoryCleanupPort, MemorySnapshot } from './duplicates.ts'
import { OpenVikingThrottled, retryOpenVikingRead } from './openviking.ts'

export const memoryUri = z.string().trim().max(600).refine(value => {
  if (!/^viking:\/\/~\/(?:peers\/[\w.@-]+\/)?memories\/.+\.md$/u.test(value) || /[%?#\\\r\n]/u.test(value)) return false
  return value.slice('viking://~/'.length).split('/').every(segment => segment && !segment.startsWith('.'))
}, 'Choose an existing Markdown memory in your OpenViking namespace')
const digestField = z.string().regex(/^[a-f0-9]{64}$/)
export const memoryPatch = z.object({ uri: memoryUri, digest: digestField, previous: z.string().min(1).max(12_000),
  replacement: z.string().min(1).max(12_000), query: z.string().trim().min(1).max(500) }).strict()
export type MemoryPatch = z.infer<typeof memoryPatch> & { digestKind?: 'visible' }
export type MemoryWriteCode = 'unsafe_uri' | 'redirected_uri' | 'body_unconfirmed' | 'recall_pending'
export type MemoryEdit = MemoryPatch & { updatedDigest: string; status: 'staged' | 'writing' | 'blocked' | 'conflict' | 'pending_verification' | 'verified';
  error?: string; errorCode?: MemoryWriteCode }
export interface MemoryPort {
  find(query: string, project?: string): Promise<{ uri: string; excerpt: string }[]>
  preview(uri: string): Promise<{ uri: string; content: string; digest: string }>
  prepare(patch: MemoryPatch): Promise<MemoryEdit>
  apply(edit: MemoryEdit): Promise<void>
}

/** A rejected or unverified OpenViking write, with the state to retain for retry. */
export class MemoryWriteError extends Error {
  constructor(readonly status: 'blocked' | 'conflict' | 'pending_verification', message: string, readonly code?: MemoryWriteCode) { super(message) }
}

const response = z.object({ result: z.unknown() }).refine(value => value.result !== undefined)
const results = z.object({ memories: z.array(z.object({ uri: z.string(), abstract: z.string().optional() })) })
const config = z.object({ url: z.string().url(), api_key: z.string().min(1) })
const mcpResult = z.object({ result: z.object({ isError: z.boolean().optional(),
  content: z.array(z.object({ text: z.string().optional() })) }) })
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const namespace = (uri: string) => uri.slice(0, uri.indexOf('/memories/') + '/memories'.length)
const toHome = (uri: string) => uri.replace(/^viking:\/\/user\/[^/]+\//, 'viking://~/')

function ensureExactWriteUri(uri: string) {
  // OpenViking normalizes storage path segments containing whitespace before writing.
  if (/[\p{White_Space}\u001c-\u001f]/u.test(uri)) {
    throw new MemoryWriteError('blocked', 'OpenViking changes paths containing whitespace when writing, so the original URI cannot be updated safely', 'unsafe_uri')
  }
}

function replacePassage(content: string, { previous, replacement }: MemoryPatch): string {
  const index = content.indexOf(previous)
  if (index < 0 || index !== content.lastIndexOf(previous) || replacement.includes(previous)) {
    throw new MemoryWriteError('conflict', 'Select one unique original passage and replace it with a materially different correction')
  }
  return content.slice(0, index) + replacement + content.slice(index + previous.length)
}

/** Adds unchanged body context when stored metadata also contains the reviewed passage. */
function editStrings(original: string, visible: string, { previous, replacement }: MemoryPatch) {
  const match = original.indexOf(previous)
  if (match >= 0 && match === original.lastIndexOf(previous)) return { oldString: previous, newString: replacement }
  const body = original.indexOf(visible)
  if (body < 0 || body !== original.lastIndexOf(visible)) {
    throw new MemoryWriteError('conflict', 'The reviewed passage could not be located uniquely in the stored OpenViking file')
  }
  const start = visible.indexOf(previous)
  const end = start + previous.length
  for (let context = 32; ; context *= 2) {
    let left = Math.max(0, start - context)
    let right = Math.min(visible.length, end + context)
    if (/[\uDC00-\uDFFF]/u.test(visible[left] ?? '')) left--
    if (/[\uDC00-\uDFFF]/u.test(visible[right] ?? '')) right++
    const oldString = visible.slice(left, right)
    const index = original.indexOf(oldString)
    if (index === body + left && index === original.lastIndexOf(oldString)) {
      return { oldString, newString: visible.slice(left, start) + replacement + visible.slice(end, right) }
    }
    if (left === 0 && right === visible.length) break
  }
  throw new MemoryWriteError('conflict', 'The reviewed passage could not be located uniquely in the stored OpenViking file')
}

const readConfig = async () => {
  const path = process.env.OPENVIKING_CLI_CONFIG_FILE ?? join(homedir(), '.openviking', 'ovcli.conf')
  return config.parse(JSON.parse(await readFile(path, 'utf8')))
}

/** Uses OpenViking's exact, metadata-preserving edit tool and verifies the indexed memory. */
export function openVikingMemory(cli: string, lifetime: AbortSignal, http = fetch, run: PilotCommand = pilotCommand,
  connection = readConfig): MemoryPort & MemoryCleanupPort & { snapshot(uri: string): Promise<MemorySnapshot> } {
  const request = async (path: string, options?: { uri?: string; body?: unknown; retryRead?: boolean; missingOkay?: boolean }) => {
    const settings = await connection()
    const base = new URL(settings.url)
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) {
      throw new MemoryWriteError('blocked', 'OpenViking writeback requires HTTPS or a local service')
    }
    const address = new URL(`${base.href.replace(/\/+$/, '')}/${path}`)
    if (options?.uri) address.searchParams.set('uri', memoryUri.parse(options.uri))
    const reply = await http(address, { redirect: 'error', signal: AbortSignal.any([lifetime, AbortSignal.timeout(45_000)]),
      headers: { 'X-API-Key': settings.api_key, 'content-type': 'application/json',
        ...(path === 'mcp' ? { accept: 'application/json, text/event-stream' } : {}) },
      ...(options?.body === undefined ? {} : { method: 'POST', body: JSON.stringify(options.body) }) })
    if (reply.status === 429 && options?.retryRead) {
      const retryAfter = reply.headers.get('retry-after')
      const retryAfterMs = retryAfter && (/^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now())
      await reply.body?.cancel().catch(() => {})
      throw new OpenVikingThrottled(retryAfterMs && Number.isFinite(retryAfterMs) ? Math.min(180_000, retryAfterMs) : 0)
    }
    if (!reply.ok && !(reply.status === 404 && options?.missingOkay)) {
      const error = z.object({ error: z.object({ code: z.string().regex(/^[a-zA-Z0-9_]+$/).max(40) }) })
        .safeParse(await reply.json().catch(() => undefined))
      const code = error.success ? ` ${error.data.error.code}` : ''
      throw new MemoryWriteError(reply.status === 409 || reply.status === 412 ? 'conflict' : 'blocked',
        `OpenViking ${path} returned HTTP ${reply.status}${code}`)
    }
    return reply
  }
  const original = async (uri: string) => {
    const reply = await request('api/v1/content/download', { uri })
    const bytes = new Uint8Array(await reply.arrayBuffer())
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    if (bytes.length > 128 * 1024 || hash(bytes) !== hash(content)) throw new MemoryWriteError('blocked', 'The memory exceeds the editable text limit')
    return { content, digest: hash(bytes) }
  }
  const visible = async (uri: string, retryRead = false) =>
    z.string().parse(response.parse(await (await request('api/v1/content/read', { uri, retryRead })).json()).result)
  const cliJson = async (args: string[], action: string) => {
    const result = await run(cli, args, { signal: lifetime })
    return readPilotJson({ ...result, stdout: result.stdout.replace(/^cmd:[^\n]*\n/, '') }, action)
  }
  const lookup = async (query: string, root: string) => results.parse(response.parse(await cliJson(
    ['find', '-u', root, '--context-type', 'memory', '--limit', '10', '-o', 'json', '--', query], 'OpenViking memory search')).result).memories
  return {
    async readForDeletion(uri) {
      const reply = await request('api/v1/content/read', { uri, missingOkay: true })
      if (reply.status === 404) return null
      const content = z.string().parse(response.parse(await reply.json()).result)
      return { uri, content, digest: hash(content) }
    },
    async deleteExact(uri) {
      const receipt = z.object({ result: z.object({ uri: z.string() }) }).parse(await cliJson(
        ['rm', memoryUri.parse(uri), '--wait', '-o', 'json'], 'OpenViking exact memory removal'))
      if (toHome(receipt.result.uri) !== uri) throw new MemoryWriteError('blocked', 'OpenViking returned a different deletion destination')
    },
    async verifyRemoval(pair) {
      const root = namespace(pair.remove.uri)
      const oldTitle = pair.remove.uri.split('/').at(-1)!.replace(/\.md$/u, '').replaceAll('_', ' ')
      const queries = [...new Set([pair.query, oldTitle])]
      const hits = (await Promise.all(queries.map(query => lookup(query, root)))).flat()
      if (hits.some(hit => toHome(hit.uri) === pair.remove.uri) || !hits.some(hit => toHome(hit.uri) === pair.keep.uri)) return false
      if (!pair.obsolete.length) return true
      if (hits.some(hit => pair.obsolete.some(fragment => hit.abstract?.includes(fragment)))) return false
      const recalled = response.parse(await cliJson(
        ['search', '--mode', 'context', '--context-type', 'memory', '--limit', '12', '-o', 'json', '--', pair.query], 'OpenViking context recall'))
      const text = JSON.stringify(recalled.result)
      if (text.includes(pair.remove.uri.split('/').at(-1)!) || pair.obsolete.some(fragment => text.includes(JSON.stringify(fragment).slice(1, -1)))) return false
      for (const fragment of pair.obsolete) {
        const pattern = fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const matches = z.object({ match_count: z.number().int().nonnegative() }).parse(response.parse(await cliJson(
          ['grep', '-u', root, '--limit', '1', '-o', 'json', '--', pattern], 'OpenViking obsolete-text search')).result)
        if (matches.match_count) return false
      }
      return true
    },
    async find(query, project) {
      const roots = ['viking://~/memories']
      if (project && /^[\w@-][\w.@-]{0,127}$/.test(project)) roots.unshift(`viking://~/peers/${project}/memories`)
      const found = await Promise.allSettled(roots.map(root => lookup(query, root)))
      if (found.every(result => result.status === 'rejected')) throw new MemoryWriteError('blocked', 'OpenViking memory search is unavailable')
      const distinct = new Map<string, string>()
      found.forEach((result, index) => {
        if (result.status === 'rejected') return
        for (const hit of result.value) {
          const uri = toHome(hit.uri)
          if (uri.startsWith(`${roots[index]}/`) && memoryUri.safeParse(uri).success) distinct.set(uri, hit.abstract?.slice(0, 400) ?? '')
        }
      })
      return [...distinct].map(([uri, excerpt]) => ({ uri, excerpt }))
    },
    async preview(uri) {
      const { digest } = await original(uri)
      return { uri, content: await visible(uri), digest }
    },
    async snapshot(uri) {
      const content = await retryOpenVikingRead(() => visible(uri, true), lifetime)
      return { uri, content, digest: hash(content) }
    },
    async prepare(patch) {
      ensureExactWriteUri(patch.uri)
      const { content, digest } = await original(patch.uri)
      const current = await visible(patch.uri)
      const { digestKind, ...fields } = patch
      if ((digestKind === 'visible' ? hash(current) : digest) !== patch.digest) {
        throw new MemoryWriteError('conflict', 'The original memory changed. Reload it before approving')
      }
      const updated = replacePassage(current, patch)
      editStrings(content, current, patch)
      return { ...fields, digest, updatedDigest: hash(updated), status: 'staged' }
    },
    async apply(edit) {
      const prior = await original(edit.uri)
      const currentText = await visible(edit.uri)
      const alreadyEdited = hash(currentText) === edit.updatedDigest
      if (edit.errorCode === 'recall_pending' && !alreadyEdited) {
        throw new MemoryWriteError('conflict', 'The verified body changed before search could be checked')
      }
      if (prior.digest !== edit.digest && !alreadyEdited) {
        throw new MemoryWriteError('conflict', 'The original memory changed. Reload it before approving')
      }
      if (!alreadyEdited) {
        ensureExactWriteUri(edit.uri)
        if (hash(replacePassage(currentText, edit)) !== edit.updatedDigest) {
          throw new MemoryWriteError('conflict', 'The approved memory patch no longer matches')
        }
        const { oldString, newString } = editStrings(prior.content, currentText, edit)
        try {
          const reply = await request('mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'edit',
            arguments: { uri: edit.uri, old_string: oldString, new_string: newString, replace_all: false, wait: true, timeout: 35 } } } })
          const raw = await reply.text()
          const payload = reply.headers.get('content-type')?.includes('text/event-stream')
            ? raw.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)) as { id?: number })
              .find(message => message.id === 1)
            : JSON.parse(raw) as unknown
          const written = mcpResult.parse(payload).result
          if (written.isError) {
            const detail = written.content.flatMap(item => item.text ?? []).join(' ')
            if (/not found|not match|occurrence/i.test(detail)) throw new MemoryWriteError('conflict', 'OpenViking no longer finds one exact occurrence of the original passage')
            if (/permission|forbidden|access denied|read.only/i.test(detail)) throw new MemoryWriteError('blocked', 'The OpenViking identity cannot edit this memory')
            throw new MemoryWriteError('pending_verification', 'OpenViking did not confirm the edit and index refresh')
          }
          const destination = written.content.map(item => item.text?.match(/^Edited (viking:\/\/[^\r\n]+?) \(\d+ bytes written\)\./m)?.[1]).find(Boolean)
          if (destination && toHome(destination) !== edit.uri) {
            throw new MemoryWriteError('blocked', 'OpenViking reported writing to another URI. The original entry was not verified', 'redirected_uri')
          }
        } catch (error) {
          if (error instanceof MemoryWriteError) throw error
          throw new MemoryWriteError('pending_verification', 'The OpenViking write outcome is uncertain. Retry to verify the current content')
        }
      }
      const updated = alreadyEdited ? currentText : await visible(edit.uri).catch(() => undefined)
      if (updated === undefined || hash(updated) !== edit.updatedDigest) {
        throw new MemoryWriteError('pending_verification', 'The updated text could not be confirmed at the original OpenViking URI', 'body_unconfirmed')
      }
      try {
        const hits = await lookup(edit.query, namespace(edit.uri))
        const indexed = hits.find(hit => toHome(hit.uri) === edit.uri)
        if (indexed && !indexed.abstract?.includes(edit.previous)) return
      } catch {
        // The original body is already verified. A failed search can be retried independently.
      }
      throw new MemoryWriteError('pending_verification', 'The original text is updated, but search has not confirmed the correction', 'recall_pending')
    },
  }
}
