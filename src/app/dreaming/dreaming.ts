import { z } from 'zod'
import { setTimeout as wait } from 'node:timers/promises'
import { key } from '../../core/ids.ts'
import { family, record } from '../../kv.ts'
import type { RoleModel } from '../../policy.ts'
import { PollAgain, type Effects } from '../effects.ts'
import type { Store } from '../store.ts'
import { findMemoryDuplicates, type MemoryCleanupPort, type MemoryDuplicate, type MemorySnapshot } from './duplicates.ts'
import { MemoryWriteError, type MemoryEdit, type MemoryPatch, type MemoryPort, type MemoryWriteCode } from './memory.ts'
import { findMemoryMerges, mergedMemoryBody, supportsMerge, type MemoryMerge, type MemoryMergeDecision, type MemoryMergePort } from './merges.ts'
const RULE_VERSION = 'dsh-agent-1'
const TIMEOUT_MS = 3 * 60_000
const MEMORY_EXCERPT_LIMIT = 2400
export interface DreamingEvidencePack {
  id: string
  project: string
  archiveUri?: string
  target?: { uri: string; digest: string; content: string }
  evidence: { id: string; source: string; kind: 'tool-result' | 'agent-report' | 'user-report' | 'artifact'; text: string }[]
}
type Experience = { title: string; action: string; scope: string; verification: string; support: string[]; counterexamples: string[] }
export type DreamingReview = 'approved' | 'rejected' | 'pending'
type Snapshot = { version: number; experience: Experience; batchId: string }
type MemoryCheckStage = 'search' | 'read' | 'match' | 'prepare'
type Candidate = { before: Experience | null; after: Experience; reason: string; review: DreamingReview; reviewedAt?: string; memory?: MemoryEdit;
  audit?: { outcome: 'revise'; patch: MemoryPatch } | { outcome: 'remove' }
  memoryMatch?: { status: 'resolving' | 'no_match' | 'ambiguous' | 'failed'; stage?: MemoryCheckStage; detail?: string; errorCode?: MemoryWriteCode } }
type Batch = { id: string; baseVersion: number; pack: DreamingEvidencePack; createdAt: string;
  attempt: number; model: RoleModel | null; sessionId: string; deadline?: number } & (
  { status: 'queued' | 'running' } | { status: 'no_change'; observation: string; finding?: 'keep' | 'insufficient' }
  | { status: 'failed'; error: 'timeout' | 'no_result' }
  | { status: 'ready' | 'published'; candidate: Candidate }
)

const statement = z.string().trim().min(1).max(1200)
const reference = z.string().trim().min(1).max(100)
export const DreamingResult = z.object({ result: z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('no_change'), reason: statement }).strict(),
  z.object({ outcome: z.literal('revise'), reason: statement, title: statement, action: statement, verification: statement,
    support: z.array(reference).min(1).max(20), counterexamples: z.array(reference).max(20) }).strict(),
]) }).strict()
const citations = { support: z.array(reference).min(1).max(20), counterexamples: z.array(reference).max(20) }
export const DreamingAuditResult = z.object({ result: z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('keep'), reason: statement }).strict(),
  z.object({ outcome: z.literal('insufficient'), reason: statement }).strict(),
  z.object({ outcome: z.literal('revise'), reason: statement, title: statement, verification: statement,
    previous: z.string().min(1).max(12_000), replacement: z.string().min(1).max(3000), ...citations }).strict(),
  z.object({ outcome: z.literal('remove'), reason: statement, ...citations }).strict(),
]) }).strict()
export const DreamingMemoryResult = z.object({ result: z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('update'), target: z.number().int().min(1).max(10),
    previous: z.string().min(8).max(3000), replacement: z.string().min(1).max(3000) }).strict(),
  z.object({ outcome: z.literal('no_match'), reason: statement }).strict(),
  z.object({ outcome: z.literal('ambiguous'), reason: statement }).strict(),
]) }).strict()
export interface MemoryMatchInput {
  model: RoleModel | null
  candidate: Pick<Candidate, 'after' | 'reason' | 'before'>
  targets: { target: number; uri: string; content: string }[]
}
export interface DreamingAgentPort {
  sessionId(batchId: string, attempt: number): string
  advance(input: { sessionId: string; model: RoleModel | null; pack: DreamingEvidencePack; before: Experience | null },
    submit: (value: unknown) => void): Promise<'waiting' | 'finished'>
  /** Returns false while a canceled attempt is still active. */
  cancel(sessionId: string): boolean
  assessMerge?(input: { model: RoleModel | null; keep: MemorySnapshot; source: MemorySnapshot }): Promise<MemoryMergeDecision>
  matchMemory?(input: MemoryMatchInput): Promise<z.infer<typeof DreamingMemoryResult>['result']>
}

