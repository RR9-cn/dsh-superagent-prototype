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
const evidenceLimit = 20
const excerptLimit = 1200

const sessions = z.array(z.object({ session_id: z.string().regex(/^[a-zA-Z0-9_.@-]+$/).refine(id => id !== '.' && id !== '..') }))
const directory = z.object({ ok: z.literal(true), result: z.array(z.object({ uri: z.string(), isDir: z.boolean(),
  modTime: z.string().nullish() })), has_more: z.boolean().optional() })
const cliFailure = z.object({ error: z.object({ code: z.string() }) })
export interface OpenVikingArchiveRow { uri: string; codex: boolean; modifiedAt: string | null }

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

export async function listOpenVikingDirectory(cli: string, root: string, signal: AbortSignal, run: PilotCommand, optional = false) {
  const rows: z.infer<typeof directory>['result'] = []
  const pageSize = 100
  let offset = 0
  for (;;) {
    const reply = await readListing(cli, ['ls', root, '--limit', String(pageSize), '--offset', String(offset),
      '--include-abstract=false', '--include-overview=false'], signal, run)
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
  let archivedMessages: unknown[]
  try {
    const archived = archive.parse(await read(['session', 'get-session-archive', sessionId, archiveId], 'OpenViking archive'))
    if (archived.archive_id !== archiveId || (archived.status !== undefined && archived.status !== 'completed')) {
      throw new Error('The selected OpenViking archive is incomplete')
    }
    if (archived.status === undefined) await completed()
    archivedMessages = archived.messages
  } catch (error) {
    signal.throwIfAborted()
    if (!(error instanceof Error) || (error.message !== 'Pilot CLI output exceeded the response limit' && error.name !== 'AbortError')) throw error
    await completed()
    // The archive endpoint returns the entire transcript. Use a bounded JSONL window on large archives.
    const window = async (limit: number) => {
      const rows = z.string().parse(await read(['read', `${uri}/messages.jsonl`, '--offset', '0', '--limit', String(limit)], 'OpenViking archive window'))
      return rows.split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as unknown)
    }
    try { archivedMessages = await window(8) }
    catch (windowError) {
      signal.throwIfAborted()
      if (!(windowError instanceof Error) || windowError.message !== 'Pilot CLI output exceeded the response limit') throw windowError
      archivedMessages = await window(1)
    }
  }
  const messages = z.array(message).parse(archivedMessages)
  const peers = new Set(messages.flatMap(item => item.peer_id ? [item.peer_id] : []))
  const project = peers.size === 1 ? [...peers][0]! : sessionId
  const evidence: DreamingEvidencePack['evidence'] = []
  for (let row = messages.length - 1; row >= 0 && evidence.length < evidenceLimit; row--) {
    const { role, parts } = messages[row]!
    if (role !== 'user' && role !== 'assistant' && role !== 'tool') continue
    for (let part = parts.length - 1; part >= 0 && evidence.length < evidenceLimit; part--) {
      const tool = toolPart.safeParse(parts[part])
      const text = textPart.safeParse(parts[part])
      const kind = tool.success ? 'tool-result' : role === 'user' ? 'user-report' : 'agent-report'
      const raw = tool.success ? `${tool.data.tool_name}\n${tool.data.tool_output}` : text.success ? text.data.text : ''
      if (!raw.trim()) continue
      const excerpt = raw.replace(/-----BEGIN [^\n]+ PRIVATE KEY-----[\s\S]*?(?:-----END [^\n]+ PRIVATE KEY-----|$)/g, '[redacted]')
        .replace(/\b(?:Bearer\s+|(?:api[_ -]?key|access[_ -]?token|password|secret)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, '[redacted]')
        .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,})\b/g, '[redacted]')
        .trim().slice(0, excerptLimit)
      evidence.push({ id: `m${row + 1}p${part + 1}`, source: `${uri}/messages.jsonl#L${row + 1}`, kind, text: excerpt })
    }
  }
  if (!evidence.length) throw new Error('The selected OpenViking archive contains no readable evidence')
  evidence.reverse()
  return { id: key(project, uri, JSON.stringify(evidence)), project, archiveUri: uri, evidence }
}

/** Stages each archive separately so one unavailable archive cannot hide the rest. */
export async function collectOpenVikingEvidence(cli: string, signal: AbortSignal, run: PilotCommand = pilotCommand) {
  const catalog = await listOpenVikingArchives(cli, signal, run)
  const packs: DreamingEvidencePack[] = []
  const skipped: string[] = []
  for (let index = 0; index < catalog.archives.length; index += 4) {
    signal.throwIfAborted()
    const group = catalog.archives.slice(index, index + 4)
    const results = await Promise.allSettled(group.map(row => readOpenVikingEvidence(cli, row.uri, signal, run)))
    results.forEach((result, position) => {
      if (result.status === 'fulfilled') packs.push(result.value)
      else skipped.push(group[position]!.uri)
    })
  }
  signal.throwIfAborted()
  return { packs, skipped, unavailable: catalog.unavailable, total: catalog.archives.length }
}
