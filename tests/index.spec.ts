import { expect, it, vi } from 'vitest'
import { Config, type Machine } from '../src/deployment.ts'
import { apply } from '../src/index.ts'
import type { HiFoxPilot } from '../src/executor/hifox-port.ts'

vi.mock('../src/infra/pilot-cli.ts', { spy: true })
import { pilotCommand } from '../src/infra/pilot-cli.ts'

// Stub Runtime to capture the resolved Machine settings and restart callback.
const runtimes = vi.hoisted(() => [] as { machine: Machine; restart: () => void; pilot?: HiFoxPilot; detail?: string }[])
vi.mock('../src/app/runtime.ts', () => ({ Runtime: class {
  ready = Promise.resolve()
  constructor(_ctx: unknown, readonly machine: Machine, readonly restart: () => void,
    readonly pilot?: HiFoxPilot, readonly detail?: string) { runtimes.push(this) }
  configured() { return true }
  async stop() {}
} }))
/** Simulate the Cordis loader updating a volatile configuration reference in place. */
const commit = (reference: unknown, value: unknown) => { (reference as Record<symbol, (value: unknown) => void>)[Symbol.for('cosmokit.volatile.write')]!(value) }

function context() {
  const handlers = new Map<string, () => void>()
  const configure = vi.fn(() => () => {})
  const describe = vi.fn(() => [])
  const ctx = {
    on: vi.fn((name: string, handler: () => void) => { handlers.set(name, handler) }),
    inject: vi.fn((_services: string[], callback: (child: unknown) => void) => { callback({ effect: (effect: () => unknown) => effect(), settings: { configure } }) }),
    effect: vi.fn(),
    fiber: { restart: vi.fn(async () => {}) },
    get: vi.fn((name: string) => name === 'settings' ? { describe } : undefined),
    logger: { info: vi.fn(), error: vi.fn() },
  }
  return { ctx, handlers, configure, describe }
}

it('reads a limit DSH commits a new value of without a restart, and asks DSH to generate no settings page', async () => {
  const { ctx, handlers, configure } = context()
  const config = Config({ stateDir: '/srv/state', promptMaxChars: 5000 })
  await apply(ctx as never, config)
  expect(configure).toHaveBeenCalledExactlyOnceWith({ auto: false }, ctx.fiber)
  const { machine } = runtimes.at(-1)!
  expect(machine.promptMaxChars.get()).toBe(5000)
  commit(config.promptMaxChars, 8000)
  expect(machine.promptMaxChars.get()).toBe(8000)
  expect(handlers.has('loader/volatile-update')).toBe(false)
  expect(ctx.fiber.restart).not.toHaveBeenCalled()
})

it('asks DSH to read its settings entry again once a restart it started finished', async () => {
  const { ctx, describe } = context()
  let finish = () => {}
  ctx.fiber.restart.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  await apply(ctx as never, Config({ stateDir: '/srv/state' }))
  // Saving a Source account change restarts dsh-superagent, which re-runs setup and refreshes the settings descriptor.
  runtimes.at(-1)!.restart()
  await Promise.resolve()
  expect(describe).not.toHaveBeenCalled()
  finish()
  await vi.waitFor(() => { expect(describe).toHaveBeenCalledTimes(1) })
})

it('refuses keys of the previous configuration before registering anything', async () => {
  const { ctx } = context()
  await expect(apply(ctx as never, Config({ stateDir: '/srv/state', github: { cli: 'gh' } } as never))).rejects.toThrow('configuration has keys it does not use: github')
  expect(ctx.on).not.toHaveBeenCalled()
  expect(ctx.inject).not.toHaveBeenCalled()
})

it('mounts the standard HiFox gateway and stopped listener from explicit plugin settings', async () => {
  const { ctx } = context()
  await apply(ctx as never, Config({ stateDir: '/srv/state', hiFoxEnabled: true }))
  expect(runtimes.at(-1)).toMatchObject({ pilot: undefined, detail: expect.stringContaining('Configure the canonical DWS') })
  await apply(ctx as never, Config({ stateDir: '/srv/state', hiFoxEnabled: true,
    hiFoxCli: process.execPath, dingTalkCli: process.execPath,
    hiFoxSpace: 'space-test', hiFoxAgent: 'agent-test',
    dingTalkConversationId: 'chat-test', dingTalkProfile: 'corp:user',
  }))
  const pilot = runtimes.at(-1)?.pilot
  expect(pilot?.scope).toEqual({ space: 'space-test' })
  expect(pilotCommand).not.toHaveBeenCalled()
  expect(pilot?.createDingTalkListener?.(() => 'stored').status()).toEqual({ state: 'stopped' })
})