// The demonstration used its own ledger. Its records cannot become a source for the real workflow.
const batches = family<Batch>('dreaming-live-batch:')
const snapshots = family<Snapshot, [number]>('dreaming-live-snapshot:')
const currentVersion = record<number>('dreaming-live-version')
const archiveVersion = family<number>('dreaming-live-archive-version:')
const archiveSnapshots = family<Snapshot, [string, number]>('dreaming-live-archive-snapshot:')
type BulkResult = { total: number; queued: number; existing: number; skipped: string[]; unavailable: string[];
  archiveTotal?: number; archiveSkipped?: string[] }
const lastBulk = record<BulkResult>('dreaming-live-bulk')
const duplicates = family<MemoryDuplicate>('dreaming-memory-duplicate:')
type DuplicateScan = { ids: string[]; total: number; skipped: string[]; unavailable: string[] }
const duplicateScan = record<DuplicateScan>('dreaming-memory-duplicate-scan')
const merges = family<MemoryMerge>('dreaming-memory-merge:')
const mergeScan = record<string[]>('dreaming-memory-merge-scan')
const merging = (plan: MemoryMerge) => !['proposed', 'verified', 'blocked', 'skipped'].includes(plan.status)
const DAILY = 24 * 60 * 60_000
// 02:00 in Asia/Shanghai is 18:00 UTC on the preceding calendar day.
const MAINTENANCE_UTC_OFFSET = 18 * 60 * 60_000
export function nextDreamingMaintenanceAt(after: number): number {
  return (Math.floor((after - MAINTENANCE_UTC_OFFSET) / DAILY) + 1) * DAILY + MAINTENANCE_UTC_OFFSET
}
type Maintenance = {
  scannedAt: number
  finishedAt?: number
  batchIds: string[]
  pairIds: string[]
  protectedUris: string[]
  revised: number
  removed: number
  unresolved: number
}
const maintenanceRun = record<Maintenance>('dreaming-memory-maintenance')
const firstMaintenanceAt = record<number>('dreaming-memory-maintenance-first-slot')
/** The batch or publication state no longer permits the requested operation. */
export class DreamingConflict extends Error {}
/** The requested batch does not exist in the local ledger. */
export class DreamingBatchMissing extends Error {}

/** Owns Dreaming batches and turns a validated DSH Agent submission into a reviewable draft. */
export class Dreaming {
  private readonly memoryWrites = new Set<string>()
  private readonly memoryMatches = new Set<string>()
  private readonly activeMemoryUris = new Set<string>()
  private autoMergeEnabled = false
  private maintenanceEnabled = false
  private maintenanceCollecting = false
  constructor(private readonly store: Store, private readonly effects: Effects, private readonly agent: DreamingAgentPort,
    private readonly lifetime: AbortSignal, private readonly readEvidence?: () => DreamingEvidencePack | null) {
    effects.handle('dreaming', ({ batchId }) => this.organize(batchId), { limit: () => 1, ordered: true })
  }

  private current(uri?: string): Snapshot | null {
    const version = this.store.get(uri ? archiveVersion(key(uri)) : currentVersion)
    if (version === undefined) return null
    const snapshot = this.store.get(uri ? archiveSnapshots(key(uri), version) : snapshots(version))
    if (!snapshot) throw new Error('The published Dreaming snapshot is missing')
    return snapshot
  }

  private batch(id: string): Batch {
    const batch = this.store.get(batches(id))
    if (!batch) throw new DreamingBatchMissing('Dreaming batch not found')
    return batch
  }

