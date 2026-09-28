import { describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { MemoryBlobStore, sampleBuildInput, sampleEventWrite } from '@defrex/autobuild/plugin-sdk'
import type { StreamPart } from '@defrex/autobuild/store-adapter'
import { assertTicketSchema, migratePostgres } from './schema'
import { PostgresBuildStore } from './store'
import { PostgresTicketDatabase } from './tickets'

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
        const markedCount = async (): Promise<number> => {
          const prepared: { statement: unknown }[] =
            await sql`SELECT statement FROM pg_prepared_statements`
          return prepared
            .map((row) => String(row.statement))
            .filter((text) => text.includes('ab-plan-retry')).length
        }
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

        // Healing is memoized, not per-operation: once a statement text has
        // recovered, later executions skip the poisoned plan entirely — no
        // further failed round trips and no further prepared statements.
        // (Growth per call would be the unbounded-leak failure mode.)
        const healed = await markedCount()
        for (let i = 0; i < 25; i++) expect(await store.getBuild('plan-probe')).toEqual(warmed)
        expect(await markedCount()).toBe(healed)
      } finally {
        await store.close()
        await database.cleanup()
      }
    })

    test('a transaction body re-runs whole after ADD COLUMN poisons its lock read', async () => {
      const database = await isolatedDatabase()
      const sql = new SQL(database.url, { max: 1 })
      const store = new PostgresBuildStore(sql, {
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

        // The healed variant is memoized: later appends run without another
        // failure and without preparing anything new on the connection.
        const markedCount = async (): Promise<number> => {
          const prepared: { statement: unknown }[] =
            await sql`SELECT statement FROM pg_prepared_statements`
          return prepared
            .map((row) => String(row.statement))
            .filter((text) => text.includes('ab-plan-retry')).length
        }
        const healed = await markedCount()
        for (let i = 0; i < 10; i++) await store.append('tx-probe', sampleEventWrite(`steady ${i}`))
        expect(await markedCount()).toBe(healed)
        expect((await store.getEvents('tx-probe')).map((e) => e.seq).length).toBe(11)
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

    test('a body touching two extended tables recovers in the single retry', async () => {
      // The failure mode this pins: a migration extending two tables that one
      // transaction body reads (here sessions + streams, the session-scoped
      // stream create's lock pair) poisons two plans. Healing only the
      // statement that failed first would let the retry abort on the second
      // one — a caller-visible 0A000. Every statement the retry re-runs is
      // re-prepared, so the first call after the migration succeeds.
      const database = await isolatedDatabase()
      const store = new PostgresBuildStore(new SQL(database.url, { max: 1 }), {
        blobs: new MemoryBlobStore(),
      })
      try {
        const session = await store.createSession({
          repo: 'https://github.com/acme/rate-limiter',
          operator: 'op',
        })
        // Warm both `SELECT * … FOR UPDATE` plans inside one transaction
        // body — the shape of a session-scoped stream create.
        const warm = await store.createStream({ kind: 'session', session: session.id }, 'warm')
        await addColumn(database.url, 'sessions', 'multi_probe_a')
        await addColumn(database.url, 'streams', 'multi_probe_b')

        // First call after the migration: must succeed, not surface 0A000.
        const stream = await store.createStream({ kind: 'session', session: session.id }, 'after')
        expect(stream.status).toBe('open')
        expect(
          (await store.listStreams({ kind: 'session', session: session.id })).map((s) => s.id),
        ).toEqual([warm.id, stream.id])

        // The healed variants are memoized: the next create runs clean.
        const next = await store.createStream({ kind: 'session', session: session.id }, 'steady')
        expect(next.status).toBe('open')
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

    // AUT-559: PostgresTicketSource executes its own SQL on the same pool and
    // gets the same treatment. The source runs over a single-connection pool
    // the test owns (the direct constructor — `openPostgresTicketDatabase`
    // creates its own default pool), so "the same connection" is
    // deterministic here too.
    test('PostgresTicketSource reads recover after ADD COLUMN poisons the ab_tickets plans', async () => {
      const database = await isolatedDatabase()
      const sql = new SQL(database.url, { max: 1 })
      await assertTicketSchema(sql)
      const tickets = new PostgresTicketDatabase(sql, {
        triage: 'Triage',
        ready: 'Ready',
        doing: 'Doing',
        done: 'Done',
      })
      const source = tickets.source({ teamKey: 'ENG' })
      try {
        const created = await source.create({ title: 'plan probe', body: 'probe body' })
        const id = created.ref.id
        // Warm the `SELECT * FROM ab_tickets` read plan and the listReady
        // plan (the `labels @> ${sql.array(…)}` statement) on the source's
        // connection.
        const warmed = await source.get(id)
        expect(warmed).toEqual(created)
        const listed = await source.listReady({})
        expect(listed.tickets.map((t) => t.ref.id)).toEqual([id])

        await addColumn(database.url, 'ab_tickets', 'ticket_probe')

        // The warmed plans now fail 0A000 on every execution (Bun never
        // rebuilds them); only the runner's marker retry recovers, so
        // success here is the proof the retry ran and re-prepared the
        // statements — including the `array`-built listReady query on the
        // reserved connection.
        expect(await source.get(id)).toEqual(warmed)
        expect((await source.listReady({})).tickets.map((t) => t.ref.id)).toEqual([id])

        // A second migration poisons the fresh plans too; they recover again.
        await addColumn(database.url, 'ab_tickets', 'ticket_probe_2')
        expect(await source.get(id)).toEqual(warmed)

        // Healing is memoized, not per-operation: later executions skip the
        // poisoned plans entirely — no further failed round trips and no
        // further prepared statements (the unbounded-leak failure mode).
        const markedCount = async (): Promise<number> => {
          const prepared: { statement: unknown }[] =
            await sql`SELECT statement FROM pg_prepared_statements`
          return prepared
            .map((row) => String(row.statement))
            .filter((text) => text.includes('ab-plan-retry')).length
        }
        const healed = await markedCount()
        for (let i = 0; i < 25; i++) expect(await source.get(id)).toEqual(warmed)
        expect(await markedCount()).toBe(healed)
      } finally {
        await tickets.close()
        await database.cleanup()
      }
    })

    test('PostgresTicketSource transaction bodies re-run whole after ADD COLUMN poisons their plans', async () => {
      const database = await isolatedDatabase()
      const sql = new SQL(database.url, { max: 1 })
      await assertTicketSchema(sql)
      const tickets = new PostgresTicketDatabase(sql, {
        triage: 'Triage',
        ready: 'Ready',
        doing: 'Doing',
        done: 'Done',
      })
      const source = tickets.source({ teamKey: 'ENG' })
      try {
        // The first create warms the transactional `INSERT … RETURNING *`
        // plan (its result type changes with the added column).
        const first = await source.create({ title: 'tx probe', body: 'probe body' })
        const id = first.ref.id
        // Warm the `SELECT * FROM ab_tickets … FOR UPDATE` lock-read plan —
        // distinct text from the plain-read plan the get test warms. Both
        // comment and update require the row under lock before writing, so
        // invoking them before the migration prepares that text.
        await source.comment(id, 'before migration')
        await source.update(id, { title: 'warmed' })

        await addColumn(database.url, 'ab_tickets', 'ticket_probe_tx')

        // Each assertion can only pass via the tx retry: a body still on a
        // bare `this.sql.begin` would fail 0A000 on its poisoned lock read
        // (comment, update) or its poisoned `RETURNING *` insert (create),
        // and the suite would catch it.
        await source.comment(id, 'after migration')
        await source.update(id, { title: 'after migration' })
        const second = await source.create({ title: 'tx probe 2', body: 'probe body 2' })
        expect(second.ref.id).not.toBe(id)

        expect((await source.get(id))?.title).toBe('after migration')
        expect((await source.get(second.ref.id))?.title).toBe('tx probe 2')

        // claim runs through the same single-statement runner as the read
        // above. Note: `UPDATE … RETURNING id`'s result type is
        // column-independent, so an ADD COLUMN can never make it fail 0A000 —
        // claim's retry is covered by construction (same runner the read
        // test proves) and is not distinguishable in this simulation.
        expect(await source.claim(id)).toBe(true)
      } finally {
        await tickets.close()
        await database.cleanup()
      }
    })
  })
}
