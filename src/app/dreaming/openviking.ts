import { setTimeout as wait } from 'node:timers/promises'
import { z } from 'zod'
import { key } from '../../core/ids.ts'
import { pilotCommand, readPilotJson, type PilotCommand } from '../../infra/pilot-cli.ts'
import type { DreamingEvidencePack } from './dreaming.ts'

const archiveUri = /^viking:\/\/~\/sessions\/([a-z0-9_.@-]+)\/history\/(archive_[0-9]+)$/i
const response = z.object({ ok: z.literal(true), result: z.unknown() })
const message = z.object({ role: z.string(), parts: z.array(z.unknown()), peer_id: z.string().nullish() })
const archive = z.object({ archive_id: z.string(), status: z.string().optional(), messages: z.array(z.unknown()) })
const textPart = z.object({ type: z.literal('text'), text: z.string() })
const toolPart = z.object({ type: z.literal('tool'), tool_name: z.string(), tool_output: z.string() })
const excerptLimit = 1200
const archivePageSize = 64

const sessions = z.array(z.object({ session_id: z.string().regex(/^[a-zA-Z0-9_.@-]+$/).refine(id => id !== '.' && id !== '..') }))
const directory = z.object({ ok: z.literal(true), result: z.array(z.object({ uri: z.string(), isDir: z.boolean(),
  modTime: z.string().nullish(), size: z.unknown().optional() })), has_more: z.boolean().optional() })
const cliFailure = z.object({ error: z.object({ code: z.string() }) })
export interface OpenVikingArchiveRow { uri: string; codex: boolean; modifiedAt: string | null }
export type CachedArchiveEvidence = { revision: string; pack: DreamingEvidencePack }
export interface ArchiveEvidenceCache {
  get(uri: string): CachedArchiveEvidence | undefined
  set(uri: string, entry: CachedArchiveEvidence): void
  delete(uri: string): void
}

/** An OpenViking read may be retried after the server's quota window resets. */
export class OpenVikingThrottled extends Error {
  constructor(readonly retryAfterMs = 0) { super('OpenViking temporarily limited reads') }
}

export async function retryOpenVikingRead<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
  const backoffs = [2000, 8000, 20_000, 50_000]
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    try { return await read() }
    catch (error) {
      const delay = backoffs[attempt]
      if (!(error instanceof OpenVikingThrottled) || delay === undefined) throw error
      await wait(Math.max(delay, error.retryAfterMs), undefined, { signal })
    }
  }
}

async function readListing(cli: string, args: string[], signal: AbortSignal, run: PilotCommand) {
  const result = await readCommand(cli, args, signal, run)
  if (result.code !== 0 && args[0] === 'ls') {
    // This CLI writes directory-not-found JSON to stderr and exits with status 1.
    const line = result.stderr.split('\n').find(part => part.startsWith('{'))
    if (line) {
      const missing = cliFailure.safeParse(JSON.parse(line))
      if (missing.success && missing.data.error.code === 'NOT_FOUND') return missing.data
    }
  }
  // The installed CLI prefixes directory listings with a command banner even in JSON mode.
  return readPilotJson({ ...result, stdout: result.stdout.replace(/^cmd:[^\n]*\n/, '') }, 'OpenViking directory listing')
}

function readCommand(cli: string, args: string[], signal: AbortSignal, run: PilotCommand) {
  return retryOpenVikingRead(async () => {
    const result = await run(cli, [...args, '-o', 'json'], { signal })
    if (result.code !== 0 && /QuotaExceeded|"code"\s*:\s*"RATE_LIMITED"|HTTP(?: status)?\s+429/i.test(result.stderr)) {
      throw new OpenVikingThrottled()
    }
    return result
  }, signal)
}

export async function listOpenVikingDirectory(cli: string, root: string, signal: AbortSignal, run: PilotCommand,
  optional = false, includeHidden = false) {
  const rows: z.infer<typeof directory>['result'] = []
  const pageSize = 100
  let offset = 0
  for (;;) {
    const reply = await readListing(cli, ['ls', root, '--limit', String(pageSize), '--offset', String(offset),
      '--include-abstract=false', '--include-overview=false', ...(includeHidden ? ['--all'] : [])], signal, run)
    const page = directory.safeParse(reply)
    if (!page.success) {
      if (optional && offset === 0 && cliFailure.safeParse(reply).data?.error.code === 'NOT_FOUND') return rows
      throw new Error('OpenViking did not return the requested directory')
    }
    rows.push(...page.data.result)
    if (!(page.data.has_more ?? page.data.result.length === pageSize)) return rows
    if (!page.data.result.length) throw new Error('OpenViking returned an empty directory page with a next page')
    offset += page.data.result.length
  }
}

