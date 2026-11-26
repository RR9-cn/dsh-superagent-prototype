import { Later, PollAgain, type Effects } from '../app/effects.ts'
import type { Store } from '../app/store.ts'
import {
  key, latestAssignment, liveTicket, type Assignment, type Engine, type Policy, type Ticket, type TicketInput,
} from '../core/index.ts'
import { family, record } from '../kv.ts'
import { DINGTALK, dingTalkMeta, pilotTrigger } from '../sources/dingtalk.ts'
import { findCodexWork, type CodexProject } from './codex-desktop.ts'
import type { CodexDelivery } from './codex-history.ts'
import {
  commentReceipt, parseWorkerReport, runObservation, runReceipt, taskReceipt, terminalTask,
  type HiFoxPilot, type HiFoxScope, type HiFoxTaskStatus, type HiFoxTaskTarget, type HiFoxWorkOrder, type RunObservation, type RunReceipt,
} from './hifox-port.ts'

type TriggerInput = Extract<TicketInput, { kind: 'trigger' }>
type LaunchFact = Pick<HiFoxWorkOrder, 'assignmentId' | 'taskUuid' | 'launchKey' | 'inputRevision'> & { agentId?: string }
type OperationKey = { marker: string; since: number }
type Pending = OperationKey & (
  | { kind: 'task' }
  | { kind: 'comment'; taskUuid: string }
  | { kind: 'launch'; work: LaunchFact }
)
type Write = OperationKey & (
  | { kind: 'task'; title: string; description: string }
  | { kind: 'comment'; taskUuid: string; text: string }
  | { kind: 'launch'; work: HiFoxWorkOrder }
)
interface Attempt {
  work: LaunchFact
  receipt: RunReceipt
  confirmedAt: number
  terminal?: RunObservation
}
interface Verdict { code: string; summary: string }
interface Result { assignmentId: string; revision: string; verdict: Verdict; runId?: string; codexDelivery?: CodexDelivery }
interface Binding {
  scope: string
  taskUuid?: string
  taskUrl?: string
  taskStatus?: HiFoxTaskStatus
  taskTarget?: HiFoxTaskTarget
  pending?: Pending
  comments: Record<string, string>
  attempts: Record<string, Attempt>
  verified?: Result
  lastResult?: Result
  reportedFollowupRuns?: string[]
  codexContentCheck?: { revision: string; at: number }
  codexDeliveryCheck?: { revision: string; at: number }
  codex?: {
    project: CodexProject
    evidence?: string[]
    observed?: true
    threadId?: string
    revision?: string
    pending?: { title: string; revision: string }
  }
  issue?: string
}
interface Owner { ticketId: string; assignmentId: string }
const bindings = family<Binding>('hifox-binding:')
/** Panel-safe projection of persisted work, even when this installation no longer mounts the adapter. */
export function hiFoxTicket(store: Pick<Store, 'get'>, ticket: Ticket) {
  if (ticket.executionTarget !== 'hifox') return undefined
  const binding = store.get(bindings(ticket.id))
  const assignment = latestAssignment(ticket)
  const attempt = assignment && binding?.attempts[assignment.id]
  const taskUrl = binding?.taskUrl && taskReceipt.shape.taskUrl.safeParse(binding.taskUrl).data
  return {
    taskUuid: binding?.taskUuid ?? null,
    taskUrl: taskUrl || null,
    taskStatus: binding?.taskStatus ?? null,
    runId: assignment && binding?.lastResult?.assignmentId === assignment.id
      ? binding.lastResult.runId ?? attempt?.receipt.runId ?? null : attempt?.receipt.runId ?? null,
    conversationId: attempt?.receipt.conversationId ?? null,
    ...(binding?.codex ? { codexProject: binding.codex.project.name, codexThreadId: binding.codex.threadId ?? null } : {}),
    agentId: ticket.hiFoxAgent?.agentId ?? attempt?.receipt.agentId ?? null,
    ...(ticket.hiFoxAgent?.agentName ? { agentName: ticket.hiFoxAgent.agentName } : {}),
  }
}
const activeRun = record<Owner>('hifox-active-run')
const taskFollowupInterval = 30_000
const codexContentCheckInterval = 5 * 60_000
const stopped = (run: RunObservation): boolean => !['running', 'queued'].includes(run.status)
const sameRun = (a: RunReceipt, b: RunReceipt): boolean =>
  a.taskUuid === b.taskUuid && a.conversationId === b.conversationId && a.runId === b.runId
  && (!b.agentId || a.agentId === b.agentId) && (!b.computerId || a.computerId === b.computerId)

