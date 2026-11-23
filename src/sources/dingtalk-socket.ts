/** Same-account, one-request socket used by the local DingTalk listener. */
import { chmodSync, lstatSync, unlinkSync, type Stats } from 'node:fs'
import { createConnection, createServer, type Socket } from 'node:net'
import { isAbsolute, join } from 'node:path'
import type { DingTalkIntakeResult } from './dingtalk.ts'

const MAX_REQUEST_BYTES = 32 * 1024
const REQUEST_TIMEOUT_MS = 5000
const MAX_CONNECTIONS = 8
const invalid = { manual: 'invalid_message' } as const

function existing(path: string): Stats | undefined {
  try { return lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** A live socket is never unlinked. Recover only an unchanged, same-owner socket left by an exited process. */
async function removeStaleSocket(path: string, uid: number): Promise<void> {
  const before = existing(path)
  if (!before) return
  if (!before.isSocket() || before.uid !== uid) throw new Error('DingTalk socket path is occupied')
  await new Promise<void>((resolve, reject) => {
    const probe = createConnection(path)
    probe.setTimeout(1000, () => {
      probe.destroy()
      reject(new Error('DingTalk socket is already in use'))
    })
    probe.once('connect', () => {
      probe.destroy()
      reject(new Error('DingTalk socket is already in use'))
    })
    probe.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve()
      else reject(error)
    })
  })
  const after = existing(path)
  if (!after) return
  if (after.dev !== before.dev || after.ino !== before.ino || !after.isSocket() || after.uid !== uid) {
    throw new Error('DingTalk socket changed during startup')
  }
  unlinkSync(path)
}

/** Reads one UTF-8 JSON document up to the client's write-half-close, then sends one JSON result. */
function handle(socket: Socket, receive: (event: unknown) => DingTalkIntakeResult): void {
  let size = 0
  let rejected = false
  const chunks: Buffer[] = []
  const timeout = setTimeout(() => socket.destroy(), REQUEST_TIMEOUT_MS)
  socket.on('error', () => socket.destroy())
  socket.once('close', () => clearTimeout(timeout))
  socket.on('data', (chunk: Buffer) => {
    if (rejected) return
    size += chunk.length
    rejected = size > MAX_REQUEST_BYTES
    if (rejected) {
      chunks.length = 0
      socket.end(JSON.stringify({ result: invalid }) + '\n')
    } else chunks.push(chunk)
  })
  socket.once('end', () => {
    if (rejected) return
    let event: unknown
    try { event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
    catch { socket.end(JSON.stringify({ result: invalid }) + '\n'); return }
    try { socket.end(JSON.stringify({ result: receive(event) }) + '\n') }
    catch { socket.end(JSON.stringify({ retry: 'unavailable' }) + '\n') }
  })
}

/** Runtime holds its state directory lock for the lifetime of this server. */
export async function openDingTalkSocket(stateDir: string, lifetime: AbortSignal,
  receive: (event: unknown) => DingTalkIntakeResult): Promise<(() => Promise<void>) | undefined> {
  const uid = process.getuid?.()
  const path = join(stateDir, 'ding.sock')
  // Unix socket paths are limited by sockaddr_un.sun_path, including the terminating NUL.
  const maxPathBytes = process.platform === 'darwin' ? 103 : 107
  if (!isAbsolute(path) || Buffer.byteLength(path) > maxPathBytes) {
    throw new Error(`DingTalk needs an absolute socket path no longer than ${maxPathBytes} UTF-8 bytes`)
  }
  const directory = lstatSync(stateDir)
  if (uid === undefined || !directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o077) !== 0) {
    throw new Error('DingTalk socket requires a private state directory owned by the current account')
  }
  await removeStaleSocket(path, uid)
  if (lifetime.aborted) return undefined

  const clients = new Set<Socket>()
  const server = createServer({ allowHalfOpen: true }, socket => {
    if (lifetime.aborted || clients.size >= MAX_CONNECTIONS) { socket.destroy(); return }
    clients.add(socket)
    socket.once('close', () => clients.delete(socket))
    handle(socket, event => {
      lifetime.throwIfAborted()
      return receive(event)
    })
  })
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => closing ??= new Promise(resolve => {
    lifetime.removeEventListener('abort', onAbort)
    for (const client of clients) client.destroy()
    server.close(() => resolve())
  })
  const onAbort = () => { void close() }

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => {
        server.removeListener('error', reject)
        server.on('error', onAbort)
        resolve()
      })
    })
    chmodSync(path, 0o600)
    if (lifetime.aborted) await close()
    else lifetime.addEventListener('abort', onAbort, { once: true })
    return close
  } catch (error) {
    await close()
    throw error
  }
}