/** Lists archive metadata for every session visible to the CLI identity, without reading archive messages. */
export async function listOpenVikingArchives(cli: string, signal: AbortSignal, run: PilotCommand = pilotCommand) {
  const visible = sessions.parse(response.parse(await readListing(cli, ['session', 'list'], signal, run)).result)
  const archives: OpenVikingArchiveRow[] = []
  const unavailable: string[] = []
  const collect = async (sid: string) => {
    const rows = await listOpenVikingDirectory(cli, `viking://~/sessions/${sid}/history`, signal, run, true)
    for (const row of rows) {
      const archiveId = row.uri.split('/').at(-1)
      if (!row.isDir || !archiveId || !/^archive_[0-9]+$/.test(archiveId)) continue
      const uri = `viking://~/sessions/${sid}/history/${archiveId}`
      archives.push({ uri, codex: sid.startsWith('cx-'), modifiedAt: row.modTime ?? null })
    }
  }
  for (let index = 0; index < visible.length; index += 4) {
    signal.throwIfAborted()
    const group = visible.slice(index, index + 4)
    const outcomes = await Promise.allSettled(group.map(session => collect(session.session_id)))
    outcomes.forEach((outcome, position) => { if (outcome.status === 'rejected') unavailable.push(group[position]!.session_id) })
  }
  signal.throwIfAborted()
  archives.sort((a, b) => (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? '') || a.uri.localeCompare(b.uri))
  return { sessions: visible.length, archives, unavailable }
}

/** Reads one completed archive through the installed CLI's current user identity. */
export async function readOpenVikingEvidence(cli: string, uri: string, signal: AbortSignal,
  run: PilotCommand = pilotCommand): Promise<DreamingEvidencePack> {
  const match = archiveUri.exec(uri)
  if (!match || match[1] === '.' || match[1] === '..') throw new Error('Invalid OpenViking archive URI')
  const sessionId = match[1]!, archiveId = match[2]!
  const read = async (args: string[], label: string) => {
    const reply = readPilotJson(await readCommand(cli, args, signal, run), label)
    const parsed = response.safeParse(reply)
    if (!parsed.success) throw new Error(`${label} is unavailable or unreadable`)
    return parsed.data.result
  }
  const completed = () => read(['read', `${uri}/.done`], 'OpenViking archive completion marker')
  const needsSmallerRead = (error: unknown) => error instanceof Error &&
    (error.message === 'Pilot CLI output exceeded the response limit' || error.name === 'AbortError')
  async function* readWindows() {
    let limit = archivePageSize
    for (let offset = 0; ;) {
      let text: string
      try {
        text = z.string().parse(await read(['read', `${uri}/messages.jsonl`, '--offset', String(offset), '--limit', String(limit)],
          'OpenViking archive window'))
      } catch (error) {
        signal.throwIfAborted()
        if (limit === 1 || !needsSmallerRead(error)) throw error
        limit = Math.floor(limit / 2)
        continue
      }
      if (!text) return
      const lines = text.replace(/\n$/u, '').split('\n')
      if (lines.length > limit) throw new Error('OpenViking exceeded the requested archive window')
      for (const line of lines) yield line.trim() ? JSON.parse(line) as unknown : undefined
      if (lines.length < limit) return
      offset += lines.length
    }
  }
  let archivedMessages: Iterable<unknown> | AsyncIterable<unknown>
  try {
    const archived = archive.parse(await read(['session', 'get-session-archive', sessionId, archiveId], 'OpenViking archive'))
    if (archived.archive_id !== archiveId || (archived.status !== undefined && archived.status !== 'completed')) {
      throw new Error('The selected OpenViking archive is incomplete')
    }
    if (archived.status === undefined) await completed()
    archivedMessages = archived.messages
  } catch (error) {
    signal.throwIfAborted()
    if (!needsSmallerRead(error)) throw error
    await completed()
    archivedMessages = readWindows()
  }
  const peers = new Set<string>()
  const evidence: DreamingEvidencePack['evidence'] = []
  let row = 0
  for await (const archivedMessage of archivedMessages) {
    row++
    if (archivedMessage === undefined) continue
    const { role, parts, peer_id } = message.parse(archivedMessage)
    if (peer_id) peers.add(peer_id)
    if (role !== 'user' && role !== 'assistant' && role !== 'tool') continue
    for (const [index, part] of parts.entries()) {
      const tool = toolPart.safeParse(part)
      const text = textPart.safeParse(part)
      const kind = tool.success ? 'tool-result' : role === 'user' ? 'user-report' : 'agent-report'
      const raw = tool.success ? `${tool.data.tool_name}\n${tool.data.tool_output}` : text.success ? text.data.text : ''
      if (!raw.trim()) continue
      const excerpt = raw.replace(/-----BEGIN [^\n]+ PRIVATE KEY-----[\s\S]*?(?:-----END [^\n]+ PRIVATE KEY-----|$)/g, '[redacted]')
        .replace(/\b(?:Bearer\s+|(?:api[_ -]?key|access[_ -]?token|password|secret)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, '[redacted]')
        .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,})\b/g, '[redacted]')
        .trim().slice(0, excerptLimit)
      evidence.push({ id: `m${row}p${index + 1}`, source: `${uri}/messages.jsonl#L${row}`, kind, text: excerpt })
    }
  }
  if (!evidence.length) throw new Error('The selected OpenViking archive contains no readable evidence')
  const project = peers.size === 1 ? [...peers][0]! : sessionId
  return { id: key(project, uri, JSON.stringify(evidence)), project, archiveUri: uri, evidence }
}

