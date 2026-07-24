/**
 * Cross-process dev-server control tests (SPEC §16.2 D10, §8.2) — real
 * processes and a real localhost readiness probe, mirroring the fixture
 * patterns of src/kernel/server.test.ts. The load-bearing difference from the
 * kernel manager: state lives in .ab/server.pid, so start/status/logs/stop
 * work across SEPARATE ServerControl instances (each CLI invocation is a
 * fresh process). Fast poll/grace knobs keep the file well under 15s.
 */
import { afterEach, beforeAll, afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Phase } from '../ontology'
import { ServerControl } from './server-control'

let root: string
let serverFixture: string
let neverFixture: string

/** Workspaces that may have a live server; afterEach stops them all. */
const liveWorkspaces = new Set<string>()

function makeControl(workspacePath: string, phase: Phase = 'implement'): ServerControl {
  liveWorkspaces.add(workspacePath)
  return new ServerControl({
    workspacePath,
    phase,
    pollIntervalMs: 25,
    killGraceMs: 500,
  })
}

function makeWorkspace(): string {
  const dir = mkdtempSync(join(root, 'ws-'))
  return dir
}

function writeToml(
  workspacePath: string,
  port: number,
  opts: { readyTimeout?: number; start?: string } = {},
): void {
  const start = opts.start ?? `PORT=${port} bun ${serverFixture}`
  writeFileSync(
    join(workspacePath, 'autobuild.toml'),
    [
      '[tickets]',
      'source = "file"',
      'readyState = "ready"',
      '[server]',
      `start = ${JSON.stringify(start)}`,
      `url = ${JSON.stringify(urlFor(port))}`,
      `readyTimeout = ${opts.readyTimeout ?? 10}`,
      '',
    ].join('\n'),
  )
}

/** Bind port 0, read the assigned port, release it — an addressable free port. */
function freePort(): number {
  const listener = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: { data() {} },
  })
  const port = listener.port
  listener.stop(true)
  return port
}

function urlFor(port: number): string {
  return `http://127.0.0.1:${port}/`
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await Bun.sleep(25)
  }
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'ab-server-control-'))

  serverFixture = join(root, 'fixture-server.ts')
  await Bun.write(
    serverFixture,
    [
      'const port = Number(process.env.PORT)',
      "console.log('fixture-alpha')",
      "console.log('fixture-beta')",
      "console.log('fixture-gamma')",
      "Bun.serve({ port, fetch: () => new Response('ok') })",
      '',
    ].join('\n'),
  )

  neverFixture = join(root, 'fixture-never.ts')
  await Bun.write(
    neverFixture,
    [
      "console.log('never-ready fixture waiting')",
      'await Bun.write(process.env.PID_FILE!, String(process.pid))',
      'await Bun.sleep(1 << 30)',
      '',
    ].join('\n'),
  )
})

