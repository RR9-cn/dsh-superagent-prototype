import { expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { openVikingMemory } from '../src/app/dreaming/memory.ts'
import { findMemoryDuplicates } from '../src/app/dreaming/duplicates.ts'
import type { MemoryMerge } from '../src/app/dreaming/merges.ts'
import type { PilotCommand } from '../src/infra/pilot-cli.ts'

const uri = 'viking://~/peers/example/memories/experiences/test.md'
const canonical = uri.replace('viking://~', 'viking://user/current')
const previous = 'Use the wrapper.'
const replacement = 'Check the working directory.'
const original = `# Test setup\n${previous}\nKeep this line.`
const connection = async () => ({ url: 'https://example.test/openviking', api_key: 'fixture' })

it('finds an approved replacement without relying on filename similarity', () => {
  const entry = (uri: string, content: string) => ({ uri, content, digest: createHash('sha256').update(content).digest('hex') })
  const old = entry(uri.replace('test.md', 'test setup.md'), original)
  const revised = entry(uri.replace('test.md', 'test_setup.md'), original.replace(previous, replacement))
  const similar = entry(uri.replace('test.md', 'test-setup.md'), original.replace('Keep this line.', 'Different evidence.'))
  const otherScope = entry(old.uri.replace('/example/', '/another/'), original)
  const proof = { uri: old.uri, digest: old.digest, previous, replacement, query: 'Test setup' }
  expect(findMemoryDuplicates([old, revised, similar, otherScope], [])).toEqual([])
  expect(findMemoryDuplicates([old, revised, similar, otherScope], [proof])).toMatchObject([
    { keep: { uri: revised.uri }, remove: { uri: old.uri }, reason: 'revised', obsolete: [previous] },
  ])
  expect(findMemoryDuplicates([old, { ...old, uri }, otherScope], [])).toMatchObject([
    { keep: { uri }, remove: { uri: old.uri }, reason: 'identical', obsolete: [] },
  ])
})

it('deletes the literal URI and checks scoped recall and obsolete text', async () => {
  const old = uri.replace('test.md', 'test setup.md')
  let stale = true
  const run = vi.fn<PilotCommand>(async (_cli, args) => {
    if (args[0] === 'rm') return { code: 0, stdout: JSON.stringify({ result: { uri: old } }), stderr: '' }
    const hits = args[0] === 'find' ? { memories: [{ uri: canonical, abstract: replacement }] } :
      args[0] === 'search' ? { text: replacement } : { match_count: Number(stale) }
    return { code: 0, stdout: JSON.stringify({ result: hits }), stderr: '' }
  })
  const memory = openVikingMemory('ov', new AbortController().signal, fetch, run, connection)
  const pair = { id: 'pair', keep: { uri, digest: 'new' }, remove: { uri: old, digest: 'old' },
    reason: 'revised' as const, query: 'Test setup', obsolete: [previous], status: 'proposed' as const }
  await memory.deleteExact(old)
  expect(run.mock.calls[0]?.[1]).toEqual(['rm', old, '--wait', '-o', 'json'])
  expect(await memory.verifyRemoval(pair)).toBe(false)
  stale = false
  expect(await memory.verifyRemoval(pair)).toBe(true)
})

it('checks each merge query and rejects a stale result for the absorbed URI', async () => {
  const old = uri.replace('test.md', 'former.md')
  const snapshot = { uri, content: original, digest: 'original' }
  const plan: MemoryMerge = { id: 'merge', keep: snapshot, source: { ...snapshot, uri: old },
    queries: ['test project', 'wrapper path'], status: 'waiting_for_recall' }
  let supplementaryRecall = false
  let oldRecall = true
  const run: PilotCommand = async (_, args) => {
    const memories = [...(args.at(-1) === plan.queries[0] || supplementaryRecall ? [{ uri: canonical }] : []),
      ...(oldRecall ? [{ uri: old }] : [])]
    return { code: 0, stderr: '', stdout: JSON.stringify({ result: { memories } }) }
  }
  const memory = openVikingMemory('ov', new AbortController().signal, fetch, run, connection)
  expect(await memory.recallsMerge(plan, false)).toBe(false)
  supplementaryRecall = true
  expect(await memory.recallsMerge(plan, false)).toBe(true)
  expect(await memory.recallsMerge(plan, true)).toBe(false)
  oldRecall = false
  expect(await memory.recallsMerge(plan, true)).toBe(true)
})

function fixture(suffix?: string, receipt = 'OK') {
  let content = original
  let metadata = suffix ?? '<metadata>original</metadata>'
  let indexed = false
  const write = vi.fn((payload: { params: { arguments: { old_string: string; new_string: string } } }) => {
    const { old_string, new_string } = payload.params.arguments
    const raw = `${content}\n${metadata}`
    expect(raw.indexOf(old_string)).toBeGreaterThanOrEqual(0)
    expect(raw.indexOf(old_string)).toBe(raw.lastIndexOf(old_string))
    content = content.replace(old_string, new_string)
    if (!suffix) metadata = '<metadata>server-refreshed</metadata>'
    return payload
  })
  const http = vi.fn<typeof fetch>(async (url, options) => {
    const path = new URL(String(url)).pathname
    if (path.endsWith('/download')) return new Response(`${content}\n${metadata}`)
    if (path.endsWith('/read')) return Response.json({ result: content })
    if (path.endsWith('/mcp')) {
      write(JSON.parse(String(options?.body)))
      return new Response(`event: message\ndata: ${JSON.stringify({ id: 1, result: { content: [{ type: 'text', text: receipt }] } })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } })
    }
    throw new Error(path)
  })
  const run: PilotCommand = async () => ({ code: 0, stderr: '', stdout: JSON.stringify({ result: {
    memories: [{ uri: canonical, abstract: indexed ? replacement : previous }, { uri: canonical.replace('test.md', 'other.md'), abstract: previous }],
  } }) })
  const memory = openVikingMemory('ov', new AbortController().signal, http, run, connection)
  const prepare = async () => memory.prepare({ uri, digest: (await memory.preview(uri)).digest, previous, replacement, query: 'Test setup' })
  const restore = () => { content = original; metadata = suffix ?? '<metadata>original</metadata>' }
  return { memory, write, prepare, restore, setIndexed: () => { indexed = true }, change: () => { content += '\nUnreviewed change.' } }
}

it('can append the reviewed supplementary body while preserving stored metadata', async () => {
  const { memory, write } = fixture()
  const snapshot = await memory.snapshot(uri)
  const suffix = '\n\n# Related memory\nVerify at the root.\n\nviking://~/sessions/example/history/archive_001/messages.jsonl#L4'
  const edit = await memory.prepare({ uri, digest: snapshot.digest, digestKind: 'visible', query: 'Test setup',
    supplement: true, previous: snapshot.content, replacement: snapshot.content + suffix })
  await memory.apply(edit)
  await memory.apply(edit)
  expect(write).toHaveBeenCalledTimes(1)
  expect((await memory.snapshot(uri)).content).toBe(original + suffix)
})

it('edits only the reviewed passage at the original URI and verifies updated retrieval', async () => {
  const f = fixture()
  const edit = await f.prepare()
  f.setIndexed()
  await f.memory.apply(edit)
  expect(f.write).toHaveBeenCalledExactlyOnceWith({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'edit', arguments: { uri, old_string: previous, new_string: replacement, replace_all: false, wait: true, timeout: 35 },
  } })
  expect((await f.memory.preview(uri)).content).toBe(original.replace(previous, replacement))
  await f.memory.apply(edit)
  expect(f.write).toHaveBeenCalledTimes(1)
})

it('adds unchanged body context to disambiguate a copy of the old passage in metadata', async () => {
  const f = fixture(`<metadata>${previous}</metadata>`)
  const edit = await f.prepare()
  f.setIndexed()
  await f.memory.apply(edit)
  expect(f.write).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ params: {
    name: 'edit', arguments: { uri, old_string: original, new_string: original.replace(previous, replacement),
      replace_all: false, wait: true, timeout: 35 },
  } }))
  expect((await f.memory.preview(uri)).content).toBe(original.replace(previous, replacement))
})

it('refuses to edit if even the complete visible body is present twice in the stored file', async () => {
  const f = fixture(`<metadata>${original}</metadata>`)
  await expect(f.prepare()).rejects.toMatchObject({ status: 'conflict' })
  expect(f.write).not.toHaveBeenCalled()
})

it('leaves stale revisions untouched and retries verification without editing twice', async () => {
  const stale = fixture()
  const staleEdit = await stale.prepare()
  stale.change()
  await expect(stale.memory.apply(staleEdit)).rejects.toMatchObject({ status: 'conflict' })
  expect(stale.write).not.toHaveBeenCalled()

  const lagging = fixture()
  const edit = await lagging.prepare()
  await expect(lagging.memory.apply(edit)).rejects.toMatchObject({ status: 'pending_verification', code: 'recall_pending' })
  lagging.setIndexed()
  await lagging.memory.apply(edit)
  expect(lagging.write).toHaveBeenCalledTimes(1)
})

it('blocks paths that OpenViking would rename before sending an edit', async () => {
  const f = fixture()
  const edit = await f.prepare()
  const originalWithSpace = { ...edit, uri: uri.replace('test.md', 'test case.md') }
  await expect(f.memory.prepare(originalWithSpace)).rejects.toMatchObject({ status: 'blocked', code: 'unsafe_uri' })
  await expect(f.memory.apply(originalWithSpace)).rejects.toMatchObject({ status: 'blocked', code: 'unsafe_uri' })
  expect(f.write).not.toHaveBeenCalled()
})

it('does not reapply an edit when the body changed during recall verification', async () => {
  const f = fixture()
  const edit = await f.prepare()
  await expect(f.memory.apply(edit)).rejects.toMatchObject({ code: 'recall_pending' })
  f.restore()
  await expect(f.memory.apply({ ...edit, errorCode: 'recall_pending' })).rejects.toMatchObject({ status: 'conflict' })
  expect(f.write).toHaveBeenCalledTimes(1)
})

it('reports an unexpected destination returned by OpenViking', async () => {
  const f = fixture(undefined, `Edited ${canonical.replace('test.md', 'different.md')} (120 bytes written).\nIndexing: vector=complete.`)
  await expect(f.memory.apply(await f.prepare())).rejects.toMatchObject({ status: 'blocked', code: 'redirected_uri' })
})

it('checks the audited visible version before staging a raw original edit', async () => {
  const f = fixture()
  const snapshot = await f.memory.snapshot(uri)
  const patch = { uri, digest: snapshot.digest, digestKind: 'visible' as const, previous, replacement, query: 'Test setup' }
  const edit = await f.memory.prepare(patch)
  expect(edit.digest).not.toBe(snapshot.digest)
  f.change()
  await expect(f.memory.prepare(patch)).rejects.toMatchObject({ status: 'conflict' })
  expect(f.write).not.toHaveBeenCalled()
})