interface Host {
  store: Store
  effects: Effects
  engine: Pick<Engine, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'report' | 'reply' | 'stopTicket'>
  pilot: HiFoxPilot & { scope: HiFoxScope }
  policy(): Policy
  paused(): boolean
  lifetime: AbortSignal
  now?(): number
}
interface Inputs {
  revision: string
  triggerInputs: { input: TriggerInput; text: string }[]
  initialClues: HiFoxWorkOrder['initialClues']
  quotedClue?: HiFoxWorkOrder['quotedClue']
}
/**
 * Serializes the pilot's external writes through one durable effect per ticket. A persisted intent can only be
 * resolved by an exact receipt or reconciliation. The active-run reservation outlives the originating Assignment.
 */
export class HiFoxExecutor {
  private readonly now: () => number
  private readonly reconcileMs: number
  constructor(private readonly host: Host) {
    this.now = host.now ?? Date.now
    this.reconcileMs = host.pilot.reconcileMs ?? 120_000
    host.effects.handle('hifox', ({ ticketId }) => this.step(ticketId), { limit: () => host.paused() ? 0 : 1 })
  }
  queue(ticketId: string): void { this.host.effects.enqueue('hifox', ticketId, { ticketId }) }
  /** Exposes reconciled identities and a manual handoff reason for the pilot operator. */
  status(ticketId: string): Readonly<Binding> | undefined { return this.host.store.get(bindings(ticketId)) }
  /** Restores domain work still awaiting an effect without resetting a queued effect's backoff. */
  resume(): void {
    const { store, effects, pilot } = this.host
    const owner = store.get(activeRun)
    const waiting = new Set(store.tickets.active().filter(ticket => {
      if (ticket.executionTarget !== 'hifox' || !liveTicket(ticket)) return false
      const assignment = latestAssignment(ticket)
      if (assignment?.report?.state !== 'blocked') return true
      const binding = store.get(bindings(ticket.id))
      return !!binding?.codex || (!!(pilot.codexDesktop || pilot.codexHistory) && !!binding?.taskUuid)
        || (!!pilot.gateway.taskRun && !!binding?.attempts[assignment.id] && binding.lastResult?.assignmentId === assignment.id)
    }).map(ticket => ticket.id))
    if (owner) waiting.add(owner.ticketId)
    for (const ticketId of waiting) if (!effects.pending('hifox', ticketId)) this.queue(ticketId)
  }
  private save(ticketId: string, binding: Binding): void { this.host.store.set(bindings(ticketId), binding) }
  private signal(): AbortSignal { return AbortSignal.any([this.host.lifetime, AbortSignal.timeout(15_000)]) }
  private current(ticketId: string, assignmentId?: string): { ticket: Ticket; assignment: Assignment } | undefined {
    const ticket = this.host.store.tickets.get(ticketId)
    const assignment = ticket && latestAssignment(ticket)
    return ticket?.executionTarget === 'hifox' && liveTicket(ticket) && assignment && assignment.state !== 'ended'
      && (assignmentId === undefined || assignment.id === assignmentId) ? { ticket, assignment } : undefined
  }
  private inputs(ticket: Ticket): Inputs | undefined {
    const { store, pilot, policy } = this.host
    if (ticket.mandate.actor.source !== DINGTALK || !policy().revalidate(ticket.mandate)) return undefined
    const origin = store.triggers.get(ticket.origin.triggerId)
    const initial = origin && pilotTrigger(origin, pilot.scope)
    if (!initial) return undefined
    const triggerInputs: Inputs['triggerInputs'] = []
    const initialClues: Inputs['initialClues'] = []
    const seen = new Set<string>()
    const inputById = new Map(ticket.inputs.flatMap(input =>
      input.kind === 'trigger' && !input.context ? [[input.triggerId, input]] as const : []))
    for (const id of new Set([...ticket.origin.triggerIds, ...inputById.keys()])) {
      const trigger = store.triggers.get(id)
      const meta = trigger && pilotTrigger(trigger, pilot.scope)
      if (!trigger || !meta || meta.conversationId !== initial.conversationId || meta.threadRootId !== initial.threadRootId) return undefined
      seen.add(id)
      const input = inputById.get(id)
      if (input) triggerInputs.push({ input, text: trigger.text })
      initialClues.push({ triggerId: id, text: trigger.text, conversationId: meta.conversationId, messageId: meta.messageId, at: trigger.at,
        ...(meta.quotedMessageId ? { quotedMessageId: meta.quotedMessageId } : {}) })
    }
    if (!seen.size) return undefined
    const quote = ticket.hiFoxQuote
    const quotedClue = quote && quote.messageId === initial.quotedMessageId
      ? { ...quote, conversationId: initial.conversationId } : undefined
    return { triggerInputs, initialClues, ...(quotedClue ? { quotedClue } : {}),
      revision: key('hifox-input', ...seen, ...(quotedClue ? [quotedClue.messageId, quotedClue.text] : []),
        ...(ticket.hiFoxRoutingNote ? [ticket.hiFoxRoutingNote] : [])) }
  }
  private authorized(ticketId: string, assignmentId: string, revision: string): boolean {
    if (this.host.paused() || this.host.lifetime.aborted) throw new Later('HiFox is paused')
    const current = this.current(ticketId, assignmentId)
    return !!current && this.inputs(current.ticket)?.revision === revision
  }
  private block(ticketId: string, binding: Binding, summary: string): void {
    this.host.store.atomic(() => {
      binding.issue = summary
      this.save(ticketId, binding)
      const current = this.current(ticketId)
      if (current && latestAssignment(current.ticket)?.report?.summary !== summary) {
        this.host.engine.report(ticketId, { state: 'blocked', summary })
      }
    })
  }
  /** Applies a receipt only if it is scoped to the exact operation. */
  private accept(ticketId: string, binding: Binding, pending: Pending, receipt: unknown): boolean {
    const { space } = this.host.pilot.scope
    if (pending.kind === 'task') {
      const task = taskReceipt.safeParse(receipt).data
      if (!task || task.space !== space || task.marker !== pending.marker) return false
      binding.taskUuid = task.taskUuid
      if (task.taskUrl) binding.taskUrl = task.taskUrl
    } else if (pending.kind === 'comment') {
      const comment = commentReceipt.safeParse(receipt).data
      if (!comment || comment.taskUuid !== pending.taskUuid || comment.marker !== pending.marker) return false
      binding.comments[pending.marker] = comment.commentId
    } else {
      const run = runReceipt.safeParse(receipt).data
      if (!run || run.taskUuid !== pending.work.taskUuid || (pending.work.agentId && run.agentId !== pending.work.agentId)) return false
      binding.attempts[pending.work.assignmentId] = { work: pending.work, receipt: run, confirmedAt: this.now() }
    }
    delete binding.pending
    delete binding.issue
    this.save(ticketId, binding)
    return true
  }
  private async write(ticket: Ticket, assignment: Assignment, binding: Binding, inputs: Inputs, op: Write): Promise<void> {
    const { store, pilot } = this.host
    if (!this.authorized(ticket.id, assignment.id, inputs.revision)) throw new Later('The current HiFox work changed')
    const { marker, since } = op
    const pending = store.atomic((): Pending => {
      let intent: Pending
      if (op.kind === 'launch') {
        if (store.get(activeRun)) throw new Later('The HiFox pilot run slot is occupied')
        store.set(activeRun, { ticketId: ticket.id, assignmentId: assignment.id })
        const { assignmentId, taskUuid, launchKey, inputRevision } = op.work
        intent = { kind: op.kind, marker, since, work: { assignmentId, taskUuid, launchKey, inputRevision, agentId: ticket.hiFoxAgent!.agentId } }
      } else {
        intent = op.kind === 'comment' ? { kind: op.kind, marker, since, taskUuid: op.taskUuid } : { kind: op.kind, marker, since }
      }
      binding.pending = intent
      this.save(ticket.id, binding)
      return intent
    })
    const signal = this.signal()
    let receipt: unknown
    try {
      receipt = op.kind === 'task'
        ? await pilot.gateway.createTask({ space: pilot.scope.space, marker: op.marker, title: op.title, description: op.description }, signal)
        : op.kind === 'comment' ? await pilot.gateway.comment({ taskUuid: op.taskUuid, marker, text: op.text }, signal)
          : await pilot.gateway.summon({ agent: ticket.hiFoxAgent!.agentId, work: op.work }, signal)
    } catch {
      throw new Later('The HiFox write receipt needs reconciliation')
    }
    if (!this.accept(ticket.id, binding, pending, receipt)) throw new Later('The HiFox write receipt could not be verified')
  }
  private async reconcile(ticketId: string, binding: Binding, op: Pending): Promise<boolean> {
    const { scope: { space }, gateway } = this.host.pilot
    const signal = this.signal()
    let found: unknown[] = []
    try {
      switch (op.kind) {
        case 'task':
          found = (await gateway.findTasks(space, op.marker, signal)).filter(item => item.space === space && item.marker === op.marker)
          break
        case 'comment':
          found = (await gateway.findComments(op.taskUuid, op.marker, signal)).filter(item => item.taskUuid === op.taskUuid && item.marker === op.marker)
          break
        case 'launch':
          found = (await gateway.runs(op.work.taskUuid, signal, op.work.agentId)).map(item => runObservation.safeParse(item).data)
            .filter(item => item?.taskUuid === op.work.taskUuid && (!op.work.agentId || item.agentId === op.work.agentId) && item.launchKey === op.work.launchKey && item.launchRevision === op.work.inputRevision)
          break
      }
    } catch { /* An unavailable read never clears a pending write. */ }
    if (found.length === 1 && this.accept(ticketId, binding, op, found[0])) return true
    if (this.now() - op.since < this.reconcileMs) throw new Later('The HiFox write receipt needs reconciliation')
    this.block(ticketId, binding, `请人工核对 HiFox 操作 ${op.marker} 的回执。`)
    return false
  }
  private async observe(ticketId: string, binding: Binding, attempt: Attempt): Promise<RunObservation | undefined> {
    if (attempt.terminal) return attempt.terminal
    let run: RunObservation | undefined
    try { run = runObservation.safeParse(await this.host.pilot.gateway.run(attempt.receipt, this.signal())).data }
    catch { /* Keep the durable reservation through an unavailable read. */ }
    if (!run || !sameRun(run, attempt.receipt) || run.launchKey !== attempt.work.launchKey || run.launchRevision !== attempt.work.inputRevision) {
      if (this.now() - attempt.confirmedAt < this.reconcileMs) throw new Later('The HiFox Run needs reconciliation')
      this.block(ticketId, binding, `请人工核对 HiFox Run ${attempt.receipt.runId} 的归属和状态。`)
      return undefined
    }
    if (stopped(run)) this.host.store.atomic(() => {
      const report = parseWorkerReport(run.report)
      attempt.terminal = { ...run, report }
      this.save(ticketId, binding)
      const owner = this.host.store.get(activeRun)
      if (owner?.ticketId === ticketId && owner.assignmentId === attempt.work.assignmentId) this.host.store.delete(activeRun)
    })
    return run
  }
  private async deliver(ticket: Ticket, assignment: Assignment, binding: Binding, inputs: Inputs): Promise<void> {
    const { engine, store } = this.host
    for (const { input, text } of inputs.triggerInputs) {
      if (!this.authorized(ticket.id, assignment.id, inputs.revision)) throw new Later('The current HiFox inputs changed')
      const marker = key('hifox-input', ticket.id, input.id)
      if (!binding.comments[marker]) {
        await this.write(ticket, assignment, binding, inputs, { kind: 'comment', taskUuid: binding.taskUuid!,
          marker, since: this.now(), text: JSON.stringify({ inputId: input.id, inputRevision: inputs.revision, clue: text }) })
      }
    }
    store.atomic(() => {
      if (!this.authorized(ticket.id, assignment.id, inputs.revision)) throw new Later('The current HiFox inputs changed')
      const current = this.current(ticket.id, assignment.id)!
      if (current.assignment.state !== 'running') return
      const waiting = new Set(current.ticket.undelivered)
      const delivered = inputs.triggerInputs.filter(({ input }) => waiting.has(input.id))
      if (delivered.length) engine.inputsDelivered(ticket.id, assignment.id, delivered.map(({ input }) => input.id))
      for (const { input } of delivered) {
        engine.reply({ purpose: 'acknowledgement', ticketId: ticket.id, triggerId: input.triggerId,
          text: `补充线索已记录到原 HiFox 卡 ${binding.taskUuid}。` })
      }
    })
  }
  private verdict(run: RunObservation, attempt: Attempt, inputs: Inputs): Verdict {
    const report = parseWorkerReport(run.report)
    if (run.status !== 'completed') return { code: 'run_ended', summary: 'HiFox 执行提前终止，请在原卡核对后重试。' }
    if (!report) return { code: 'missing_report', summary: '该轮 HiFox Run 没有可验证的结构化回执。' }
    if (report.taskUuid !== attempt.work.taskUuid || report.launchKey !== attempt.work.launchKey || report.inputRevision !== inputs.revision) {
      return { code: 'stale_report', summary: 'HiFox 回执与当前输入版本或派工记录不一致。' }
    }
    return { code: report.outcome === 'completed' ? 'ready' : 'agent_blocked', summary: report.summary }
  }
  private async finish(ticket: Ticket, assignment: Assignment, binding: Binding, inputs: Inputs, result: Result): Promise<boolean> {
    const { engine, store } = this.host
    if (await this.syncTask(ticket.id, binding)) return false
    const { verdict } = result
    const marker = key('hifox-result', ticket.id, inputs.revision, verdict.code, verdict.summary)
    if (!this.authorized(ticket.id, assignment.id, inputs.revision)) throw new Later('The current HiFox work changed during verification')
    binding.verified = result
    this.save(ticket.id, binding)
    if (!binding.comments[marker]) {
      await this.write(ticket, assignment, binding, inputs, { kind: 'comment', marker, since: this.now(), taskUuid: binding.taskUuid!,
        text: `输入版本 ${inputs.revision}\n${verdict.summary}` })
    }
    store.atomic(() => {
      if (!this.authorized(ticket.id, assignment.id, inputs.revision)) throw new Later('The current HiFox work changed during writeback')
      binding.lastResult = result
      const launchedRun = binding.attempts[assignment.id]?.receipt.runId
      if (result.runId && result.runId !== launchedRun) {
        binding.reportedFollowupRuns = [...binding.reportedFollowupRuns ?? [], result.runId]
      }
      this.save(ticket.id, binding)
      if (verdict.code === 'ready') {
        engine.report(ticket.id, { state: 'ready', summary: verdict.summary })
        if (store.tickets.get(ticket.id)?.ended?.outcome === 'completed') {
          binding.taskTarget = 'completed'
          this.save(ticket.id, binding)
          this.queue(ticket.id)
        }
        if (!result.codexDelivery) engine.reply({ purpose: 'result', ticketId: ticket.id, hiFoxTerminal: true,
          text: `${verdict.summary} HiFox 卡 ${binding.taskUuid}，输入版本 ${inputs.revision}。` })
      } else {
        engine.report(ticket.id, { state: 'blocked', summary: verdict.summary, question: verdict.summary })
        engine.reply({ purpose: 'attention', ticketId: ticket.id, question: verdict.summary, text: verdict.summary,
          ...(verdict.code === 'agent_blocked' ? { hiFoxTerminal: true } : {}) })
      }
    })
    return true
  }
  private async followTask(ticket: Ticket, assignment: Assignment, binding: Binding, inputs: Inputs): Promise<void> {
    const { gateway } = this.host.pilot
    const attempt = binding.attempts[assignment.id]
    if (!gateway.taskRun || !attempt || binding.lastResult?.verdict.code === 'ready') return
    const run = runObservation.safeParse(await gateway.taskRun(attempt.receipt, this.signal())).data
    if (!this.authorized(ticket.id, assignment.id, inputs.revision)) throw new Later('The current HiFox work changed during Task follow-up')
    if (run && run.runId !== attempt.receipt.runId && !binding.reportedFollowupRuns?.includes(run.runId)
      && sameRun(run, { ...attempt.receipt, runId: run.runId })
      && run.launchKey === attempt.work.launchKey && run.launchRevision === attempt.work.inputRevision
      && run.status === 'completed') {
      const verdict = this.verdict(run, attempt, inputs)
      if (verdict.code === 'ready' || verdict.code === 'agent_blocked') {
        const reported = await this.finish(ticket, assignment, binding, inputs, {
          assignmentId: assignment.id, revision: inputs.revision, runId: run.runId, verdict,
        })
        if (!reported || verdict.code === 'ready') return
      }
    }
    throw new PollAgain('Waiting for a newer result on the HiFox Task', taskFollowupInterval)
  }
  private async advanceCodex(ticket: Ticket, assignment: Assignment, binding: Binding, inputs: Inputs): Promise<void> {
    const { engine, pilot } = this.host
    const desktop = pilot.codexDesktop
    if (!desktop) throw new Later('The Codex Desktop connection is unavailable')
    const codex = binding.codex!
    const verify = () => {
      if (!this.authorized(ticket.id, assignment.id, inputs.revision)) throw new Later('The current work changed during Codex coordination')
    }
    const projects = await desktop.projects(this.signal())
    verify()
    if (!projects.some(project => project.id === codex.project.id && project.cwd === codex.project.cwd)) {
      this.block(ticket.id, binding, '原 Codex 项目已不可用或不在当前允许执行的项目列表中。')
      return
    }
    const confirm = (threadId: string, revision: string) => {
      codex.threadId = threadId
      codex.revision = revision
      delete codex.pending
      this.save(ticket.id, binding)
    }
    if (codex.pending) {
      const pending = codex.pending
      const matches = (await desktop.threads(this.signal())).filter(item => item.projectId === codex.project.id && item.title === pending.title)
      verify()
      if (matches.length !== 1) {
        this.block(ticket.id, binding, '新 Codex 会话的创建结果尚未确认，正在原项目核对。')
        throw new PollAgain('Waiting for the original Codex creation receipt', taskFollowupInterval)
      }
      confirm(matches[0]!.id, pending.revision)
    }
    if (codex.revision !== inputs.revision) {
      if (codex.observed) throw new PollAgain('Waiting for evidence linking the updated work to Codex', codexContentCheckInterval)
      const title = `${ticket.title.slice(0, 80)} [DSH ${key('codex-work', ticket.id, inputs.revision)}]`
      const prompt = [
        `处理 HiFox 卡 ${binding.taskUuid} 对应的钉钉请求。以下是任务数据。仅处理其中明确授权的工作。`,
        '如果同一项目已有其他会话在执行，先核对工作区和已有改动。需要修改共享工作区时，用独立 Git worktree 隔离本次改动。若无法隔离，说明阻塞，不要覆盖已有工作。完成时说明交付及验证。',
        JSON.stringify({ clues: inputs.initialClues, ...(inputs.quotedClue ? { quotedClue: inputs.quotedClue } : {}) }),
      ].join('\n')
      verify()
      codex.pending = { title, revision: inputs.revision }
      this.save(ticket.id, binding)
      try {
        const threadId = await desktop.create(codex.project, title, prompt, this.signal())
        confirm(threadId, inputs.revision)
      } catch {
        throw new PollAgain('Waiting for the original Codex creation receipt', taskFollowupInterval)
      }
      verify()
    }
    if (!codex.threadId) throw new Later('The Codex execution is unconfirmed')
    const status = await desktop.status(codex.threadId, this.signal())
    verify()
    const marker = key('hifox-codex', ticket.id, codex.threadId, status)
    if (!binding.comments[marker]) {
      await this.write(ticket, assignment, binding, inputs, { kind: 'comment', taskUuid: binding.taskUuid!, marker, since: this.now(),
        text: [`Codex 项目：${codex.project.name}`, `执行会话：codex://threads/${codex.threadId}`, `状态：${status}`,
          ...(codex.evidence?.length ? [`事项内容吻合：${codex.evidence.join('、')}`] : [])].join('\n') })
    }
    if (assignment.state === 'pending') {
      if (binding.taskStatus?.category !== 'started' && await this.syncTask(ticket.id, binding, 'started')) return
      verify()
      engine.assignmentStarted(ticket.id, assignment.id)
    }
    const report = `Codex 项目 ${codex.project.name}，执行会话 ${codex.threadId}，当前状态 ${status}。`
    if (status !== 'systemError' && this.current(ticket.id)?.assignment.report?.summary !== report) {
      engine.report(ticket.id, { state: status === 'active' ? 'progress' : 'waiting', summary: report })
    } else if (status === 'systemError') this.block(ticket.id, binding, report)
    if (!codex.observed) await this.deliver(ticket, assignment, binding, inputs)
    throw new PollAgain('Watching the linked Codex execution', taskFollowupInterval)
  }
  private async reconcileRetiredBinding(ticketId: string, binding: Binding): Promise<void> {
    const { store, pilot } = this.host
    const owner = store.get(activeRun)
    const ticket = store.tickets.get(ticketId)
    const migrated = ticket?.executionTarget === 'hifox' && !ticket.hiFoxAgent
    if (migrated && owner?.ticketId === ticketId) {
      // Older work remains visible. Only release its slot after a read-only lookup proves the exact Run ended.
      const attempt = binding.attempts[owner.assignmentId]
      const pending = binding.pending?.kind === 'launch' ? binding.pending.work : undefined
      const fact = attempt?.work ?? pending
      if (fact?.assignmentId === owner.assignmentId) {
        try {
          const observed = attempt
            ? [await pilot.gateway.run(attempt.receipt, this.signal())]
            : await pilot.gateway.runs(fact.taskUuid, this.signal())
          const matches = observed.flatMap(value => {
            const run = runObservation.safeParse(value).data
            return run && run.taskUuid === fact.taskUuid && run.launchKey === fact.launchKey
              && run.launchRevision === fact.inputRevision && (!attempt || sameRun(run, attempt.receipt)) ? [run] : []
          })
          if (matches.length === 1 && stopped(matches[0]!)) store.delete(activeRun)
        } catch { /* A failed read does not free an old in-flight slot. */ }
      }
      if (store.get(activeRun)?.ticketId === ticketId) {
        this.block(ticketId, binding, '旧版 HiFox 派工还未核实终止，需先核对原卡和执行记录。')
        throw new Later('A prior HiFox Run is still unverified')
      }
    }
    this.block(ticketId, binding, '该工单使用旧版或不同的 HiFox 路由，已保留原记录。')
  }
  private async selectedAgentAvailable(ticketId: string, binding: Binding, agentId: string): Promise<boolean> {
    const eligible = await this.host.pilot.gateway.agents(this.signal())
    if (eligible.some(agent => agent.id === agentId)) return true
    this.block(ticketId, binding, '原选定的 HiFox Agent 当前不在可用名单中，需要人工核对。')
    return false
  }
  /** Persist the verified card status. A terminal card relinquishes local follow-up, even if its Run reported blocked. */
  private async syncTask(ticketId: string, binding: Binding, target?: HiFoxTaskTarget): Promise<boolean> {
    if (!binding.taskUuid) return false
    const { gateway } = this.host.pilot
    const status = terminalTask(binding.taskStatus) ? binding.taskStatus!
      : target ? await gateway.setTaskStatus(binding.taskUuid, target, this.signal())
        : await gateway.taskStatus(binding.taskUuid, this.signal())
    const closed = terminalTask(status)
    this.host.store.atomic(() => {
      if (binding.taskStatus?.name !== status.name || binding.taskStatus?.category !== status.category || binding.taskTarget) {
        binding.taskStatus = status
        delete binding.taskTarget
        this.save(ticketId, binding)
      }
      if (closed && this.current(ticketId)) this.host.engine.stopTicket(ticketId, `HiFox 卡片状态为「${status.name}」，已结束跟进。`)
    })
    return closed
  }
  private async step(ticketId: string): Promise<void> {
    const { store, pilot, engine } = this.host
    const ticketRecord = store.tickets.get(ticketId)
    const selected = ticketRecord?.hiFoxAgent
    const origin = ticketRecord && store.triggers.get(ticketRecord.origin.triggerId)
    const conversationId = origin && dingTalkMeta(origin.meta)?.conversationId
    const scopeKey = selected && conversationId && selected.space === pilot.scope.space
      && (!pilot.scope.conversationId || conversationId === pilot.scope.conversationId)
      ? key('hifox-agent-v3', conversationId, selected.space, selected.agentId) : undefined
    const binding: Binding = store.get(bindings(ticketId)) ?? { scope: scopeKey ?? 'unassigned', comments: {}, attempts: {} }
    if (!scopeKey || !selected || binding.scope !== scopeKey) { await this.reconcileRetiredBinding(ticketId, binding); return }
    if (binding.pending && !await this.reconcile(ticketId, binding, binding.pending)) return
    if (binding.taskUuid && (ticketRecord?.ended?.outcome === 'stopped' || binding.taskTarget || this.current(ticketId))) {
      const target = binding.taskTarget ?? (ticketRecord?.ended?.outcome === 'stopped' ? 'canceled' : undefined)
      await this.syncTask(ticketId, binding, target)
    }
    const active = this.current(ticketId)
    const inputs = active && this.inputs(active.ticket)
    const owner = store.get(activeRun)
    if (owner?.ticketId === ticketId && (!inputs || active?.assignment.id !== owner.assignmentId)) {
      const attempt = binding.attempts[owner.assignmentId]
      if (!attempt) { this.block(ticketId, binding, '请人工核对未完成的 HiFox 派工。'); return }
      binding.issue = `请在 HiFox 确认停止 Run ${attempt.receipt.runId}。`
      this.save(ticketId, binding)
      const run = await this.observe(ticketId, binding, attempt)
      if (!run) return
      if (!stopped(run)) throw new PollAgain('A prior HiFox Run may require manual cancellation')
      delete binding.issue
      this.save(ticketId, binding)
    }
    if (!active) return
    const { ticket, assignment } = active
    if (!inputs) { this.block(ticketId, binding, '请核对钉钉原消息、会话及工单授权状态。'); return }
    const attemptForAssignment = binding.attempts[assignment.id]
    const historyCheck = binding.codexDeliveryCheck
    if (pilot.codexHistory && binding.taskUuid && ticket.mandate.strength === 'explicit'
      && (!attemptForAssignment || attemptForAssignment.terminal || binding.lastResult?.assignmentId === assignment.id)
      && (historyCheck?.revision !== inputs.revision || this.now() - historyCheck.at >= codexContentCheckInterval)) {
      const requestedAt = inputs.initialClues.map(clue => clue.at).sort().at(-1)!
      const cardContent = await pilot.gateway.taskContent?.(binding.taskUuid, this.signal())
      const cardTitle = cardContent === undefined ? ticket.title : cardContent.split('\n', 1)[0]?.trim()
      const verified = binding.verified?.assignmentId === assignment.id && binding.verified.revision === inputs.revision
        ? binding.verified.codexDelivery : undefined
      const delivery = cardTitle === ticket.title.trim()
        ? verified ?? await pilot.codexHistory.delivery({ title: cardTitle, requestedAt }, this.signal()) : undefined
      if (!this.authorized(ticketId, assignment.id, inputs.revision)) throw new Later('The work changed while reading local Codex evidence')
      if (delivery) {
        await this.finish(ticket, assignment, binding, inputs, { assignmentId: assignment.id, revision: inputs.revision,
          verdict: { code: 'ready', summary: delivery.summary }, codexDelivery: delivery })
        return
      }
      binding.codexDeliveryCheck = { revision: inputs.revision, at: this.now() }
      this.save(ticketId, binding)
    }
    const desktop = pilot.codexDesktop
    const contentCheck = binding.codexContentCheck
    const existingWork = assignment.report?.state === 'blocked' || assignment.report?.state === 'failed'
      || !!binding.lastResult || Object.keys(binding.attempts).length > 0
    if (desktop && ticket.mandate.strength === 'explicit' && (!binding.codex || binding.codex.observed)
      && (contentCheck?.revision !== inputs.revision || this.now() - contentCheck.at >= codexContentCheckInterval)
      && (!attemptForAssignment || attemptForAssignment.terminal)) {
      const clues = [...inputs.initialClues.map(clue => clue.text), inputs.quotedClue?.text ?? ''].join('\n')
      const [projects, threads, cardContent] = await Promise.all([desktop.projects(this.signal()), desktop.threads(this.signal()),
        binding.taskUuid && pilot.gateway.taskContent?.(binding.taskUuid, this.signal()) || ''])
      if (!this.authorized(ticketId, assignment.id, inputs.revision)) throw new Later('The current work changed during Codex discovery')
      const match = await findCodexWork(desktop, clues, projects, threads, `${ticket.title}\n${cardContent}`, this.signal())
      if (!this.authorized(ticketId, assignment.id, inputs.revision)) throw new Later('The current work changed during Codex discovery')
      binding.codexContentCheck = { revision: inputs.revision, at: this.now() }
      if (match && 'ambiguous' in match) {
        if (!existingWork) {
          this.block(ticketId, binding, '找到多个可能的 Codex 项目或会话。请补充可区分的项目名、任务链接或 PR。')
          return
        }
      } else if (match && (!(existingWork || binding.codex?.observed) || match.thread)) {
        const evidence = 'evidence' in match ? match.evidence : undefined
        const contentObservation = existingWork || !!evidence || !!binding.codex?.observed
        const observeExisting = contentObservation
          || (match.thread?.status === 'idle' && await desktop.status(match.thread.id, this.signal()) === 'idle')
        if (!this.authorized(ticketId, assignment.id, inputs.revision)) throw new Later('The current work changed during Codex discovery')
        binding.codex = { project: match.project, ...(evidence ? { evidence } : {}),
          ...(contentObservation ? { observed: true } : {}),
          ...(observeExisting && match.thread ? { threadId: match.thread.id, revision: inputs.revision } : {}) }
      }
      this.save(ticketId, binding)
    }
    if (!binding.codex && binding.lastResult?.assignmentId === assignment.id && binding.lastResult.revision === inputs.revision) {
      await this.followTask(ticket, assignment, binding, inputs)
      return
    }
    if (!binding.codex && (desktop || pilot.codexHistory) && assignment.report?.state === 'blocked' && !attemptForAssignment && binding.taskUuid) {
      throw new PollAgain('Waiting for new evidence of a matching Codex session', codexContentCheckInterval)
    }
    if (!binding.taskUuid) {
      if (!binding.codex && !await this.selectedAgentAvailable(ticketId, binding, selected.agentId)) return
      const marker = key('hifox-task', ticketId)
      await this.write(ticket, assignment, binding, inputs, { kind: 'task', marker, since: this.now(),
        title: ticket.title, description: JSON.stringify({ ticketId, origin: inputs.initialClues[0]?.messageId }) })
      if (await this.syncTask(ticketId, binding)) return
    }
    if (binding.codex) {
      await this.advanceCodex(ticket, assignment, binding, inputs)
      return
    }
    await this.deliver(ticket, assignment, binding, inputs)
    let attempt = binding.attempts[assignment.id]
    if (!attempt) {
      if (store.get(activeRun)) throw new Later('The HiFox pilot run slot is occupied')
      if (!await this.selectedAgentAvailable(ticketId, binding, selected.agentId)) return
      const existing = await pilot.gateway.runs(binding.taskUuid!, this.signal(), selected.agentId)
      if (!this.authorized(ticketId, assignment.id, inputs.revision)) throw new Later('The current HiFox work changed before dispatch')
      if (existing.some(item => {
        const run = runObservation.safeParse(item).data
        return !run || run.taskUuid !== binding.taskUuid || !stopped(run)
      })) {
        this.block(ticketId, binding, '请人工核对原卡已有 HiFox 执行的归属和状态。')
        return
      }
      const launchKey = key('hifox-launch', assignment.id)
      const work = { ticketId, assignmentId: assignment.id, taskUuid: binding.taskUuid!,
        launchKey, inputRevision: inputs.revision, initialClues: inputs.initialClues,
        ...(inputs.quotedClue ? { quotedClue: inputs.quotedClue } : {}),
        ...(ticket.hiFoxRoutingNote ? { routingNote: ticket.hiFoxRoutingNote } : {}) }
      await this.write(ticket, assignment, binding, inputs, { kind: 'launch', marker: launchKey, since: this.now(), work })
      attempt = binding.attempts[assignment.id]!
    }
    if (!this.authorized(ticketId, assignment.id, inputs.revision)) throw new Later('The current HiFox work changed after dispatch')
    if (assignment.state === 'pending') {
      if (binding.taskStatus?.category !== 'started' && await this.syncTask(ticketId, binding, 'started')) return
      if (!this.authorized(ticketId, assignment.id, inputs.revision)) throw new Later('The current HiFox work changed during status update')
      engine.assignmentStarted(ticketId, assignment.id)
      await this.deliver(ticket, assignment, binding, inputs)
    }
    const run = await this.observe(ticketId, binding, attempt)
    if (!run) return
    if (!this.authorized(ticketId, assignment.id, inputs.revision)) throw new Later('The current HiFox work changed during polling')
    const confirmedReads = new Set(run.readInputIds)
    const read = inputs.triggerInputs.filter(({ input }) => confirmedReads.has(input.id)).map(({ input }) => input.id)
    if (read.length) engine.inputsRead(ticketId, read)
    if (!stopped(run)) throw new PollAgain('The HiFox Run is still active')
    const result = binding.verified?.assignmentId === assignment.id && binding.verified.revision === inputs.revision
      ? binding.verified
      : { assignmentId: assignment.id, revision: inputs.revision, runId: run.runId, verdict: this.verdict(run, attempt, inputs) }
    const reported = await this.finish(ticket, assignment, binding, inputs, result)
    if (reported && pilot.gateway.taskRun && result.verdict.code !== 'ready') {
      throw new PollAgain('Waiting for a newer result on the HiFox Task', taskFollowupInterval)
    }
  }
}
