/** Read-only routing context from the authenticated DWS conversation. */
import { z } from 'zod'
import { readPilotJson, type PilotCommand } from '../infra/pilot-cli.ts'
import type { DingTalkCli } from './dingtalk-listener.ts'

const nativeId = z.string().regex(/^[\w:@.+=/-]{1,160}$/)
const message = z.object({ conversationId: nativeId, messageId: nativeId, createTime: z.string().regex(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/),
  text: z.string(), sender: z.string().nullish(), senderId: nativeId.nullish() })
const request = z.object({ conversationId: nativeId, messageId: nativeId, quotedMessageId: nativeId.optional(),
  at: z.iso.datetime({ offset: true }) })
const page = z.object({ messages: z.array(z.unknown()) })
const limit = 12
type ContextMessage = { message_id: string; sender: string; at: string; text: string }
type RoutingContext = {
  quoted_message?: ContextMessage
  quoted_message_unavailable?: true
  preceding_messages: ContextMessage[]
  preceding_messages_unavailable?: true
}

function localClock(at: Date): string {
  const pad = (number: number) => String(number).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
}

export function dingTalkRoutingContext(command: PilotCommand, config: DingTalkCli) {
  return async (input: z.infer<typeof request>, signal: AbortSignal): Promise<RoutingContext> => {
    const origin = request.safeParse(input).data
    if (!origin) throw new Error('Invalid DingTalk routing context origin')
    const { conversationId } = origin
    const clock = localClock(new Date(origin.at))
    const read = async (args: string[]) => {
      const data = page.parse(readPilotJson(await command(config.cli,
        ['chat', ...args, '--no-reactions', '--profile', config.profile, '--format', 'json'], { signal }), 'DWS routing context'))
      return data.messages.flatMap(item => {
        const row = message.safeParse(item).data
        return row && row.conversationId === conversationId && row.messageId !== origin.messageId && row.text.trim() ? [row] : []
      })
    }
    const quoteId = origin.quotedMessageId !== origin.messageId ? origin.quotedMessageId : undefined
    const [nearby, quote] = await Promise.allSettled([
      read(['+messages-list', '--conversation-id', conversationId, '--time', clock, '--forward=false', '--limit', String(limit)]),
      quoteId ? read(['+messages-mget', '--msg-ids', quoteId]) : Promise.resolve([]),
    ])
    signal.throwIfAborted()
    const quoted = quote.status === 'fulfilled' ? quote.value.find(row => row.messageId === quoteId) : undefined
    const view = (row: z.infer<typeof message>, max: number) => ({ message_id: row.messageId,
      sender: (row.sender || row.senderId || '').slice(0, 160), at: row.createTime,
      text: row.text.length > max ? `${row.text.slice(0, max)}…` : row.text })
    // DWS renders local timestamps to whole seconds. Rows in the trigger's second cannot be ordered reliably.
    const preceding = new Map<string, z.infer<typeof message>>()
    if (nearby.status === 'fulfilled') for (const row of nearby.value) {
      if (row.messageId !== quoteId && row.createTime < clock) {
        preceding.set(row.messageId, row)
      }
    }
    return {
      ...(quoted ? { quoted_message: view(quoted, 4000) } : quoteId ? { quoted_message_unavailable: true } : {}),
      preceding_messages: [...preceding.values()].sort((a, b) => a.createTime.localeCompare(b.createTime))
        .slice(-limit).map(row => view(row, 1000)),
      ...(nearby.status === 'rejected' ? { preceding_messages_unavailable: true } : {}),
    }
  }
}
