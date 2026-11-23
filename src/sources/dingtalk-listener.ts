/** Owns the DWS personal IM subscriptions for the configured desktop account. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { z } from 'zod'
import type { DingTalkIntakeResult, DingTalkMessage, DingTalkPilotScope } from './dingtalk.ts'
import { readPilotJson, type PilotCommand } from '../infra/pilot-cli.ts'

export interface DingTalkListenerStatus {
  state: 'unavailable' | 'stopped' | 'starting' | 'listening' | 'stopping' | 'error'
  detail?: string
  received?: { group: number; direct: number; mentions: number }
}
export interface DingTalkCli { cli: string; profile: string }
const streams = [
  { kind: 'at-me', event: 'user_im_message_receive_at', count: 'mentions' },
  { kind: 'all-direct', event: 'user_im_message_receive_o2o_all', count: 'direct' },
  { kind: 'all-group', event: 'user_im_message_receive_group_all', count: 'group' },
] as const
type Stream = typeof streams[number]
const native = z.string().regex(/^[\w:@.+=/-]{1,160}$/)
const iso = z.iso.datetime({ offset: true })
const envelope = z.object({ type: z.string(), subscribe_id: native })
const dwsEvent = z.object({
  conversation_id: native,
  message_id: native, sender_open_dingtalk_id: native, content: z.string().trim().min(1).max(4000),
  create_time: z.union([z.number(), z.string()]).optional(), event_time: z.number().int().optional(),
  quoted_message: z.object({ message_id: native, conversation_id: native }).nullish(),
  forward_messages: z.array(z.unknown()).nullish(),
})
const intTime = /^\d{10}$|^\d{13}$/
function isoTime(value?: string | number): string | undefined {
  if (typeof value === 'string' && iso.safeParse(value).success) return new Date(value).toISOString()
  if (value === undefined || !intTime.test(String(value))) return undefined
  const epoch = Number(value)
  return new Date(epoch < 1e12 ? epoch * 1000 : epoch).toISOString()
}
export function decodeDwsRequest(value: unknown, scope: DingTalkPilotScope, subscription: string, kind: 'at-me' | 'all-direct'): DingTalkMessage | undefined {
  const identity = envelope.safeParse(value).data
  const eventName = kind === 'at-me' ? streams[0].event : streams[1].event
  if (identity?.type !== eventName || identity.subscribe_id !== subscription) return
  const event = dwsEvent.safeParse(value).data
  if (!event || (scope.conversationId && event.conversation_id !== scope.conversationId) || event.forward_messages?.length) return
  const at = isoTime(event.create_time) ?? isoTime(event.event_time)
  if (!at) return
  const parent = event.quoted_message
  if (parent && (parent.conversation_id !== event.conversation_id || parent.message_id === event.message_id)) return
  return { conversationId: event.conversation_id, messageId: event.message_id, senderId: event.sender_open_dingtalk_id,
    addressed: kind === 'at-me' ? 'mention' : 'direct', human: true, text: event.content, at,
    ...(parent ? { replyToMessageId: parent.message_id } : {}) }
}

const maxLine = 32_768
function readLines(read: (line: string) => void): (chunk: string) => void {
  let pending = '', oversized = false
  return chunk => {
    const lines = chunk.split('\n')
    for (const [index, piece] of lines.entries()) {
      if (!oversized && pending.length + piece.length <= maxLine) pending += piece
      else { pending = ''; oversized = true }
      if (index === lines.length - 1) return
      if (!oversized) read(pending.trimEnd())
      pending = ''
      oversized = false
    }
  }
}

function profileLock(profile: string, compromised: () => void): () => void {
  const root = join(homedir(), '.dsh-superagent-dws')
  mkdirSync(root, { mode: 0o700, recursive: true })
  const info = lstatSync(root)
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077)) {
    throw new Error('DWS lock directory must be private and owned by this user')
  }
  const path = join(root, createHash('sha256').update(profile).digest('hex'))
  return lockSync(path, { realpath: false, stale: 30_000, onCompromised: compromised })
}
interface ListenerSession { abort: AbortController; done: Promise<void>; watchdog?: ReturnType<typeof setTimeout> }
const stopTimeoutMs = 8_000

/** Manages the verified subscriptions under one exclusive DWS profile lease until shutdown. */
export class DingTalkListener {
  private state: DingTalkListenerStatus = { state: 'stopped' }
  private session?: ListenerSession
  constructor(private readonly config: DingTalkCli, private readonly scope: DingTalkPilotScope,
    private readonly command: PilotCommand, private readonly verify: (signal: AbortSignal) => Promise<void>,
    private readonly receive: (message: DingTalkMessage) => DingTalkIntakeResult,
    private readonly makeLock = profileLock) {}

