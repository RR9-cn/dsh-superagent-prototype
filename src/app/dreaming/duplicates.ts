import { createHash } from 'node:crypto'
import { key } from '../../core/ids.ts'

export type MemorySnapshot = { uri: string; digest: string; content: string }
type MemoryVersion = Omit<MemorySnapshot, 'content'>
export type ApprovedRevision = { uri: string; digest: string; previous: string; replacement: string; query: string }
export type MemoryDuplicate = {
  id: string
  keep: MemoryVersion
  remove: MemoryVersion
  reason: 'identical' | 'revised'
  query: string
  obsolete: string[]
  status: 'proposed' | 'deleting' | 'pending_verification' | 'verified' | 'blocked'
}

export interface MemoryCleanupPort {
  readForDeletion(uri: string): Promise<MemorySnapshot | null>
  deleteExact(uri: string): Promise<void>
  verifyRemoval(pair: MemoryDuplicate): Promise<boolean>
}

export const memoryParent = (uri: string) => uri.slice(0, uri.lastIndexOf('/'))
const digest = (content: string) => createHash('sha256').update(content).digest('hex')
const pathHasSpaces = (uri: string) => /\p{White_Space}/u.test(uri)

/** Suggests only same-directory duplicates and replacements proven by an approved exact revision. */
export function findMemoryDuplicates(entries: MemorySnapshot[], revisions: ApprovedRevision[]): MemoryDuplicate[] {
  const pairs: MemoryDuplicate[] = []
  const removed = new Set<string>()
  const retained = new Set<string>()
  const byUri = new Map(entries.map(entry => [entry.uri, entry]))
  const sameBody = new Map<string, MemorySnapshot>()
  const version = ({ uri, digest }: MemorySnapshot) => ({ uri, digest })
  const record = (keep: MemorySnapshot, remove: MemorySnapshot, reason: MemoryDuplicate['reason'], query: string, obsolete: string[]) => {
    if (keep.uri === remove.uri || removed.has(keep.uri) || removed.has(remove.uri) || retained.has(remove.uri)) return
    removed.add(remove.uri)
    retained.add(keep.uri)
    pairs.push({ id: key(keep.uri, keep.digest, remove.uri, remove.digest), keep: version(keep), remove: version(remove),
      reason, query, obsolete, status: 'proposed' })
  }
  for (const revision of revisions) {
    const old = byUri.get(revision.uri)
    if (!old || old.digest !== revision.digest || !revision.previous || revision.previous === revision.replacement) continue
    const index = old.content.indexOf(revision.previous)
    if (index < 0 || index !== old.content.lastIndexOf(revision.previous)) continue
    const expected = digest(old.content.slice(0, index) + revision.replacement + old.content.slice(index + revision.previous.length))
    const keep = entries.find(item => item.uri !== old.uri && item.digest === expected && memoryParent(item.uri) === memoryParent(old.uri))
    if (!keep || keep.content.includes(revision.previous)) continue
    const obsolete = revision.previous.split(/\r?\n/).map(line => line.trim())
      .filter(line => line.length >= 12 && !keep.content.includes(line)).slice(0, 8)
    record(keep, old, 'revised', revision.query, obsolete.length ? obsolete : [revision.previous])
  }
  const ordered = entries.toSorted((a, b) => Number(retained.has(b.uri)) - Number(retained.has(a.uri)) ||
    Number(pathHasSpaces(a.uri)) - Number(pathHasSpaces(b.uri)) || a.uri.localeCompare(b.uri))
  for (const entry of ordered) {
    if (removed.has(entry.uri)) continue
    const group = key(memoryParent(entry.uri), entry.digest)
    const keep = sameBody.get(group)
    if (!keep) {
      sameBody.set(group, entry)
      continue
    }
    const title = keep.uri.split('/').at(-1)!.replace(/\.md$/u, '').replaceAll('_', ' ')
    record(keep, entry, 'identical', title.slice(0, 500), [])
  }
  return pairs
}
