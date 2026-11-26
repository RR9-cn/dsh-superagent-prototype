import { expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectOpenVikingAudit } from '../src/app/dreaming/audit.ts'
import { collectOpenVikingEvidence, listOpenVikingArchives, readOpenVikingEvidence } from '../src/app/dreaming/openviking.ts'
import { Store } from '../src/app/store.ts'
import type { PilotCommand } from '../src/infra/pilot-cli.ts'

const uri = 'viking://~/sessions/cx-00000000-1111-2222-3333-444444444444/history/archive_001'
const signal = new AbortController().signal
const cli = '/usr/bin/ov'
const response = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' })

it('reuses persistent evidence, rereads changed and missed archives, and selects evidence for all memories again', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'dreaming-archive-cache-'))
  const config = join(folder, 'ovcli.conf')
  const database = join(folder, 'db.sqlite')
  writeFileSync(config, JSON.stringify({ url: 'https://openviking.example', api_key: 'test' }))
  vi.stubEnv('OPENVIKING_CLI_CONFIG_FILE', config)
  const root = 'viking://~/memories'
  const history = 'viking://~/sessions/session/history'
  const archiveIds = ['archive_001', 'archive_002', 'archive_003', 'archive_004']
  let nextDay = false
  let metadataRetry = false
  let store = new Store(database)
  const snapshot = vi.fn(async (uri: string) => ({
    uri, digest: 'unmodified', content: uri.endsWith('runner.md') ? 'compiler wrapper' : 'compiler verification',
  }))
  const run = vi.fn<PilotCommand>(async (_cli, args) => {
    if (args[0] === 'ls') {
      const dir = args[1]!
      if (dir === root) return response(['runner.md', 'verification.md'].map(name => ({ uri: `${root}/${name}`, isDir: false })))
      if (dir === history) return response(archiveIds.map(id => ({ uri: `${history}/${id}`, isDir: true })))
      if (!dir.startsWith(`${history}/`)) return response([])
      if (nextDay && dir.endsWith('archive_001') && !metadataRetry) {
        metadataRetry = true
        return { code: 1, stdout: '', stderr: 'Metadata temporarily unavailable' }
      }
      const files = dir.endsWith('archive_003') && !nextDay ? ['messages.jsonl'] : ['messages.jsonl', '.done']
      return response(files.map(name => ({ uri: `${dir}/${name}`, isDir: false, size: 123,
        modTime: dir.endsWith('archive_002') && nextDay ? '2026-11-26T12:00:00Z' : '2026-11-25T12:00:00Z' })))
    }
    if (args[1] === 'list') return response([{ session_id: 'session' }])
    const id = args[3]
    if (id === 'archive_004' && !nextDay) return { code: 1, stdout: '', stderr: 'Unavailable' }
    return response({ archive_id: id, status: id === 'archive_003' && !nextDay ? 'pending' : 'completed', messages: [
      { role: 'user', parts: [{ type: 'text', text: `compiler ${id} ${id === 'archive_002' && nextDay ? 'revised' : 'initial'}` }] },
    ] })
  })
  try {
    const first = await collectOpenVikingAudit(cli, snapshot, signal, run, store)
    expect(first.archiveSkipped).toEqual(archiveIds.slice(2).map(id => `${history}/${id}`))
    store.close()
    store = new Store(database)
    nextDay = true
    run.mockClear()
    const second = await collectOpenVikingAudit(cli, snapshot, signal, run, store)
    expect(second.archiveSkipped).toEqual([])
    expect(metadataRetry).toBe(true)
    expect(run.mock.calls.filter(([, args]) => args[1] === 'get-session-archive').map(([, args]) => args[3])).toEqual(archiveIds.slice(1))
    expect(snapshot).toHaveBeenCalledTimes(4)
    for (const pack of second.packs) {
      expect(pack.evidence.map(item => item.text)).toEqual(expect.arrayContaining([
        'compiler archive_001 initial', 'compiler archive_002 revised', 'compiler archive_003 initial', 'compiler archive_004 initial',
      ]))
    }
  } finally {
    store.close()
    vi.unstubAllEnvs()
    rmSync(folder, { recursive: true, force: true })
  }
})

