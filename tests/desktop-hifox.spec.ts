import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { desktopHiFox } from '../src/app/hifox-desktop.ts'
import { Config } from '../src/deployment.ts'
import { DingTalkListener, decodeDwsRequest } from '../src/sources/dingtalk-listener.ts'
import { dingTalkTerminalSender } from '../src/sources/dingtalk-reply.ts'
import { hiFoxCliGateway } from '../src/executor/hifox-cli.ts'
import type { HiFoxScope, HiFoxWorkOrder } from '../src/executor/hifox-port.ts'
import type { OutboundMessage } from '../src/core/index.ts'
import type { PilotCommand } from '../src/infra/pilot-cli.ts'

const signal = new AbortController().signal
const scope = { space: 'test-space', conversationId: 'test-room' } satisfies HiFoxScope
const selectedAgent = 'test-agent'
const computerId = 'test-computer'
const from = '2026-11-21T10:00:00Z'
const work: HiFoxWorkOrder = { ticketId: 'ticket', assignmentId: 'assignment', taskUuid: 'task', launchKey: 'launch',
  inputRevision: 'revision', initialClues: [{ triggerId: 'trigger', conversationId: scope.conversationId, messageId: 'ding-1', at: from, text: '请查‘资料不完整’原因' }] }
const result = (value: unknown, stderr = '') => ({ code: 0, stdout: JSON.stringify(value), stderr })
const mention = { type: 'user_im_message_receive_at', subscribe_id: 'sub-1', conversation_id: scope.conversationId,
  message_id: 'original', sender_open_dingtalk_id: 'sender', create_time: '2026-11-21 18:00:00', event_time: Date.parse(from),
  content: '请查‘资料不完整’原因' }

describe('standard HiFox configuration', () => {
  it('mounts without a fixed Agent and lists only eligible Agents on demand', async () => {
    const space = '80e9552a-5568-4e0b-9b08-4446c6156e77'
    const settings = { stateDir: '/srv/state',
      dingTalkProfile: 'corp:user', hiFoxCli: process.execPath, dingTalkCli: process.execPath }
    await expect(desktopHiFox(Config(settings), signal)).resolves.toEqual({})
    const selected = { id: selectedAgent, computerId, spaceIds: [space], status: 'idle', provisioningState: 'ready',
      name: '日志 Agent', jobTitle: '排障', skills: [{ name: '日志查询' }], allowMention: true, allowTaskAssignment: false }
    const agents = [selected, { ...selected, id: 'other-space', spaceIds: [scope.space] },
      { ...selected, id: 'native-assignment', name: '文档 Agent', allowTaskAssignment: true },
      { ...selected, id: 'mention-disabled', allowMention: false },
      { ...selected, id: 'provisioning-agent', provisioningState: 'pending' },
      { ...selected, id: 'offline-agent', status: 'offline' }]
    const command = vi.fn<PilotCommand>().mockResolvedValue(result(agents))
    const configured = await desktopHiFox(Config({ ...settings, hiFoxEnabled: true, hiFoxAgent: 'stale-agent' }), signal, command)
    expect(configured.pilot?.scope).toEqual({ space })
    expect(command).not.toHaveBeenCalled()
    expect(configured.pilot?.createDingTalkListener?.(() => 'stored').status()).toEqual({ state: 'stopped' })
    const roster = await configured.pilot?.gateway.agents(signal)
    expect(roster).toHaveLength(2)
    expect(roster).toEqual(expect.arrayContaining([
      { id: selectedAgent, name: '日志 Agent', status: 'idle', jobTitle: '排障', skills: ['日志查询'] },
      expect.objectContaining({ id: 'native-assignment', name: '文档 Agent' }),
    ]))
    expect(command).toHaveBeenCalledExactlyOnceWith(process.execPath, ['agent', 'list', '--limit', '1000', '--output', 'json'], { signal })
  })
})

