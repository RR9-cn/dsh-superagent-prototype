// @vitest-environment jsdom
// Panel search, glossary, route persistence, and host-down fallback.
import { act } from 'react'
import { expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, settle, all, click, type, text, field, find } from './fixtures/panel.tsx'
import { server, found } from './fixtures/panel-server.ts'

usePanel()
it('shows the two exact URIs and waits for explicit duplicate deletion confirmation', async () => {
  const base = 'viking://~/memories/experiences/'
  const pair = { id: 'duplicate', keep: { uri: base + 'test_setup.md', digest: 'new' },
    remove: { uri: base + 'test setup.md', digest: 'old' }, reason: 'revised' as const, query: 'Test setup',
    obsolete: ['Switch to the wrapper.'], status: 'proposed' as const }
  server.dreaming = { mode: 'dsh', openViking: true, canStart: true, pack: null, published: null, bulk: null, batches: [],
    duplicates: { ids: [pair.id], pairs: [pair], total: 2, skipped: [], unavailable: [] } }
  await mount()
  await click(zh['tab.dreaming'])
  expect(text()).toContain(pair.keep.uri)
  expect(text()).toContain(pair.remove.uri)
  await click(zh['dreaming.duplicateReview'])
  expect(server.requests.some(r => r.path.endsWith('/remove'))).toBe(false)
  await click(zh['dreaming.duplicateConfirm'])
  expect(server.requests.filter(r => r.path.endsWith('/remove'))).toEqual([
    { path: 'dreaming/duplicates/duplicate/remove', method: 'POST' },
  ])
  expect(text()).toContain(zh['dreaming.duplicateStatus.verified'])
})

it('keeps automatic merge results collapsed without a confirmation control', async () => {
  const root = 'viking://~/memories/experiences/'
  const keep = { uri: root + 'test_setup.md', digest: 'keep', content: 'Configuration from the project root.' }
  const source = { uri: root + 'test setup.md', digest: 'source', content: 'Logs show the resolved configuration file.' }
  server.dreaming = { mode: 'dsh', openViking: true, canStart: true, pack: null, published: null, bulk: null, batches: [],
    merges: [{ id: 'pending', keep, source, status: 'proposed' }] }
  await mount()
  await click(zh['tab.dreaming'])
  const list = find(zh['dreaming.mergeResults'].replace('{count}', '1'), 'summary')
  const item = find(`test_setup.md · ${zh['dreaming.mergeStatus.proposed']}`, 'summary')
  expect(list.closest('details')?.open).toBe(false)
  expect(item.closest('details')?.open).toBe(false)
  await click(list)
  await click(item)
  expect(text()).toContain(source.uri)
  expect(item.closest('details')?.querySelector('button')).toBeNull()
  expect(server.requests.some(request => request.path.includes('/merges/'))).toBe(false)
})

it('starts one-click correction directly and keeps manual editing available separately', async () => {
  server.dreaming = { mode: 'dsh', openViking: true, canStart: true, pack: null, published: null, bulk: null, batches: [{
    id: 'batch-1', baseVersion: 0, pack: { id: 'evidence', project: 'example', evidence: [
      { id: 'root', source: 'viking://~/sessions/test/history/archive_001/messages.jsonl#L42', kind: 'tool-result', text: 'The test ran.' },
    ] }, createdAt: '2026-11-25T08:00:00Z',
    attempt: 1, model: null, sessionId: 'dreaming-session', status: 'published', candidate: { before: null, review: 'approved',
      reason: 'Verified with the current setup', after: { title: 'Test setup', action: 'Check the directory', scope: 'example',
        verification: 'The test ran at the root', support: ['root'], counterexamples: [] } },
  }] }
  const uri = 'viking://~/memories/experiences/test-setup.md'
  server.dreamingMemoryMatches = [{ uri, excerpt: 'Original test setup' }]
  await mount()
  await click(zh['tab.dreaming'])
  expect(server.requests.some(request => request.path === 'dreaming/archives')).toBe(false)
  const results = find(zh['dreaming.auditResults'].replace('{count}', '1'), 'summary')
  const group = results.closest('details')!
  expect(group.open).toBe(false)
  const result = find(zh['dreaming.published'], 'summary')
  const details = result.closest('details')!
  expect(group.contains(details)).toBe(true)
  await click(results)
  expect(group.open).toBe(true)
  expect(details.open).toBe(false)
  expect(details.textContent).toContain('Verified with the current setup')
  expect(find(zh['dreaming.writeMemory']).closest('details')).toBe(details)
  await click(result)
  expect(details.open).toBe(true)
  const evidence = find(zh['dreaming.evidenceDetails'], 'summary').closest('details')!
  expect(evidence.open).toBe(false)
  expect(evidence.textContent).toContain('messages.jsonl#L42')
  expect(evidence.textContent).not.toContain(zh['dreaming.counterexamples'])
  await click(zh['dreaming.writeMemory'])
  expect(server.requests.filter(request => request.path.endsWith('/memory/correct'))).toEqual([
    { path: 'dreaming/batches/batch-1/memory/correct', method: 'POST' },
  ])
  const open = find(zh['dreaming.manualMemory'])
  expect(open.getAttribute('aria-expanded')).toBe('false')
  expect(text()).toContain(zh['dreaming.published'])
  expect(server.requests.some(request => request.path.endsWith('/memory/find'))).toBe(false)
  await click(open)
  expect(open.getAttribute('aria-expanded')).toBe('true')
  expect(field<HTMLInputElement>(zh['dreaming.findMemory']).value).toBe('Test setup')
  expect(find(uri)).toBeTruthy()
  expect(server.requests.filter(request => request.path.endsWith('/memory/find'))).toEqual([
    { path: 'dreaming/batches/batch-1/memory/find', method: 'POST', body: { query: 'Test setup' } },
  ])
  expect(text()).not.toContain(zh['dreaming.commitMemory'])
  expect(server.requests.some(request => request.path.endsWith('/memory/write'))).toBe(false)
})

