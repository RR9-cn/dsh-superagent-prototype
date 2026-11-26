import { setTimeout as wait } from 'node:timers/promises'
import { key } from '../../core/ids.ts'
import { pilotCommand, type PilotCommand } from '../../infra/pilot-cli.ts'
import type { DreamingEvidencePack } from './dreaming.ts'
import { memoryUri, type MemoryPort } from './memory.ts'
import { collectOpenVikingEvidence, listOpenVikingDirectory } from './openviking.ts'

const home = 'viking://~/'
const peerPath = /^viking:\/\/~\/peers\/([\w.@-]+)\//
const memoryLimit = 12_000
const evidenceLimit = 20

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
  return packs.map(pack => ({ pack, excerpts: pack.evidence.map(item => ({ item, terms: terms(item.text) })) }))
}

function selectEvidence(target: NonNullable<DreamingEvidencePack['target']>, history: ReturnType<typeof indexArchives>) {
  const project = peerPath.exec(target.uri)?.[1]
  const query = terms(target.content)
  const ranked = history.flatMap(({ pack, excerpts }) => {
    if (!pack.archiveUri || (project && pack.project !== project)) return []
    const cited = target.content.includes(`${pack.archiveUri}/`) || target.content.includes(`${pack.archiveUri} `)
    const items = excerpts.map(({ item, terms }) => {
      const overlap = [...terms].filter(term => query.has(term)).length
      return { item: { ...item, id: `${pack.id.slice(0, 12)}:${item.id}` }, score: overlap + (cited ? 1000 : 0) }
    })
    return items.filter(({ score }) => score > 0)
  })
  const selected = new Set(ranked.toSorted((a, b) => b.score - a.score).slice(0, evidenceLimit))
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
  run: PilotCommand = pilotCommand) {
  const { targets, skipped, unavailable, total } = await collectOpenVikingMemories(cli, snapshot, signal, run)
  const archives = targets.length ? await collectOpenVikingEvidence(cli, signal, run)
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
