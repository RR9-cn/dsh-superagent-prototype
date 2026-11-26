import { setTimeout as wait } from 'node:timers/promises'
import { key } from '../../core/ids.ts'
import { pilotCommand, type PilotCommand } from '../../infra/pilot-cli.ts'
import { family } from '../../kv.ts'
import type { Store } from '../store.ts'
import type { DreamingEvidencePack } from './dreaming.ts'
import { memoryUri, openVikingEvidenceScope, type MemoryPort } from './memory.ts'
import { collectOpenVikingEvidence, listOpenVikingDirectory, type ArchiveEvidenceCache, type CachedArchiveEvidence } from './openviking.ts'

const home = 'viking://~/'
const peerPath = /^viking:\/\/~\/peers\/([\w.@-]+)\//
const memoryLimit = 12_000
const evidenceLimit = 20
const archiveCitation = /(viking:\/\/(?:~|user\/[^/\s]+)\/sessions\/[\w.@-]+\/history\/archive_\d+)\/messages\.jsonl#L(\d+)\b/gu
const archiveEvidence = family<CachedArchiveEvidence, [string, string]>('dreaming-archive-evidence:')

async function archiveCache(store: Pick<Store, 'get' | 'set' | 'delete'>): Promise<ArchiveEvidenceCache | undefined> {
  const scope = await openVikingEvidenceScope().catch(() => undefined)
  if (!scope) return undefined
  const entry = (uri: string) => archiveEvidence(scope, key(uri))
  return { get: uri => store.get(entry(uri)), set: (uri, value) => store.set(entry(uri), value), delete: uri => store.delete(entry(uri)) }
}

async function listMemories(cli: string, signal: AbortSignal, run: PilotCommand) {
  const pending = [`${home}memories`, `${home}peers`]
  const visited = new Set(pending)
  const files = new Set<string>()
  const unavailable: string[] = []
  const retry: string[] = []
  const failed = new Set<string>()
  while (pending.length || retry.length) {
    signal.throwIfAborted()
    if (!pending.length) {
      await wait(1000, undefined, { signal })
      pending.push(...retry.splice(0))
    }
    const group = pending.splice(0, 4)
    const pages = await Promise.allSettled(group.map(root => listOpenVikingDirectory(cli, root, signal, run,
      root === `${home}peers` || root.endsWith('/memories'))))
    for (const [index, page] of pages.entries()) {
      const root = group[index]!
      if (page.status === 'rejected') {
        if (failed.has(root)) unavailable.push(root)
        else {
          failed.add(root)
          retry.push(root)
        }
        continue
      }
      for (const row of page.value) {
        const uri = row.uri.replace(/^viking:\/\/user\/[^/]+\//, home).replace(/\/$/, '')
        if (!uri.startsWith(`${root}/`)) continue
        const name = uri.slice(root.length + 1)
        if (!name || /[/\\%?#\r\n]/u.test(name) || name.startsWith('.')) continue
        const next = root === `${home}peers` ? `${uri}/memories` : uri
        if (row.isDir && !visited.has(next)) {
          visited.add(next)
          pending.push(next)
        }
        if (root !== `${home}peers` && !row.isDir && memoryUri.safeParse(uri).success) files.add(uri)
      }
    }
  }
  signal.throwIfAborted()
  return { files: [...files].sort(), unavailable }
}

function terms(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}|\p{Script=Han}{2,}/gu) ?? []
  return new Set(words.flatMap(word => /^[a-z]/.test(word) ? [word] :
    Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2))))
}

function indexArchives(packs: DreamingEvidencePack[]) {
  return packs.flatMap(pack => {
    if (!pack.archiveUri) return []
    const prefix = key(pack.archiveUri).slice(0, 12)
    return [{ uri: pack.archiveUri, project: pack.project, excerpts: pack.evidence.map(item => ({
      item: { ...item, id: `${prefix}:${item.id}` }, line: Number(/^m(\d+)p/.exec(item.id)?.[1]), terms: terms(item.text),
    })) }]
  })
}

