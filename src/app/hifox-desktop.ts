/** Assemble the real CLI pilot from the standard plugin's operator configuration. */
import type { DeploymentConfig } from '../deployment.ts'
import { executable } from '../deployment.ts'
import { hiFoxCliGateway } from '../executor/hifox-cli.ts'
import { localCodexHistory } from '../executor/codex-history.ts'
import { hiFoxScope, type HiFoxPilot } from '../executor/hifox-port.ts'
import { pilotCommand, type PilotCommand } from '../infra/pilot-cli.ts'
import { DingTalkListener } from '../sources/dingtalk-listener.ts'
import { dingTalkTerminalSender } from '../sources/dingtalk-reply.ts'
import { dingTalkRoutingContext } from '../sources/dingtalk-context.ts'

export type DesktopHiFox = { pilot?: HiFoxPilot; detail?: string }

export async function desktopHiFox(config: DeploymentConfig, lifetime: AbortSignal, command: PilotCommand = pilotCommand): Promise<DesktopHiFox> {
  if (!config.hiFoxEnabled) return {}
  const base = hiFoxScope.safeParse({
    space: config.hiFoxSpace?.trim() || undefined,
  })
  if (!base.success) return { detail: 'Configure a valid HiFox Space.' }
  const dwsProfile = config.dingTalkProfile?.trim()
  if (!dwsProfile || !/^[\w.@+=/-]{1,160}:[\w.@+=/-]{1,160}$/.test(dwsProfile)) {
    return { detail: 'Configure the canonical DWS organization and user profile (corpId:userId).' }
  }
  const path = process.env.PATH ?? ''
  let hiFoxCli: string, dingTalkCli: string
  try { hiFoxCli = executable(config.hiFoxCli?.trim() || 'hifox', path) }
  catch { return { detail: 'The configured HiFox CLI was not found or is not executable.' } }
  try { dingTalkCli = executable(config.dingTalkCli?.trim() || 'dws', path) }
  catch { return { detail: 'The configured DWS CLI was not found or is not executable.' } }
  const scope = base.data
  const dws = { cli: dingTalkCli, profile: dwsProfile }
  const gateway = hiFoxCliGateway(command, hiFoxCli, scope)
  const history = config.codexProjectPaths?.length ? localCodexHistory(config.codexProjectPaths) : undefined
  return { pilot: {
    scope, gateway,
    ...(history ? { codexHistory: history } : {}),
    createDingTalkListener: receive => new DingTalkListener(dws, scope, command, gateway.verify, receive),
    readDingTalkContext: dingTalkRoutingContext(command, dws),
    sendDingTalk: dingTalkTerminalSender(command, dws, config.dingTalkConversationId?.trim() || undefined,
      config.dingTalkRepliesEnabled === true, lifetime),
    requireTerminalOrigin: true,
  } }
}
