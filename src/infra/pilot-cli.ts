/** Bounded subprocess transport for the host's configured pilot identities. */
import { spawn } from 'node:child_process'

export interface PilotCliResult { code: number | null; stdout: string; stderr: string }
export interface PilotCommandOptions { signal: AbortSignal; input?: string; env?: NodeJS.ProcessEnv }
export type PilotCommand = (binary: string, args: string[], options: PilotCommandOptions) => Promise<PilotCliResult>

export const pilotCommand: PilotCommand = (binary, args, { signal, input, env }) => new Promise((resolve, reject) => {
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
  const child = spawn(binary, args, { signal: timeout, stdio: ['pipe', 'pipe', 'pipe'], ...(env ? { env: { ...process.env, ...env } } : {}) })
  let stdout = '', stderr = ''
  let tooLarge = false
  child.stdout.setEncoding('utf8').on('data', (text: string) => {
    if (tooLarge) return
    stdout += text
    if (stdout.length > 2_000_000) {
      tooLarge = true
      child.kill()
    }
  })
  child.stderr.setEncoding('utf8').on('data', (text: string) => { stderr = (stderr + text).slice(-32_000) })
  child.stdin.on('error', () => { /* The CLI may exit without reading stdin. */ })
  child.stdin.end(input)
  child.on('error', reject)
  child.on('close', code => {
    if (tooLarge) reject(new Error('Pilot CLI output exceeded the response limit'))
    else resolve({ code, stdout, stderr })
  })
})

export function readPilotJson(result: PilotCliResult, action: string): unknown {
  // CLI diagnostics and bodies can include operator data, so only expose the operation and exit status.
  if (result.code !== 0) throw new Error(`${action} failed (exit ${result.code ?? 'signal'})`)
  try { return JSON.parse(result.stdout) as unknown } catch { throw new Error(`${action} did not return JSON`) }
}