it('states why a filtered search result has no Thread instead of opening an empty one', async () => {
  server.search = { items: [found('e9', '2026-09-20T00:00:00Z', { source: 'github', actor: { source: 'github', id: 'someone' },
    preview: 'issue text', threads: ['github:7'],
    filtered: 'source_disabled' })], threads: [] }
  await mount()
  await type(field<HTMLInputElement>(zh.searchLabel), 'issue')
  await act(async () => { field<HTMLInputElement>(zh.searchLabel).closest('form')!.requestSubmit() }); await settle()
  expect(text()).toContain('被来源过滤：来源已停用')
  expect(all('.dt-search-results button').some(button => button.textContent === 'issue text')).toBe(false)
})

it('opens a search result older than the newest page around its Trigger', async () => {
  server.search = { items: [found('e1', '2026-09-20T00:00:00Z')], threads: [] }
  await mount()
  await type(field<HTMLInputElement>(zh.searchLabel), 'message')
  await act(async () => { field<HTMLInputElement>(zh.searchLabel).closest('form')!.requestSubmit() }); await settle()
  expect(text()).toContain('找到 0 个工单、0 个线程、1 条触发')
  await click(all('.dt-search-results button').find(button => button.textContent === 'message e1')!)
  expect(server.requests.some(request => request.path.includes('around=e1'))).toBe(true)
  expect(document.querySelector('.dt-highlight')?.textContent).toContain('message e1')
})

it('explains what can be searched when nothing matches', async () => {
  await mount()
  await type(field<HTMLInputElement>(zh.searchLabel), 'nothing')
  await act(async () => { field<HTMLInputElement>(zh.searchLabel).closest('form')!.requestSubmit() }); await settle()
  expect(text()).toContain('没有找到。可以输入触发文字')
})

it('returns to the exact page after a remount of the main panel', async () => {
  await mount()
  await click('修复回归')
  await remount()
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('修复回归')
})

it('shows domain terms in the interface language only and lists both languages in the (?) glossary', async () => {
  await mount(en)
  expect(all('[role="tab"]').map(tab => tab.textContent)).toEqual(['Overview', 'Source', 'Trigger', 'Eval', 'Execution', 'Dreaming', 'Settings'])
  await click('Glossary')
  const dialog = document.querySelector('[role="dialog"]')!
  const row = [...dialog.querySelectorAll('tr')].find(item => item.textContent?.startsWith('Ticket'))!
  expect([...row.querySelectorAll('td')].map(cell => cell.textContent)).toEqual(['Ticket', '工单', 'An authorized unit of work'])
  expect(dialog.textContent).toContain('Accept 接单')
  // Terms are grouped the way the tabs follow the flow, after the roles that act in it.
  expect([...dialog.querySelectorAll('th.dt-glossary-group')].map(cell => cell.textContent)).toEqual(['Roles', 'Source', 'Trigger', 'Eval',
    'Execution'])
  expect([...dialog.querySelectorAll('tr')].find(item => item.textContent?.startsWith('Main Session'))!.textContent).toContain('prompts call it the orchestrator')
})

it('says dsh-superagent is not answering when its routes are gone, as while it restarts', async () => {
  server.down = true
  await mount()
  expect(text()).toContain(zh.hostNotRunning)
  expect(text()).not.toContain('404')
})

it('closes search results on Escape and on a click outside the search', async () => {
  await mount()
  const search = field<HTMLInputElement>(zh.searchLabel)
  const submit = async () => { await type(search,
    'nothing'); await act(async () => { search.closest('form')!.requestSubmit() }); await settle() }
  await submit()
  expect(document.querySelector('.dt-search-results')).not.toBeNull()
  await act(async () => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  expect(document.querySelector('.dt-search-results')).toBeNull()
  await submit()
  await act(async () => { document.querySelector('main')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
  expect(document.querySelector('.dt-search-results')).toBeNull()
})

it('shows the answer to the latest search only', async () => {
  server.search = { items: [found('e1', '2026-09-20T00:00:00Z', { preview: 'old message' }), found('e2', '2026-09-21T00:00:00Z',
    { preview: 'new message' })], threads: [] }
  let release = () => {}
  server.searching = async query => { if (query === 'old') await new Promise<void>(resolve => { release = resolve }) }
  await mount()
  const search = field<HTMLInputElement>(zh.searchLabel)
  for (const query of ['old', 'new']) { await type(search,
    query); await act(async () => { search.closest('form')!.requestSubmit() }); await settle() }
  expect(all('.dt-search-results .dt-row-title').map(title => title.textContent)).toEqual(['new message'])
  await act(async () => { release() }); await settle()
  expect(all('.dt-search-results .dt-row-title').map(title => title.textContent)).toEqual(['new message'])
})
