/** Normalizes messages from the authenticated DingTalk pilot transport or its local replay. */
import { z } from 'zod'
import { key, type OutboundMessage, type ReceiveResult, type Trigger } from '../core/index.ts'
import type { SourceKind } from './kind.ts'

export const DINGTALK = 'dingtalk'
const nativeId = z.string().regex(/^[\w:@.+=/-]{1,160}$/)
const time = z.iso.datetime({ offset: true })
export const dingTalkPilotScope = z.object({ conversationId: nativeId.optional() })
export type DingTalkPilotScope = z.infer<typeof dingTalkPilotScope>

const messageSchema = z.object({
  conversationId: nativeId,
  messageId: nativeId,
  senderId: nativeId,
  human: z.literal(true),
  at: time,
  addressed: z.enum(['mention', 'direct']).optional(),
  text: z.string().trim().min(1).max(4000),
  replyToMessageId: nativeId.optional(),
})
export type DingTalkMessage = z.infer<typeof messageSchema>

const metaSchema = z.object({
  conversationId: nativeId,
  senderId: nativeId,
  messageId: nativeId,
  replyToMessageId: nativeId.optional(),
  threadRootId: nativeId,
  quotedMessageId: nativeId.optional(),
})
export type DingTalkMeta = z.infer<typeof metaSchema>

const messageKey = (conversation: string, message: string) => key(DINGTALK, conversation, message)
const issueKey = (meta: DingTalkMeta) => key(DINGTALK, 'conversation-thread-v2', meta.conversationId, meta.threadRootId)
function sameScope(pilot: DingTalkPilotScope, conversationId: string): boolean {
  return !pilot.conversationId || pilot.conversationId === conversationId
}

export function dingTalkMeta(meta: unknown): DingTalkMeta | undefined { return metaSchema.safeParse(meta).data }
export function pilotTrigger(trigger: Trigger, pilot: DingTalkPilotScope): DingTalkMeta | undefined {
  const meta = dingTalkMeta(trigger.meta)
  const channel = trigger.channel
  if (!meta || trigger.source !== DINGTALK || trigger.actor.source !== DINGTALK || !trigger.human || trigger.actor.id !== meta.senderId
    || !sameScope(pilot, meta.conversationId) || trigger.id !== messageKey(meta.conversationId, meta.messageId)
    || channel?.source !== DINGTALK || channel.address.conversationId !== meta.conversationId || channel.address.messageId !== meta.messageId
    || trigger.threads.length !== 1 || trigger.threads[0]?.source !== DINGTALK || trigger.threads[0]?.id !== issueKey(meta)) return undefined
  return meta
}

export type DingTalkIntakeResult = ReceiveResult
  | { manual: 'invalid_message' | 'outside_pilot' }
export interface DingTalkIntake {
  readonly scope: DingTalkPilotScope
  getTrigger(id: string): Trigger | undefined
  getReference(id: string): Trigger | undefined
  receive(trigger: Trigger): ReceiveResult
}

/** A transport verifies DingTalk identity and reply metadata before calling this entry point. */
export function receiveDingTalk(host: DingTalkIntake, input: unknown): DingTalkIntakeResult {
  const event = messageSchema.safeParse(input).data
  if (!event) return { manual: 'invalid_message' }
  const { scope } = host
  if (!sameScope(scope, event.conversationId)) return { manual: 'outside_pilot' }
  const id = messageKey(event.conversationId, event.messageId)
  if (host.getTrigger(id)) return host.getReference(id) ? 'duplicate' : 'filtered'
  if (event.replyToMessageId === event.messageId) return { manual: 'invalid_message' }
  const parent = event.replyToMessageId ? host.getReference(messageKey(event.conversationId, event.replyToMessageId)) : undefined
  const previous = parent && pilotTrigger(parent, scope)
  const meta: DingTalkMeta = {
    conversationId: event.conversationId, messageId: event.messageId, senderId: event.senderId,
    threadRootId: previous?.threadRootId ?? event.messageId,
    ...(event.replyToMessageId ? { quotedMessageId: event.replyToMessageId } : {}),
    ...(previous ? { replyToMessageId: previous.messageId } : {}),
  }
  const ref = { source: DINGTALK, id: issueKey(meta) }
  return host.receive({
    id, source: DINGTALK, actor: { source: DINGTALK, id: event.senderId }, human: true,
    ...(event.addressed ? { addressed: event.addressed } : {}), threads: [ref], at: event.at, text: event.text,
    channel: { source: DINGTALK, thread: `dingtalk:${ref.id}`, address: { conversationId: event.conversationId, messageId: event.messageId } },
    meta,
  })
}

export function dingTalkKind(pilot: DingTalkPilotScope,
  send: (message: OutboundMessage) => Promise<'sent' | 'gone'>): SourceKind {
  return {
    kind: DINGTALK, title: { zh: '钉钉试点', en: 'DingTalk pilot' },
    description: { zh: '接收群聊 @ 和单聊请求', en: 'DingTalk group mentions and direct requests' },
    schema: z.object({}), fields: [], health: [],
    acceptsAnyAddressedSender: true,
    policy: {
      schema: z.object({ allowed: z.array(z.object({id: nativeId, name: z.string().optional()})).default([]) }),
      fields: [],
      explicit: { zh: '任何发送者均可通过群聊 @ 或单聊发起请求', en: 'Any sender can address DSH in a group mention or direct message' },
    },
    scope: ({ meta }) => {
      const message = dingTalkMeta(meta)
      return message && sameScope(pilot, message.conversationId)
        ? { listened: true, observed: false, row: message.conversationId }
        : { listened: false, reason: 'outside_dingtalk_pilot' }
    },
    repliesTo: trigger => {
      const meta = dingTalkMeta(trigger.meta)
      return meta?.replyToMessageId ? messageKey(meta.conversationId, meta.replyToMessageId) : undefined
    },
    channel: {
      allowed: address => !!address.conversationId && nativeId.safeParse(address.conversationId).success
        && sameScope(pilot, address.conversationId) && nativeId.safeParse(address.messageId).success,
      send: (_, message) => send(message),
      link: () => ({ url: '', label: { zh: '钉钉试点会话', en: 'DingTalk pilot conversation' } }),
    },
  }
}