function selectEvidence(target: NonNullable<DreamingEvidencePack['target']>, history: ReturnType<typeof indexArchives>) {
  const project = peerPath.exec(target.uri)?.[1]
  const query = terms(target.content)
  const citations = new Map<string, Set<number>>()
  for (const [, uri, line] of target.content.matchAll(archiveCitation)) {
    const homeUri = uri!.replace(/^viking:\/\/user\/[^/]+\//, home)
    const lines = citations.get(homeUri) ?? new Set<number>()
    lines.add(Number(line))
    citations.set(homeUri, lines)
  }
  const ranked = history.flatMap(({ uri, project: archivedProject, excerpts }) => {
    if (project && archivedProject !== project) return []
    const cited = citations.get(uri)
    const items = excerpts.map(({ item, line, terms }) => {
      const overlap = [...terms].filter(term => query.has(term)).length
      const proximity = cited?.has(line) ? 2 : cited?.has(line - 1) || cited?.has(line + 1) ? 1 : 0
      return { item, overlap, proximity }
    })
    return items.filter(({ overlap, proximity }) => overlap > 0 || proximity > 0)
  })
  const selected = new Set(ranked.toSorted((a, b) => b.proximity - a.proximity || b.overlap - a.overlap ||
    Number(b.item.kind === 'tool-result') - Number(a.item.kind === 'tool-result')).slice(0, evidenceLimit))
  return ranked.filter(item => selected.has(item)).map(({ item }) => item)
}

/** Freezes existing memories and selects evidence across the visible archive catalog for each original URI. */
export async function collectOpenVikingMemories(cli: string, snapshot: MemoryPort['preview'], signal: AbortSignal,
  run: PilotCommand = pilotCommand) {
  const catalog = await listMemories(cli, signal, run)
  if (!catalog.files.length && catalog.unavailable.length) throw new Error('OpenViking memory directories could not be read')
  const targets: NonNullable<DreamingEvidencePack['target']>[] = []
  const skipped: string[] = []
  for (let index = 0; index < catalog.files.length; index += 4) {
    signal.throwIfAborted()
    const group = catalog.files.slice(index, index + 4)
    const results = await Promise.allSettled(group.map(uri => snapshot(uri)))
    for (const [position, result] of results.entries()) {
      const uri = group[position]!
      if (result.status === 'rejected' || result.value.uri !== uri ||
        !result.value.content.trim() || result.value.content.length > memoryLimit) {
        skipped.push(uri)
        continue
      }
      targets.push(result.value)
    }
  }
  signal.throwIfAborted()
  return { targets, skipped, unavailable: catalog.unavailable, total: catalog.files.length }
}

/** Combines each memory snapshot with bounded evidence from the visible archive catalog. */
export async function collectOpenVikingAudit(cli: string, snapshot: MemoryPort['preview'], signal: AbortSignal,
  run: PilotCommand = pilotCommand, store?: Pick<Store, 'get' | 'set' | 'delete'>) {
  const { targets, skipped, unavailable, total } = await collectOpenVikingMemories(cli, snapshot, signal, run)
  const archives = targets.length ? await collectOpenVikingEvidence(cli, signal, run, store ? await archiveCache(store) : undefined)
    : { packs: [], total: 0, unavailable: [], skipped: [] }
  const history = indexArchives(archives.packs)
  const packs = targets.map(target => {
    const project = peerPath.exec(target.uri)?.[1] ?? 'user'
    const evidence = selectEvidence(target, history)
    return { id: key(target.uri, target.digest, JSON.stringify(evidence)), project, target, evidence }
  })
  return { packs, total, skipped, unavailable: [...unavailable, ...archives.unavailable],
    archiveTotal: archives.total, archiveSkipped: archives.skipped }
}
