import { expect, it, vi } from 'vitest'
import { collectOpenVikingAudit } from '../src/app/dreaming/audit.ts'
import { collectOpenVikingEvidence, listOpenVikingArchives, readOpenVikingEvidence } from '../src/app/dreaming/openviking.ts'
import type { PilotCommand } from '../src/infra/pilot-cli.ts'

const uri = 'viking://~/sessions/cx-00000000-1111-2222-3333-444444444444/history/archive_001'
const signal = new AbortController().signal
const cli = '/usr/bin/ov'
const response = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' })

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
  const run = vi.fn<PilotCommand>().mockRejectedValueOnce(new Error('Pilot CLI output exceeded the response limit'))
    .mockResolvedValueOnce(response('{}'))
    .mockResolvedValueOnce(response(JSON.stringify({ role: 'user', parts: [{ type: 'text', text: 'Check the workspace.' }] })))
  const pack = await readOpenVikingEvidence(cli, uri, signal, run)
  expect(pack.evidence).toMatchObject([{ source: `${uri}/messages.jsonl#L1`, text: 'Check the workspace.' }])
  expect(run.mock.calls[2]![1]).toEqual(['read', `${uri}/messages.jsonl`, '--offset', '0', '--limit', '8', '-o', 'json'])
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
