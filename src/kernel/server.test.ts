/**
 * Contract tests for the dev-server lifecycle seam (SPEC §16.2, D10), driven
 * with real processes: fixture bun scripts written to a temp dir at test
 * time, real localhost fetch for the readiness probe. Fast poll/grace values
 * are injected so the whole file stays well under the time budget.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DevServerManager } from './server'

const SERVER_MODULE = join(import.meta.dir, 'server.ts')

let dir: string
let serverFixture: string
let neverFixture: string
let heartbeatFixture: string

/** Managers created by tests; afterEach stops them so failures never leak. */
const managers: DevServerManager[] = []

function makeManager(opts: {
  start: string
  url: string
  readyTimeout?: number
  logPath?: string
}): DevServerManager {
  const manager = new DevServerManager({
    config: { start: opts.start, url: opts.url, readyTimeout: opts.readyTimeout ?? 10 },
    cwd: dir,
    logPath: opts.logPath,
    pollIntervalMs: 25,
    killGraceMs: 500,
  })
  managers.push(manager)
  return manager
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
  dir = mkdtempSync(join(tmpdir(), 'ab-server-test-'))

  serverFixture = join(dir, 'fixture-server.ts')
  await Bun.write(
    serverFixture,
    [
      "const port = Number(process.env.PORT)",
      "const delayMs = Number(process.env.DELAY_MS ?? '0')",
      "console.log('fixture-alpha')",
      "console.log('fixture-beta')",
      "console.log('fixture-gamma')",
      'if (delayMs > 0) await Bun.sleep(delayMs)',
      "Bun.serve({ port, fetch: () => new Response('ok') })",
      '',
    ].join('\n'),
  )

  neverFixture = join(dir, 'fixture-never.ts')
  await Bun.write(
    neverFixture,
    [
      "console.log('never-ready fixture waiting')",
      'await Bun.write(process.env.PID_FILE!, String(process.pid))',
      'await Bun.sleep(1 << 30)',
      '',
    ].join('\n'),
  )

  heartbeatFixture = join(dir, 'fixture-heartbeat.ts')
  await Bun.write(
    heartbeatFixture,
    [
      "import { appendFileSync } from 'node:fs'",
      'const file = process.argv[2]!',
      "setInterval(() => appendFileSync(file, 'beat\\n'), 50)",
      '',
    ].join('\n'),
  )
})

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stop()
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('DevServerManager', () => {
  test('status false before start, running with pid during, false after stop; stop is idempotent', async () => {
    const port = freePort()
    const url = urlFor(port)
    const manager = makeManager({ start: `PORT=${port} bun ${serverFixture}`, url })

    expect(manager.status()).toEqual({ running: false, url })

    const started = await manager.start()
    expect(started.running).toBe(true)
    expect(started.pid).toBeGreaterThan(0)
    expect(alive(started.pid!)).toBe(true)
    expect(manager.status()).toEqual({ running: true, pid: started.pid, url })

    await manager.stop()
    expect(manager.status()).toEqual({ running: false, url })
    expect(alive(started.pid!)).toBe(false)

    await manager.stop()
    expect(manager.status()).toEqual({ running: false, url })
  })

  test('start resolves only after the readiness probe gets an HTTP response', async () => {
    const port = freePort()
    const manager = makeManager({
      start: `DELAY_MS=300 PORT=${port} bun ${serverFixture}`,
      url: urlFor(port),
    })

    const before = Date.now()
    const status = await manager.start()
    const elapsed = Date.now() - before

    // The fixture does not listen for its first 300ms, so a resolved start
    // proves the probe waited for a real response.
    expect(elapsed).toBeGreaterThanOrEqual(280)
    expect(status.running).toBe(true)
    const response = await fetch(urlFor(port))
    expect(response.status).toBe(200)
  })

  test('double start is a no-op returning the current status (same pid)', async () => {
    const port = freePort()
    const manager = makeManager({ start: `PORT=${port} bun ${serverFixture}`, url: urlFor(port) })

    const first = await manager.start()
    const second = await manager.start()
    expect(second).toEqual(first)
    expect(second.pid).toBe(first.pid)
  })

  test('readyTimeout kills the process and throws with the log tail', async () => {
    const port = freePort()
    const pidFile = join(dir, 'never.pid')
    const manager = makeManager({
      start: `PID_FILE=${pidFile} bun ${neverFixture}`,
      url: urlFor(port),
      readyTimeout: 1,
    })

    const before = Date.now()
    let error: Error | undefined
    try {
      await manager.start()
    } catch (caught) {
      error = caught as Error
    }
    const elapsed = Date.now() - before

    expect(error).toBeDefined()
    expect(elapsed).toBeGreaterThanOrEqual(1000)
    expect(elapsed).toBeLessThan(1500)
    expect(error!.message).toContain('not ready after 1s')
    expect(error!.message).toContain('--- server log tail ---')
    expect(error!.message).toContain('never-ready fixture waiting')

    const fixturePid = Number(readFileSync(pidFile, 'utf8'))
    await waitFor(() => !alive(fixturePid), 1000)
    expect(alive(fixturePid)).toBe(false)
    expect(manager.status().running).toBe(false)
  })

  test('start fails fast with the log tail when the command exits before ready', async () => {
    const manager = makeManager({
      start: 'echo boom-line && exit 7',
      url: urlFor(freePort()),
      readyTimeout: 10,
    })

    const before = Date.now()
    let error: Error | undefined
    try {
      await manager.start()
    } catch (caught) {
      error = caught as Error
    }

    expect(error).toBeDefined()
    expect(Date.now() - before).toBeLessThan(2000)
    expect(error!.message).toContain('exited with code 7 before becoming ready')
    expect(error!.message).toContain('boom-line')
    expect(manager.status().running).toBe(false)
  })

  test('stop kills the whole process group, not just the direct child', async () => {
    const port = freePort()
    const heartbeatFile = join(dir, 'heartbeat.txt')
    // Nested spawn: the heartbeat child is a sibling in the same group and
    // would outlive a leader-only kill.
    const manager = makeManager({
      start: `bun ${heartbeatFixture} ${heartbeatFile} & PORT=${port} bun ${serverFixture}`,
      url: urlFor(port),
    })

    await manager.start()
    await waitFor(() => existsSync(heartbeatFile) && statSync(heartbeatFile).size > 0, 2000)

    await manager.stop()
    await Bun.sleep(150)
    const sizeAfterStop = statSync(heartbeatFile).size
    await Bun.sleep(250)
    expect(statSync(heartbeatFile).size).toBe(sizeAfterStop)
    expect(manager.status().running).toBe(false)
  })

  test('logs returns the last N tail lines and the log file contains them', async () => {
    const port = freePort()
    const logPath = join(dir, 'custom-server.log')
    const manager = makeManager({
      start: `PORT=${port} bun ${serverFixture}`,
      url: urlFor(port),
      logPath,
    })

    await manager.start()
    await waitFor(() => manager.logs().includes('fixture-gamma'), 2000)

    expect(manager.logs(2)).toEqual(['fixture-beta', 'fixture-gamma'])
    expect(manager.logs()).toEqual(['fixture-alpha', 'fixture-beta', 'fixture-gamma'])

    expect(existsSync(logPath)).toBe(true)
    const fileContent = readFileSync(logPath, 'utf8')
    expect(fileContent).toContain('fixture-alpha')
    expect(fileContent).toContain('fixture-beta')
    expect(fileContent).toContain('fixture-gamma')
  })

  test('default log path is <cwd>/.ab/server.log', async () => {
    const port = freePort()
    const manager = makeManager({ start: `PORT=${port} bun ${serverFixture}`, url: urlFor(port) })

    await manager.start()
    await waitFor(() => existsSync(join(dir, '.ab', 'server.log')), 2000)
    await waitFor(
      () => readFileSync(join(dir, '.ab', 'server.log'), 'utf8').includes('fixture-gamma'),
      2000,
    )
  })

  test('restart replaces the process and comes back ready', async () => {
    const port = freePort()
    const manager = makeManager({ start: `PORT=${port} bun ${serverFixture}`, url: urlFor(port) })

    const first = await manager.start()
    const second = await manager.restart()

    expect(second.running).toBe(true)
    expect(second.pid).not.toBe(first.pid)
    expect(alive(first.pid!)).toBe(false)
    const response = await fetch(urlFor(port))
    expect(response.status).toBe(200)
  })

  test('process exit hook kills the group even when stop() is never called (D10)', async () => {
    const port = freePort()
    const pidFile = join(dir, 'orphan.pid')
    const driverPath = join(dir, 'driver.ts')
    await Bun.write(
      driverPath,
      [
        `import { DevServerManager } from ${JSON.stringify(SERVER_MODULE)}`,
        'const manager = new DevServerManager({',
        `  config: { start: ${JSON.stringify(`PORT=${port} bun ${serverFixture}`)}, url: ${JSON.stringify(urlFor(port))}, readyTimeout: 10 },`,
        `  cwd: ${JSON.stringify(dir)},`,
        '  pollIntervalMs: 25,',
        '})',
        'const status = await manager.start()',
        `await Bun.write(${JSON.stringify(pidFile)}, String(status.pid))`,
        'process.exit(0) // no stop(): the exit hook must tear the group down',
        '',
      ].join('\n'),
    )

    const driver = Bun.spawn(['bun', driverPath], { cwd: dir, stdout: 'ignore', stderr: 'pipe' })
    const exitCode = await driver.exited
    expect(exitCode).toBe(0)

    const serverPid = Number(readFileSync(pidFile, 'utf8'))
    expect(serverPid).toBeGreaterThan(0)
    await waitFor(() => !alive(serverPid), 2000)
    expect(alive(serverPid)).toBe(false)
  })
})
