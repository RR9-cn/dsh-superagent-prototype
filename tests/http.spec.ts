import { expect, it } from 'vitest'
import { z } from 'zod'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Dreaming, type DreamingAgentPort, type DreamingEvidencePack } from '../src/app/dreaming/dreaming.ts'
import type { MemoryCleanupPort } from '../src/app/dreaming/duplicates.ts'
import type { MemoryMergePort } from '../src/app/dreaming/merges.ts'
import type { MemoryPort } from '../src/app/dreaming/memory.ts'
import { Effects } from '../src/app/effects.ts'
import { Store } from '../src/app/store.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { registerHttp } from '../src/app/http.ts'
import { PromptConflict } from '../src/app/prompts.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import type { HttpHost } from '../src/app/http.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SetupError } from '../src/setup.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
type Headers = Record<string, string | undefined>
const testEvidence: DreamingEvidencePack = { id: 'test-pack', project: 'test-project', evidence: [
  { id: 'early', kind: 'agent-report', source: 'test archive 1', text: 'An early report.' },
  { id: 'root', kind: 'tool-result', source: 'test archive 2', text: 'Test passed at the root.' },
  { id: 'subdirectory', kind: 'tool-result', source: 'test archive 3', text: 'Test failed in the subdirectory.' },
  { id: 'missing', kind: 'tool-result', source: 'test archive 4', text: 'Test failed when the config was missing.' },
] }
/** Mount management HTTP routes on a fake web server and return a request helper that includes default panel headers. */
function serve(runtime: Partial<Record<keyof HttpHost, unknown>>, host = '127.0.0.1') {
  let handler: Handler = async () => {}
  const ctx = { webServer: { host, port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), ...runtime } as unknown as HttpHost)
  return async (method: string, path: string, body?: unknown, headers: Headers = {}) => {
    let status = 0, text = ''
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const sent = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers }).filter(([,
      value]) => value !== undefined))
    const req = { method, url: `/orchestrator/api/${path}`, headers: sent, async *[Symbol.asyncIterator]() { yield* chunks } }
    await handler(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
}

