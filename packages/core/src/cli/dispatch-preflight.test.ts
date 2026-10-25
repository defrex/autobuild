import { temporaryDirectories as ownTempDirectories } from '../testing/temp-directories'
import { afterEach, expect, test } from 'bun:test'
import { prepareDispatcherYield } from './dispatch-preflight'
import { classifyClient } from '../store/remote/compatibility'
import type { BuildStore } from '../store/types'
import type { Handoff } from '../kernel/dispatch-upgrade'

const mkdtemp = ownTempDirectories(afterEach)

const handoff: Handoff = {
  run: 'old',
  lineage: 'launcher',
  correlation: 'upgrade',
  from: { version: '0.14.0', commit: 'unknown', source: { kind: 'package', location: '/old' } },
  to: { version: '0.14.1', commit: 'unknown', source: { kind: 'package', location: '/new' } },
  root: '/new',
  cacheId: 'new',
  target: { mode: 'installed', key: 'new', source: '/install' },
}
test('admitted newer client against an older catalog fails preflight without yielding', async () => {
  expect(classifyClient('0.14.1', { minVersion: '0.12.0', maxVersionExclusive: '0.15.0' })).toBe(
    'supported',
  )
  const failures: string[] = []
  let holder = 'old'
  const store = {
    inspectDispatcherOverlap: async () => ({
      compatible: true,
      evidence: 'hosted admission supported',
    }),
    getRepo: async () => ({
      lease: { holder, expiresAt: new Date(Date.now() + 60_000).toISOString() },
    }),
    appendRepo: async (_repo: string, event: { type: string }) => {
      throw new Error(`unknown repository event type "${event.type}"`)
    },
    releaseRepoLease: async () => {
      holder = ''
    },
  } as unknown as BuildStore
  expect(
    await prepareDispatcherYield({
      store,
      repo: 'repo',
      handoff,
      successor: 'new',
      signal: new AbortController().signal,
      validate: async () => {},
      failure: async (reason) => {
        failures.push(reason)
      },
    }),
  ).toBe(false)
  expect(failures).toEqual(['unknown repository event type "dispatcher.yield-requested"'])
  expect(holder).toBe('old')
})
test('missing capability chooses cutover but still requires durable request admission', async () => {
  const events: unknown[] = []
  const store = {
    getRepo: async () => ({
      lease: { holder: 'old', expiresAt: new Date(Date.now() + 60_000).toISOString() },
    }),
    appendRepo: async (_repo: string, event: unknown) => {
      events.push(event)
    },
  } as unknown as BuildStore
  expect(
    await prepareDispatcherYield({
      store,
      repo: 'repo',
      handoff,
      successor: 'new',
      signal: new AbortController().signal,
      validate: async () => {},
      failure: async () => {
        throw new Error('unexpected failure')
      },
    }),
  ).toBe(true)
  expect(events).toMatchObject([
    { type: 'dispatcher.yield-requested', payload: { mode: 'cutover', successor: 'new' } },
  ])
})

test('SQLite preflight compares requirements without running initialization DDL', async () => {
  const { Database } = await import('bun:sqlite')
  const { SqliteBuildStore } = await import('../store/local/store')
  const { MemoryBlobStore } = await import('../store/memory')
  const database = new Database(':memory:')
  const store = new SqliteBuildStore({ database, blobs: new MemoryBlobStore() })
  const signal = new AbortController().signal
  expect((await store.inspectDispatcherOverlap(signal)).compatible).toBe(true)
  database.exec('ALTER TABLE builds ADD COLUMN future_column TEXT')
  const before = database.query('SELECT sql FROM sqlite_master ORDER BY name').all()
  expect((await store.inspectDispatcherOverlap(signal)).compatible).toBe(false)
  expect(database.query('SELECT sql FROM sqlite_master ORDER BY name').all()).toEqual(before)
  await store.close()
})

