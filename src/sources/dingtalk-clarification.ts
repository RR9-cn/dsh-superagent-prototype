/** Send a DSH question and read quoted replies from one operator-selected DingTalk group. */
import { z } from 'zod'
import { readPilotJson, type PilotCommand } from '../infra/pilot-cli.ts'
import type { DingTalkCli } from './dingtalk-listener.ts'

const id = z.string().regex(/^[\w:@.+=/-]{1,160}$/)
const delivery = z.object({ success: z.literal(true), result: z.object({ openTaskId: id }) })
const status = z.object({ success: z.literal(true), result: z.object({ sendStatus: z.literal('SUCCESS') }),
  messageRef: z.object({ openConversationId: id, openMessageId: id }) })
const message = z.object({ messageId: id, conversationId: id, senderId: id, text: z.string().trim().min(1).max(4000),
  quotedMessage: z.object({ messageId: id, conversationId: id.optional() }).nullish() })
export type DingTalkClarificationMessage = z.infer<typeof message>
export interface DingTalkClarificationTransport {
  readonly group: string
  readonly responder: string
  send(key: string, text: string): Promise<string | undefined>
  confirm(taskId: string): Promise<DingTalkClarificationMessage | undefined>
  replies(since: string): Promise<DingTalkClarificationMessage[]>
}

export function dingTalkClarificationTransport(command: PilotCommand, config: DingTalkCli, group: string, responder: string,
  signal: AbortSignal): DingTalkClarificationTransport {
  const dws = async (args: string[], action: string) => readPilotJson(await command(config.cli,
    [...args, '--profile', config.profile, '--format', 'json'], { signal }), action)
  const messages = (value: unknown) => z.object({ messages: z.array(z.unknown()) }).parse(value).messages
    .flatMap(item => message.safeParse(item).data ?? []).filter(item => item.conversationId === group)
  return { group, responder,
    async send(key, text) {
      const sent = delivery.safeParse(await dws(['chat', '+messages-send', '--identity', 'user', '--group', group,
        '--text', text, '--uuid', key, '--yes'], 'DWS clarification send'))
      return sent.data?.result.openTaskId
    },
    async confirm(taskId) {
      const result = await dws(['chat', '+messages-query-send-status', '--open-task-id', taskId], 'DWS clarification status')
      const receipt = status.safeParse(result).data
      if (!receipt) {
        if (z.object({ success: z.literal(true), result: z.object({ sendStatus: z.enum(['FAILED', 'FAIL']) }) }).safeParse(result).success) {
          throw new Error('DWS could not deliver the clarification')
        }
        return
      }
      if (receipt.messageRef.openConversationId !== group) throw new Error('DWS clarification receipt points to another group')
      const outgoing = receipt.messageRef.openMessageId
      return messages(await dws(['chat', '+messages-mget', '--msg-ids', outgoing, '--no-reactions'],
        'DWS clarification readback')).find(item => item.messageId === outgoing)
    },
    async replies(since) {
      // The DWS event stream filters self-sent messages, including replies from this signed-in operator.
      return messages(await dws(['chat', '+chat-messages', '--group', group, '--start', since, '--page-all',
        '--max-items', '100', '--no-reactions'], 'DWS clarification replies')).reverse()
    },
  }
}
