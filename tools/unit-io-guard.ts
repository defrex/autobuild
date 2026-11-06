/**
 * Unit-suite IO guard, loaded with `bun test --preload` by `bun run test` only.
 *
 * A unit test runs in memory: no filesystem, subprocess, network socket or
 * real clock wait. Every guarded entry point records a violation and throws
 * (or rejects); a global `afterEach` fails the test when anything was
 * recorded, so IO that product code swallows in `try/catch` still fails.
 * Delayed timers record only when they actually fire, because product code
 * arms deadlines and heartbeats it never waits on.
 *
 * Module loading by the test runner (imports, JSON, snapshots) is exempt.
 * `Bun.fetch` is a non-configurable read-only property and cannot be wrapped;
 * the `fetch` global is.
 *
 * Capitalized exports of guarded modules, classified:
 *
 * | module          | export                                | handling                         |
 * | --------------- | ------------------------------------- | -------------------------------- |
 * | fs              | Dirent, Stats                         | data, passes through             |
 * | fs              | Dir                                   | constructor denied               |
 * | fs              | ReadStream, WriteStream,              | constructor denied for paths;    |
 * |                 | FileReadStream, FileWriteStream,      | numeric descriptors allowed      |
 * |                 | Utf8Stream                            |                                  |
 * | child_process   | ChildProcess                          | `#spawn` denied                  |
 * | net             | Socket (= Stream)                     | prototype `connect` denied       |
 * | net             | Server                                | prototype `listen` denied        |
 * | net             | BlockList, SocketAddress              | data, passes through             |
 * | tls             | TLSSocket, Server                     | covered by net prototypes        |
 * | tls             | SecureContext                         | data, passes through             |
 * | http, https     | Server                                | prototype `listen` denied        |
 * | http            | ClientRequest, WebSocket              | constructor denied               |
 * | http, https     | Agent                                 | sockets go through net.Socket    |
 * | http            | ServerResponse, IncomingMessage,      | data, passes through             |
 * |                 | OutgoingMessage, CloseEvent,          |                                  |
 * |                 | MessageEvent                          |                                  |
 * | http2           | ClientHttp2Session                    | constructor denied               |
 * | http2           | Http2ServerRequest/Response           | data, passes through             |
 * | dgram           | Socket                                | prototype bind/connect/send      |
 * | dns, dns/promis | Resolver                              | constructor denied               |
 * | bun:sqlite      | Database                              | constructor and `open` denied    |
 * |                 |                                       | for files; in-memory allowed     |
 * | bun:sqlite      | Database#loadExtension, SQL that      | denied                           |
 * |                 | ATTACHes or VACUUMs INTO anything but |                                  |
 * |                 | a literal in-memory name              |                                  |
 * | bun:sqlite      | Statement, SQLiteError, constants     | data, passes through             |
 */
import { afterAll, afterEach, beforeEach, mock } from 'bun:test'
import { createRequire } from 'node:module'
import { relative, resolve } from 'node:path'

export const UNIT_IO_GUARD_MESSAGE_HINT =
  'A test that touches the filesystem, a subprocess, a network socket or the real clock is an integration test: rename it *.integration.test.ts (AGENTS.md "Development conventions"), or rewrite it against an in-memory fake or injected clock.'

type Category = 'filesystem' | 'subprocess' | 'network' | 'real clock'

const GUARD_KEY = Symbol.for('autobuild.unitIoGuard')
const root = resolve(import.meta.dir, '..')
const guardFile = import.meta.path

// Shared through the global so a second module instance drains the same list.
const VIOLATIONS_KEY = Symbol.for('autobuild.unitIoGuard.violations')
const shared = globalThis as Record<symbol, unknown>
if (!Array.isArray(shared[VIOLATIONS_KEY])) shared[VIOLATIONS_KEY] = []
const violations = shared[VIOLATIONS_KEY] as string[]

/** Returns and clears every violation recorded since the last drain. */
export function drainUnitIoViolations(): string[] {
  return violations.splice(0)
}

