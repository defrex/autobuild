import { describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { MemoryBlobStore, sampleBuildInput, sampleEventWrite } from '@defrex/autobuild/plugin-sdk'
import type { StreamPart } from '@defrex/autobuild/store-adapter'
import { migratePostgres } from './schema'
import { PostgresBuildStore } from './store'

const testUrl = process.env.AB_POSTGRES_TEST_URL?.trim()

async function isolatedDatabase(): Promise<{ url: string; cleanup: () => Promise<void> }> {
  if (!testUrl) throw new Error('AB_POSTGRES_TEST_URL is required')
  const schema = `ab_test_${crypto.randomUUID().replaceAll('-', '')}`
  const admin = new SQL(testUrl)
  await admin.unsafe(`CREATE SCHEMA ${schema}`)
  await admin.close()
  const scoped = new URL(testUrl)
  scoped.searchParams.set('options', `-csearch_path=${schema}`)
  const url = scoped.toString()
  await migratePostgres(url)
  return {
    url,
    cleanup: async () => {
      const cleanupSql = new SQL(testUrl)
      try {
        await cleanupSql.unsafe(`DROP SCHEMA ${schema} CASCADE`)
      } finally {
        await cleanupSql.close()
      }
    },
  }
}

/** Adds a column through a second connection — the migration that poisons
 * the store connection's cached plans. */
async function addColumn(url: string, table: string, column: string): Promise<void> {
  const other = new SQL(url)
  try {
    await other.unsafe(`ALTER TABLE ${table} ADD COLUMN ${column} text`)
  } finally {
    await other.close()
  }
}

if (testUrl) {
  describe('PostgreSQL cached-plan invalidation retry', () => {
    // The store runs over a single-connection pool the test owns, so "the
    // same connection" is deterministic: every statement the store executes
    // prepares and runs on that one connection.

    test('a SELECT * warmed before ADD COLUMN recovers on the same connection and returns the new column', async () => {
      const database = await isolatedDatabase()
      const sql = new SQL(database.url, { max: 1 })
      const store = new PostgresBuildStore(sql, { blobs: new MemoryBlobStore() })
      try {
        const created = await store.createBuild(sampleBuildInput('plan-probe'))
        // Warm the `SELECT * FROM builds` plan on the store's connection.
        const warmed = await store.getBuild('plan-probe')
        expect(warmed).toEqual(created)

        await addColumn(database.url, 'builds', 'plan_probe')

        // The warmed plan now fails 0A000 on every execution (Bun never
        // rebuilds it); only the store's marker retry recovers, so success
        // here is the proof the retry ran and re-prepared the statement.
        expect(await store.getBuild('plan-probe')).toEqual(warmed)
        // A second migration poisons the fresh plan too; it recovers again.
        await addColumn(database.url, 'builds', 'plan_probe_2')
        expect(await store.getBuild('plan-probe')).toEqual(warmed)

        // The retry prepared its marked statement on that very connection
        // (the pool has one connection, so anything prepared is on it).
        const prepared: { statement: unknown }[] =
          await sql`SELECT statement FROM pg_prepared_statements`
        const marked = prepared
          .map((row) => String(row.statement))
          .find((text) => text.includes('ab-plan-retry'))
        expect(marked).toBeDefined()
        // The fresh plan's result type includes the added column: executing
        // the marked statement text directly returns it.
        const row = (await sql.unsafe(marked!, marked!.includes('$1') ? ['plan-probe'] : []))[0] as
          | Record<string, unknown>
          | undefined
        expect(row).toBeDefined()
        expect(Object.keys(row ?? {})).toContain('plan_probe')
      } finally {
        await store.close()
        await database.cleanup()
      }
    })

    test('a transaction body re-runs whole after ADD COLUMN poisons its lock read', async () => {
      const database = await isolatedDatabase()
      const store = new PostgresBuildStore(new SQL(database.url, { max: 1 }), {
        blobs: new MemoryBlobStore(),
      })
      try {
        // createBuild warms the transactional `SELECT * FROM builds … FOR
        // UPDATE` plan on the store's connection.
        await store.createBuild(sampleBuildInput('tx-probe'))
        await addColumn(database.url, 'builds', 'plan_probe')

        const event = await store.append('tx-probe', sampleEventWrite('after migration'))
        expect(event.seq).toBe(1)
        const events = await store.getEvents('tx-probe')
        expect(events.map((e) => e.seq)).toEqual([1])
        expect(events[0]?.payload).toEqual(
          (sampleEventWrite('after migration').payload as Record<string, unknown>) ?? {},
        )
      } finally {
        await store.close()
        await database.cleanup()
      }
    })

    test('stream creation and appends recover after ADD COLUMN poisons the streams reads', async () => {
      const database = await isolatedDatabase()
      const store = new PostgresBuildStore(new SQL(database.url, { max: 1 }), {
        blobs: new MemoryBlobStore(),
      })
      try {
        const slug = 'stream-probe'
        await store.createBuild(sampleBuildInput(slug))
        // Warm every streams-touching transactional plan: the scope lock,
        // the retention prune, the insert, and the `SELECT * FROM streams …
        // FOR UPDATE` re-read.
        const warm = await store.createStream({ kind: 'build', build: slug }, 'warm')
        await store.appendStreamParts(warm.id, [
          { type: 'text-delta', id: 't', delta: 'before' },
        ] satisfies StreamPart[])
        await addColumn(database.url, 'streams', 'stream_probe')

        // The production incident's shape (POST /builds/<slug>/streams): the
        // create must succeed and the record must be readable afterwards.
        const stream = await store.createStream({ kind: 'build', build: slug }, 'after migration')
        const read = await store.readStream(stream.id)
        expect(read.status).toBe('open')
        expect((await store.listStreams({ kind: 'build', build: slug })).map((s) => s.id)).toEqual([
          warm.id,
          stream.id,
        ])
        // The lock-read retry also covers appends into the poisoned plan.
        const chunk = await store.appendStreamParts(stream.id, [
          { type: 'text-delta', id: 't', delta: 'after' },
        ] satisfies StreamPart[])
        expect(chunk.seq).toBe(1)
        const appended = await store.readStream(stream.id)
        expect(appended.chunks.map((c) => c.seq)).toEqual([1])
      } finally {
        await store.close()
        await database.cleanup()
      }
    })

    test('session creation recovers after ADD COLUMN poisons the sessions lock read', async () => {
      const database = await isolatedDatabase()
      const store = new PostgresBuildStore(new SQL(database.url, { max: 1 }), {
        blobs: new MemoryBlobStore(),
      })
      try {
        // Warm the transactional `SELECT * FROM sessions … FOR UPDATE` plan.
        await store.createSession({
          repo: 'https://github.com/acme/rate-limiter',
          operator: 'op',
        })
        await addColumn(database.url, 'sessions', 'session_probe')

        const session = await store.createSession({
          repo: 'https://github.com/acme/rate-limiter',
          operator: 'op',
          title: 'after migration',
        })
        expect(session.title).toBe('after migration')
        const events = await store.getSessionEvents(session.id)
        expect(events.map((e) => e.type)).toEqual(['session.created'])
      } finally {
        await store.close()
        await database.cleanup()
      }
    })

    test('errors that are not plan changes propagate unchanged', async () => {
      const database = await isolatedDatabase()
      const store = new PostgresBuildStore(new SQL(database.url, { max: 1 }), {
        blobs: new MemoryBlobStore(),
      })
      try {
        await store.createBuild(sampleBuildInput('err-probe'))
        const error = await store
          .append('no-such-build', sampleEventWrite('boom'))
          .then(() => null)
          .catch((e: unknown) => e)
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toBe('unknown build "no-such-build"')
      } finally {
        await store.close()
        await database.cleanup()
      }
    })
  })
}