test('real HTTP health admission cannot bypass an older hosted write catalog', async () => {
  const { RemoteBuildStore } = await import('../store/remote/client')
  const facts: Array<{ type: string; payload: unknown; writer: string | null }> = []
  const requests: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const path = new URL(request.url).pathname
      requests.push(`${request.method} ${path}`)
      if (path === '/health')
        return Response.json({
          ok: true,
          autobuildVersion: '0.14.0',
          protocolVersion: '4',
          supportedClientRange: { minVersion: '0.12.0', maxVersionExclusive: '0.15.0' },
        })
      if (request.method === 'GET')
        return Response.json({
          repo: 'repo',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          lease: { holder: 'old', expiresAt: new Date(Date.now() + 60_000).toISOString() },
        })
      const fact = (await request.json()) as { type: string; payload: unknown }
      if (fact.type === 'dispatcher.yield-requested')
        return Response.json(
          {
            kind: 'validation',
            error: 'unknown repository event type "dispatcher.yield-requested"',
          },
          { status: 422 },
        )
      facts.push({ ...fact, writer: request.headers.get('x-autobuild-version') })
      return Response.json({
        ...fact,
        actor: { kind: 'dispatcher' },
        seq: 1,
        repo: 'repo',
        ts: new Date().toISOString(),
      })
    },
  })
  const target = new RemoteBuildStore({
    url: server.url.href,
    identity: { autobuildVersion: '0.14.1', protocolVersion: '4' },
  })
  const predecessor = new RemoteBuildStore({
    url: server.url.href,
    identity: { autobuildVersion: '0.14.0', protocolVersion: '4' },
  })
  try {
    expect(
      await prepareDispatcherYield({
        store: target,
        repo: 'repo',
        handoff,
        successor: 'new',
        signal: new AbortController().signal,
        validate: async () => {},
        failure: async (reason) => {
          await predecessor.appendRepo('repo', {
            actor: { kind: 'dispatcher' },
            type: 'dispatcher.upgrade-failed',
            payload: {
              correlation: handoff.correlation,
              run: handoff.run,
              lineage: handoff.lineage,
              from: handoff.from,
              target: handoff.target,
              reason,
            },
          })
        },
      }),
    ).toBe(false)
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({
      type: 'dispatcher.upgrade-failed',
      payload: { reason: 'unknown repository event type "dispatcher.yield-requested"' },
    })
    expect(requests.some((request) => /lease/.test(request))).toBe(false)
  } finally {
    server.stop(true)
    await target.close()
    await predecessor.close()
  }
})

test('preflight deadline cancels a blocked validation before any yield write', async () => {
  let writes = 0
  const failures: string[] = []
  const signal = AbortSignal.timeout(5)
  const store = {
    appendRepo: async () => {
      writes++
    },
  } as unknown as BuildStore
  const keepAlive = setTimeout(() => {}, 100)
  try {
    expect(
      await prepareDispatcherYield({
        store,
        repo: 'repo',
        handoff,
        successor: 'new',
        signal,
        validate: () => new Promise(() => {}),
        failure: async (reason) => {
          failures.push(reason)
        },
      }),
    ).toBe(false)
    expect(failures).toEqual(['dispatcher preflight deadline exceeded'])
    expect(writes).toBe(0)
  } finally {
    clearTimeout(keepAlive)
  }
})

