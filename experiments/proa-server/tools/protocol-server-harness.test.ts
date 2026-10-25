import { expect, test } from 'bun:test'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startProtocolServer } from './protocol-server-harness'

// A real child with the private control protocol, not a backing-store adapter.
// These tests prove lifecycle and queue behavior; Rust HTTP conformance remains
// the separate integration runner's responsibility.
const stub = `#!/usr/bin/env bun
if (process.env.STUB_MODE === 'exit') process.exit(17)
if (process.env.STUB_MODE === 'quiet') await Bun.sleep(60000)
if (process.env.STUB_MODE === 'invalid') {
  console.log(JSON.stringify({ready:true,port:0}))
  await Bun.sleep(60000)
}
let now = null
let release
const hold = new Promise(resolve => { release = resolve })
const server = Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req) {
  const path = new URL(req.url).pathname
  if (path === '/held') await hold
  if (path === '/release') release()
  return Response.json({now,retention:process.env.PROA_TEST_RETENTION,pid:process.pid})
}})
console.log(JSON.stringify({ready:true,port:server.port}))
let pending = ''
for await (const bytes of Bun.stdin.stream()) {
  pending += new TextDecoder().decode(bytes)
  while (pending.includes('\\n')) {
    const index = pending.indexOf('\\n')
    const command = JSON.parse(pending.slice(0,index))
    pending = pending.slice(index+1)
    now = command.now
    console.log(JSON.stringify({ok:process.env.STUB_MODE !== 'refuse'}))
  }
}
await server.stop(true)
`
async function withStub(work: (executable: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'proa-protocol-server-'))
  const executable = join(directory, 'stub')
  try {
    await Bun.write(executable, stub)
    await chmod(executable, 0o755)
    await work(executable)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('server harness synchronizes clock, injects retention, releases held reads and reaps child', async () => {
  await withStub(async (executable) => {
    let now = new Date('2026-07-15T12:00:00.000Z')
    const server = await startProtocolServer({
      executable,
      env: process.env,
      clock: () => now,
      retention: { maxRevisions: 3 },
    })
    let pid: number | undefined
    try {
      const first = await (await server.fetch(`${server.url}/read`)).json()
      expect(first.now).toBe(now.toISOString())
      expect(JSON.parse(first.retention)).toEqual({ maxRevisions: 3 })
      pid = first.pid
      now = new Date('2026-07-15T13:00:00.000Z')
      const held = server.fetch(`${server.url}/held`, { signal: AbortSignal.timeout(2000) })
      const released = await server.fetch(`${server.url}/release`, {
        signal: AbortSignal.timeout(2000),
      })
      expect((await released.json()).now).toBe(now.toISOString())
      expect((await held).status).toBe(200)
    } finally {
      await server.close()
      await server.close()
    }
    expect(() => process.kill(pid!, 0)).toThrow()
    await expect(server.fetch(`${server.url}/read`)).rejects.toThrow('closed')
  })
})

test('server harness fails fast on process exit, malformed readiness and startup timeout', async () => {
  await withStub(async (executable) => {
    await expect(
      startProtocolServer({ executable, env: { ...process.env, STUB_MODE: 'exit' } }),
    ).rejects.toThrow('exited (17)')
    await expect(
      startProtocolServer({
        executable,
        env: { ...process.env, STUB_MODE: 'invalid' },
        teardownTimeoutMs: 20,
      }),
    ).rejects.toThrow('Invalid protocol server readiness')
    await expect(
      startProtocolServer({
        executable,
        env: { ...process.env, STUB_MODE: 'quiet' },
        startupTimeoutMs: 20,
        teardownTimeoutMs: 20,
      }),
    ).rejects.toThrow('startup timed out')
  })
})

test('clock refusal closes the control channel and server instead of reusing uncertain framing', async () => {
  await withStub(async (executable) => {
    const server = await startProtocolServer({
      executable,
      env: { ...process.env, STUB_MODE: 'refuse' },
      clock: () => new Date(),
    })
    await expect(server.fetch(`${server.url}/read`)).rejects.toThrow('synchronization refused')
    await expect(server.fetch(`${server.url}/read`)).rejects.toThrow('closed')
    await server.close()
  })
})