function callSite(stack: string | undefined): string {
  const frames = (stack ?? '').split('\n').slice(1)
  for (const frame of frames) {
    if (frame.includes(guardFile)) continue
    const match = /\(?((?:\/|file:\/\/)[^():]+):(\d+)(?::\d+)?\)?\s*$/.exec(frame.trim())
    if (!match?.[1]) continue
    const path = match[1].replace(/^file:\/\//, '')
    return `${relative(root, path)}:${match[2]}`
  }
  return 'an unknown location'
}

function message(name: string, category: Category, site: string): string {
  return `Unit tests must not do IO: ${name} (${category}) at ${site}. ${UNIT_IO_GUARD_MESSAGE_HINT}`
}

function record(name: string, category: Category, stack = new Error().stack): Error {
  const text = message(name, category, callSite(stack))
  violations.push(text)
  return new Error(text)
}

function flush(): void {
  const pending = drainUnitIoViolations()
  if (pending.length) throw new Error([...new Set(pending)].join('\n'))
}

// biome-ignore lint/suspicious/noExplicitAny: wraps arbitrary module exports
type AnyFunction = (...args: any[]) => any

function denySync(name: string, category: Category): AnyFunction {
  return () => {
    throw record(name, category)
  }
}

function denyAsync(name: string, category: Category): AnyFunction {
  return () => Promise.reject(record(name, category))
}

/** Pure helpers on guarded modules that never perform IO. */
const PURE = new Set([
  'net.isIP',
  'net.isIPv4',
  'net.isIPv6',
  'net.getDefaultAutoSelectFamily',
  'net.setDefaultAutoSelectFamily',
  'net.getDefaultAutoSelectFamilyAttemptTimeout',
  'net.setDefaultAutoSelectFamilyAttemptTimeout',
  'tls.convertALPNProtocols',
  'tls.createSecureContext',
  'tls.getCiphers',
  'tls.parseCertString',
  'tls.checkServerIdentity',
  'http.validateHeaderName',
  'http.validateHeaderValue',
  'http.setMaxIdleHTTPParsers',
  'http2.getDefaultSettings',
  'http2.getPackedSettings',
  'http2.getUnpackedSettings',
  'dns.setServers',
  'dns.getServers',
  'dns.setDefaultResultOrder',
  'dns.getDefaultResultOrder',
  'dns/promises.setServers',
  'dns/promises.getServers',
  'dns/promises.setDefaultResultOrder',
  'dns/promises.getDefaultResultOrder',
])

function isDescriptor(value: unknown): boolean {
  return typeof value === 'number'
}

// biome-ignore lint/suspicious/noExplicitAny: wraps arbitrary classes
type AnyClass = new (...args: any[]) => any

function deniedClass(
  base: AnyClass,
  name: string,
  category: Category,
  allow?: (args: unknown[]) => boolean,
): AnyClass {
  const Denied = class extends base {
    constructor(...args: unknown[]) {
      if (!allow?.(args)) throw record(name, category)
      super(...args)
    }
  }
  Object.defineProperty(Denied, 'name', { value: base.name })
  return Denied
}

const closed = new WeakSet<AnyFunction>()

/** Closes an inherited entry point once, under the most general owner's name. */
function closePrototype(target: object, method: string, name: string, category: Category): void {
  const current = (target as Record<string, unknown>)[method]
  if (typeof current !== 'function' || closed.has(current as AnyFunction)) return
  const denied = denySync(name, category)
  closed.add(denied)
  Object.defineProperty(target, method, { configurable: true, writable: true, value: denied })
}

/**
 * True when a SQLite filename names an in-memory database. Bun opens without
 * URI mode, so `file::memory:` and `?mode=memory` are ordinary file names.
 */
export function isInMemorySqlite(filename: unknown): boolean {
  return filename === undefined || filename === null || filename === '' || filename === ':memory:'
}

const SQLITE_FILE_TARGET =
  /\b(?:ATTACH(?:\s+DATABASE)?|VACUUM(?:\s+\w+)?\s+INTO)\s+([\s\S]*?)(?=\s+AS\b|\s*;|\s*$)/gi
const SQLITE_MEMORY_LITERAL = /^(['"])(?::memory:)?\1$/

/**
 * Names the first target an SQL text ATTACHes or VACUUMs INTO, unless it is a
 * literal in-memory name. A bound parameter or any expression counts as a file,
 * because its value is only known when the statement executes.
 */
export function sqliteFileTarget(sql: unknown): string | undefined {
  if (typeof sql !== 'string') return undefined
  for (const match of sql.matchAll(SQLITE_FILE_TARGET))
    if (!SQLITE_MEMORY_LITERAL.test(match[1] ?? '')) return match[1] ?? ''
  return undefined
}

type ModuleSpec = {
  id: string
  label: string
  category: Category
  async?: boolean
  classes?: Record<string, AnyClass>
  extra?: Record<string, unknown>
}

function wrapModule(real: Record<string, unknown>, spec: ModuleSpec): Record<string, unknown> {
  const wrapped: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(real)) {
    const name = `${spec.label}.${key}`
    if (spec.classes && key in spec.classes) wrapped[key] = spec.classes[key]
    else if (typeof value !== 'function' || /^[A-Z]/.test(key) || PURE.has(name))
      wrapped[key] = value
    else wrapped[key] = spec.async ? denyAsync(name, spec.category) : denySync(name, spec.category)
  }
  Object.assign(wrapped, spec.extra)
  wrapped.default = wrapped
  return wrapped
}

function wrapTimer(real: AnyFunction, name: string): AnyFunction {
  return (callback: unknown, delay?: unknown, ...args: unknown[]) => {
    if (typeof callback !== 'function' || !(Number(delay) > 0))
      return real(callback, delay, ...args)
    const stack = new Error().stack
    let fired = false
    return real(
      (...callbackArgs: unknown[]) => {
        if (!fired) {
          fired = true
          record(name, 'real clock', stack)
        }
        return (callback as AnyFunction)(...callbackArgs)
      },
      delay,
      ...args,
    )
  }
}

function install(): void {
  const global = globalThis as Record<symbol, unknown>
  if (global[GUARD_KEY]) return
  global[GUARD_KEY] = true

  const require = createRequire(import.meta.path)
  const fs = require('node:fs')
  const fsPromises = require('node:fs/promises')
  const childProcess = require('node:child_process')
  const net = require('node:net')
  const tls = require('node:tls')
  const http = require('node:http')
  const https = require('node:https')
  const http2 = require('node:http2')
  const dgram = require('node:dgram')
  const dns = require('node:dns')
  const dnsPromises = require('node:dns/promises')
  const timers = require('node:timers')
  const timersPromises = require('node:timers/promises')
  const sqlite = require('bun:sqlite')

  const realSetTimeout = globalThis.setTimeout
  const realSetInterval = globalThis.setInterval

  // Entry points on real prototypes also cover instances product code creates
  // internally and subclasses such as tls.TLSSocket and tls.Server.
  closePrototype(net.Socket.prototype, 'connect', 'net.Socket#connect', 'network')
  closePrototype(net.Server.prototype, 'listen', 'net.Server#listen', 'network')
  closePrototype(http.Server.prototype, 'listen', 'http.Server#listen', 'network')
  closePrototype(https.Server.prototype, 'listen', 'https.Server#listen', 'network')
  for (const method of ['bind', 'connect', 'send'])
    closePrototype(dgram.Socket.prototype, method, `dgram.Socket#${method}`, 'network')
  closePrototype(
    childProcess.ChildProcess.prototype,
    'spawn',
    'child_process.ChildProcess#spawn',
    'subprocess',
  )

  // bun:sqlite opens files natively, below node:fs. In-memory databases stay
  // allowed; SQL statements reach files through ATTACH and VACUUM INTO.
  const SqliteDatabase = deniedClass(sqlite.Database, 'bun:sqlite.Database', 'filesystem', (args) =>
    isInMemorySqlite(args[0]),
  )
  Object.defineProperty(SqliteDatabase, 'open', {
    configurable: true,
    writable: true,
    value: (filename: unknown, options?: unknown) => new SqliteDatabase(filename, options),
  })
  closePrototype(
    sqlite.Database.prototype,
    'loadExtension',
    'bun:sqlite.Database#loadExtension',
    'filesystem',
  )
  for (const method of ['exec', 'run', 'query', 'prepare']) {
    const real = sqlite.Database.prototype[method] as AnyFunction
    Object.defineProperty(sqlite.Database.prototype, method, {
      configurable: true,
      writable: true,
      value: function (this: unknown, sql: unknown, ...rest: unknown[]) {
        if (sqliteFileTarget(sql) !== undefined)
          throw record(`bun:sqlite.Database#${method}`, 'filesystem')
        return real.call(this, sql, ...rest)
      },
    })
  }
  sqlite.Database.setCustomSQLite = denySync('bun:sqlite.Database.setCustomSQLite', 'filesystem')

  const allowDescriptor = (args: unknown[]) =>
    isDescriptor(args[0]) || isDescriptor((args[1] as { fd?: unknown })?.fd)
  const fsPromisesWrapped = wrapModule(fsPromises, {
    id: 'fs/promises',
    label: 'fs/promises',
    category: 'filesystem',
    async: true,
  })
  const fsWrapped = wrapModule(fs, {
    id: 'fs',
    label: 'fs',
    category: 'filesystem',
    classes: {
      Dir: deniedClass(fs.Dir, 'fs.Dir', 'filesystem'),
      ReadStream: deniedClass(fs.ReadStream, 'fs.ReadStream', 'filesystem', allowDescriptor),
      WriteStream: deniedClass(fs.WriteStream, 'fs.WriteStream', 'filesystem', allowDescriptor),
      FileReadStream: deniedClass(
        fs.FileReadStream,
        'fs.FileReadStream',
        'filesystem',
        allowDescriptor,
      ),
      FileWriteStream: deniedClass(
        fs.FileWriteStream,
        'fs.FileWriteStream',
        'filesystem',
        allowDescriptor,
      ),
      Utf8Stream: deniedClass(fs.Utf8Stream, 'fs.Utf8Stream', 'filesystem', (args) =>
        isDescriptor((args[0] as { fd?: unknown })?.fd),
      ),
    },
    extra: { promises: fsPromisesWrapped },
  })

  const modules: [string, Record<string, unknown>][] = [
    ['fs', fsWrapped],
    ['fs/promises', fsPromisesWrapped],
    [
      'child_process',
      wrapModule(childProcess, {
        id: 'child_process',
        label: 'child_process',
        category: 'subprocess',
        classes: { ChildProcess: childProcess.ChildProcess },
      }),
    ],
    ['net', wrapModule(net, { id: 'net', label: 'net', category: 'network' })],
    ['tls', wrapModule(tls, { id: 'tls', label: 'tls', category: 'network' })],
    [
      'http',
      wrapModule(http, {
        id: 'http',
        label: 'http',
        category: 'network',
        classes: {
          ClientRequest: deniedClass(http.ClientRequest, 'http.ClientRequest', 'network'),
          WebSocket: deniedClass(http.WebSocket, 'http.WebSocket', 'network'),
        },
      }),
    ],
    ['https', wrapModule(https, { id: 'https', label: 'https', category: 'network' })],
    [
      'http2',
      wrapModule(http2, {
        id: 'http2',
        label: 'http2',
        category: 'network',
        classes: {
          ClientHttp2Session: deniedClass(
            http2.ClientHttp2Session,
            'http2.ClientHttp2Session',
            'network',
          ),
        },
      }),
    ],
    ['dgram', wrapModule(dgram, { id: 'dgram', label: 'dgram', category: 'network' })],
    [
      'dns/promises',
      wrapModule(dnsPromises, {
        id: 'dns/promises',
        label: 'dns/promises',
        category: 'network',
        async: true,
        classes: {
          Resolver: deniedClass(dnsPromises.Resolver, 'dns/promises.Resolver', 'network'),
        },
      }),
    ],
  ]
  modules.push([
    'dns',
    wrapModule(dns, {
      id: 'dns',
      label: 'dns',
      category: 'network',
      classes: { Resolver: deniedClass(dns.Resolver, 'dns.Resolver', 'network') },
      extra: { promises: modules.find(([id]) => id === 'dns/promises')?.[1] },
    }),
  ])
  modules.push([
    'timers',
    {
      ...timers,
      setTimeout: wrapTimer(timers.setTimeout, 'timers.setTimeout'),
      setInterval: wrapTimer(timers.setInterval, 'timers.setInterval'),
    },
  ])
  const timersPromisesWrapped: Record<string, unknown> = {
    ...timersPromises,
    setTimeout: (delay?: unknown, ...rest: unknown[]) => {
      if (!(Number(delay) > 0)) return timersPromises.setTimeout(delay, ...rest)
      const stack = new Error().stack
      return timersPromises.setTimeout(delay, ...rest).then((value: unknown) => {
        record('timers/promises.setTimeout', 'real clock', stack)
        return value
      })
    },
    setInterval: (delay?: unknown, ...rest: unknown[]) => {
      const iterator = timersPromises.setInterval(delay, ...rest)
      if (!(Number(delay) > 0)) return iterator
      const stack = new Error().stack
      let ticked = false
      return {
        [Symbol.asyncIterator]() {
          return this
        },
        async next() {
          const result = await iterator.next()
          if (!ticked && !result.done) {
            ticked = true
            record('timers/promises.setInterval', 'real clock', stack)
          }
          return result
        },
        return: (value?: unknown) => iterator.return(value),
        throw: (error?: unknown) => iterator.throw(error),
      }
    },
    scheduler: {
      ...timersPromises.scheduler,
      yield: () => timersPromises.scheduler.yield(),
      wait: (delay?: unknown, options?: unknown) => {
        if (!(Number(delay) > 0)) return timersPromises.scheduler.wait(delay, options)
        const stack = new Error().stack
        return timersPromises.scheduler.wait(delay, options).then((value: unknown) => {
          record('timers/promises.scheduler.wait', 'real clock', stack)
          return value
        })
      },
    },
  }
  modules.push(['timers/promises', timersPromisesWrapped])
  ;(modules.find(([id]) => id === 'timers')?.[1] as Record<string, unknown>).promises =
    timersPromisesWrapped

  const sqliteWrapped: Record<string, unknown> = { ...sqlite, Database: SqliteDatabase }
  sqliteWrapped.default = sqliteWrapped
  mock.module('bun:sqlite', () => sqliteWrapped)

  for (const [id, wrapped] of modules) {
    if (!('default' in wrapped) || wrapped.default !== wrapped) wrapped.default = wrapped
    mock.module(`node:${id}`, () => wrapped)
    mock.module(id, () => wrapped)
  }

  // Globals.
  globalThis.setTimeout = wrapTimer(realSetTimeout, 'setTimeout') as typeof setTimeout
  globalThis.setInterval = wrapTimer(realSetInterval, 'setInterval') as typeof setInterval

  const realAbortTimeout = AbortSignal.timeout.bind(AbortSignal)
  AbortSignal.timeout = (ms: number) => {
    const signal = realAbortTimeout(ms)
    if (ms > 0) {
      const stack = new Error().stack
      signal.addEventListener('abort', () => record('AbortSignal.timeout', 'real clock', stack), {
        once: true,
      })
    }
    return signal
  }

  const realWait = Atomics.wait.bind(Atomics)
  const realWaitAsync = (Atomics as { waitAsync?: AnyFunction }).waitAsync?.bind(Atomics)
  ;(Atomics as { wait: AnyFunction }).wait = (
    array: Int32Array,
    index: number,
    value: number,
    timeout?: number,
  ) => {
    if (timeout === 0) return realWait(array, index, value, 0)
    throw record('Atomics.wait', 'real clock')
  }
  if (realWaitAsync)
    (Atomics as { waitAsync: AnyFunction }).waitAsync = (
      array: Int32Array,
      index: number,
      value: number,
      timeout?: number,
    ) => {
      const result = realWaitAsync(array, index, value, timeout)
      if (timeout === 0 || !result.async) return result
      const stack = new Error().stack
      return {
        ...result,
        value: result.value.then((outcome: string) => {
          if (outcome === 'timed-out') record('Atomics.waitAsync', 'real clock', stack)
          return outcome
        }),
      }
    }

  const bun = Bun as unknown as Record<string, unknown>
  const denyBun: [string, Category][] = [
    ['spawn', 'subprocess'],
    ['spawnSync', 'subprocess'],
    ['$', 'subprocess'],
    ['write', 'filesystem'],
    ['build', 'filesystem'],
    ['mmap', 'filesystem'],
    ['serve', 'network'],
    ['connect', 'network'],
    ['listen', 'network'],
    ['udpSocket', 'network'],
    ['sleepSync', 'real clock'],
  ]
  for (const [key, category] of denyBun) bun[key] = denySync(`Bun.${key}`, category)
  bun.sleep = denyAsync('Bun.sleep', 'real clock')

  const realFile = Bun.file
  // Bun's own process.stdout/stderr streams call Bun.file(fd); only paths are IO.
  bun.file = (target: unknown, options?: unknown) => {
    if (!isDescriptor(target)) throw record('Bun.file', 'filesystem')
    return (realFile as AnyFunction)(target, options)
  }
  closePrototype(Bun.Glob.prototype, 'scan', 'Bun.Glob#scan', 'filesystem')
  closePrototype(Bun.Glob.prototype, 'scanSync', 'Bun.Glob#scanSync', 'filesystem')

  globalThis.fetch = Object.assign(denyAsync('fetch', 'network'), {
    preconnect: denySync('fetch.preconnect', 'network'),
  }) as unknown as typeof fetch
  globalThis.WebSocket = deniedClass(WebSocket, 'WebSocket', 'network') as typeof WebSocket

  beforeEach(flush)
  afterEach(flush)
  // Runs once after the whole run, catching violations no test hook drained
  // (for example import-time IO in a file whose tests are all skipped).
  // `bun test` does not emit beforeExit, so this hook is the backstop.
  afterAll(flush)
}

install()
