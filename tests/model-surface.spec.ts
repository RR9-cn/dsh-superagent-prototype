import { afterEach, expect, it } from 'vitest'
import { builtInParts } from '../src/app/prompts.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let host: Host | undefined
afterEach(async () => { await host?.stop(); host = undefined })

it('exposes HiFox routing and orchestration tools on the main Session', async () => {
  host = await startRuntime()
  const tools = host.tools.get(host.runtime.masterId)!
  expect([...tools.keys()]).toEqual(expect.arrayContaining([
    'orchestrator_route', 'orchestrator_eval_decide', 'orchestrator_reply', 'orchestrator_hifox_agents', 'orchestrator_dingtalk_context',
  ]))
  expect([...tools.keys()]).not.toContain('orchestrator_report')
  expect(builtInParts()['runtime/dispatch'].text).toContain('orchestrator_hifox_agents')
})