it('resumes a queued Dreaming Agent batch after restart and publishes only its approved result', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dreaming-'))
  const path = join(directory, 'db.sqlite')
  let store = new Store(path)
  let effects = new Effects(store, new HealthBoard())
  const lifetime = new AbortController().signal
  const agent: DreamingAgentPort = {
    sessionId: (id, attempt) => `dreaming-${id}-${attempt}`,
    cancel: () => true,
    async advance({ before }, submit) {
      if (before?.action.includes('working directory')) {
        submit({ result: { outcome: 'no_change', reason: 'Already reflects the evidence' } })
      } else {
        const result = { outcome: 'revise', title: 'Test setup', action: 'Check the working directory.',
          verification: 'Both commands locate the configuration at the root.', reason: 'The later runs controlled the directory.',
          support: ['root', 'subdirectory'], counterexamples: ['missing'] }
        expect(() => submit({ result: { ...result, support: ['unrelated'] } })).toThrow(/evidence IDs/)
        expect(() => submit({ result: { ...result, support: ['early'] } })).toThrow(/tool result/)
        submit({ result })
        submit({ result: { ...result, action: 'Duplicate attempt' } })
      }
      return 'finished'
    },
  }
  try {
    const first = serve({ dreaming: new Dreaming(store, effects, agent, lifetime, () => testEvidence), configured: () => true })
    const started = await first('POST', 'dreaming/batches')
    expect(started).toMatchObject({ status: 200, body: { id: expect.any(String) } })
    expect(await first('POST', 'dreaming/batches')).toEqual(started)
    expect(await first('GET', 'dreaming')).toMatchObject({ body: { published: null, batches: [{ status: 'queued' }] } })
    await effects.drain()
    store.close()

    store = new Store(path)
    effects = new Effects(store, new HealthBoard())
    const call = serve({ dreaming: new Dreaming(store, effects, agent, lifetime, () => testEvidence), configured: () => true })
    effects.start()
    await effects.idle('dreaming')
    expect(effects.pending('dreaming')).toBe(false)
    const batch = `dreaming/batches/${started.body.id}`
    expect(await call('GET', 'dreaming')).toMatchObject({ body: { mode: 'dsh', published: null,
      batches: [{ status: 'ready', sessionId: expect.stringMatching(/-1$/),
        candidate: { review: 'pending', after: { action: 'Check the working directory.', support: ['root', 'subdirectory'], counterexamples: ['missing'] } } }] } })
    expect(await call('POST', `${batch}/publish`)).toMatchObject({ status: 409 })
    expect(await call('PUT', `${batch}/review`, { review: 'approved', after: {} })).toMatchObject({ status: 400 })
    expect(await call('PUT', `${batch}/review`, { review: 'approved' }, { origin: 'http://evil.example' })).toMatchObject({ status: 403 })
    expect(await call('PUT', `${batch}/review`, { review: 'rejected' })).toMatchObject({ status: 200 })
    expect(await call('POST', `${batch}/publish`)).toMatchObject({ status: 409 })
    expect(await call('PUT', `${batch}/review`, { review: 'approved' })).toMatchObject({ status: 200 })
    expect(await call('POST', `${batch}/publish`)).toEqual({ status: 200, body: { version: 1 } })
    expect(await call('POST', `${batch}/publish`)).toEqual({ status: 200, body: { version: 1 } })
    await call('POST', 'dreaming/batches')
    await effects.idle('dreaming')
    expect(await call('GET', 'dreaming')).toMatchObject({ body: {
      published: { version: 1, batchId: started.body.id, experience: { action: expect.stringContaining('working directory') } },
      batches: [{ status: 'no_change' }, { status: 'published' }],
    } })
  } finally {
    await effects.drain()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('retries a Dreaming session without a result using a new attempt and refuses late submissions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dreaming-retry-'))
  const store = new Store(join(directory, 'db.sqlite'))
  const effects = new Effects(store, new HealthBoard())
  const callbacks = new Map<string, (value: unknown) => void>()
  const agent: DreamingAgentPort = {
    sessionId: (id, attempt) => `dreaming-${id}-${attempt}`,
    cancel: () => true,
    async advance({ sessionId }, submit) {
      callbacks.set(sessionId, submit)
      if (sessionId.endsWith('-2')) submit({ result: { outcome: 'no_change', reason: 'No supported revision' } })
      return 'finished'
    },
  }
  try {
    const dreaming = new Dreaming(store, effects, agent, new AbortController().signal, () => testEvidence)
    effects.start()
    const { id } = dreaming.start()
    await effects.idle('dreaming')
    const first = dreaming.view().batches[0]!
    expect(first).toMatchObject({ status: 'failed', error: 'no_result', attempt: 1 })
    expect(dreaming.start()).toEqual({ id })
    await effects.idle('dreaming')
    expect(dreaming.view()).toMatchObject({ published: null, batches: [{ status: 'no_change', attempt: 2 }] })
    expect(() => callbacks.get(first.sessionId!)!({ result: { outcome: 'no_change', reason: 'Late' } })).toThrow(/no longer active/)
  } finally {
    await effects.drain()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('does not expose, publish or resume old demonstration data without a live evidence source', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dreaming-retired-'))
  const store = new Store(join(directory, 'db.sqlite'))
  const effects = new Effects(store, new HealthBoard())
  let ran = false
  try {
    store.set('dreaming-batch:old', { id: 'old', status: 'queued', pack: testEvidence })
    store.set('dreaming-snapshot:1', { version: 1, batchId: 'old' })
    store.set('dreaming-version', 1)
    effects.enqueue('dreaming', 'old', { batchId: 'old' })
    const dreaming = new Dreaming(store, effects, {
      sessionId: id => id,
      cancel: () => true,
      async advance() { ran = true; return 'finished' },
    }, new AbortController().signal)
    effects.start()
    await effects.idle('dreaming')
    const call = serve({ dreaming, configured: () => true })
    expect(await call('GET', 'dreaming')).toEqual({ status: 200,
      body: { mode: 'dsh', canStart: false, pack: null, batches: [], published: null, bulk: null } })
    expect(await call('POST', 'dreaming/batches')).toMatchObject({ status: 409 })
    expect(await call('POST', 'dreaming/batches/old/publish')).toMatchObject({ status: 404 })
    expect(effects.pending('dreaming')).toBe(false)
    expect(ran).toBe(false)
  } finally {
    await effects.drain()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('queues every archive, keeps repeat loads idempotent, and publishes each archive independently', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dreaming-bulk-'))
  const store = new Store(join(directory, 'db.sqlite'))
  const effects = new Effects(store, new HealthBoard())
  const received: string[] = []
  const packs = ['one', 'two'].map(id => ({ ...testEvidence, id, archiveUri: `viking://~/sessions/${id}/history/archive_001` }))
  try {
    const dreaming = new Dreaming(store, effects, {
      sessionId: (id, attempt) => `${id}-${attempt}`,
      cancel: () => true,
      async advance({ pack }, submit) {
        received.push(pack.id)
        submit({ result: { outcome: 'revise', reason: 'Verified', title: pack.id, action: 'Check the configured path',
          verification: 'The test ran', support: ['root'], counterexamples: [] } })
        return 'finished'
      },
    }, new AbortController().signal)
    const source = { packs, total: 3, skipped: ['failed archive'], unavailable: [] }
    expect(dreaming.startAll(source)).toMatchObject({ queued: 2, existing: 0 })
    expect(dreaming.startAll(source)).toMatchObject({ queued: 0, existing: 2 })
    effects.start()
    await effects.idle('dreaming')
    expect(received).toEqual(['one', 'two'])
    for (const batch of dreaming.view().batches) {
      dreaming.review(batch.id, 'approved')
      expect(dreaming.publish(batch.id)).toEqual({ version: 1 })
    }
    expect(dreaming.startAll(source)).toMatchObject({ queued: 0, existing: 2 })
  } finally {
    await effects.drain()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('requires fresh approval of the exact OpenViking patch and records a single verified write', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dreaming-memory-approval-'))
  const store = new Store(join(directory, 'db.sqlite'))
  const effects = new Effects(store, new HealthBoard())
  let writes = 0
  const memory: MemoryPort = {
    find: async () => [],
    preview: async () => ({ uri: '', content: '', digest: '' }),
    prepare: async patch => ({ ...patch, updatedDigest: 'new', status: 'staged' }),
    apply: async () => { writes++ },
  }
  try {
    const dreaming = new Dreaming(store, effects, {
      sessionId: id => id, cancel: () => true,
      async advance(_input, submit) {
        submit({ result: { outcome: 'revise', title: 'Config', action: 'Inspect the directory', reason: 'Verified',
          verification: 'The test ran', support: ['root'], counterexamples: [] } })
        return 'finished'
      },
    }, new AbortController().signal, () => testEvidence)
    effects.start()
    const { id } = dreaming.start()
    await effects.idle('dreaming')
    dreaming.review(id, 'approved')
    await dreaming.stageMemory(id, { uri: 'viking://~/memories/experiences/test.md', digest: 'old',
      previous: 'Old conclusion', replacement: 'Corrected conclusion', query: 'Config' }, memory)
    await expect(dreaming.updateMemory(id, memory)).rejects.toThrow(/Approve the exact memory correction/)
    expect(writes).toBe(0)
    dreaming.review(id, 'approved')
    await expect(dreaming.updateMemory(id, memory)).resolves.toMatchObject({ status: 'verified' })
    await expect(dreaming.updateMemory(id, memory)).resolves.toMatchObject({ status: 'verified' })
    expect(writes).toBe(1)
    expect(dreaming.view().batches[0]).toMatchObject({ candidate: { memory: { status: 'verified' } } })
  } finally {
    await effects.drain()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('reports the failed check stage, leaves an ambiguous match alone, and updates the exact original memory', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dreaming-memory-click-'))
  const store = new Store(join(directory, 'db.sqlite'))
  const effects = new Effects(store, new HealthBoard())
  const uri = 'viking://~/memories/experiences/test.md'
  const other = 'viking://~/memories/preferences/unrelated.md'
  const previous = 'Always switch the wrapper.'
  const written: string[] = []
  const memory: MemoryPort = {
    find: async () => [{ uri, excerpt: '' }, { uri: other, excerpt: '' }],
    preview: async target => ({ uri: target, content: target === uri ? previous : 'Unrelated preference', digest: 'reviewed' }),
    prepare: async patch => {
      expect(patch).toMatchObject({ uri, previous, digest: 'reviewed', replacement: expect.stringContaining('test archive 2') })
      return { ...patch, updatedDigest: 'new', status: 'staged' }
    },
    apply: async edit => { written.push(edit.uri) },
  }
  try {
    let ambiguous = true
    let failMatching = true
    const dreaming = new Dreaming(store, effects, {
      sessionId: id => id, cancel: () => true,
      async advance(_input, submit) {
        submit({ result: { outcome: 'revise', title: 'Config', action: 'Inspect the directory', reason: 'Verified',
          verification: 'The test ran', support: ['root'], counterexamples: [] } })
        return 'finished'
      },
      async matchMemory({ targets }) {
        expect(targets).toMatchObject([{ target: 1, uri }, { target: 2, uri: other }])
        if (failMatching) throw new Error('Invalid agent response')
        return ambiguous ? { outcome: 'ambiguous', reason: 'No unique match' }
          : { outcome: 'update', target: 1, previous, replacement: 'Inspect the working directory first.' }
      },
    }, new AbortController().signal, () => testEvidence)
    effects.start()
    const { id } = dreaming.start()
    await effects.idle('dreaming')
    await expect(dreaming.correctMemory(id, { ...memory, preview: async () => { throw new Error('Connection lost') } }))
      .rejects.toThrow('Connection lost')
    expect(dreaming.view().batches[0]).toMatchObject({ candidate: { review: 'pending', memoryMatch: { status: 'failed', stage: 'read' } } })
    await expect(dreaming.correctMemory(id, memory)).rejects.toThrow('Invalid agent response')
    expect(dreaming.view().batches[0]).toMatchObject({ candidate: { review: 'pending', memoryMatch: { status: 'failed', stage: 'match' } } })
    failMatching = false
    await expect(dreaming.correctMemory(id, memory)).resolves.toMatchObject({ status: 'ambiguous' })
    expect(written).toEqual([])
    ambiguous = false
    await expect(dreaming.correctMemory(id, memory)).resolves.toMatchObject({ status: 'verified', uri })
    expect(dreaming.view().batches[0]).toMatchObject({ candidate: { review: 'approved', memory: { status: 'verified' } } })
    await dreaming.correctMemory(id, memory)
    expect(written).toEqual([uri])
  } finally {
    await effects.drain()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('audits the existing memory before proposing a patch or recommending removal', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dreaming-audit-'))
  const store = new Store(join(directory, 'db.sqlite'))
  const effects = new Effects(store, new HealthBoard())
  const uri = 'viking://~/memories/experiences/runner.md'
  const previous = 'Only the wrapper can run the compiler.'
  const digest = 'original'
  const target = { uri, digest, content: previous }
  const removeTarget = { ...target, uri: uri.replace('runner', 'remove') }
  const noEvidence = { ...target, uri: uri.replace('runner', 'insufficient') }
  const updated: string[] = []
  const memory: MemoryPort = {
    find: async () => { throw new Error('The audit already identified the original memory') },
    preview: async () => { throw new Error('The audit already froze the original text') },
    prepare: async patch => {
      expect(patch).toMatchObject({ uri, digest, previous, replacement: expect.stringContaining('test archive 2') })
      return { ...patch, updatedDigest: 'updated', status: 'staged' }
    },
    apply: async edit => { updated.push(edit.uri) },
  }
  try {
    const dreaming = new Dreaming(store, effects, {
      sessionId: id => id, cancel: () => true,
      async advance({ pack, before, sessionId }, submit) {
        expect(sessionId).toMatch(/^audit-/)
        expect(before).toBeNull()
        expect(pack.target?.content).toBe(previous)
        expect(pack.target?.uri).not.toBe(noEvidence.uri)
        const evidence = { reason: 'Historical tool run contradicted the original.', support: ['root'], counterexamples: [] }
        submit({ result: pack.target?.uri === removeTarget.uri ? { outcome: 'remove', ...evidence } :
          { outcome: 'revise', ...evidence, title: 'Compiler runner', verification: 'Run directly', previous,
            replacement: 'The compiler also runs directly from the project root.' } })
        return 'finished'
      },
    }, new AbortController().signal)
    effects.start()
    dreaming.startAll({ packs: [{ ...testEvidence, target }, { ...testEvidence, target: removeTarget },
      { ...testEvidence, target: noEvidence, evidence: [] }], total: 3, skipped: [], unavailable: [], archiveTotal: 2 })
    await effects.idle('dreaming')
    const results = dreaming.view().batches
    const revised = results.find(batch => batch.pack.target?.uri === uri)!
    const removed = results.find(batch => batch.pack.target?.uri === removeTarget.uri)!
    expect(results.find(batch => batch.pack.target?.uri === noEvidence.uri)).toMatchObject({ status: 'no_change', finding: 'insufficient' })
    expect(revised).toMatchObject({ status: 'ready', candidate: { audit: { outcome: 'revise', patch: { uri, previous } }, review: 'pending' } })
    expect(removed).toMatchObject({ status: 'ready', candidate: { audit: { outcome: 'remove' } } })
    expect(updated).toEqual([])
    await expect(dreaming.correctMemory(removed.id, memory)).rejects.toThrow('did not recommend a revision')
    await expect(dreaming.correctMemory(revised.id, memory)).resolves.toEqual({ uri, status: 'verified' })
    expect(updated).toEqual([uri])
  } finally {
    await effects.drain()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('checks both duplicate versions, deletes only the confirmed old URI, and retries verification without deleting again', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dreaming-deduplicate-'))
  const store = new Store(join(directory, 'db.sqlite'))
  const effects = new Effects(store, new HealthBoard())
  const keep = { uri: 'viking://~/memories/experiences/test_setup.md', digest: 'same', content: 'Check the configuration.' }
  const old = { ...keep, uri: 'viking://~/memories/experiences/test setup.md' }
  const entries = new Map([[keep.uri, keep], [old.uri, old]])
  const deleted: string[] = []
  let indexed = false
  const memory: MemoryCleanupPort = {
    async readForDeletion(uri) { return entries.get(uri) ?? null },
    async deleteExact(uri) { deleted.push(uri); entries.delete(uri) },
    async verifyRemoval() { return indexed },
  }
  try {
    const dreaming = new Dreaming(store, effects, { sessionId: id => id, cancel: () => true, async advance() { return 'finished' } },
      new AbortController().signal)
    const scan = () => dreaming.scanDuplicates({ targets: [old, keep], total: 2, skipped: [], unavailable: [] })
    const [id] = scan().ids
    expect(id).toBeTruthy()
    const changed = { ...keep, digest: 'changed' }
    entries.set(keep.uri, changed)
    await expect(dreaming.removeDuplicate(id!, memory)).resolves.toEqual({ status: 'blocked' })
    expect(deleted).toEqual([])
    entries.set(keep.uri, keep)

    const refreshed = { ...old, content: 'Check the directory.', digest: 'another' }
    const retained = { ...keep, content: refreshed.content, digest: refreshed.digest }
    entries.set(keep.uri, retained)
    entries.set(old.uri, refreshed)
    const [otherId] = dreaming.scanDuplicates({ targets: [refreshed, retained], total: 2, skipped: [], unavailable: [] }).ids
    await expect(dreaming.removeDuplicate(otherId!, memory)).resolves.toEqual({ status: 'pending_verification' })
    indexed = true
    await expect(dreaming.removeDuplicate(otherId!, memory)).resolves.toEqual({ status: 'verified' })
    expect(deleted).toEqual([old.uri])
    expect(entries.get(keep.uri)).toEqual(retained)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it.each(['merge', 'changed', 'skip', 'bad-evidence'])('automatically processes complementary memory candidates (%s)', async outcome => {
  const directory = mkdtempSync(join(tmpdir(), 'dreaming-merge-'))
  const store = new Store(join(directory, 'db.sqlite'))
  let now = Date.parse('2026-11-26T17:00:00.000Z')
  const effects = new Effects(store, new HealthBoard(), () => now)
  let assessments = 0
  const dreaming = new Dreaming(store, effects, {
    sessionId: id => id, cancel: () => true, async advance() { return 'finished' },
    async assessMerge({ keep, source }) {
      assessments++
      if (outcome === 'skip') return { outcome: 'skip', reason: 'Incompatible guidance' }
      return { outcome: 'merge', reason: 'Complementary steps',
        keepPassage: keep.content.split('\n')[0]!,
        sourcePassage: outcome === 'bad-evidence' ? 'Unsupported quotation.' : source.content.split('\n')[0]! }
    },
  }, new AbortController().signal)
  const root = 'viking://~/memories/experiences/'
  const keep = { uri: root + 'test_config_paths.md', digest: 'keep',
    content: 'Configuration is read from the working directory.\n\nviking://~/sessions/session1/history/archive_001/messages.jsonl#L1' }
  const old = { uri: root + 'test config paths.md', digest: 'old',
    content: 'The wrapper prints its resolved configuration path.\n\nviking://~/sessions/session2/history/archive_002/messages.jsonl#L3' }
  const entries = new Map([[keep.uri, keep], [old.uri, old]])
  const actions: string[] = []
  let before = false
  let after = false
  const memory: MemoryPort & MemoryMergePort = {
    async find() { return [] },
    async preview() { return keep },
    async prepare(patch) { return { ...patch, updatedDigest: 'merged', status: 'staged' } },
    async apply(edit) { actions.push('write'); entries.set(keep.uri, { ...keep, digest: 'merged', content: edit.replacement }) },
    async readForDeletion(uri) { return entries.get(uri) ?? null },
    async deleteExact(uri) { actions.push('delete'); expect(uri).toBe(old.uri); entries.delete(uri) },
    async verifyRemoval() { throw new Error('Unexpected duplicate verification') },
    async recallsMerge(plan, sourceAbsent) {
      expect(plan.queries).toHaveLength(2)
      expect(plan.queries[1]).toContain('resolved configuration path')
      actions.push(sourceAbsent ? 'recall after' : 'recall before')
      if (before && !sourceAbsent && outcome === 'changed') entries.set(old.uri, { ...old, digest: 'changed' })
      return sourceAbsent ? after : before
    },
  }
  try {
    const other = { ...old, uri: 'viking://~/peers/other/memories/experiences/test_config_paths.md' }
    expect(dreaming.scanDuplicates({ targets: [keep, old, other], total: 3, skipped: [], unavailable: [] }).ids).toEqual([])
    const plans = dreaming.view().merges!
    expect(plans).toMatchObject([{ keep: { uri: keep.uri }, source: { uri: old.uri }, status: 'proposed' }])
    expect(actions).toEqual([])
    // Enabling automatic maintenance also resumes candidates saved before startup.
    dreaming.enableMaintenance(memory, async () => { throw new Error('Automatic audit is not due') }, () => false, () => now)
    effects.start()
    await effects.idle('dreaming-merge')
    const status = () => dreaming.view().merges![0]!.status
    if (outcome === 'skip' || outcome === 'bad-evidence') {
      expect(status()).toBe('skipped')
      expect(actions).toEqual([])
      return
    }
    expect(status()).toBe('waiting_for_recall')
    expect(actions).toEqual(['write', 'recall before'])
    expect(entries.get(keep.uri)!.content).toContain(keep.content)
    expect(entries.get(keep.uri)!.content).toContain(old.content)
    expect(entries.get(keep.uri)!.content).toContain(old.uri)
    expect(entries.get(old.uri)).toEqual(old)
    before = true
    now += 60_000
    await effects.idle('dreaming-merge')
    if (outcome === 'changed') {
      expect(status()).toBe('blocked')
      expect(actions).toEqual(['write', 'recall before', 'recall before'])
      return
    }
    expect(status()).toBe('checking_removal')
    after = true
    now += 60_000
    await effects.idle('dreaming-merge')
    expect(status()).toBe('verified')
    expect(assessments).toBe(1)
    expect(actions).toEqual(['write', 'recall before', 'recall before', 'delete', 'recall after', 'recall after'])
  } finally {
    await effects.drain()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('runs automatic corrections and duplicate cleanup at 02:00 Beijing time', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dreaming-maintenance-'))
  const store = new Store(join(directory, 'db.sqlite'))
  let now = Date.parse('2026-11-26T17:59:59.000Z')
  const effects = new Effects(store, new HealthBoard(), () => now)
  const root = 'viking://~/memories/experiences/'
  const previous = 'Use the wrapper.'
  const target = { uri: root + 'revision.md', digest: 'baseline', content: previous }
  const keep = { uri: root + 'test_setup.md', digest: 'same', content: 'Check configuration.' }
  const remove = { ...keep, uri: root + 'test setup.md' }
  const removed: string[] = []
  const applied: string[] = []
  const memory: MemoryPort & MemoryMergePort = {
    async readForDeletion(uri) { return uri === keep.uri ? keep : removed.includes(uri) ? null : remove },
    async deleteExact(uri) { removed.push(uri) },
    async verifyRemoval() { return true },
    async recallsMerge() { throw new Error('No assessed merge') },
    async find() { throw new Error('The audit is already bound to an original URI') },
    async preview() { return target },
    async prepare(patch) { return { ...patch, updatedDigest: 'updated', status: 'staged' } },
    async apply(edit) { applied.push(edit.uri) },
  }
  try {
    const dreaming = new Dreaming(store, effects, {
      sessionId: id => id, cancel: () => true,
      async advance(_input, submit) {
        submit({ result: { outcome: 'revise', title: 'Runner', verification: 'Run directly', reason: 'Observed',
          previous, replacement: 'Run from the project root.', support: ['root'], counterexamples: [] } })
        return 'finished'
      },
    }, new AbortController().signal)
    let scans = 0
    dreaming.enableMaintenance(memory, async () => {
      scans++
      return { packs: [{ ...testEvidence, target }, ...[keep, remove].map(target => ({ ...testEvidence, target, evidence: [] }))],
        total: 3, skipped: [], unavailable: [], archiveTotal: 1 }
    }, () => false, () => now)
    effects.start()
    await effects.idle()
    expect(scans).toBe(0)
    expect(dreaming.view().maintenance).toMatchObject({ active: false, nextAt: '2026-11-26T18:00:00.000Z' })
    now += 1000
    await effects.idle()
    now += 1000
    await effects.idle()
    expect(dreaming.view().maintenance).toMatchObject({
      active: false, revised: 1, removed: 1, unresolved: 0, nextAt: '2026-11-27T18:00:00.000Z',
    })
    expect(applied).toEqual([target.uri])
    expect(removed).toEqual([remove.uri])
    expect(scans).toBe(1)
  } finally {
    await effects.drain()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('answers each kind of failure with its own status', async () => {
  const saves: unknown[] = []
  const call = serve({
    store: { tickets: { get: () => undefined }, blockRevision: () => 0 },
    sources: { instances: () => [{ id: 'feishu' }] },
    settings: { save: async (...args: unknown[]) => {
      saves.push(args)
      if (args[1] === 'stale') throw new SettingsConflict('Settings changed. Reload before saving.')
      if (args[1] === 'invalid') z.object({ maxWorkers: z.number() }).parse({})
      if (args[1] === 'refused') throw new SetupError('feishuNoBot')
      if (args[1] === 'broken') throw new Error('disk full')
      return { saved: true, revision: 1, restarting: false }
    } },
  })
  expect(await call('PUT', 'settings/executor', { value: 'stale', revision: 0 })).toMatchObject({ status: 409 })
  expect(await call('PUT', 'settings/executor', { value: 'invalid', revision: 0 })).toMatchObject({ status: 400, body: { issues: [{ path: 'maxWorkers' }] } })
  expect(await call('PUT', 'settings/source:feishu', { value: 'refused', revision: 0 })).toMatchObject({ status: 400, body: { setup: { code: 'feishuNoBot', place: 'feishu' } } })
  expect(await call('PUT', 'settings/executor', { value: 'broken', revision: 0 })).toEqual({ status: 500, body: { error: 'disk full' } })
  // Block names are validated before calling settings.save: reject unknown blocks or non-existent Sources.
  expect(await call('PUT', 'settings/pause', { value: {}, revision: 0 })).toMatchObject({ status: 400 })
  expect(await call('PUT', 'settings/source:github', { value: {}, revision: 0 })).toEqual({ status: 404, body: { error: 'Source not found' } })
  expect(saves).toHaveLength(4)
  expect(await call('POST', 'tickets/t9/retry')).toEqual({ status: 404, body: { error: 'Ticket not found' } })
  expect(await call('GET', 'nothing/here')).toEqual({ status: 404, body: { error: 'Unknown operation' } })
  expect(await call('POST', 'executor/pause', 'not json')).toEqual({ status: 400, body: { error: 'The request body is not JSON' } })
})

it('decodes path parameters and parses each route\'s query', async () => {
  const seen: unknown[] = []
  const call = serve({
    store: { settings: () => SettingsSchema.parse({}),
      read: { decisions: (filter: unknown, offset: number, limit: number) => { seen.push({ filter, offset, limit }); return { items: [], more: false } } } },
    links: () => () => ({ url: '', label: { zh: '', en: '' } }),
    engine: { unsubscribe: (key: string) => { seen.push(key); return true } },
    sessions: { delivery: async () => 'injected' },
  })
  expect(await call('POST', `threads/${encodeURIComponent('feishu:oc_1:om/root')}/unsubscribe`)).toMatchObject({ status: 200, body: { context_delivery: 'injected' } })
  // Invalid offsets default to 0, and limits above the route maximum are clamped.
  expect(await call('GET', 'decisions?kind=accept%2Creopen&limit=500&offset=x&window=24h')).toEqual({ status: 200, body: { items: [], next_offset: null } })
  expect(seen).toEqual(['feishu:oc_1:om/root', { filter: { kinds: ['accept', 'reopen'], since: expect.any(String) }, offset: 0, limit: 200 }])
})

it('answers only a same-origin request from the panel on the loopback address', async () => {
  const call = serve({ sessions: { delivery: async () => 'injected' }, engine: { unsubscribe: () => true } })
  const post = (headers: Headers) => call('POST', 'threads/github%3A1/unsubscribe', undefined, headers)
  for (const headers of [{ 'x-orchestrator-request': undefined }, { host: 'evil.example:3082' }, { host: '127.0.0.1:9999' },
    { origin: 'http://evil.example' }, { host: 'localhost:3082', origin: 'http://127.0.0.1:3082' }]) {
    expect(await post(headers), JSON.stringify(headers)).toEqual({ status: 403,
      body: { error: 'Same-origin management request required' } })
  }
  expect(await post({ host: 'localhost:3082', origin: 'http://localhost:3082' })).toMatchObject({ status: 200 })
  // Management routes require a loopback Web server.
  expect(() => serve({}, '0.0.0.0')).toThrow('Orchestrator management requires a loopback Web server')
})

it('answers a prompt save that lost a race with 409, and a settings body over 128 KiB with 400', async () => {
  const saves: unknown[] = []
  const call = serve({
    machine: { promptMaxChars: { get: () => 100_000 } },
    store: { atomic: (work: () => unknown) => work(), blockRevision: () => 0 },
    prompts: { save: () => { throw new PromptConflict('Prompt version changed to 3; compare the latest version before saving') } },
    sessions: { notify: () => {}, delivery: async () => 'injected' },
    settings: { save: async (...args: unknown[]) => { saves.push(args); return { saved: true, revision: 1, restarting: false } } },
  })
  expect(await call('PUT', 'prompts', { config: {}, baseRevision: 2 }))
    .toEqual({ status: 409, body: { error: 'Prompt version changed to 3; compare the latest version before saving' } })
  const value = { prepare: 'x'.repeat(128 * 1024) }
  expect(await call('PUT', 'settings/executor', { value, revision: 0 })).toEqual({ status: 400,
    body: { error: `Request exceeds ${128 * 1024} bytes` } })
  expect(saves).toEqual([])
})