  status(): DingTalkListenerStatus { return this.state }
  start(): DingTalkListenerStatus {
    if (this.session) return this.state
    this.state = { state: 'starting' }
    const abort = new AbortController()
    const session: ListenerSession = { abort, done: Promise.resolve() }
    session.done = Promise.resolve().then(() => this.run(abort.signal)).catch((error: unknown) => {
      if (!abort.signal.aborted) this.state = { state: 'error', detail: error instanceof Error ? error.message : 'DWS listener failed' }
    }).finally(() => {
      clearTimeout(session.watchdog)
      if (abort.signal.aborted) this.state = { state: 'stopped' }
      delete this.session
    })
    this.session = session
    return this.state
  }
  stop(): DingTalkListenerStatus {
    const session = this.session
    if (!session) this.state = { state: 'stopped' }
    else if (!session.abort.signal.aborted) {
      this.state = { state: 'stopping' }
      session.watchdog = setTimeout(() => {
        this.state = { state: 'error', detail: 'DWS did not confirm shutdown; the listener slot is held until the process exits.' }
      }, stopTimeoutMs)
      session.watchdog.unref()
      session.abort.abort()
    }
    return this.state
  }
  async dispose(): Promise<void> {
    const session = this.session
    this.stop()
    if (!session) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([session.done, new Promise<void>(resolve => { timer = setTimeout(resolve, stopTimeoutMs) })]) }
    finally { clearTimeout(timer) }
  }
  private args(args: string[]): string[] { return [...args, '--profile', this.config.profile] }
  private async run(lifetime: AbortSignal): Promise<void> {
    lifetime.throwIfAborted()
    const lease = new AbortController()
    const signal = AbortSignal.any([lifetime, lease.signal])
    let unlock: () => void
    try { unlock = this.makeLock(this.config.profile, () => {
      this.state = { state: 'error', detail: 'The exclusive DWS listener lock was lost.' }
      lease.abort()
    }) }
    catch { throw new Error('A managed DingTalk listener is already active, or its local lock could not be opened') }
    try {
      await this.verify(signal)
      const schema = z.object({ identity: z.object({ corp_id: native, user_id: native }), subscriptions: z.array(z.unknown()) })
      await Promise.all(streams.map(async ({ event, kind }) => {
        const check = schema.safeParse(readPilotJson(await this.command(this.config.cli,
          this.args(['event', 'status', '--event', event, '--format', 'json']), { signal }), 'DWS subscription status')).data
        if (!check) throw new Error('DWS subscription status could not be established')
        if (`${check.identity.corp_id}:${check.identity.user_id}` !== this.config.profile) {
          throw new Error('The DWS profile must match the canonical signed-in organization and user IDs.')
        }
        if (check.subscriptions.length) throw new Error(`A DingTalk ${kind} subscription is already active for this profile.`)
      }))
      await this.consumeAll(signal)
    } catch (error) {
      if (!lease.signal.aborted) throw error
    } finally {
      if (!lease.signal.aborted) unlock()
    }
  }
  private async consumeAll(lifetime: AbortSignal): Promise<void> {
    const pool = new AbortController()
    const signal = AbortSignal.any([lifetime, pool.signal])
    const received = { group: 0, direct: 0, mentions: 0 }
    const children: Promise<void>[] = []
    let failure: unknown
    let detail: string | undefined
    const update = () => { this.state = { state: 'listening', received: { ...received }, ...(detail ? { detail } : {}) } }
    try {
      for (const stream of streams) {
        if (signal.aborted) break
        const child = this.consume(stream, signal, message => {
          received[stream.count]++
          if (message) {
            const result = this.receive(message)
            detail = typeof result === 'object' ? `Event needs review: ${result.manual}` : undefined
          }
          if (this.state.state === 'listening') update()
        })
        children.push(child.done.catch(error => { failure ??= error; pool.abort() }))
        if (!await child.ready) break
      }
      if (!signal.aborted) update()
      await Promise.all(children)
      if (failure) throw failure
    } finally {
      pool.abort()
      await Promise.all(children)
    }
  }
  private consume(stream: Stream, signal: AbortSignal, receive: (message?: DingTalkMessage) => void) {
    let ready!: (confirmed: boolean) => void
    const started = new Promise<boolean>(resolve => { ready = resolve })
    const done = new Promise<void>((resolve, reject) => {
      const child = spawn(this.config.cli, this.args(['event', '+listen-im', '--kind', stream.kind, '--format', 'ndjson']),
        { stdio: ['ignore', 'pipe', 'pipe'] })
      let subscription: string | undefined
      let failure: Error | undefined
      const early: string[] = []
      const terminate = () => { child.kill('SIGTERM') }
      const fail = (text: string) => {
        failure ??= new Error(text)
        terminate()
      }
      const readyTimeout = setTimeout(() => fail(`DWS did not confirm the ${stream.kind} subscription before the startup deadline`), 30_000)
      signal.addEventListener('abort', terminate, { once: true })
      const accept = (line: string) => {
        if (failure || signal.aborted) return
        if (!subscription) {
          if (early.length < 32) early.push(line)
          else fail('DWS emitted too many events before confirming subscription readiness')
          return
        }
        let event: unknown
        try { event = JSON.parse(line) as unknown } catch { return }
        const identity = envelope.safeParse(event).data
        if (identity?.type !== stream.event || identity.subscribe_id !== subscription) return
        try {
          // All-group events do not carry a trustworthy mention marker. The separate @me subscription is authoritative.
          receive(stream.kind === 'all-group' ? undefined : decodeDwsRequest(event, this.scope, subscription, stream.kind))
        } catch { fail('The DSH journal could not accept a DingTalk event') }
      }
      child.stdout.setEncoding('utf8').on('data', readLines(accept))
      child.stderr.setEncoding('utf8').on('data', readLines(line => {
        if (signal.aborted || failure) return
        const match = /^\[event\] ready event_key=(\w+) bus_pid=\d+ subscribe_id=([\w-]+)(?:\s|$)/.exec(line)
        if (!match || match[1] !== stream.event) return
        if (subscription && subscription !== match[2]) { fail('DWS changed the active subscription unexpectedly'); return }
        subscription = match[2]
        clearTimeout(readyTimeout)
        for (const event of early.splice(0)) accept(event)
        ready(true)
      }))
      child.on('error', () => { failure ??= new Error('DWS listener process could not be started or stopped') })
      child.on('close', (code, exitSignal) => {
        clearTimeout(readyTimeout)
        signal.removeEventListener('abort', terminate)
        if (signal.aborted) resolve()
        else reject(failure ?? new Error(`DWS ${stream.kind} listener exited (${exitSignal ?? code ?? 'unknown'})`))
      })
      if (signal.aborted) terminate()
    }).finally(() => ready(false))
    return { ready: started, done }
  }
}
