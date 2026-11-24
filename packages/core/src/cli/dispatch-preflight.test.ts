import { expect, test } from 'bun:test'
import { prepareDispatcherYield } from './dispatch-preflight'
import { classifyClient } from '../store/remote/compatibility'
import type { BuildStore } from '../store/types'
import type { Handoff } from '../kernel/dispatch-upgrade'

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

test('missing successor account credentials refuse yield and retain predecessor authority', async () => {
  const { missingAccountCredentials, MissingAccountCredentialsError } = await import(
    '../accounts/availability'
  )
  const failures: string[] = []
  const writes: unknown[] = []
  let claims = 0
  const store = {
    getRepo: async () => ({
      lease: { holder: 'old', expiresAt: new Date(Date.now() + 60000).toISOString() },
    }),
    claimRepoLease: async () => {
      claims++
      return true
    },
    appendRepo: async (_repo: string, event: unknown) => {
      writes.push(event)
    },
  } as unknown as BuildStore
  const accepted = await prepareDispatcherYield({
    store,
    repo: 'repo',
    handoff,
    successor: 'new',
    signal: new AbortController().signal,
    validate: async () => {
      throw new MissingAccountCredentialsError(
        missingAccountCredentials(
          { billing: { kind: 'claude-subscription', credentialEnv: 'BILLING_TOKEN' } },
          {},
        ),
      )
    },
    failure: async (reason) => {
      failures.push(reason)
    },
  })
  expect(accepted).toBe(false)
  expect(failures[0]).toContain('BILLING_TOKEN')
  expect(failures[0]).toContain('claude setup-token')
  expect(writes).toEqual([])
  expect(claims).toBe(0)
  expect((await store.getRepo('repo'))?.lease?.holder).toBe('old')
})
