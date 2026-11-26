import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { dingTalkPilotScope, type DingTalkIntakeResult, type DingTalkMessage } from '../sources/dingtalk.ts'
import type { DingTalkListener } from '../sources/dingtalk-listener.ts'
import type { CodexDesktop } from './codex-desktop.ts'
import type { CodexHistory } from './codex-history.ts'

const reference = z.string().regex(/^[\w:@.+/=-]{1,160}$/)
export const hiFoxScope = dingTalkPilotScope.extend({
  space: reference.default('80e9552a-5568-4e0b-9b08-4446c6156e77'), // Existing fshows (FSH) default.
})
export type HiFoxScope = z.infer<typeof hiFoxScope>
export interface HiFoxAgent {
  id: string
  name: string
  status: string
  description?: string
  jobTitle?: string
  skills?: string[]
}
export interface DingTalkContextOrigin {
  conversationId: string
  messageId: string
  quotedMessageId?: string
  at: string
}
export interface HiFoxWorkOrder {
  ticketId: string
  assignmentId: string
  taskUuid: string
  launchKey: string
  inputRevision: string
  initialClues: { triggerId: string; text: string; conversationId: string; messageId: string; at: string; quotedMessageId?: string }[]
  quotedClue?: { conversationId: string; messageId: string; text: string }
  routingNote?: string
}

export const taskReceipt = z.object({ space: reference, taskUuid: reference, marker: reference,
  taskUrl: z.url({ protocol: /^https$/, hostname: /^app\.hifox\.com$/ }).optional(),
})
export const commentReceipt = z.object({ taskUuid: reference, commentId: reference, marker: reference })
export const runReceipt = z.object({
  taskUuid: reference, conversationId: reference, runId: reference, agentId: reference.optional(), computerId: reference.optional(),
})
const workerReport = z.object({
  taskUuid: reference,
  launchKey: reference,
  inputRevision: reference,
  outcome: z.enum(['completed', 'blocked']),
  summary: z.string().trim().min(1).max(1000),
}).strict()
export const runObservation = runReceipt.extend({
  /** Proven by the canonical Conversation's first work order; never inferred from a comment's source Run. */
  launchKey: reference,
  launchRevision: reference,
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
  /** Confirmed by the remote execution trace. Omit when the connector cannot establish which inputs were read. */
  readInputIds: z.array(reference).max(1000).optional(),
  report: z.unknown().optional(),
})
export type TaskReceipt = z.infer<typeof taskReceipt>
export type CommentReceipt = z.infer<typeof commentReceipt>
export type RunReceipt = z.infer<typeof runReceipt>
export type RunObservation = z.infer<typeof runObservation>
export const parseWorkerReport = (value: unknown) => workerReport.safeParse(value).data

/**
 * All calls use the fixed pilot identity. The adapter authoritatively scopes Task and Conversation reads, verifies the
 * launch marker against the originating work order, and selects any report by exact Run ID. Partial paginated reads must
 * fail instead of claiming uniqueness. Task creation and plain comments must have auto-assignment and comment hooks off.
 * The adapter embeds the stable operation marker in the task description or comment so it can find a lost receipt.
 */
export interface HiFoxTaskStatus { name: string; category: string }
export type HiFoxTaskTarget = 'started' | 'completed' | 'canceled'
export const terminalTask = (status: HiFoxTaskStatus | undefined): boolean =>
  !!status && ['completed', 'canceled', 'cancelled', 'duplicate'].includes(status.category)

export interface HiFoxGateway {
  agents(signal: AbortSignal): Promise<HiFoxAgent[]>
  createTask(input: { space: string; marker: string; title: string; description: string }, signal: AbortSignal): Promise<TaskReceipt>
  findTasks(space: string, marker: string, signal: AbortSignal): Promise<TaskReceipt[]>
  taskStatus(taskUuid: string, signal: AbortSignal): Promise<HiFoxTaskStatus>
  taskContent?(taskUuid: string, signal: AbortSignal): Promise<string>
  setTaskStatus(taskUuid: string, target: HiFoxTaskTarget, signal: AbortSignal): Promise<HiFoxTaskStatus>
  comment(input: { taskUuid: string; marker: string; text: string }, signal: AbortSignal): Promise<CommentReceipt>
  findComments(taskUuid: string, marker: string, signal: AbortSignal): Promise<CommentReceipt[]>
  summon(input: { agent: string; work: HiFoxWorkOrder }, signal: AbortSignal): Promise<RunReceipt>
  /** Enumerates confirmed Task-owned Runs. If a candidate's activity is unknown the adapter must fail closed. */
  runs(taskUuid: string, signal: AbortSignal, agent?: string): Promise<RunObservation[]>
  run(receipt: RunReceipt, signal: AbortSignal): Promise<RunObservation | undefined>
  /** Read the latest Run of the bound conversation from its Task, which may have advanced directly in HiFox. */
  taskRun?(receipt: RunReceipt, signal: AbortSignal): Promise<RunObservation | undefined>
}

/** Trusted host wiring for an opt-in pilot or offline replay. */
export interface HiFoxPilot {
  scope: z.input<typeof hiFoxScope>
  gateway: HiFoxGateway
  codexDesktop?: CodexDesktop
  codexHistory?: CodexHistory
  /** Expose the pilot ingress at ding.sock in Runtime's private state directory. */
  dingTalkSocket?: boolean
  /** In the standard desktop deployment, listen explicitly through the DWS child process. */
  createDingTalkListener?(receive: (message: DingTalkMessage) => DingTalkIntakeResult): DingTalkListener
  readDingTalkContext?(origin: DingTalkContextOrigin, signal: AbortSignal): Promise<Record<string, unknown>>
  /** Only the standard adapter requires a locally attested source and terminal Outbox mark. */
  requireTerminalOrigin?: boolean
  /** The adapter implements idempotency by the Outbox message ID. */
  sendDingTalk(message: OutboundMessage): Promise<'sent' | 'gone'>
  /** Bound reconciliation after a missing or unconfirmed external receipt. */
  reconcileMs?: number
}
