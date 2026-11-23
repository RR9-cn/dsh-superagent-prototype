import { describe, expect, it, vi } from 'vitest'
import { dingTalkRoutingContext } from '../src/sources/dingtalk-context.ts'

const conversationId = 'cid:pilot'
const request = { conversationId, messageId: 'origin', quotedMessageId: 'quote',
  at: new Date(2026, 10, 21, 9, 30, 0).toISOString() }
const ok = (...messages: unknown[]) => ({ code: 0, stdout: JSON.stringify({ messages }), stderr: '' })
const row = (messageId: string, createTime = '2026-11-21 09:28:00', cid = conversationId) => ({
  conversationId: cid, messageId, createTime, senderId: 'sender', text: `Message ${messageId}`,
})
const signal = new AbortController().signal
const profile = { cli: 'dws', profile: 'corp:user' }

describe('DingTalk routing context', () => {
  it('loads the exact quote and only earlier same-conversation messages with the configured DWS identity', async () => {
    const command = vi.fn(async (_bin: string, args: string[]) => args.includes('+messages-list') ? ok(
      row('recent', '2026-11-21 09:29:59'), row('wrong-room', undefined, 'cid:other'), row('older'), row('older'),
      row('quote'), row('origin'), row('same-second', '2026-11-21 09:30:00'), row('future', '2026-11-21 09:30:01'),
    ) : ok(row('quote', undefined, 'cid:other'), row('wrong-id'), row('quote')))
    const result = await dingTalkRoutingContext(command, profile)(request, signal)
    expect(result.quoted_message).toMatchObject({ message_id: 'quote', text: 'Message quote' })
    expect(result.preceding_messages.map(item => item.message_id)).toEqual(['older', 'recent'])
    expect(command).toHaveBeenCalledWith('dws', ['chat', '+messages-list', '--conversation-id', conversationId, '--time',
      '2026-11-21 09:30:00', '--forward=false', '--limit', '12', '--no-reactions', '--profile', 'corp:user', '--format', 'json'], { signal })
    expect(command).toHaveBeenCalledWith('dws', ['chat', '+messages-mget', '--msg-ids', 'quote', '--no-reactions',
      '--profile', 'corp:user', '--format', 'json'], { signal })
  })

  it('distinguishes a failed timeline and an unavailable quote from a verified empty context', async () => {
    const command = vi.fn(async (_bin: string, args: string[]) => args.includes('+messages-list')
      ? { code: 2, stdout: '', stderr: 'private diagnostic' } : ok(row('quote', undefined, 'cid:other')))
    const read = dingTalkRoutingContext(command, profile)
    await expect(read(request, signal)).resolves.toEqual({ preceding_messages: [], preceding_messages_unavailable: true,
      quoted_message_unavailable: true })
    await expect(read({ ...request, conversationId: '' }, signal)).rejects.toThrow('Invalid DingTalk routing context origin')
    expect(command).toHaveBeenCalledTimes(2)
  })
})