afterEach(async () => {
  for (const workspacePath of [...liveWorkspaces]) {
    await new ServerControl({
      workspacePath,
      phase: 'implement',
      pollIntervalMs: 25,
      killGraceMs: 500,
    }).stop()
    liveWorkspaces.delete(workspacePath)
  }
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('ServerControl — refusals (§16.2, §8.2)', () => {
  test('a phase without serverAccess (plan) is refused before config is even read', async () => {
    const ws = makeWorkspace() // no autobuild.toml at all
    await expect(makeControl(ws, 'plan').start()).rejects.toThrow(
      /'ab server' is not available in phase "plan".*implement and verify/s,
    )
  })

  test('a missing autobuild.toml is refused naming the file', async () => {
    const ws = makeWorkspace()
    await expect(makeControl(ws).start()).rejects.toThrow(
      /autobuild\.toml does not exist.*\[server\]/s,
    )
  })

  test('an autobuild.toml without [server] is refused', async () => {
    const ws = makeWorkspace()
    writeFileSync(
      join(ws, 'autobuild.toml'),
      'baseBranch = "main"\n[tickets]\nsource = "file"\nreadyState = "ready"\n',
    )
    await expect(makeControl(ws).start()).rejects.toThrow(
      /no \[server\] table.*refuses without one/s,
    )
  })
})

describe('ServerControl — pidfile lifecycle (cross-process semantics)', () => {
  test('start → status → logs → stop, each through a SEPARATE control instance', async () => {
    const ws = makeWorkspace()
    const port = freePort()
    writeToml(ws, port)

    // Instance 1 starts (the "first CLI invocation").
    const started = await makeControl(ws).start()
    expect(started.pid).toBeGreaterThan(0)
    expect(started.url).toBe(urlFor(port))
    expect(readFileSync(join(ws, '.ab', 'server.pid'), 'utf8').trim()).toBe(String(started.pid))
    const response = await fetch(urlFor(port))
    expect(response.status).toBe(200)

    // Instance 2 sees it via the pidfile.
    const statusControl = makeControl(ws)
    expect(statusControl.status()).toEqual({ running: true, pid: started.pid })

    // Instance 3 reads the log file.
    const logsControl = makeControl(ws)
    await waitFor(() => logsControl.logs().includes('fixture-gamma'), 2000)
    expect(logsControl.logs(2)).toEqual(['fixture-beta', 'fixture-gamma'])

    // Instance 4 stops it: group killed, pidfile removed.
    await makeControl(ws).stop()
    expect(alive(started.pid)).toBe(false)
    expect(existsSync(join(ws, '.ab', 'server.pid'))).toBe(false)
    expect(makeControl(ws).status()).toEqual({ running: false })
  })

  test('start is a no-op returning the live pid when already running', async () => {
    const ws = makeWorkspace()
    const port = freePort()
    writeToml(ws, port)

    const first = await makeControl(ws).start()
    const second = await makeControl(ws).start()
    expect(second.pid).toBe(first.pid)
  })

  test('a stale pidfile (dead pid) reads as not running and start replaces it', async () => {
    const ws = makeWorkspace()
    const port = freePort()
    writeToml(ws, port)

    // A real-but-dead pid: spawn a process that exits immediately.
    const shortLived = Bun.spawn(['sh', '-c', 'exit 0'])
    await shortLived.exited
    mkdirSync(join(ws, '.ab'), { recursive: true })
    writeFileSync(join(ws, '.ab', 'server.pid'), `${shortLived.pid}\n`)

    expect(makeControl(ws).status()).toEqual({ running: false })
    const started = await makeControl(ws).start()
    expect(started.pid).not.toBe(shortLived.pid)
    expect(makeControl(ws).status()).toEqual({ running: true, pid: started.pid })
  })

  test('stop is idempotent: nothing running, no pidfile — a clean no-op', async () => {
    const ws = makeWorkspace()
    const control = makeControl(ws)
    await control.stop()
    await control.stop()
    expect(control.status()).toEqual({ running: false })
  })

  test('restart replaces the process and comes back ready', async () => {
    const ws = makeWorkspace()
    const port = freePort()
    writeToml(ws, port)

    const first = await makeControl(ws).start()
    const second = await makeControl(ws).restart()

    expect(second.pid).not.toBe(first.pid)
    expect(alive(first.pid)).toBe(false)
    expect(alive(second.pid)).toBe(true)
    const response = await fetch(urlFor(port))
    expect(response.status).toBe(200)
  })

  test('readyTimeout kills the group, removes the pidfile, and throws with the log tail', async () => {
    const ws = makeWorkspace()
    const port = freePort()
    const pidFile = join(ws, 'never.pid')
    writeToml(ws, port, {
      start: `PID_FILE=${pidFile} bun ${neverFixture}`,
      readyTimeout: 1,
    })

    let error: Error | undefined
    try {
      await makeControl(ws).start()
    } catch (caught) {
      error = caught as Error
    }

    expect(error).toBeDefined()
    expect(error!.message).toContain('not ready after 1s')
    expect(error!.message).toContain('--- server log tail ---')
    expect(error!.message).toContain('never-ready fixture waiting')
    expect(existsSync(join(ws, '.ab', 'server.pid'))).toBe(false)

    const fixturePid = Number(readFileSync(pidFile, 'utf8'))
    await waitFor(() => !alive(fixturePid), 2000)
    expect(alive(fixturePid)).toBe(false)
  })

  test('a command that exits before ready fails fast with the log tail', async () => {
    const ws = makeWorkspace()
    writeToml(ws, freePort(), { start: 'echo boom-line && exit 7' })

    const before = Date.now()
    let error: Error | undefined
    try {
      await makeControl(ws).start()
    } catch (caught) {
      error = caught as Error
    }
    expect(error).toBeDefined()
    expect(Date.now() - before).toBeLessThan(3000)
    expect(error!.message).toContain('exited before becoming ready')
    expect(error!.message).toContain('boom-line')
    expect(existsSync(join(ws, '.ab', 'server.pid'))).toBe(false)
  })
})