  private list(): Batch[] {
    return this.store.keys(batches).flatMap(name => {
      const batch = this.store.get(batches(name.slice(batches.prefix.length)))
      return batch ? [batch] : []
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.baseVersion - a.baseVersion)
  }

  private evidence(): DreamingEvidencePack | null {
    const pack = this.readEvidence?.()
    return pack?.evidence.length ? pack : null
  }

  view() {
    const scan = this.store.get(duplicateScan)
    const maintenance = this.store.get(maintenanceRun)
    const mergeIds = this.store.get(mergeScan)
    return { mode: 'dsh' as const, pack: this.evidence(), batches: this.list(), published: this.current(), bulk: this.store.get(lastBulk) ?? null,
      ...(scan ? { duplicates: { ...scan, pairs: this.duplicatePairs().filter(pair =>
        scan.ids.includes(pair.id) || ['deleting', 'pending_verification', 'verified'].includes(pair.status)) } } : {}),
      ...(mergeIds ? { merges: this.mergePlans().filter(plan => mergeIds.includes(plan.id) || plan.status !== 'proposed')
        .map(({ id, keep, source, status, decision }) => ({ id, keep, source, status, ...(decision ? { reason: decision.reason } : {}) })) } : {}),
      ...(this.maintenanceEnabled ? { maintenance: { active: this.maintenanceCollecting || (!!maintenance && !maintenance.finishedAt),
        revised: maintenance?.revised ?? 0, removed: maintenance?.removed ?? 0, unresolved: maintenance?.unresolved ?? 0,
        nextAt: maintenance && !maintenance.finishedAt ? undefined : new Date(this.maintenanceDue(maintenance)).toISOString() } } : {}) }
  }

  private maintenanceDue(run?: Maintenance): number {
    return run?.finishedAt === undefined ? this.store.get(firstMaintenanceAt)! : nextDreamingMaintenanceAt(run.finishedAt)
  }

  private duplicatePairs() {
    return this.store.keys(duplicates).flatMap(name => {
      const pair = this.store.get(duplicates(name.slice(duplicates.prefix.length)))
      return pair ? [pair] : []
    })
  }

  enableMaintenance(memory: MemoryPort & MemoryMergePort,
    collect: () => Promise<Parameters<Dreaming['startAll']>[0]>, paused: () => boolean, now = Date.now): void {
    if (this.store.get(firstMaintenanceAt) === undefined) this.store.set(firstMaintenanceAt, nextDreamingMaintenanceAt(now()))
    this.maintenanceEnabled = true
    if (this.agent.assessMerge) {
      this.autoMergeEnabled = true
      this.effects.handle('dreaming-merge', async ({ id }) => {
        const plan = this.store.get(merges(id))
        if (!plan || !this.canRunMerge(plan)) return
        const { status } = await this.mergeMemories(id, memory, paused)
        if (['writing', 'waiting_for_recall', 'removing', 'checking_removal'].includes(status)) {
          throw new PollAgain('Waiting for OpenViking merge verification', 60_000)
        }
      }, { retry: [30_000, 15 * 60_000] })
      this.enqueueMerges()
    }
    this.effects.handle('dreaming-maintenance', async () => {
      if (this.lifetime.aborted || paused()) throw new PollAgain('Dreaming maintenance is paused', 60_000)
      let run = this.store.get(maintenanceRun)
      if (!run || run.finishedAt) {
        const remaining = this.maintenanceDue(run) - now()
        if (remaining > 0) throw new PollAgain('Dreaming maintenance is scheduled', remaining)
        this.maintenanceCollecting = true
        const input = await collect().finally(() => { this.maintenanceCollecting = false })
        this.lifetime.throwIfAborted()
        if (paused()) throw new PollAgain('Dreaming maintenance is paused', 60_000)
        run = this.store.atomic(() => {
          const { batchIds, pairIds } = this.queueAll(input)
          const allowed = new Set(pairIds)
          const pairs = this.duplicatePairs().filter(pair => ['deleting', 'pending_verification'].includes(pair.status) ||
            (allowed.has(pair.id) && pair.status === 'proposed'))
          const recallChecks = this.list().flatMap(batch => batch.status === 'ready' && batch.candidate.review === 'approved' &&
            batch.candidate.memory?.errorCode === 'recall_pending' ? [batch.id] : [])
          const next: Maintenance = { scannedAt: now(), batchIds: [...new Set([...batchIds, ...recallChecks])],
            pairIds: pairs.map(pair => pair.id),
            protectedUris: [...new Set(pairs.flatMap(pair => [pair.remove.uri, pair.keep.uri]))],
            revised: 0, removed: 0, unresolved: 0 }
          this.store.set(maintenanceRun, next)
          return next
        })
      }
      const pairId = run.pairIds[0]
      const batchId = run.batchIds[0]
      if (pairId) {
        let result = await this.removeDuplicate(pairId, memory).catch(() => undefined)
        if (result?.status === 'pending_verification') {
          await wait(3000, undefined, { signal: this.lifetime })
          if (!paused()) result = await this.removeDuplicate(pairId, memory).catch(() => undefined)
        }
        this.lifetime.throwIfAborted()
        this.store.set(maintenanceRun, { ...run, pairIds: run.pairIds.slice(1),
          removed: run.removed + Number(result?.status === 'verified'), unresolved: run.unresolved + Number(result?.status !== 'verified') })
      } else if (batchId) {
        const batch = this.batch(batchId)
        if (batch.status === 'queued' || batch.status === 'running') throw new PollAgain('Waiting for Dreaming audit results', 1000)
        const actionable = batch.status === 'ready' && batch.candidate.audit?.outcome === 'revise' &&
          batch.candidate.review !== 'rejected' && batch.candidate.memory?.status !== 'verified' &&
          !run.protectedUris.includes(batch.candidate.audit.patch.uri)
        let result = actionable ? await this.correctMemory(batchId, memory).catch(() => undefined) : undefined
        if (actionable && this.correctionBatch(batchId).candidate.memory?.errorCode === 'recall_pending' && !result) {
          await wait(3000, undefined, { signal: this.lifetime })
          if (!paused()) result = await this.correctMemory(batchId, memory).catch(() => undefined)
        }
        this.lifetime.throwIfAborted()
        this.store.set(maintenanceRun, { ...run, batchIds: run.batchIds.slice(1),
          revised: run.revised + Number(result?.status === 'verified'),
          unresolved: run.unresolved + Number(batch.status === 'failed' || (actionable && result?.status !== 'verified')) })
      } else {
        const finishedAt = now()
        this.store.set(maintenanceRun, { ...run, finishedAt })
        throw new PollAgain('Dreaming maintenance is scheduled', nextDreamingMaintenanceAt(finishedAt) - finishedAt)
      }
      throw new PollAgain('Continuing Dreaming maintenance', 0)
    }, { retry: [30_000, 15 * 60_000] })
    // Recompute the wake-up at each startup, including rows saved by an older schedule.
    this.effects.enqueue('dreaming-maintenance', 'daily', {})
  }

  scanDuplicates({ targets, ...coverage }: Omit<DuplicateScan, 'ids'> & { targets: MemorySnapshot[] }): DuplicateScan {
    const revisions = this.list().flatMap(batch => {
      if (batch.status !== 'ready' || batch.candidate.review !== 'approved' || batch.candidate.audit?.outcome !== 'revise') return []
      return [batch.candidate.audit.patch]
    })
    return this.store.atomic(() => {
      const pairs = findMemoryDuplicates(targets, revisions)
      for (const pair of pairs) {
        if (!this.store.get(duplicates(pair.id))) this.store.set(duplicates(pair.id), pair)
      }
      const result = { ...coverage, ids: pairs.map(pair => pair.id) }
      this.store.set(duplicateScan, result)
      const excluded = new Set(pairs.flatMap(pair => [pair.keep.uri, pair.remove.uri]))
      for (const plan of this.mergePlans().filter(merging)) {
        excluded.add(plan.keep.uri)
        excluded.add(plan.source.uri)
      }
      const candidates = findMemoryMerges(targets, excluded)
      for (const plan of candidates) {
        if (!this.store.get(merges(plan.id))) this.store.set(merges(plan.id), plan)
      }
      this.store.set(mergeScan, candidates.map(plan => plan.id))
      this.enqueueMerges()
      return result
    })
  }

  private mergePlans(): MemoryMerge[] {
    return this.store.keys(merges).flatMap(name => {
      const plan = this.store.get(merges(name.slice(merges.prefix.length)))
      return plan ? [plan] : []
    })
  }

  private mergeUses(uri: string): boolean {
    return this.mergePlans().some(plan => merging(plan) && (plan.keep.uri === uri || plan.source.uri === uri))
  }

  private canRunMerge(plan: MemoryMerge): boolean {
    return merging(plan) || (plan.status === 'proposed' && this.store.get(mergeScan)?.includes(plan.id) === true)
  }

  private enqueueMerges(): void {
    if (!this.autoMergeEnabled) return
    for (const plan of this.mergePlans().filter(plan => this.canRunMerge(plan))) {
      if (!this.effects.pending('dreaming-merge', plan.id)) this.effects.enqueue('dreaming-merge', plan.id, { id: plan.id })
    }
  }

  private async mergeMemories(id: string, memory: MemoryMergePort, paused: () => boolean): Promise<{ status: MemoryMerge['status'] }> {
    const saved = this.store.get(merges(id))
    if (!saved) throw new DreamingBatchMissing('Dreaming merge not found')
    let plan = saved
    if (!this.canRunMerge(plan)) return { status: plan.status }
    const ensureRunning = () => {
      this.lifetime.throwIfAborted()
      if (paused()) throw new PollAgain('Dreaming merge is paused', 60_000)
    }
    ensureRunning()
    const { keep, source } = plan
    const uris = [keep.uri, source.uri]
    if (uris.some(uri => this.activeMemoryUris.has(uri) || (plan.status === 'proposed' && this.mergeUses(uri)))) {
      throw new DreamingConflict('One of these memories is in use')
    }
    uris.forEach(uri => this.activeMemoryUris.add(uri))
    const save = (status: MemoryMerge['status'], edit = plan.edit) => {
      plan = { ...plan, status, edit }
      this.store.set(merges(id), plan)
      return { status }
    }
    const read = () => Promise.all([memory.readForDeletion(keep.uri), memory.readForDeletion(source.uri)])
    try {
      const [current, old] = await read()
      const removing = plan.status === 'removing' || plan.status === 'checking_removal'
      if (!current || (old ? old.digest !== source.digest : !removing)) return save('blocked')

      if (!plan.edit && current.digest !== keep.digest) return save('blocked')
      if (!plan.decision && !removing) {
        const decision = await this.agent.assessMerge?.({ keep, source, model: this.store.settings().eval.model })
        ensureRunning()
        if (!decision) return save('blocked')
        if (!this.canRunMerge(plan)) return save('skipped')
        if (decision.outcome === 'skip' || !supportsMerge(plan, decision)) {
          plan = { ...plan, decision: decision.outcome === 'skip' ? decision :
            { outcome: 'skip', reason: '模型返回的互补内容无法在两条原记忆中核对。' } }
          return save('skipped')
        }
        plan = { ...plan, decision, queries: [plan.queries[0]!, decision.sourcePassage.slice(0, 500)] }
        const [retained, absorbed] = await read()
        if (retained?.digest !== current.digest || absorbed?.digest !== source.digest) return save('blocked')
        save(plan.status)
      }

      if (!plan.edit) {
        const staged = await memory.prepare({ uri: keep.uri, previous: keep.content, replacement: mergedMemoryBody(plan),
          digest: keep.digest, digestKind: 'visible', query: plan.queries[0]!, supplement: true })
        ensureRunning()
        save('writing', staged)
      }
      const edit = plan.edit!
      if (current.digest !== edit.updatedDigest) {
        if (plan.status !== 'writing' || current.digest !== keep.digest) return save('blocked')
        ensureRunning()
        await memory.apply(edit)
      }
      if (!removing) save('waiting_for_recall')
      if (old && plan.status !== 'checking_removal') {
        if (!await memory.recallsMerge(plan, false)) return { status: plan.status }
        // Recheck both approved versions after waiting on the search index.
        const [retained, absorbed] = await read()
        if (retained?.digest !== edit.updatedDigest || absorbed?.digest !== source.digest) return save('blocked')
        ensureRunning()
        save('removing')
        await memory.deleteExact(source.uri)
      }
      save('checking_removal')
      const [retained, absorbed] = await read()
      if (retained?.digest !== edit.updatedDigest || (absorbed && absorbed.digest !== source.digest)) return save('blocked')
      if (!absorbed && await memory.recallsMerge(plan, true)) return save('verified')
      return { status: 'checking_removal' }
    } catch (error) {
      if (error instanceof MemoryWriteError && error.status !== 'pending_verification') return save('blocked')
      throw error
    } finally { uris.forEach(uri => this.activeMemoryUris.delete(uri)) }
  }

  async removeDuplicate(id: string, memory: MemoryCleanupPort): Promise<{ status: MemoryDuplicate['status'] }> {
    const pair = this.store.get(duplicates(id))
    if (!pair) throw new DreamingBatchMissing('Dreaming duplicate not found')
    if (pair.status === 'verified') return { status: 'verified' }
    if (pair.status === 'blocked' || (pair.status === 'proposed' && !this.store.get(duplicateScan)?.ids.includes(id))) {
      throw new DreamingConflict('Scan for duplicates again before confirming deletion')
    }
    const uris = [pair.keep.uri, pair.remove.uri]
    if (uris.some(uri => this.activeMemoryUris.has(uri) || this.mergeUses(uri))) throw new DreamingConflict('One of these memories is in use')
    uris.forEach(uri => this.activeMemoryUris.add(uri))
    const save = (status: MemoryDuplicate['status']) => {
      this.store.set(duplicates(id), { ...pair, status })
      return { status }
    }
    try {
      const [keep, old] = await Promise.all(uris.map(uri => memory.readForDeletion(uri)))
      if (keep?.digest !== pair.keep.digest || (old && old.digest !== pair.remove.digest)) return save('blocked')
      if (old && pair.status === 'pending_verification') return { status: 'pending_verification' }
      let receipt = false
      if (old) {
        this.lifetime.throwIfAborted()
        save('deleting')
        try { await memory.deleteExact(pair.remove.uri); receipt = true }
        catch (error) {
          if (error instanceof MemoryWriteError && error.status === 'blocked') return save('blocked')
          // The remote deletion may have completed despite the transport failure.
        }
      }
      const [retained, deleted] = await Promise.all(uris.map(uri => memory.readForDeletion(uri)))
      if (retained?.digest !== pair.keep.digest) return save('blocked')
      if (deleted) return save(receipt ? 'pending_verification' : 'proposed')
      save('pending_verification')
      if (await memory.verifyRemoval(pair)) return save('verified')
      return { status: 'pending_verification' }
    } finally { uris.forEach(uri => this.activeMemoryUris.delete(uri)) }
  }

  start(selected?: DreamingEvidencePack): { id: string } {
    return this.store.atomic(() => {
      const pack = selected ?? this.evidence()
      if (!pack) throw new DreamingConflict('No Dreaming evidence source is available')
      const active = this.list().find(batch => batch.status === 'running' || batch.status === 'queued')
      if (active) return { id: active.id }
      return { id: this.queue(pack, this.store.settings().eval.model).id }
    })
  }

  startAll({ packs, ...coverage }: Omit<BulkResult, 'queued' | 'existing'> & { packs: DreamingEvidencePack[] }): BulkResult {
    return this.queueAll({ packs, ...coverage }).result
  }

  private queueAll({ packs, ...coverage }: Omit<BulkResult, 'queued' | 'existing'> & { packs: DreamingEvidencePack[] }) {
    return this.store.atomic(() => {
      const pairIds = coverage.archiveTotal !== undefined ? this.scanDuplicates({
        total: coverage.total, skipped: coverage.skipped, unavailable: coverage.unavailable,
        targets: packs.flatMap(pack => pack.target ? [pack.target] : []),
      }).ids : []
      const model = this.store.settings().eval.model
      const entries = packs.map(pack => this.queue(pack, model))
      const queued = entries.filter(entry => entry.queued).length
      const result = { ...coverage, queued, existing: packs.length - queued }
      this.store.set(lastBulk, result)
      return { result, pairIds, batchIds: entries.map(entry => entry.id) }
    })
  }

  private queue(pack: DreamingEvidencePack, model: RoleModel | null): { id: string; queued: boolean } {
    const snapshot = pack.target ? null : this.current(pack.archiveUri)
    if (snapshot && snapshot.experience.scope !== pack.project) throw new DreamingConflict('The archive project differs from the published Dreaming project')
    const baseVersion = snapshot?.version ?? 0
    const id = key('dreaming', RULE_VERSION, pack.archiveUri ? 'archive' : String(baseVersion), JSON.stringify(pack), JSON.stringify(model))
    const existing = this.store.get(batches(id))
    if (existing && existing.status !== 'failed') return { id, queued: false }
    const attempt = (existing?.attempt ?? 0) + 1
    this.store.set(batches(id), { id, baseVersion, pack, status: 'queued', createdAt: new Date().toISOString(),
      attempt, model, sessionId: this.agent.sessionId(pack.target ? `audit-${id}` : id, attempt) })
    this.effects.enqueue('dreaming', id, { batchId: id })
    return { id, queued: true }
  }

  private async organize(id: string): Promise<void> {
    // Discard any queued effects left by the retired demonstration.
    let batch = this.store.get(batches(id))
    if (!batch) return
    if (batch.status !== 'queued' && batch.status !== 'running') return
    if (batch.pack.target && !batch.pack.evidence.length) {
      this.store.set(batches(id), { ...batch, status: 'no_change', observation: '', finding: 'insufficient' })
      return
    }
    const sessionId = batch.sessionId
    if (batch.status === 'queued') {
      batch = { ...batch, status: 'running', deadline: Date.now() + TIMEOUT_MS }
      this.store.set(batches(id), batch)
    }
    if (this.lifetime.aborted) return
    if (Date.now() >= batch.deadline!) {
      if (!this.agent.cancel(sessionId)) throw new PollAgain('Waiting for the timed-out Dreaming session to stop')
      this.store.set(batches(id), { ...batch, status: 'failed', error: 'timeout' })
      return
    }
    const before = this.experienceAt(batch.baseVersion, batch.pack.archiveUri)
    let outcome: 'waiting' | 'finished'
    try {
      outcome = await this.agent.advance({ sessionId, model: batch.model ?? null, pack: batch.pack, before },
        value => this.submit(id, sessionId, before, value))
    } catch (error) {
      if (this.lifetime.aborted) return
      if (this.batch(id).status !== 'running') return
      // Keep the row for a bounded retry, including an ambiguous delivery acknowledgement.
      throw error
    }
    if (this.lifetime.aborted || this.batch(id).status !== 'running') return
    if (outcome === 'waiting') throw new PollAgain('Waiting for the Dreaming Agent', 1000)
    this.store.set(batches(id), { ...batch, status: 'failed', error: 'no_result' })
  }

  private experienceAt(version: number, uri?: string): Experience | null {
    if (version === 0) return null
    const experience = this.store.get(uri ? archiveSnapshots(key(uri), version) : snapshots(version))?.experience
    if (!experience) throw new Error('The base Dreaming snapshot is missing')
    return experience
  }

  private submit(id: string, sessionId: string, before: Experience | null, value: unknown): void {
    this.store.atomic(() => {
      const batch = this.batch(id)
      if (batch.sessionId !== sessionId || this.lifetime.aborted) throw new DreamingConflict('This Dreaming attempt is no longer active')
      if (batch.status === 'ready' || batch.status === 'no_change') return
      if (batch.status !== 'running' || Date.now() >= batch.deadline!) throw new DreamingConflict('This Dreaming attempt is no longer active')
      const { result } = batch.pack.target ? DreamingAuditResult.parse(value) : DreamingResult.parse(value)
      if (result.outcome === 'no_change') {
        this.store.set(batches(id), { ...batch, status: 'no_change', observation: result.reason })
        return
      }
      if (result.outcome === 'keep' || result.outcome === 'insufficient') {
        this.store.set(batches(id), { ...batch, status: 'no_change', observation: result.reason, finding: result.outcome })
        return
      }
      const { reason, support, counterexamples } = result
      const refs = [...support, ...counterexamples]
      const evidence = new Map(batch.pack.evidence.map(item => [item.id, item.kind]))
      if (new Set(refs).size !== refs.length || refs.some(ref => !evidence.has(ref)) ||
        !support.some(ref => evidence.get(ref) === 'tool-result')) throw new Error('Cite unique evidence IDs from this batch, including a supporting tool result')
      const target = batch.pack.target
      const evidenceSources = batch.pack.evidence.filter(item => support.includes(item.id)).map(item => item.source)
      const fields = { scope: batch.pack.project, support, counterexamples }
      let candidate: Candidate
      if (target && result.outcome === 'remove') {
        candidate = { before: null, after: { ...fields, title: target.uri, action: '', verification: '' },
          audit: { outcome: 'remove' }, reason, review: 'pending' }
      } else if (target && 'previous' in result) {
        const { previous, replacement, title, verification } = result
        const first = target.content.indexOf(previous)
        if (first < 0 || first !== target.content.lastIndexOf(previous) || replacement.includes(previous)) {
          throw new Error('A revision must replace one unique original passage')
        }
        const patch: MemoryPatch = { uri: target.uri, digest: target.digest, digestKind: 'visible', previous, query: title.slice(0, 500),
          replacement: `${replacement}\n\n证据\n${[...new Set(evidenceSources)].map(source => `- ${source}`).join('\n')}` }
        candidate = { before: null, after: { ...fields, title, action: replacement, verification },
          audit: { outcome: 'revise', patch }, reason, review: 'pending' }
      } else if ('action' in result) {
        const { title, action, verification } = result
        candidate = { before, after: { ...fields, title, action, verification }, reason, review: 'pending' }
      } else throw new Error('The Dreaming result does not match the batch')
      this.store.set(batches(id), { ...batch, status: 'ready', candidate })
    })
  }

  review(id: string, review: DreamingReview): { id: string } {
    return this.store.atomic(() => {
      const batch = this.batch(id)
      if (batch.status !== 'ready' && (batch.status !== 'published' || !batch.candidate.memory)) {
        throw new DreamingConflict('Only a ready candidate or a staged memory correction can be reviewed')
      }
      if (this.memoryWrites.has(id) || this.memoryMatches.has(id) || ['writing', 'pending_verification', 'verified'].includes(batch.candidate.memory?.status ?? '')) {
        throw new DreamingConflict('The memory correction has already entered writeback')
      }
      if (batch.candidate.review !== review) {
        this.store.set(batches(id), { ...batch, candidate: { ...batch.candidate, review, reviewedAt: new Date().toISOString() } })
      }
      return { id }
    })
  }

  private correctionBatch(id: string) {
    const batch = this.batch(id)
    if (batch.status !== 'ready' && batch.status !== 'published') throw new DreamingConflict('This batch has no memory correction candidate')
    return batch
  }

  memoryContext(id: string, uri?: string): { project: string; title: string } {
    const batch = this.correctionBatch(id)
    if (uri?.startsWith('viking://~/peers/') && !uri.startsWith(`viking://~/peers/${batch.pack.project}/memories/`)) {
      throw new DreamingConflict('The target memory belongs to a different project')
    }
    return { project: batch.pack.project, title: batch.candidate.after.title }
  }

  async stageMemory(id: string, patch: MemoryPatch, memory: MemoryPort): Promise<{ id: string }> {
    if (this.correctionBatch(id).pack.target) throw new DreamingConflict('Apply the reviewed correction to its original memory')
    this.memoryContext(id, patch.uri)
    const edit = await memory.prepare(patch)
    return this.store.atomic(() => {
      const batch = this.correctionBatch(id)
      if (this.memoryWrites.has(id) || this.memoryMatches.has(id) || ['writing', 'pending_verification', 'verified'].includes(batch.candidate.memory?.status ?? '')) {
        throw new DreamingConflict('The previous memory write must be resolved first')
      }
      const { reviewedAt: _, memoryMatch: _match, ...candidate } = batch.candidate
      this.store.set(batches(id), { ...batch, candidate: { ...candidate, review: 'pending', memory: edit } })
      return { id }
    })
  }

  async correctMemory(id: string, memory: MemoryPort): Promise<{ status: 'verified'; uri: string } |
    { status: 'no_match' | 'ambiguous'; detail?: string }> {
    const batch = this.correctionBatch(id)
    if (this.memoryMatches.has(id) || this.memoryWrites.has(id)) throw new DreamingConflict('This memory correction is already running')
    if (batch.candidate.review === 'rejected') throw new DreamingConflict('This candidate was rejected')
    if (batch.candidate.memory?.status === 'verified') return { status: 'verified', uri: batch.candidate.memory.uri }
    this.memoryMatches.add(id)
    const updateCandidate = (changes: Partial<Candidate>) => {
      this.lifetime.throwIfAborted()
      const current = this.correctionBatch(id)
      this.store.set(batches(id), { ...current, candidate: { ...current.candidate, ...changes } })
    }
    let stage: MemoryCheckStage = 'search'
    try {
      const existing = batch.candidate.memory
      if (batch.pack.target) {
        const audit = batch.candidate.audit
        if (audit?.outcome !== 'revise') throw new DreamingConflict('This audit did not recommend a revision')
        if (existing?.status === 'conflict') throw new DreamingConflict('The memory changed. Run the audit again')
        if (!existing) {
          stage = 'prepare'
          updateCandidate({ memoryMatch: { status: 'resolving' } })
          updateCandidate({ memory: await memory.prepare(audit.patch) })
        }
      } else if (!existing || existing.status === 'conflict') {
        updateCandidate({ memoryMatch: { status: 'resolving' } })
        const { after, before, reason } = batch.candidate
        const query = after.title.slice(0, 500)
        const hits = (await memory.find(query, batch.pack.project)).slice(0, 10)
        if (!hits.length) {
          updateCandidate({ memoryMatch: { status: 'no_match' } })
          return { status: 'no_match' }
        }
        stage = 'read'
        const targets = await Promise.all(hits.map(({ uri }) => {
          this.memoryContext(id, uri)
          return memory.preview(uri)
        }))
        stage = 'match'
        const match = this.agent.matchMemory
        if (!match) throw new DreamingConflict('DSH memory matching is unavailable')
        const plan = await match.call(this.agent, { model: batch.model, candidate: { after, before, reason },
          targets: targets.map((item, index) => ({ target: index + 1, uri: item.uri, content: item.content.slice(0, MEMORY_EXCERPT_LIMIT) })) })
        if (plan.outcome !== 'update') {
          updateCandidate({ memoryMatch: { status: plan.outcome, detail: plan.reason } })
          return { status: plan.outcome, detail: plan.reason }
        }
        stage = 'prepare'
        const target = targets[plan.target - 1]
        if (!target || !target.content.slice(0, MEMORY_EXCERPT_LIMIT).includes(plan.previous) || !plan.replacement.trim()) {
          throw new DreamingConflict('DSH could not identify an exact original passage')
        }
        const sources = batch.pack.evidence.filter(item => after.support.includes(item.id)).map(item => `- ${item.source}`)
        const replacement = [plan.replacement.trim(), sources.length ? `证据\n${sources.join('\n')}` : ''].filter(Boolean).join('\n\n')
        const edit = await memory.prepare({ uri: target.uri, digest: target.digest, previous: plan.previous, replacement, query })
        updateCandidate({ memory: edit })
      }
      const current = this.correctionBatch(id)
      const { memoryMatch: _, ...candidate } = current.candidate
      this.store.set(batches(id), { ...current, candidate: { ...candidate, review: 'approved', reviewedAt: new Date().toISOString() } })
      return await this.updateMemory(id, memory)
    } catch (error) {
      if (!this.lifetime.aborted && this.correctionBatch(id).candidate.memoryMatch?.status === 'resolving') {
        const detail = error instanceof DreamingConflict || error instanceof MemoryWriteError ? error.message : undefined
        const errorCode = error instanceof MemoryWriteError ? error.code : undefined
        updateCandidate({ memoryMatch: { status: 'failed', stage, ...(detail ? { detail } : {}), ...(errorCode ? { errorCode } : {}) } })
      }
      throw error
    } finally { this.memoryMatches.delete(id) }
  }

  async updateMemory(id: string, memory: MemoryPort): Promise<{ uri: string; status: 'verified' }> {
    const batch = this.correctionBatch(id)
    const edit = batch.candidate.memory
    if (!edit || batch.candidate.review !== 'approved') throw new DreamingConflict('Approve the exact memory correction before writing to OpenViking')
    if (edit.status === 'verified') return { uri: edit.uri, status: 'verified' }
    if (edit.errorCode === 'redirected_uri') throw new DreamingConflict('OpenViking reported a different write destination. Check the original URI before retrying')
    if (edit.status === 'conflict') throw new DreamingConflict('Reload the original memory and approve the correction again')
    if (this.memoryWrites.has(id) || this.activeMemoryUris.has(edit.uri) || this.mergeUses(edit.uri)) throw new DreamingConflict('This OpenViking writeback is already in progress')
    this.memoryWrites.add(id)
    this.activeMemoryUris.add(edit.uri)
    const save = (status: MemoryEdit['status'], error?: MemoryWriteError) => {
      const current = this.correctionBatch(id)
      const { error: _error, errorCode: _code, ...fields } = edit
      this.store.set(batches(id), { ...current, candidate: { ...current.candidate,
        memory: { ...fields, status, ...(error ? { error: error.message } : {}), ...(error?.code ? { errorCode: error.code } : {}) } } })
    }
    try {
      if (edit.errorCode !== 'recall_pending') save('writing')
      await memory.apply(edit)
      save('verified')
      return { uri: edit.uri, status: 'verified' }
    } catch (error) {
      const reason = error instanceof MemoryWriteError ? error : new MemoryWriteError('pending_verification', 'OpenViking writeback needs verification before retrying')
      save(reason.status, reason)
      throw reason
    } finally { this.memoryWrites.delete(id); this.activeMemoryUris.delete(edit.uri) }
  }

  publish(id: string): { version: number } {
    return this.store.atomic(() => {
      const batch = this.batch(id)
      if (batch.pack.target) throw new DreamingConflict('Apply the audit recommendation to its original memory')
      const uri = batch.pack.archiveUri
      const current = this.current(uri)
      if (batch.status === 'published') return { version: batch.baseVersion + 1 }
      if (batch.status !== 'ready' || batch.candidate.review !== 'approved') {
        throw new DreamingConflict('Approve the Dreaming candidate before publishing')
      }
      if (batch.baseVersion !== (current?.version ?? 0)) throw new DreamingConflict('The published Dreaming snapshot has changed')
      const version = batch.baseVersion + 1
      this.store.set(uri ? archiveSnapshots(key(uri), version) : snapshots(version), { version, experience: batch.candidate.after, batchId: id })
      this.store.set(uri ? archiveVersion(key(uri)) : currentVersion, version)
      this.store.set(batches(id), { ...batch, status: 'published' })
      return { version }
    })
  }
}