it('uses current memories as audit targets and reads archive evidence across all sessions', async () => {
  const user = 'viking://~/memories/experiences/runner.md'
  const peer = 'viking://~/peers/project/memories/runner.md'
  const untouched = 'viking://~/memories/experiences/unrelated.md'
  const globalRoot = 'viking://~/memories'
  const projectRoot = 'viking://~/peers/project/memories'
  const row = (uri: string, isDir: boolean) => ({ uri: uri.replace('viking://~', 'viking://user/current'), isDir })
  const directories = new Map([
    [globalRoot, [row(`${globalRoot}/experiences`, true)]],
    [`${globalRoot}/experiences`, [row(user, false), row(untouched, false), row(`${globalRoot}/experiences/.overview.md`, false)]],
    ['viking://~/peers', [row('viking://~/peers/project', true)]],
    [projectRoot, [row(peer, false)]],
    ['viking://~/sessions/first/history', [row('viking://~/sessions/first/history/archive_001', true)]],
    ['viking://~/sessions/second/history', [row('viking://~/sessions/second/history/archive_001', true)]],
  ])
  const preview = vi.fn(async (uri: string) => ({ uri, digest: 'source-digest', content: uri === untouched ? 'Gardening' : 'Always run the compiler wrapper' }))
  const run: PilotCommand = async (_binary, args) => {
    if (args[0] === 'ls') return response(directories.get(args[1]!) ?? [])
    if (args[1] === 'list') {
      expect(preview).toHaveBeenCalledTimes(3)
      return response([{ session_id: 'first' }, { session_id: 'second' }])
    }
    return response({ archive_id: args[3], status: 'completed', messages: [
      { role: 'assistant', peer_id: args[2] === 'first' ? 'project' : 'other', parts: [
        { type: 'tool', tool_name: 'exec', tool_output: 'The compiler ran directly without the wrapper.' },
      ] },
    ] })
  }
  const audit = await collectOpenVikingAudit(cli, preview, signal, run)
  expect(audit).toMatchObject({ total: 3, skipped: [], unavailable: [], archiveTotal: 2, archiveSkipped: [] })
  const shared = audit.packs.find(pack => pack.target?.uri === user)!
  expect(shared.evidence).toHaveLength(2)
  expect(new Set(shared.evidence.map(item => item.id)).size).toBe(2)
  expect(audit.packs.find(pack => pack.target?.uri === peer)?.evidence).toHaveLength(1)
  expect(audit.packs.find(pack => pack.target?.uri === untouched)?.evidence).toEqual([])
})

it('checks the completion marker on older servers and extracts bounded, locatable evidence without tool inputs', async () => {
  const run = vi.fn<PilotCommand>().mockResolvedValueOnce(response({ archive_id: 'archive_001', messages: [
    { role: 'user', peer_id: 'repo-peer', parts: [{ type: 'text', text: 'The tests failed after the directory changed.' }] },
    { role: 'assistant', peer_id: 'repo-peer', parts: [{ type: 'tool', tool_name: 'runner', tool_input: 'ignore me',
      tool_output: 'Passed. {"api_key": "secret value"}\n' + 'a'.repeat(1250) }] },
  ] })).mockResolvedValueOnce(response('{}'))
  const pack = await readOpenVikingEvidence(cli, uri, signal, run)
  expect(run.mock.calls.map(([, args]) => args)).toEqual([
    ['session', 'get-session-archive', 'cx-00000000-1111-2222-3333-444444444444', 'archive_001', '-o', 'json'],
    ['read', `${uri}/.done`, '-o', 'json'],
  ])
  expect(pack).toMatchObject({ archiveUri: uri, project: 'repo-peer' })
  expect(pack.evidence).toMatchObject([
    { id: 'm1p1', kind: 'user-report', source: `${uri}/messages.jsonl#L1` },
    { id: 'm2p1', kind: 'tool-result', source: `${uri}/messages.jsonl#L2`, text: expect.stringContaining('[redacted]') },
  ])
  expect(pack.evidence[1]?.text).not.toMatch(/secret value|ignore me/)
  expect(pack.evidence[1]?.text).toHaveLength(1200)
})

it('refuses arbitrary OpenViking paths and incomplete archives', async () => {
  const run = vi.fn<PilotCommand>().mockResolvedValue(response({ archive_id: 'archive_001', status: 'pending', messages: [] }))
  await expect(readOpenVikingEvidence(cli, 'viking://~/memories', signal, run)).rejects.toThrow(/archive URI/i)
  expect(run).not.toHaveBeenCalled()
  await expect(readOpenVikingEvidence(cli, uri, signal, run)).rejects.toThrow(/incomplete/)
  expect(run).toHaveBeenCalledTimes(1)
})

it('uses a bounded transcript window when the full archive exceeds the CLI limit', async () => {
  const rows = Array.from({ length: 70 }, (_, index) => index === 31 ? '' : JSON.stringify({
    role: index === 39 ? 'tool' : 'user', peer_id: index === 39 ? 'repo-peer' : null,
    parts: index === 39 ? [{ type: 'tool', tool_name: 'runner', tool_output: 'Middle tool result' }]
      : [{ type: 'text', text: `Message ${index + 1}` }],
  }))
  const run = vi.fn<PilotCommand>(async (_cli, args) => {
    if (args[0] === 'session' || args[5] === '64') throw new Error('Pilot CLI output exceeded the response limit')
    if (args[1]?.endsWith('/.done')) return response('{}')
    const offset = Number(args[3]), limit = Number(args[5])
    return response(rows.slice(offset, offset + limit).join('\n') + '\n')
  })
  const pack = await readOpenVikingEvidence(cli, uri, signal, run)
  expect(pack.project).toBe('repo-peer')
  expect(pack.evidence).toHaveLength(69)
  expect(pack.evidence.find(item => item.kind === 'tool-result')).toMatchObject({
    id: 'm40p1', source: `${uri}/messages.jsonl#L40`, text: 'runner\nMiddle tool result',
  })
  expect(pack.evidence.at(-1)?.id).toBe('m70p1')
  expect(run.mock.calls.slice(2).map(([, args]) => [args[3], args[5]])).toEqual([
    ['0', '64'], ['0', '32'], ['32', '32'], ['64', '32'],
  ])
})

