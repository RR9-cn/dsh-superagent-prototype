/** Session tool registration, role-scoped resource reads, and routing/settings tool contracts. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { builtInBase, builtInParts, defaultPrompts } from '../src/app/prompts.ts'
import { UserError } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { Commands } from '../src/infra/commands.ts'
import { IM_WORDS, NOTE_WORDS } from '../src/infra/text.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })
const read = (resource: string, page: { offset?: number; limit?: number } = {}) =>
  h.runTool(h.runtime.masterId, 'orchestrator_read', { resource, ...page })

it('lists in prompts the built-in parts whose text changed since the team overrode them, and the built-in parts in prompts/defaults', async () => {
  const read = (resource: string, offset = 0) => h.runTool(h.runtime.masterId, 'orchestrator_read', { resource, offset, limit: 8000 })
  expect(await read('prompts')).not.toHaveProperty('default_changed')
  // An override edited from the built-in text of an earlier version.
  h.runtime.prompts.save({ ...defaultPrompts(), overrides: { 'runtime/dispatch': { text: '## dispatch\nOurs.', base: 'earlier' } } }, 0, 'panel')
  expect(await read('prompts')).toMatchObject({ default_changed: ['runtime/dispatch'] })
  // A text page at a time, which the whole text joins.
  let text = '', offset: number | null = 0
  while (offset !== null) {
    const page = await read('prompts/defaults', offset) as { text: string; next_offset: number | null }
    text += page.text; offset = page.next_offset
  }
  const defaults = JSON.parse(text) as { parts: Record<string, string> }
  expect(defaults.parts).toEqual(Object.fromEntries(Object.entries(builtInParts()).map(([key, part]) => [key, part.text])))
})

it('saves with the prompt save tool an override without its base, refuses a part no version has, and drops a removed one read back', async () => {
  const save = (overrides: Record<string, unknown>) => h.runTool(h.runtime.masterId, 'orchestrator_prompts_save',
    { config: { ...defaultPrompts(), overrides }, baseRevision: h.runtime.prompts.current().revision })
  await expect(save({ constructor: { text: 'x' } })).rejects.toThrow(new UserError('unknownPromptPart', { part: 'constructor' }))
  await save({ 'runtime/dispatch': { text: '## dispatch\nOurs.' } })
  const dispatch = { text: '## dispatch\nOurs.', base: builtInBase(builtInParts()['runtime/dispatch'].text) }
  expect(h.runtime.prompts.current().config.overrides).toEqual({ 'runtime/dispatch': dispatch })
  // The saved version overrides a part this version no longer has: saving back the configuration as read drops it.
  const { revision } = h.runtime.prompts.current(), read = { ...defaultPrompts(), overrides: { 'runtime/dispatch': dispatch,
    'runtime/retired': { text: 'Old.', base: 'b' } } }
  h.runtime.store.set(KV.prompts.version(revision + 1), { revision: revision + 1, previousRevision: revision, savedAt: '', source: 'panel', config: read })
  h.runtime.store.set(KV.prompts.revision, revision + 1)
  await h.runTool(h.runtime.masterId, 'orchestrator_prompts_save', { config: read, baseRevision: revision + 1 })
  expect(h.runtime.prompts.current().config.overrides).toEqual({ 'runtime/dispatch': dispatch })
  // The tool describes the overrides once, in its schema.
  const tool = h.tools.get(h.runtime.masterId)!.get('orchestrator_prompts_save') as unknown as { description: string }
  expect(tool.description).not.toContain('overrides')
})

it('states each routing field\'s limit in its description, which the schema leaves to the item\'s check', () => {
  type Schema = { parameters: { properties: { decisions: { items: { properties: Record<string, { description?: string }> } } } } }
  const fields = (h.tools.get(h.runtime.masterId)!.get('orchestrator_route') as unknown as Schema).parameters.properties.decisions.items.properties
  const limits: Record<string, string[]> = { title: ['200 characters'],
    acknowledgement: [`${IM_WORDS} words`], note: [`${NOTE_WORDS} words`, 'Never add implementation instructions'], reason: ['500 characters'] }
  for (const [field, phrases] of Object.entries(limits)) for (const phrase of phrases) expect(fields[field]!.description, field).toContain(phrase)
})

it('saves a settings block by name, a Source\'s block with the Source\'s id', async () => {
  const save = (args: Record<string, unknown>) => h.runTool(h.runtime.masterId, 'orchestrator_settings_save', args)
  const feishuSettings = { config: h.runtime.store.settings().sources.feishu!.config, revision: h.runtime.store.blockRevision('source:feishu') }
  const off = { enabled: false, config: feishuSettings.config }
  await expect(save({ block: 'source', value: off, revision: feishuSettings.revision })).rejects.toThrow('source names the Source')
  await expect(save({ block: 'source:feishu', value: off, revision: feishuSettings.revision })).rejects.toThrow()
  expect(await save({ block: 'source', source: 'feishu', value: off, revision: feishuSettings.revision })).toMatchObject({ saved: true })
  expect(h.runtime.store.settings().sources.feishu?.enabled).toBe(false)
  expect(await save({ block: 'pause', value: { paused: true }, revision: 0 })).toEqual({ paused: true })
})

it('previews a prompt configuration without saving it, and saves one only against the revision it edits', async () => {
  const save = (args: Record<string, unknown>) => h.runTool(h.runtime.masterId, 'orchestrator_prompts_save', args)
  const config = { ...h.runtime.prompts.current().config, scope: 'Finish what was asked.' }
  const preview = await save({ config, preview: true }) as { previews: { role: string; read: string }[] }
  expect(preview.previews.map(item => item.role)).toEqual(['orchestrator', 'worker'])
  let text = '', offset: number | null = 0
  while (offset !== null) {
    const page = await read(preview.previews[1]!.read, { offset, limit: 8000 }) as { text: string; next_offset: number | null }
    text += page.text; offset = page.next_offset
  }
  expect(text).toContain('## Ticket scope\nFinish what was asked.')
  expect(h.runtime.prompts.current().revision).toBe(0)
  await expect(save({ config })).rejects.toThrow('baseRevision')
  expect(await save({ config, baseRevision: 0 })).toMatchObject({ revision: 1 })
})

it('reads a trigger once with the message it replies to and the messages around it on its thread, without the CI runs', async () => {
  const at = (minute: number) => `2026-10-06T00:0${minute}:00.000Z`
  const message = (id: string, minute: number, overrides: Record<string, unknown> = {}) => ({ ...feishu(id, `message ${id}`, { root_id: 'om_root', ...overrides }), at: at(minute) })
  const ci = (id: string, minute: number) => ({ ...message(id, minute), source: 'github', human: false, text: '{"check":"build"}', meta: { ci: true } })
  const asked = message('asked', 1), replying = message('reply', 3, { parent_id: 'om_asked' })
  for (const item of [message('root', 0, { root_id: undefined }), asked, ci('ci-1', 2), replying, ci('ci-2', 4), message('later', 5)]) h.runtime.store.triggers.save(item)
  const page = await read(`trigger/${replying.id}`)
  expect(page).toMatchObject({ trigger_id: replying.id, replied_to: { trigger_id: asked.id, read: `trigger/${asked.id}` },
    around: { before: { trigger_id: asked.id }, after: { trigger_id: feishu('later', '').id } }, text: 'message reply' })
  // The page holds the text once, and no pointer to itself.
  expect(page).not.toHaveProperty('preview')
  expect(page).not.toHaveProperty('read')
})

it('answers a policy sync with the counts and what changed, not the whole list', async () => {
  vi.mocked(Commands.prototype.lark).mockResolvedValue({ users: [{ member_id: 'ou_alice', name: 'Alice' }, { member_id: 'ou_bob', name: 'Bob' }], has_more: false })
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_policy_sync', { source: 'feishu' })).toEqual({ source: 'feishu', allowed: 2, added: ['Bob'], removed: [] })
})
