import { describe, expect, test } from 'bun:test'
import { drainUnitIoViolations, UNIT_IO_GUARD_MESSAGE_HINT } from './unit-io-guard'

function expectViolation(name: string): void {
  const drained = drainUnitIoViolations()
  expect(drained).toHaveLength(1)
  expect(drained[0]).toContain(`Unit tests must not do IO: ${name} (`)
  expect(drained[0]).toContain('tools/unit-io-guard.test.ts:')
  expect(drained[0]).toContain(UNIT_IO_GUARD_MESSAGE_HINT)
}

function expectThrows(name: string, call: () => unknown): void {
  expect(call).toThrow(name)
  expect(call).toThrow('*.integration.test.ts')
  drainUnitIoViolations()
  try {
    call()
  } catch {}
  expectViolation(name)
}

async function expectRejects(name: string, call: () => Promise<unknown>): Promise<void> {
  await expect(call()).rejects.toThrow(name)
  await expect(call()).rejects.toThrow('*.integration.test.ts')
  drainUnitIoViolations()
  await call().catch(() => undefined)
  expectViolation(name)
}

describe('unit IO guard', () => {
  test('denies filesystem access', async () => {
    const fs = await import('node:fs')
    const fsPromises = await import('node:fs/promises')
    expectThrows('fs.readFileSync', () => fs.readFileSync('package.json'))
    expectThrows('fs.readFileSync', () => fs.default.readFileSync('package.json'))
    await expectRejects('fs/promises.readFile', () => fsPromises.readFile('package.json'))
    await expectRejects('fs/promises.readFile', () => fs.promises.readFile('package.json'))
    const ReadStream = fs.ReadStream as unknown as new (path: string) => unknown
    expectThrows('fs.ReadStream', () => new ReadStream('package.json'))
    expectThrows('Bun.file', () => Bun.file('package.json'))
    expectThrows('Bun.Glob#scanSync', () => Array.from(new Bun.Glob('*').scanSync('.')))
  })

  test('allows pure helpers and descriptor streams', () => {
    expect(Bun.file(1)).toBeDefined()
    expect(new Bun.Glob('*.ts').match('x.ts')).toBe(true)
    expect(drainUnitIoViolations()).toEqual([])
  })

  test('denies file-backed SQLite and allows in-memory databases', async () => {
    const { Database } = await import('bun:sqlite')
    expectThrows('bun:sqlite.Database', () => new Database('.ab/unit-io-guard.sqlite'))
    expectThrows('bun:sqlite.Database', () => Database.open('.ab/unit-io-guard.sqlite'))
    expectThrows('bun:sqlite.Database', () => new Database('file::memory:'))
    const db = new Database(':memory:')
    for (const method of ['exec', 'run', 'query', 'prepare'] as const)
      expectThrows(`bun:sqlite.Database#${method}`, () =>
        (db[method] as (sql: string) => unknown).call(
          db,
          "ATTACH DATABASE '.ab/unit-io-guard.sqlite' AS probe",
        ),
      )
    expectThrows('bun:sqlite.Database#exec', () =>
      db.exec("VACUUM INTO '.ab/unit-io-guard.sqlite'"),
    )
    expectThrows('bun:sqlite.Database#loadExtension', () => db.loadExtension('.ab/probe'))
    db.exec("ATTACH ':memory:' AS scratch")
    db.exec('CREATE TABLE probe (value TEXT)')
    db.run("INSERT INTO probe VALUES ('kept in memory')")
    expect(db.query('SELECT COUNT(*) AS n FROM probe').get()).toEqual({ n: 1 })
    db.close()
    for (const filename of [undefined, '']) new Database(filename).close()
    expect(drainUnitIoViolations()).toEqual([])
  })

  test('denies subprocesses', async () => {
    const childProcess = await import('node:child_process')
    expectThrows('child_process.spawnSync', () => childProcess.spawnSync('true'))
    expectThrows('Bun.spawnSync', () => Bun.spawnSync(['true']))
    expectThrows('Bun.spawn', () => Bun.spawn(['true']))
  })

  test('denies network access', async () => {
    const net = await import('node:net')
    const http = await import('node:http')
    const dgram = await import('node:dgram')
    expect(net.isIP('127.0.0.1')).toBe(4)
    expectThrows('Bun.serve', () => Bun.serve({ port: 0, fetch: () => new Response('') }))
    await expectRejects('fetch', () => fetch('http://127.0.0.1:9'))
    expectThrows('net.connect', () => net.connect(9, '127.0.0.1'))
    expectThrows('net.Socket#connect', () => new net.Socket().connect(9, '127.0.0.1'))
    expectThrows('net.createServer', () => net.createServer())
    // Instances made by the real module (as product internals would) are closed too.
    const { Server } = net
    expectThrows('net.Server#listen', () => new Server().listen(0))
    expectThrows('http.Server#listen', () => new http.Server().listen(0))
    expectThrows('dgram.createSocket', () => dgram.createSocket('udp4'))
    const socket = Object.create(dgram.Socket.prototype) as InstanceType<typeof dgram.Socket>
    expectThrows('dgram.Socket#bind', () => socket.bind(0))
  })

  test('denies real clock waits', async () => {
    await expectRejects('Bun.sleep', () => Bun.sleep(1))
    expectThrows('Atomics.wait', () =>
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10),
    )
    expect(Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 0)).toBe('timed-out')
    expect(drainUnitIoViolations()).toEqual([])
  })

  test('records delayed timers only when they fire', async () => {
    clearTimeout(setTimeout(() => undefined, 50))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(drainUnitIoViolations()).toEqual([])

    const timersPromises = await import('node:timers/promises')
    await timersPromises.setTimeout(5)
    expectViolation('timers/promises.setTimeout')

    const timers = await import('node:timers')
    await new Promise((resolve) => timers.setTimeout(resolve, 5))
    expectViolation('timers.setTimeout')

    await new Promise((resolve) => setTimeout(resolve, 5))
    expectViolation('setTimeout')
  })
})