describe('DWS pilot listener', () => {
  it('maps only the exact stream and subscription, with timestamp fallback and trusted quoted ID', () => {
    const decodeMention = (data: unknown, sub = 'sub-1') => decodeDwsRequest(data, {}, sub, 'at-me')
    expect(decodeMention(mention, 'sub-2')).toBeUndefined()
    expect(decodeMention({ ...mention, conversation_id: 'other' })).toMatchObject({ conversationId: 'other', addressed: 'mention' })
    expect(decodeMention({ ...mention, quoted_message: { conversation_id: 'other', message_id: 'old' } })).toBeUndefined()
    expect(decodeMention({ ...mention, event_time: undefined })).toBeUndefined()
    expect(decodeMention(mention)).toMatchObject({ at: new Date(from).toISOString(), messageId: 'original',
      text: mention.content })
    expect(decodeMention({ ...mention, content: '继续处理', quoted_message: {
      conversation_id: scope.conversationId, message_id: 'old',
    } })).toMatchObject({ replyToMessageId: 'old' })
    expect(decodeDwsRequest({ ...mention, type: 'user_im_message_receive_o2o_all', conversation_id: 'direct-chat' },
      {}, 'sub-1', 'all-direct')).toMatchObject({ conversationId: 'direct-chat', addressed: 'direct' })
  })

  it('waits for all streams, observes ambient group messages, and releases the shared lease after graceful child exit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dws-fake-'))
    const cli = join(dir, 'dws')
    const release = vi.fn()
    const lock = vi.fn(() => release)
    const receive = vi.fn(() => 'stored' as const)
    // The fake child sends output from stdout before ready appears on stderr.
    writeFileSync(cli, `#!${process.execPath}
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 80))
const kind = process.argv[process.argv.indexOf('--kind') + 1]
const type = { 'at-me': 'user_im_message_receive_at', 'all-group': 'user_im_message_receive_group_all',
  'all-direct': 'user_im_message_receive_o2o_all' }[kind]
const event = { ...${JSON.stringify(mention)}, type, subscribe_id: 'sub-' + kind }
if (kind === 'all-direct') { event.conversation_id = 'direct-chat'; event.message_id = 'direct-message' }
console.log(JSON.stringify({ ...event, subscribe_id: 'forged' }))
console.log(JSON.stringify(event))
setTimeout(() => process.stderr.write('[event] ready event_key=' + type + ' bus_pid=123 subscribe_id=' + event.subscribe_id + '\\n'), 50)
setInterval(() => {}, 1000)
`, { mode: 0o700 })
    const command = vi.fn<PilotCommand>(async () => result({ identity: { corp_id: 'corp', user_id: 'user' }, subscriptions: [] }))
    const listener = new DingTalkListener({ cli, profile: 'corp:user' }, {}, command, async () => {}, receive, lock)
    try {
      expect(listener.start().state).toBe('starting')
      expect(listener.start().state).toBe('starting')
      await vi.waitFor(() => expect(listener.status()).toEqual({ state: 'listening', received: { group: 1, direct: 1, mentions: 1 } }), { timeout: 7000 })
      expect(receive).toHaveBeenCalledTimes(2)
      expect(receive).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'direct-chat', addressed: 'direct' }))
      expect(command.mock.calls[0]?.[1]).toContain('status')
      expect(listener.stop().state).toBe('stopping')
      expect(listener.start().state).toBe('stopping')
      expect(release).not.toHaveBeenCalled()
      await vi.waitFor(() => expect(listener.status().state).toBe('stopped'), { timeout: 3000 })
      expect(lock).toHaveBeenCalledTimes(1)
      expect(release).toHaveBeenCalledTimes(1)
    } finally {
      await listener.dispose()
      rmSync(dir, { force: true, recursive: true })
    }
  }, 12000)

  it('refuses an existing subscription without opening another consumer', async () => {
    const release = vi.fn()
    const listener = new DingTalkListener({ cli: '/cannot-spawn', profile: 'corp:user' }, scope,
      async () => result({ identity: { corp_id: 'corp', user_id: 'user' }, subscriptions: [{}] }), async () => {}, () => 'stored', () => release)
    listener.start()
    await vi.waitFor(() => expect(listener.status()).toMatchObject({ state: 'error', detail: expect.stringContaining('already active') }))
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('stops its already started stream if the next subscription fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dws-partial-'))
    const cli = join(dir, 'dws')
    const stopped = join(dir, 'stopped')
    const release = vi.fn(() => expect(() => rmSync(stopped)).not.toThrow())
    writeFileSync(cli, `#!${process.execPath}
const kind = process.argv[process.argv.indexOf('--kind') + 1]
if (kind !== 'at-me') process.exit(9)
process.on('SIGTERM', () => { require('node:fs').writeFileSync(${JSON.stringify(stopped)}, 'stopped'); process.exit(0) })
process.stderr.write('[event] ready event_key=user_im_message_receive_at bus_pid=123 subscribe_id=sub-at-me\\n')
setInterval(() => {}, 1000)
`, { mode: 0o700 })
    const listener = new DingTalkListener({ cli, profile: 'corp:user' }, {},
      async () => result({ identity: { corp_id: 'corp', user_id: 'user' }, subscriptions: [] }), async () => {}, () => 'stored', () => release)
    try {
      expect(listener.start().state).toBe('starting')
      await vi.waitFor(() => expect(listener.status()).toEqual({ state: 'error', detail: 'DWS all-direct listener exited (9)' }), { timeout: 5000 })
      expect(release).toHaveBeenCalledTimes(1)
    } finally {
      await listener.dispose()
      rmSync(dir, { force: true, recursive: true })
    }
  })
})

