import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, existsSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDingTalkSocket } from '../src/sources/dingtalk-socket.ts'

describe.skipIf(typeof process.getuid !== 'function')('local DingTalk socket', () => {
  let directory: string
  let endpoint: string
  let lifetime: AbortController
  let close: (() => Promise<void>) | undefined

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ds-'))
    endpoint = join(directory, 'ding.sock')
    lifetime = new AbortController()
  })
  afterEach(async () => {
    lifetime.abort()
    await close?.()
    close = undefined
    rmSync(directory, { recursive: true, force: true })
  })

  function request(body: Buffer | string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(endpoint)
      const chunks: Buffer[] = []
      socket.on('data', data => chunks.push(data))
      socket.setTimeout(3000, () => socket.destroy(new Error('DingTalk socket test timeout')))
      socket.once('error', reject)
      socket.once('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch (error) { reject(error) }
      })
      socket.end(body)
    })
  }

  it('bounds and validates the one-request frame before intake', async () => {
    const receive = vi.fn(() => 'stored' as const)
    close = await openDingTalkSocket(directory, lifetime.signal, receive)
    expect(lstatSync(endpoint).mode & 0o777).toBe(0o600)
    expect(await request(JSON.stringify({ text: '测试' }))).toEqual({ result: 'stored' })
    for (const body of ['{}{}', Buffer.from([0xff]), 'x'.repeat(32 * 1024 + 1)]) {
      expect(await request(body)).toEqual({ result: { manual: 'invalid_message' } })
    }
    expect(receive.mock.calls).toEqual([[{ text: '测试' }]])
  })

  it('recovers stale sockets and closes a client that has not finished sending', async () => {
    execFileSync(process.execPath, ['-e',
      "require('node:net').createServer().listen(process.argv[1], () => process.exit(0))", endpoint])
    expect(lstatSync(endpoint).isSocket()).toBe(true)
    const receive = vi.fn(() => 'stored' as const)
    close = await openDingTalkSocket(directory, lifetime.signal, receive)
    const socket = createConnection(endpoint)
    const disconnected = once(socket, 'close')
    await once(socket, 'connect')
    socket.write('{"incomplete":')
    lifetime.abort()
    await Promise.all([disconnected, close?.()])
    expect(existsSync(endpoint)).toBe(false)
    expect(receive).not.toHaveBeenCalled()
  })

  it('leaves live sockets and unrelated files alone and requires a private directory', async () => {
    const open = () => openDingTalkSocket(directory, lifetime.signal, () => 'stored')
    chmodSync(directory, 0o755)
    await expect(open()).rejects.toThrow('private state directory')
    chmodSync(directory, 0o700)
    writeFileSync(endpoint, 'unrelated file')
    await expect(open()).rejects.toThrow('path is occupied')
    expect(lstatSync(endpoint).isFile()).toBe(true)
    rmSync(endpoint)
    close = await open()
    await expect(open()).rejects.toThrow('already in use')
    expect(await request('{}')).toEqual({ result: 'stored' })
  })
})