async function archiveRevision(cli: string, uri: string, signal: AbortSignal, run: PilotCommand) {
  const list = () => listOpenVikingDirectory(cli, uri, signal, run, true, true)
  const rows = await list().catch(async () => {
    signal.throwIfAborted()
    await wait(500, undefined, { signal })
    return list()
  })
  const version = ['messages.jsonl', '.done'].map(name => {
    const row = rows.find(row => !row.isDir &&
      row.uri.replace(/^viking:\/\/user\/[^/]+\//u, 'viking://~/') === `${uri}/${name}`)
    return row?.modTime && Number.isFinite(Date.parse(row.modTime)) &&
      typeof row.size === 'number' && Number.isSafeInteger(row.size) && row.size >= 0 ? [row.uri, row.modTime, row.size] : undefined
  })
  return version.every(file => file !== undefined) ? key('archive-evidence-v1', JSON.stringify(version)) : undefined
}

/** Rediscovers every archive and reuses evidence only from a fully read, unchanged completed archive. */
export async function collectOpenVikingEvidence(cli: string, signal: AbortSignal, run: PilotCommand = pilotCommand,
  cache?: ArchiveEvidenceCache) {
  const catalog = await listOpenVikingArchives(cli, signal, run)
  const packs: DreamingEvidencePack[] = []
  const skipped: string[] = []
  const collect = async ({ uri }: OpenVikingArchiveRow) => {
    if (!cache) return readOpenVikingEvidence(cli, uri, signal, run)
    const revision = await archiveRevision(cli, uri, signal, run).catch(() => undefined)
    signal.throwIfAborted()
    const cached = revision ? cache.get(uri) : undefined
    if (cached && cached.revision === revision) return cached.pack
    cache.delete(uri)
    const pack = await readOpenVikingEvidence(cli, uri, signal, run)
    if (revision) {
      const confirmed = await archiveRevision(cli, uri, signal, run)
      if (confirmed !== revision) throw new Error('OpenViking archive changed while reading its evidence')
      signal.throwIfAborted()
      cache.set(uri, { revision, pack })
    }
    return pack
  }
  for (let index = 0; index < catalog.archives.length; index += 4) {
    signal.throwIfAborted()
    const group = catalog.archives.slice(index, index + 4)
    const results = await Promise.allSettled(group.map(collect))
    results.forEach((result, position) => {
      if (result.status === 'fulfilled') packs.push(result.value)
      else skipped.push(group[position]!.uri)
    })
  }
  signal.throwIfAborted()
  return { packs, skipped, unavailable: catalog.unavailable, total: catalog.archives.length }
}
