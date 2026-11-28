/** Reply targets provided by a Source adapter. */
import { afterEach, expect, it } from 'vitest'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { repliedTo } from '../src/app/links.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
const followup = (id: string, text: string, overrides: Record<string, unknown> = {}) => feishu(id, text, { mentions: [], root_id: 'om_1',
  ...overrides })
it('takes the message a follow-up answers from its Source kind, whichever kind it is', async () => {
  h = await startRuntime()
  const parent = feishu('1', 'the earlier message')
  h.runtime.store.triggers.save(parent)
  const reply = { ...feishu('2', 'a reply'), source: 'other' }
  expect(repliedTo({ store: h.runtime.store, sources: { repliesTo: trigger => trigger.id === reply.id ? parent.id : undefined } },
    reply)).toEqual(parent)
  expect(repliedTo({ store: h.runtime.store, sources: { repliesTo: () => undefined } }, reply)).toBeUndefined()
  expect(repliedTo(h.runtime, followup('3', 'yes', { parent_id: 'om_1' }))).toEqual(parent)
})