test('preflight exits if an unrelated dispatcher supersedes the predecessor before acceptance', async () => {
  const { rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { openLocalStore } = await import('../store/local/store')
  const { preflightGeneration } = await import('./dispatch-preflight')
  const root = await mkdtemp(join(tmpdir(), 'ab-unaccepted-yield-'))
  const store = openLocalStore(root)
  const actor = { kind: 'dispatcher' as const }
  await store.ensureRepo('repo')
  await store.claimRepoLease('repo', 'old', 60_000)
  await store.appendRepo('repo', { actor, type: 'dispatcher.target-prepared', payload: handoff })
  await store.appendRepo('repo', {
    actor,
    type: 'dispatcher.yield-requested',
    payload: { ...handoff, successor: 'new', mode: 'drain', evidence: 'same schema' },
  })
  await store.releaseRepoLease('repo', 'old')
  await store.claimRepoLease('repo', 'peer', 60_000)
  await store.appendRepo('repo', {
    actor,
    type: 'dispatcher.run-stopped',
    payload: { run: 'old', outcome: 'normal', exitCode: 0, reason: 'superseded' },
  })
  const abort = new AbortController()
  const launch = {
    version: 1,
    overlapVersion: 1,
    runtimeRoot: handoff.root,
    checkout: root,
    originalInstall: '/install',
    run: 'new',
    lineage: handoff.lineage,
    predecessor: 'old',
    predecessorCorrelation: handoff.correlation,
    journal: { storeRef: root, repo: 'repo' },
  } as const
  expect(
    await preflightGeneration(
      { ...launch, run: 'unrelated-successor' },
      ['dispatch'],
      {},
      abort.signal,
    ),
  ).toBe(false)
  expect(
    await preflightGeneration(
      { ...launch, predecessorCorrelation: 'stale-correlation' },
      ['dispatch'],
      {},
      abort.signal,
    ),
  ).toBe(false)
  const work = preflightGeneration(launch, ['dispatch'], {}, abort.signal)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    expect(
      await Promise.race([
        work,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('waited for a yield the stopped predecessor cannot accept')),
            2_000,
          )
        }),
      ]),
    ).toBe(false)
    expect((await store.getRepo('repo'))!.lease!.holder).toBe('peer')
  } finally {
    clearTimeout(timer)
    abort.abort()
    await work
    await store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('an HTTP provider without admission metadata chooses cutover and still persists the yield request', async () => {
  const { RemoteBuildStore } = await import('../store/remote/client')
  const facts: unknown[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      if (new URL(request.url).pathname === '/health')
        return Response.json({ kind: 'not-found', error: 'unknown route' }, { status: 404 })
      if (request.method === 'GET')
        return Response.json({
          repo: 'repo',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lease: { holder: 'old', expiresAt: new Date(Date.now() + 60_000).toISOString() },
        })
      const fact = (await request.json()) as Record<string, unknown>
      facts.push(fact)
      return Response.json({ ...fact, repo: 'repo', seq: 1, ts: new Date().toISOString() })
    },
  })
  const store = new RemoteBuildStore({ url: server.url.href })
  try {
    expect(
      await prepareDispatcherYield({
        store,
        repo: 'repo',
        handoff,
        successor: 'new',
        signal: new AbortController().signal,
        validate: async () => {},
        failure: async (reason) => {
          throw new Error(reason)
        },
      }),
    ).toBe(true)
    expect(facts).toMatchObject([
      {
        type: 'dispatcher.yield-requested',
        payload: { mode: 'cutover', evidence: 'hosted admission metadata unavailable' },
      },
    ])
  } finally {
    server.stop(true)
    await store.close()
  }
})