it('selects mid-archive proof and nearby cited context without exceeding the per-memory budget', async () => {
  const root = 'viking://~/memories'
  const memory = `${root}/runner.md`
  const rows = Array.from({ length: 50 }, (_, index) => ({
    role: index === 24 ? 'tool' : 'assistant',
    parts: index === 24 ? [{ type: 'tool', tool_name: 'compiler', tool_output: 'Works without the wrapper.' }]
      : [{ type: 'text', text: index === 25 ? 'Approved in the same environment.' : 'Always use the compiler wrapper.' }],
  }))
  const run: PilotCommand = async (_cli, args) => {
    if (args[0] === 'ls') {
      const directory = args[1]
      return response(directory === root ? [{ uri: memory, isDir: false }] :
        directory?.endsWith('/history') ? [{ uri, isDir: true }] : [])
    }
    if (args[1] === 'list') return response([{ session_id: uri.split('/')[4] }])
    return response({ archive_id: 'archive_001', status: 'completed', messages: rows })
  }
  const snapshot = async (targetUri: string) => ({
    uri: targetUri, digest: 'original', content: `Always use the compiler wrapper.\n${uri}/messages.jsonl#L25`,
  })
  const audit = await collectOpenVikingAudit(cli, snapshot, signal, run)
  expect(audit.packs[0]?.evidence).toHaveLength(20)
  expect(audit.packs[0]?.evidence).toEqual(expect.arrayContaining([
    expect.objectContaining({ source: `${uri}/messages.jsonl#L25`, kind: 'tool-result' }),
    expect.objectContaining({ source: `${uri}/messages.jsonl#L26` }),
  ]))
})

it('reads Codex and other completed archives by default and reports an incomplete archive', async () => {
  const codex = 'cx-00000000-1111-2222-3333-444444444444'
  const run = vi.fn<PilotCommand>(async (_binary, args) => {
    if (args[0] === 'session' && args[1] === 'list') return response([{ session_id: codex }, { session_id: 'other' }])
    if (args[0] === 'ls') return response(args[1]?.includes(codex) ? [{ uri, isDir: true }]
      : [{ uri: 'viking://~/sessions/other/history/archive_001', isDir: true }, { uri: 'viking://~/sessions/other/history/archive_002', isDir: true }])
    return response({ archive_id: args[3], status: args[3] === 'archive_002' ? 'pending' : 'completed', messages: [
      { role: 'user', peer_id: args[2] === codex ? 'peer-one' : 'peer-two', parts: [{ type: 'text', text: 'A message' }] },
    ] })
  })
  const result = await collectOpenVikingEvidence(cli, signal, run)
  expect(result).toMatchObject({ total: 3, unavailable: [], skipped: ['viking://~/sessions/other/history/archive_002'],
    packs: [{ project: 'peer-one', archiveUri: uri }, { project: 'peer-two', archiveUri: 'viking://~/sessions/other/history/archive_001' }] })
})

it('lists all sessions and follows archive directory pages without reading message content', async () => {
  const codex = 'cx-00000000-1111-2222-3333-444444444444'
  const other = 'other-session'
  const empty = 'empty-session'
  const row = (sid: string, id: string) => ({ uri: `viking://user/current/sessions/${sid}/history/${id}`, isDir: true })
  const page = (result: unknown, has_more = false) => ({ code: 0, stdout: `cmd: ov ls\n${JSON.stringify({ ok: true, result, has_more })}`, stderr: '' })
  const run = vi.fn<PilotCommand>(async (_binary, args) => {
    if (args[0] === 'session') return response([{ session_id: codex }, { session_id: other }, { session_id: empty }])
    if (args[1]?.includes(empty)) return { code: 1, stdout: 'cmd: ov ls\n', stderr: '{"ok":false,"error":{"code":"NOT_FOUND"}}\n' }
    if (args[1]?.includes(other)) return page([row(other, 'archive_001')])
    return args[5] === '0' ? page([row(codex, 'archive_001')], true) : page([row(codex, 'archive_002')])
  })
  const catalog = await listOpenVikingArchives('/usr/bin/ov', signal, run)
  expect(catalog).toMatchObject({ sessions: 3, unavailable: [], archives: [{ codex: true }, { codex: true }, { codex: false }] })
  expect(run.mock.calls.map(([, args]) => args[0])).toEqual(['session', 'ls', 'ls', 'ls', 'ls'])
  expect(run.mock.calls[4]![1]).toContain('1')
})
