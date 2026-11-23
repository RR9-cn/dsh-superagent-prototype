/** Opt-in delivery of one DSH-produced terminal reply to its exact DingTalk message. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { readPilotJson, type PilotCommand } from '../infra/pilot-cli.ts'
import type { DingTalkCli } from './dingtalk-listener.ts'

const native = z.string().regex(/^[\w:@.+=/-]{1,160}$/)
const sendResult = z.object({ success: z.literal(true), conversationId: native, idempotencyKey: z.string(),
  referencedMessage: z.object({ messageId: native }), result: z.object({ openTaskId: native.optional(),
    openMessageId: native.optional(), messageId: native.optional() }) })
const found = z.object({ messages: z.array(z.object({ messageId: native, conversationId: native, text: z.string(),
  quotedMessage: z.object({ messageId: native }).optional() })) })
function messageIds(value: unknown): Set<string> {
  if (!value || typeof value !== 'object') return new Set()
  if (Array.isArray(value)) return new Set(value.flatMap(item => [...messageIds(item)]))
  const record = value as Record<string, unknown>
  // The status response can nest the delivery under result/records; do not read the quoted source as the outbound ID.
  const direct = [record.openMessageId, record.messageId].flatMap(item => {
    const id = native.safeParse(item).data
    return id ? [id] : []
  })
  const nested = Object.entries(record).filter(([field]) => field !== 'referencedMessage' && field !== 'quotedMessage')
  return new Set([...direct, ...nested.flatMap(([_field, item]) => [...messageIds(item)])])
}

export function dingTalkTerminalSender(command: PilotCommand, config: DingTalkCli, legacyConversation: string | undefined, enabled: boolean,
  signal: AbortSignal): (message: OutboundMessage) => Promise<'sent' | 'gone'> {
  const dws = async (args: string[], action: string) => readPilotJson(await command(config.cli,
    [...args, '--profile', config.profile, '--format', 'json'], { signal }), action)
  return async message => {
    if (!enabled || message.kind !== 'reply' || message.hiFoxTerminal !== true || message.channel.source !== 'dingtalk') return 'gone'
    const { conversationId, messageId } = z.object({ conversationId: native, messageId: native })
      .safeParse(message.channel.address).data ?? {}
    if (!conversationId || !messageId || (legacyConversation && conversationId !== legacyConversation) || !/^[a-f0-9]{32}$/.test(message.id)) return 'gone'
    const args = ['chat', '+messages-reply', '--group', conversationId, '--message-id', messageId,
      '--content', message.text, '--uuid', message.id]
    // Explicit operator opt-in authorizes this narrowly scoped, machine-generated terminal response.
    const returned = sendResult.safeParse(await dws([...args, '--yes'], 'DWS terminal reply')).data
    if (!returned || returned.conversationId !== conversationId || returned.referencedMessage.messageId !== messageId
      || returned.idempotencyKey !== message.id) throw new Error('DWS did not confirm the target and idempotency key')
    const ids = returned.result.openTaskId
      ? messageIds(await dws(['chat', '+messages-query-send-status', '--open-task-id', returned.result.openTaskId], 'DWS reply delivery status'))
      : messageIds(returned.result)
    ids.delete(messageId)
    if (ids.size !== 1) throw new Error('DWS has not identified one terminal reply yet')
    const [outgoing] = ids
    const readback = found.safeParse(await dws(['chat', '+messages-mget', '--msg-ids', outgoing!, '--no-reactions'],
      'DWS reply readback')).data
    if (readback?.messages.filter(item => item.messageId === outgoing && item.conversationId === conversationId
      && item.quotedMessage?.messageId === messageId && item.text === message.text).length !== 1) {
      throw new Error('DWS cannot verify the exact quoted terminal reply yet')
    }
    return 'sent'
  }
}