test('SQLite stores migrated from older DDL drain without changing the inspected catalog', async () => {
  const { Database } = await import('bun:sqlite')
  const { SqliteBuildStore, BOOTSTRAP_DDL } = await import('../store/local/store')
  const { MemoryBlobStore } = await import('../store/memory')
  const database = new Database(':memory:')
  for (const ddl of BOOTSTRAP_DDL) {
    database.exec(
      ddl
        .replace(
          /^\s*(?:compatibility|tick|repo_origin|node_writer_holder|node_writer_expires_at|node_writer_ttl_ms|creation_seq) [^\n]*\n/gm,
          '',
        )
        .replace(/,\s*\)/g, '\n)'),
    )
  }
  const migrated = new SqliteBuildStore({ database, blobs: new MemoryBlobStore() })
  const columns = database.query("PRAGMA table_info('builds')").all() as Array<{ name: string }>
  expect(columns.at(-1)?.name).toBe('node_writer_ttl_ms')
  const store = new SqliteBuildStore({ database, blobs: new MemoryBlobStore(), bootstrap: false })
  const before = database.query('SELECT sql FROM sqlite_master ORDER BY name').all()
  const signal = new AbortController().signal
  try {
    expect((await store.inspectDispatcherOverlap(signal)).compatible).toBe(true)
    await store.ensureRepo('repo')
    await store.claimRepoLease('repo', 'old', 60_000)
    expect(
      await prepareDispatcherYield({
        store,
        repo: 'repo',
        handoff,
        successor: 'new',
        signal,
        validate: async () => {},
        failure: async (reason) => {
          throw new Error(reason)
        },
      }),
    ).toBe(true)
    expect((await store.getRepoEvents('repo')).at(-1)).toMatchObject({
      type: 'dispatcher.yield-requested',
      payload: { mode: 'drain' },
    })
    expect(database.query('SELECT sql FROM sqlite_master ORDER BY name').all()).toEqual(before)
    database.exec('DROP INDEX events_type_build_seq')
    expect((await store.inspectDispatcherOverlap(signal)).compatible).toBe(false)
  } finally {
    await migrated.close()
  }
})

test('SQLite overlap still rejects a narrower CHECK constraint without initializing the store', async () => {
  const { Database } = await import('bun:sqlite')
  const { SqliteBuildStore, BOOTSTRAP_DDL } = await import('../store/local/store')
  const { MemoryBlobStore } = await import('../store/memory')
  const database = new Database(':memory:')
  for (const ddl of BOOTSTRAP_DDL)
    database.exec(ddl.replace("'build','repo','session'", "'build','repo'"))
  const store = new SqliteBuildStore({ database, blobs: new MemoryBlobStore(), bootstrap: false })
  try {
    const before = database.query('SELECT sql FROM sqlite_master ORDER BY name').all()
    expect((await store.inspectDispatcherOverlap(new AbortController().signal)).compatible).toBe(
      false,
    )
    expect(database.query('SELECT sql FROM sqlite_master ORDER BY name').all()).toEqual(before)
  } finally {
    await store.close()
  }
})

for (const admitted of [false, true])
  test(`hosted client outside overlap selects cutover but still requires target write admission (${admitted})`, async () => {
    const { RemoteBuildStore } = await import('../store/remote/client')
    const writes: Array<{ type: string; payload: unknown }> = []
    const failures: string[] = []
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        if (new URL(request.url).pathname === '/health')
          return Response.json({
            autobuildVersion: '1.2.0',
            protocolVersion: '4',
            supportedClientRange: { minVersion: '1.0.0', maxVersionExclusive: '1.3.0' },
          })
        if (request.method === 'GET')
          return Response.json({
            repo: 'repo',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            lease: { holder: handoff.run, expiresAt: new Date(Date.now() + 60_000).toISOString() },
          })
        const fact = (await request.json()) as { type: string; payload: unknown }
        if (!admitted)
          return Response.json(
            { kind: 'validation', error: 'target client refused' },
            { status: 409 },
          )
        writes.push(fact)
        return Response.json({ ...fact, repo: 'repo', seq: 1, ts: new Date().toISOString() })
      },
    })
    const store = new RemoteBuildStore({
      url: server.url.href,
      identity: { autobuildVersion: '1.3.0', protocolVersion: '4' },
    })
    try {
      expect(
        await prepareDispatcherYield({
          store,
          repo: 'repo',
          handoff,
          successor: 'new',
          signal: new AbortController().signal,
          validate: async () => {},
          failure: async (reason) => {
            failures.push(reason)
          },
        }),
      ).toBe(admitted)
      if (admitted)
        expect(writes).toMatchObject([
          { type: 'dispatcher.yield-requested', payload: { mode: 'cutover' } },
        ])
      else {
        expect(writes).toEqual([])
        expect(failures).toHaveLength(1)
      }
    } finally {
      server.stop(true)
      await store.close()
    }
  })