describe('verified transport contracts', () => {
  it('does not mutate a Space with active automations or summon an unrelated Agent', async () => {
    let activeAutomations = true
    const command = vi.fn<PilotCommand>(async (_binary, [group, action]) => {
      if (group === 'auth') return result({ authenticated: true, authMode: 'user' })
      if (group === 'space') return result({ id: scope.space, isMember: true })
      if (group === 'agent') return result({ id: selectedAgent, computerId, status: 'idle',
        spaceId: scope.space, allowTaskAssignment: false, allowMention: true })
      if (group === 'automation' && action === 'list') return result(activeAutomations ? [{}] : [])
      throw new Error('unexpected remote write')
    })
    const gateway = hiFoxCliGateway(command, '/hifox', scope)
    await expect(gateway.createTask({ space: scope.space, marker: 'marker', title: 'title', description: 'test' }, signal))
      .rejects.toThrow('active automations')
    activeAutomations = false
    await expect(gateway.summon({ agent: 'different-agent', work }, signal)).rejects.toThrow('no longer eligible')
    expect(command.mock.calls.map(([, [group, action]]) => [group, action])).toEqual([
      ['auth', 'status'], ['space', 'view'], ['automation', 'list'],
      ['auth', 'status'], ['space', 'view'], ['automation', 'list'], ['agent', 'view'],
    ])
  })

  it('writes and reads back the card status, preserving a terminal status set in HiFox', async () => {
    let status = { name: '待开始', category: 'unstarted' }
    const command = vi.fn<PilotCommand>(async (_binary, args) => {
      const [group, action] = args
      if (group === 'automation' && action === 'list') return result([])
      if (group === 'task' && action === 'view') {
        return result({ id: work.taskUuid, spaceId: scope.space, description: 'DSH-SUPERAGENT-OPERATION:marker', status })
      }
      if (group === 'task' && action === 'edit') {
        expect(args).toEqual(['task', 'edit', work.taskUuid, '--status', '进行中', '--output', 'json'])
        status = { name: '进行中', category: 'started' }
        return result({})
      }
      throw new Error('unexpected command')
    })
    const gateway = hiFoxCliGateway(command, '/hifox', scope)
    await expect(gateway.setTaskStatus(work.taskUuid, 'started', signal)).resolves.toEqual({ name: '进行中', category: 'started' })
    status = { name: '已取消', category: 'cancelled' }
    await expect(gateway.setTaskStatus(work.taskUuid, 'completed', signal)).resolves.toEqual(status)
    expect(command.mock.calls.filter(([, [group, action]]) => group === 'task' && action === 'edit')).toHaveLength(1)
  })

  it('passes the original request to HiFox and pins the Agent-owned computer in the Run receipt', async () => {
    let observedComputer = 'other-computer'
    let runTaskId = work.taskUuid
    let conversationTaskId = work.taskUuid
    const report = { taskUuid: work.taskUuid, launchKey: work.launchKey, inputRevision: work.inputRevision,
      outcome: 'completed', summary: '已定位缺项。' }
    let output = `排查完成。\n${JSON.stringify(report)}`
    const command = vi.fn<PilotCommand>(async (_binary, [group, action]) => {
      if (group === 'auth') return result({ authenticated: true, authMode: 'user' })
      if (group === 'space') return result({ id: scope.space, isMember: true })
      if (group === 'agent') return result({ id: selectedAgent, computerId, status: 'idle',
        spaceId: scope.space, allowTaskAssignment: false, allowMention: true })
      if (group === 'automation') return result([])
      if (group === 'task' && action === 'view') return result({ id: work.taskUuid, spaceId: scope.space,
        description: 'DSH-SUPERAGENT-OPERATION:marker', agentChatSessions: [{ id: 'chat', agentId: selectedAgent }] })
      if (group === 'task' && action === 'summon') return result({ conversationId: 'chat', runId: 'run' })
      if (group === 'run' && action === 'view') return result({ id: 'run', agentId: selectedAgent,
        computerId: observedComputer, chatSessionId: 'chat', taskId: runTaskId, status: 'completed', result: { output } })
      if (group === 'chat' && action === 'view') return result({ id: 'chat', taskId: conversationTaskId, agentId: selectedAgent })
      if (group === 'chat' && action === 'message') return result([{ chatSessionId: 'chat', role: 'user',
        content: `DSH-SUPERAGENT-WORK-ORDER\n${JSON.stringify(report)}` }])
      throw new Error('unexpected remote operation')
    })
    const gateway = hiFoxCliGateway(command, '/hifox', scope)
    const receipt = await gateway.summon({ agent: selectedAgent, work }, signal)
    expect(receipt).toMatchObject({ computerId, agentId: selectedAgent })
    const invocation = command.mock.calls.find(([, [group, action]]) => group === 'task' && action === 'summon')
    expect(invocation?.[2].input).toContain(work.initialClues[0]!.text)
    expect(invocation?.[2].input).toContain(scope.conversationId)
    expect(invocation?.[2].input).not.toMatch(/sls|aliyun|测试日志/i)
    await expect(gateway.run(receipt, signal)).resolves.toBeUndefined()
    observedComputer = computerId
    await expect(gateway.run(receipt, signal)).resolves.toMatchObject({ report, status: 'completed' })
    runTaskId = 'different-task'
    await expect(gateway.run(receipt, signal)).resolves.toBeUndefined()
    runTaskId = ''
    await expect(gateway.run(receipt, signal)).resolves.toMatchObject({ report, status: 'completed' })
    conversationTaskId = 'different-task'
    await expect(gateway.run(receipt, signal)).resolves.toBeUndefined()
    conversationTaskId = work.taskUuid
    output += `\n${JSON.stringify({ ...report, summary: '另一个结果' })}`
    await expect(gateway.run(receipt, signal)).resolves.toMatchObject({ report: undefined, status: 'completed' })
  })

  it('uses one idempotent key and checks the outbound message quotes the exact source before recording sent', async () => {
    const id = 'a'.repeat(32)
    const message: OutboundMessage = { id, kind: 'reply', text: '结果', hiFoxTerminal: true,
      channel: { source: 'dingtalk', thread: 'thread', address: { conversationId: scope.conversationId, messageId: 'original' } } }
    let verified = false
    const cli = { cli: '/dws', profile: 'corp:user' }
    const command = vi.fn<PilotCommand>(async (_binary, args) => {
      if (args[1] === '+messages-reply') return result({ success: true, conversationId: scope.conversationId, idempotencyKey: id,
        referencedMessage: { messageId: 'original' }, result: { openTaskId: 'send-task' } })
      if (args[1] === '+messages-query-send-status') return result({ result: { openMessageId: 'outgoing' } })
      if (args[1] === '+messages-mget') return result({ messages: [{ conversationId: scope.conversationId,
        messageId: 'outgoing', text: message.text, quotedMessage: { messageId: verified ? 'original' : 'other' } }] })
      throw new Error('unexpected DWS command')
    })
    const send = dingTalkTerminalSender(command, cli, scope.conversationId, true, signal)
    expect(await send({ ...message, kind: 'acknowledgement' })).toBe('gone')
    expect(await dingTalkTerminalSender(command, cli, scope.conversationId, false, signal)(message)).toBe('gone')
    expect(command).not.toHaveBeenCalled()
    await expect(send(message)).rejects.toThrow('exact quoted terminal reply')
    verified = true
    await expect(send(message)).resolves.toBe('sent')
    const replies = command.mock.calls.filter(([, args]) => args[1] === '+messages-reply')
    expect(replies).toHaveLength(2)
    expect(replies[0]?.[1]).toEqual(replies[1]?.[1])
    expect(replies[0]?.[1]).toEqual(expect.arrayContaining(['--uuid', id, '--message-id', 'original', '--yes']))
  })
})
