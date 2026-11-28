import { key, type Engine, type Ticket } from '../core/index.ts'
import { hiFoxTicket } from '../executor/hifox.ts'
import { family } from '../kv.ts'
import type { DingTalkClarificationTransport } from '../sources/dingtalk-clarification.ts'
import { PollAgain, type Effects } from './effects.ts'
import type { Store } from './store.ts'

interface Notice {
  startedAt: string
  sendTaskId?: string
  messageId?: string
  senderId?: string
}
const notices = family<Notice>('ding-clarification:')
const accepted = family<true>('ding-clarification-answer:')
const effect = 'dingtalk-clarifications'
const pollInterval = 20_000
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()

export function dingTalkClarifications(store: Store, effects: Effects, engine: Pick<Engine, 'note'>,
  transport: DingTalkClarificationTransport, paused: () => boolean) {
  const current = (ticket: Ticket) => store.tickets.get(ticket.id)?.attention?.id === ticket.attention?.id
  const prepare = async (ticket: Ticket) => {
    const attention = ticket.attention!
    const deliveryKey = key(effect, transport.group, attention.id)
    const code = `DSH-${deliveryKey.slice(0, 12)}`
    const record = notices(deliveryKey)
    const saved = store.get(record)
    const notice = saved ?? { startedAt: new Date(Date.now() - 2000).toISOString() }
    const url = hiFoxTicket(store, ticket)?.taskUrl
    const text = [`【DSH 工单澄清】${ticket.title}`, attention.question, ...(url ? [url] : []),
      `请引用本条消息回复。若无法引用，请以 ${code} 开头后写答复。`].join('\n\n')
    const remember = (sent: Awaited<ReturnType<typeof transport.confirm>>) => {
      if (sent?.conversationId === transport.group && sent.senderId === transport.responder && normalize(sent.text) === normalize(text)) {
        notice.messageId = sent.messageId; notice.senderId = sent.senderId
        store.set(record, notice)
      }
    }
    if (saved && !notice.messageId && !notice.sendTaskId) {
      // An ambiguous send may already be visible in DingTalk even if it returned no usable task receipt.
      const matches = (await transport.replies(notice.startedAt)).filter(item => item.senderId === transport.responder
        && item.conversationId === transport.group && normalize(item.text) === normalize(text))
      if (matches.length === 1) remember(matches[0])
      if (matches.length > 1) throw new Error('DingTalk returned multiple copies of one clarification')
    }
    if (!notice.messageId && !notice.sendTaskId && current(ticket) && !paused()) {
      store.set(record, notice)
      notice.sendTaskId = await transport.send(deliveryKey, text)
      store.set(record, notice)
    }
    if (!notice.messageId && notice.sendTaskId && current(ticket)) {
      remember(await transport.confirm(notice.sendTaskId))
    }
    return { ticket, code, notice }
  }
  effects.handle(effect, async () => {
    const waiting = store.tickets.open().filter(ticket => ticket.executionTarget === 'hifox' && ticket.attention)
    const ready: Awaited<ReturnType<typeof prepare>>[] = []
    let failure: unknown
    for (const ticket of waiting) {
      if (paused() || !current(ticket)) continue
      try {
        const item = await prepare(ticket)
        if (item.notice.messageId && item.notice.senderId) ready.push(item)
      } catch (error) { failure ??= error }
    }
    const since = ready.map(item => item.notice.startedAt).sort()[0]
    if (since) {
      const messages = await transport.replies(since)
      store.atomic(() => {
        if (paused()) return
        for (const { ticket, notice, code } of ready) {
          if (!current(ticket)) continue
          for (const message of messages) {
            if (message.conversationId !== transport.group || message.senderId !== transport.responder || message.messageId === notice.messageId) continue
            const receipt = accepted(key(transport.group, message.messageId))
            if (store.get(receipt)) continue
            const quote = message.quotedMessage
            const text = quote && quote.messageId === notice.messageId && (!quote.conversationId || quote.conversationId === transport.group)
              ? message.text : !quote && message.text.startsWith(code) && /^[\s:：]/.test(message.text.slice(code.length))
                ? message.text.slice(code.length).replace(/^[\s:：]+/, '') : ''
            if (!text.trim()) continue
            engine.note(ticket.id, `工单联系人在钉钉澄清群回复：${text}`)
            store.set(receipt, true)
          }
        }
      })
    }
    if (failure) throw failure
    throw new PollAgain('Watching for HiFox clarification questions and replies', pollInterval)
  }, { limit: () => paused() ? 0 : 1 })
  if (!effects.pending(effect, effect)) effects.enqueue(effect, effect, {})
}
