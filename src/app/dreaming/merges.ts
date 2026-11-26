import { z } from 'zod'
import { key } from '../../core/ids.ts'
import { memoryParent, type MemoryCleanupPort, type MemorySnapshot } from './duplicates.ts'
import type { MemoryEdit, MemoryPort } from './memory.ts'

const statement = z.string().trim().min(1).max(800)
const passage = z.string().trim().min(8).max(1200)
export const DreamingMergeResult = z.object({ result: z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('merge'), reason: statement, keepPassage: passage, sourcePassage: passage }).strict(),
  z.object({ outcome: z.literal('skip'), reason: statement }).strict(),
]) }).strict()
export type MemoryMergeDecision = z.infer<typeof DreamingMergeResult>['result']

export type MemoryMerge = {
  id: string
  keep: MemorySnapshot
  source: MemorySnapshot
  queries: string[]
  status: 'proposed' | 'writing' | 'waiting_for_recall' | 'removing' | 'checking_removal' | 'verified' | 'blocked' | 'skipped'
  edit?: MemoryEdit
  decision?: MemoryMergeDecision
}
export type MemoryMergePort = MemoryCleanupPort & Pick<MemoryPort, 'prepare' | 'apply'> & {
  recallsMerge(plan: MemoryMerge, sourceAbsent: boolean): Promise<boolean>
}

export function supportsMerge(plan: MemoryMerge, decision: MemoryMergeDecision): boolean {
  if (decision.outcome !== 'merge') return false
  const distinct = (excerpt: string, present: string, other: string) => present.includes(excerpt) &&
    present.indexOf(excerpt) === present.lastIndexOf(excerpt) && !other.includes(excerpt)
  return distinct(decision.keepPassage, plan.keep.content, plan.source.content) &&
    distinct(decision.sourcePassage, plan.source.content, plan.keep.content)
}

const title = (uri: string) => uri.split('/').at(-1)!.replace(/\.md$/iu, '').replaceAll('_', ' ')
const normalized = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '')
const terms = (text: string) => {
  const name = text.normalize('NFKC').toLowerCase()
  return new Set([...(name.match(/[a-z0-9]{3,}/g) ?? []),
    ...Array.from(name.matchAll(/(?=(\p{Script=Han}{2}))/gu), match => match[1]!)])
}

export function mergedMemoryBody(plan: Pick<MemoryMerge, 'keep' | 'source'>): string {
  const { keep, source } = plan
  return [keep.content, '## 合并记忆与出处', `- 保留条目：<${keep.uri}>\n- 原补充条目：<${source.uri}>`, source.content].join('\n\n')
}

/** Finds reviewable same-directory pairs with related topics and distinct substantive lines. */
export function findMemoryMerges(entries: MemorySnapshot[], excluded: Set<string>): MemoryMerge[] {
  const reserved = new Set(excluded)
  const groups = new Map<string, { entry: MemorySnapshot; topic: string; keywords: Set<string>; lines: Set<string> }[]>()
  for (const entry of entries) {
    if (excluded.has(entry.uri)) continue
    const parent = memoryParent(entry.uri)
    const name = title(entry.uri)
    const lines = new Set(entry.content.split(/\r?\n/u)
      .filter(line => !/^\s*(?:#|(?:[-*]\s*)?(?:viking:\/\/|https?:\/\/))/u.test(line))
      .map(normalized).filter(line => line.length >= 12))
    const topic = normalized(name)
    const keywords = terms(name)
    const group = groups.get(parent) ?? []
    group.push({ entry, topic, keywords, lines })
    groups.set(parent, group)
  }
  const candidates: { plan: MemoryMerge; score: number }[] = []
  for (const group of groups.values()) {
    const ordered = group.toSorted((a, b) => Number(/\p{White_Space}/u.test(a.entry.uri)) - Number(/\p{White_Space}/u.test(b.entry.uri))
      || b.entry.content.length - a.entry.content.length || a.entry.uri.localeCompare(b.entry.uri))
    for (const [index, a] of ordered.entries()) {
      const keep = a.entry
      if (/[\p{White_Space}\u001c-\u001f]/u.test(keep.uri)) continue
      for (const b of ordered.slice(index + 1)) {
        const source = b.entry
        if (keep.uri === source.uri || keep.digest === source.digest || keep.content.includes(source.uri) ||
          source.content.includes(keep.uri) || Math.min(a.topic.length, b.topic.length) < 4) continue
        const overlap = [...a.keywords].filter(word => b.keywords.has(word)).length
        const exactTopic = a.topic === b.topic
        const score = exactTopic ? 1 : overlap / new Set([...a.keywords, ...b.keywords]).size
        if (!exactTopic && (overlap < 2 || !(score >= 0.45))) continue
        if (![...a.lines].some(line => !b.lines.has(line)) || ![...b.lines].some(line => !a.lines.has(line))) continue
        const familyQuery = title(keep.uri).slice(0, 500)
        const sourceLine = source.content.split(/\r?\n/u).find(line => b.lines.has(normalized(line)) && !a.lines.has(normalized(line)))
        const sourceQuery = [title(source.uri), sourceLine?.trim()].filter(Boolean).join(' ').slice(0, 500)
        const plan: MemoryMerge = { id: key(keep.uri, keep.digest, source.uri, source.digest), keep, source,
          queries: [...new Set([familyQuery, sourceQuery])], status: 'proposed' }
        if (mergedMemoryBody(plan).length <= 12000) candidates.push({ plan, score })
      }
    }
  }
  return candidates.sort((a, b) => b.score - a.score).flatMap(({ plan }) => {
    if (reserved.has(plan.keep.uri) || reserved.has(plan.source.uri)) return []
    reserved.add(plan.keep.uri)
    reserved.add(plan.source.uri)
    return [plan]
  })
}
