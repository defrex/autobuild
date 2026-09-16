import { describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { CONTRACT_T0, MemoryBlobStore } from 'autobuild/plugin-sdk'

type Row = Record<string, unknown>
import {
  MIGRATE_COMMAND,
  SCHEMA_CHECKSUM,
  SCHEMA_V1_CHECKSUM,
  SCHEMA_V1_DDL,
  SCHEMA_V2_CHECKSUM,
  SCHEMA_V2_DDL,
  SCHEMA_V3_CHECKSUM,
  SCHEMA_V3_DDL,
  SCHEMA_V4_CHECKSUM,
  SCHEMA_V4_DDL,
  SCHEMA_VERSION,
  migratePostgres,
} from './schema'
import { openPostgresBuildStore } from './store'

const testUrl = process.env.AB_POSTGRES_TEST_URL?.trim()

async function schemaHarness(): Promise<{ url: string; cleanup: () => Promise<void> }> {
  if (!testUrl) throw new Error('AB_POSTGRES_TEST_URL is required')
  const schema = `ab_migrate_${crypto.randomUUID().replaceAll('-', '')}`
  const admin = new SQL(testUrl)
  await admin.unsafe(`CREATE SCHEMA ${schema}`)
  await admin.close()
  const scoped = new URL(testUrl)
  scoped.searchParams.set('options', `-csearch_path=${schema}`)
  return {
    url: scoped.toString(),
    cleanup: async () => {
      const sql = new SQL(testUrl)
      try {
        await sql.unsafe(`DROP SCHEMA ${schema} CASCADE`)
      } finally {
        await sql.close()
      }
    },
  }
}

if (testUrl) {
  describe('PostgreSQL schema migration', () => {
    test('is repeatable and serializes concurrent initializers', async () => {
      const harness = await schemaHarness()
      try {
        await Promise.all([migratePostgres(harness.url), migratePostgres(harness.url)])
        await migratePostgres(harness.url)
        const store = await openPostgresBuildStore(harness.url, new MemoryBlobStore())
        await store.close()
      } finally {
        await harness.cleanup()
      }
    })

    for (const scenario of [
      {
        name: 'older-with-a-foreign-checksum',
        version: SCHEMA_VERSION - 1,
        checksum: SCHEMA_CHECKSUM,
      },
      { name: 'newer', version: SCHEMA_VERSION + 1, checksum: SCHEMA_CHECKSUM },
      { name: 'checksum-mismatched', version: SCHEMA_VERSION, checksum: 'wrong' },
    ]) {
      test(`rejects an ${scenario.name} marker`, async () => {
        const harness = await schemaHarness()
        const sql = new SQL(harness.url)
        try {
          await sql`CREATE TABLE ab_schema_migrations (
            singleton boolean PRIMARY KEY, version integer NOT NULL,
            checksum text NOT NULL, applied_at timestamptz NOT NULL
          )`
          await sql`INSERT INTO ab_schema_migrations VALUES
            (true, ${scenario.version}, ${scenario.checksum}, ${new Date().toISOString()})`
          const error = await openPostgresBuildStore(harness.url, new MemoryBlobStore()).catch(
            (caught: unknown) => caught,
          )
          expect(error).toBeInstanceOf(Error)
          expect((error as Error).message).toContain(MIGRATE_COMMAND)
          await expect(migratePostgres(harness.url)).rejects.toThrow('incompatible')
        } finally {
          await sql.close()
          await harness.cleanup()
        }
      })
    }

    test('upgrades a genuine v1 database in place, preserving prior rows and enabling streams', async () => {
      const harness = await schemaHarness()
      const sql = new SQL(harness.url)
      try {
        // Create a real v1 database: v1 DDL, v1 marker, plus a build, an
        // event, and an artifact written before streams existed.
        await sql.unsafe(SCHEMA_V1_DDL)
        await sql`INSERT INTO ab_schema_migrations VALUES
          (true, 1, ${SCHEMA_V1_CHECKSUM}, ${new Date().toISOString()})`
        await sql`INSERT INTO builds (slug, repo, created_at, updated_at)
          VALUES ('v1-build', 'acme/v1', ${CONTRACT_T0}, ${CONTRACT_T0})`
        await sql`INSERT INTO events (build, seq, ts, actor, type, payload)
          VALUES ('v1-build', 1, ${CONTRACT_T0}, '{"kind":"dispatcher"}', 'build.created',
            '{"ticket":{"source":"linear","id":"TICK-1"},"repo":"acme/v1","baseBranch":"main"}')`
        await sql`INSERT INTO artifacts (build, kind, revision, blob_ref, metadata, created_at)
          VALUES ('v1-build', 'plan', 0, 'deadbeef', '{}', ${CONTRACT_T0})`

        await migratePostgres(harness.url)

        const marker = await sql`SELECT version, checksum FROM ab_schema_migrations`
        expect(Number(marker[0]?.version)).toBe(SCHEMA_VERSION)
        expect(marker[0]?.checksum).toBe(SCHEMA_CHECKSUM)

        // Prior rows survive untouched.
        const builds = await sql`SELECT slug FROM builds`
        expect(builds.map((row: Row) => row.slug)).toEqual(['v1-build'])
        const events = await sql`SELECT seq FROM events WHERE build = 'v1-build'`
        expect(events).toHaveLength(1)

        // The stream tables work end to end through the migrated store.
        const store = await openPostgresBuildStore(harness.url, new MemoryBlobStore())
        try {
          const stream = await store.createStream({ kind: 'build', build: 'v1-build' }, 'migrated')
          await store.appendStreamParts(stream.id, [
            { type: 'start', messageId: 'm' },
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: 'survived' },
            { type: 'text-end', id: 't' },
          ])
          const closed = await store.closeStream(stream.id, 'completed')
          expect(closed.status).toBe('closed')
          const read = await store.readStream(stream.id)
          expect(read.chunks).toHaveLength(1)
          expect(read.status).toBe('closed')
          expect(read.outcome).toBe('completed')
        } finally {
          await store.close()
        }

        // The upgrade is idempotent.
        await migratePostgres(harness.url)
      } finally {
        await sql.close()
        await harness.cleanup()
      }
    })

    test('upgrades a genuine v2 database in place: session tables, the streams.session column, and widened CHECKs, preserving prior rows', async () => {
      const harness = await schemaHarness()
      const sql = new SQL(harness.url)
      try {
        // Create a real v2 database: v2 DDL, v2 marker, plus a build and a
        // closed build-scoped stream written before sessions existed.
        await sql.unsafe(SCHEMA_V2_DDL)
        // The genuine v2 marker is version 2 literally: SCHEMA_VERSION moves
        // on with every schema revision, and a v2 checksum under any other
        // version is (correctly) rejected as incompatible.
        await sql`INSERT INTO ab_schema_migrations VALUES
          (true, 2, ${SCHEMA_V2_CHECKSUM}, ${new Date().toISOString()})`
        await sql`INSERT INTO builds (slug, repo, created_at, updated_at)
          VALUES ('v2-build', 'acme/v2', ${CONTRACT_T0}, ${CONTRACT_T0})`
        await sql`INSERT INTO events (build, seq, ts, actor, type, payload)
          VALUES ('v2-build', 1, ${CONTRACT_T0}, '{"kind":"dispatcher"}', 'build.created',
            '{"ticket":{"source":"linear","id":"TICK-1"},"repo":"acme/v2","baseBranch":"main"}')`
        await sql`INSERT INTO streams (id, scope_kind, build, label, format, status, created_at)
          VALUES ('st_v2', 'build', 'v2-build', 'before', 'ai-ui-message-stream/v1', 'open', ${CONTRACT_T0})`

        await migratePostgres(harness.url)

        const marker = await sql`SELECT version, checksum FROM ab_schema_migrations`
        expect(Number(marker[0]?.version)).toBe(SCHEMA_VERSION)
        expect(marker[0]?.checksum).toBe(SCHEMA_CHECKSUM)

        // Prior rows survive untouched.
        const events = await sql`SELECT seq FROM events WHERE build = 'v2-build'`
        expect(events).toHaveLength(1)
        const oldStream = await sql`SELECT scope_kind, session FROM streams WHERE id = 'st_v2'`
        expect(oldStream[0]?.scope_kind).toBe('build')
        expect(oldStream[0]?.session).toBeNull()

        // The migrated store works end to end, including sessions and
        // session-scoped streams.
        const store = await openPostgresBuildStore(harness.url, new MemoryBlobStore())
        try {
          const session = await store.createSession({ repo: 'acme/v2', operator: 'op' })
          await store.appendSessionEvent(session.id, {
            actor: { kind: 'human', user: 'op' },
            type: 'message.posted',
            payload: { text: 'hello' },
          })
          const stream = await store.createStream(
            { kind: 'session', session: session.id },
            'migrated turn',
          )
          await store.appendStreamParts(stream.id, [{ type: 'text-delta', id: 't', delta: 'x' }])
          const closed = await store.closeStream(stream.id, 'completed')
          expect(closed.status).toBe('closed')
          expect(
            (await store.getSessionArtifact(session.id, `stream:${stream.id}`))?.meta.revision,
          ).toBe(0)
        } finally {
          await store.close()
        }

        // The upgrade is idempotent.
        await migratePostgres(harness.url)
      } finally {
        await sql.close()
        await harness.cleanup()
      }
    })

    test('upgrades a genuine v3 database in place: the sessions.creation_seq backfill, sequence continuity, and preserving prior rows', async () => {
      const harness = await schemaHarness()
      const sql = new SQL(harness.url)
      try {
        // Create a real v3 database: v3 DDL, v3 marker, plus two
        // same-millisecond sessions whose id order is reversed from insertion
        // order. Legacy ties are genuinely unorderable, so the pinned
        // insertion order is not asserted — the backfill assigns a distinct,
        // deterministic (created_at, id)-ordered counter per row and
        // otherwise leaves the rows untouched.
        await sql.unsafe(SCHEMA_V3_DDL)
        // The genuine v3 marker is version 3 literally: SCHEMA_VERSION moves
        // on with every schema revision, and a v3 checksum under any other
        // version is (correctly) rejected as incompatible. The genuine v4
        // fixture below covers the streams.creation_seq backfill; on the
        // next schema revision, add a genuine v5 fixture and retire or
        // re-pin this one.
        await sql`INSERT INTO ab_schema_migrations VALUES
          (true, 3, ${SCHEMA_V3_CHECKSUM}, ${new Date().toISOString()})`
        for (const id of ['os_legacy-2', 'os_legacy-1']) {
          await sql`INSERT INTO sessions (id, repo, operator, created_at, updated_at)
            VALUES (${id}, 'acme/v3', 'op', ${CONTRACT_T0}, ${CONTRACT_T0})`
          await sql`INSERT INTO session_events (session, seq, ts, actor, type, payload)
            VALUES (${id}, 1, ${CONTRACT_T0}, '{"kind":"human","user":"op"}', 'session.created', '{}')`
        }

        await migratePostgres(harness.url)

        const marker = await sql`SELECT version, checksum FROM ab_schema_migrations`
        expect(Number(marker[0]?.version)).toBe(SCHEMA_VERSION)
        expect(marker[0]?.checksum).toBe(SCHEMA_CHECKSUM)

        // Both rows survived with distinct backfilled counters, ordered by
        // (created_at, id) — the lexicographically smaller id lands first
        // despite being inserted second.
        const backfilled = await sql`SELECT id, creation_seq FROM sessions ORDER BY creation_seq`
        expect(backfilled.map((row: Row) => [row.id, Number(row.creation_seq)])).toEqual([
          ['os_legacy-1', 1],
          ['os_legacy-2', 2],
        ])

        // The migrated store works end to end: the sequence continues above
        // the backfill, so a same-millisecond post-migration creation gets a
        // fresh counter and sorts after both migrated rows.
        const store = await openPostgresBuildStore(harness.url, new MemoryBlobStore(), {
          clock: () => new Date(CONTRACT_T0),
        })
        try {
          const created = await store.createSession({ repo: 'acme/v3', operator: 'op' })
          expect(created.createdAt).toBe(CONTRACT_T0)
          const seqs = await sql`SELECT id, creation_seq FROM sessions ORDER BY creation_seq`
          expect(seqs.map((row: Row) => row.id)).toEqual(['os_legacy-1', 'os_legacy-2', created.id])
          expect((await store.listSessions('acme/v3')).map((s) => s.id)).toEqual([
            'os_legacy-1',
            'os_legacy-2',
            created.id,
          ])
          await store.appendSessionEvent(created.id, {
            actor: { kind: 'human', user: 'op' },
            type: 'message.posted',
            payload: { text: 'hello' },
          })
        } finally {
          await store.close()
        }

        // The upgrade is idempotent.
        await migratePostgres(harness.url)
      } finally {
        await sql.close()
        await harness.cleanup()
      }
    })

    test('upgrades a genuine v4 database in place: the streams.creation_seq backfill, sequence continuity, and preserving prior rows', async () => {
      const harness = await schemaHarness()
      const sql = new SQL(harness.url)
      try {
        // Create a real v4 database: v4 DDL, v4 marker, plus two
        // same-millisecond build-scoped streams whose id order is reversed
        // from insertion order. Legacy ties are genuinely unorderable, so
        // the pinned insertion order is not asserted — the backfill assigns
        // a distinct, deterministic (created_at, id)-ordered counter per row
        // and otherwise leaves the rows untouched.
        await sql.unsafe(SCHEMA_V4_DDL)
        // The genuine v4 marker is version 4 literally: SCHEMA_VERSION moves
        // on with every schema revision, and a v4 checksum under any other
        // version is (correctly) rejected as incompatible.
        await sql`INSERT INTO ab_schema_migrations VALUES
          (true, 4, ${SCHEMA_V4_CHECKSUM}, ${new Date().toISOString()})`
        await sql`INSERT INTO builds (slug, repo, created_at, updated_at)
          VALUES ('v4-build', 'acme/v4', ${CONTRACT_T0}, ${CONTRACT_T0})`
        for (const id of ['st_legacy-2', 'st_legacy-1']) {
          await sql`INSERT INTO streams (id, scope_kind, build, label, format, status, created_at)
            VALUES (${id}, 'build', 'v4-build', 'before', 'ai-ui-message-stream/v1', 'open', ${CONTRACT_T0})`
        }

        await migratePostgres(harness.url)

        const marker = await sql`SELECT version, checksum FROM ab_schema_migrations`
        expect(Number(marker[0]?.version)).toBe(SCHEMA_VERSION)
        expect(marker[0]?.checksum).toBe(SCHEMA_CHECKSUM)

        // Both rows survived with distinct backfilled counters, ordered by
        // (created_at, id) — the lexicographically smaller id lands first
        // despite being inserted second.
        const backfilled = await sql`SELECT id, creation_seq FROM streams ORDER BY creation_seq`
        expect(backfilled.map((row: Row) => [row.id, Number(row.creation_seq)])).toEqual([
          ['st_legacy-1', 1],
          ['st_legacy-2', 2],
        ])

        // The migrated store works end to end: the sequence continues above
        // the backfill, so a same-millisecond post-migration creation gets a
        // fresh counter and sorts after both migrated rows.
        const store = await openPostgresBuildStore(harness.url, new MemoryBlobStore(), {
          clock: () => new Date(CONTRACT_T0),
        })
        try {
          const created = await store.createStream({ kind: 'build', build: 'v4-build' }, 'after')
          expect(created.createdAt).toBe(CONTRACT_T0)
          const seqs = await sql`SELECT id, creation_seq FROM streams ORDER BY creation_seq`
          expect(seqs.map((row: Row) => row.id)).toEqual(['st_legacy-1', 'st_legacy-2', created.id])
          expect(
            (await store.listStreams({ kind: 'build', build: 'v4-build' })).map((s) => s.id),
          ).toEqual(['st_legacy-1', 'st_legacy-2', created.id])
          await store.appendStreamParts(created.id, [{ type: 'text-delta', id: 't', delta: 'x' }])
        } finally {
          await store.close()
        }

        // The upgrade is idempotent.
        await migratePostgres(harness.url)
      } finally {
        await sql.close()
        await harness.cleanup()
      }
    })

    test('upgrades a genuine v4 database in place: the builds.repo_origin column, preserving prior rows', async () => {
      const harness = await schemaHarness()
      const sql = new SQL(harness.url)
      try {
        // Create a real v4 database: v4 DDL, v4 marker, plus a build written
        // before repoOrigin was persisted — legacy rows legitimately have no
        // origin, so the column must backfill as NULL ("field absent").
        await sql.unsafe(SCHEMA_V4_DDL)
        // The genuine v4 marker is version 4 literally: SCHEMA_VERSION moves
        // on with every schema revision, and a v4 checksum under any other
        // version is (correctly) rejected as incompatible.
        await sql`INSERT INTO ab_schema_migrations VALUES
          (true, 4, ${SCHEMA_V4_CHECKSUM}, ${new Date().toISOString()})`
        await sql`INSERT INTO builds (slug, repo, created_at, updated_at)
          VALUES ('v4-build', 'acme/v4', ${CONTRACT_T0}, ${CONTRACT_T0})`

        await migratePostgres(harness.url)

        const marker = await sql`SELECT version, checksum FROM ab_schema_migrations`
        expect(Number(marker[0]?.version)).toBe(SCHEMA_VERSION)
        expect(marker[0]?.checksum).toBe(SCHEMA_CHECKSUM)

        // The legacy row survives with repo_origin NULL — the read path
        // treats NULL as "field absent".
        const legacy = await sql`SELECT repo_origin FROM builds WHERE slug = 'v4-build'`
        expect(legacy[0]?.repo_origin).toBeNull()

        // The migrated store persists repoOrigin both ways: with an origin
        // the value round-trips; without one the field stays absent.
        const store = await openPostgresBuildStore(harness.url, new MemoryBlobStore())
        try {
          const origin = 'https://github.com/acme/v4.git'
          const withOrigin = await store.createBuild({
            slug: 'v4-origin-set',
            repo: 'acme/v4',
            repoOrigin: origin,
          })
          expect(withOrigin.repoOrigin).toBe(origin)
          expect((await store.getBuild('v4-origin-set'))?.repoOrigin).toBe(origin)
          expect(
            (await store.listBuilds()).find((build) => build.slug === 'v4-origin-set')?.repoOrigin,
          ).toBe(origin)

          await store.createBuild({ slug: 'v4-origin-absent', repo: 'acme/v4' })
          expect((await store.getBuild('v4-origin-absent'))?.repoOrigin).toBeUndefined()
        } finally {
          await store.close()
        }

        // The upgrade is idempotent.
        await migratePostgres(harness.url)
      } finally {
        await sql.close()
        await harness.cleanup()
      }
    })

    test('refuses a current marker when a required table is missing', async () => {
      const harness = await schemaHarness()
      const sql = new SQL(harness.url)
      try {
        await migratePostgres(harness.url)
        await sql`DROP TABLE events`
        const error = await openPostgresBuildStore(harness.url, new MemoryBlobStore()).catch(
          (caught: unknown) => caught,
        )
        expect((error as Error).message).toContain('table events is missing or mismatched')
        expect((error as Error).message).toContain(MIGRATE_COMMAND)

        await migratePostgres(harness.url)
        const repaired = await openPostgresBuildStore(harness.url, new MemoryBlobStore())
        await repaired.close()
      } finally {
        await sql.close()
        await harness.cleanup()
      }
    })

    test('refuses a current marker when a required column is altered', async () => {
      const harness = await schemaHarness()
      const sql = new SQL(harness.url)
      try {
        await migratePostgres(harness.url)
        await sql`ALTER TABLE events ALTER COLUMN type TYPE varchar(100)`
        const error = await openPostgresBuildStore(harness.url, new MemoryBlobStore()).catch(
          (caught: unknown) => caught,
        )
        expect((error as Error).message).toContain('table events is missing or mismatched')
        expect((error as Error).message).toContain(MIGRATE_COMMAND)
        await expect(migratePostgres(harness.url)).rejects.toThrow('table events')
      } finally {
        await sql.close()
        await harness.cleanup()
      }
    })

    test('opening an uninitialized database names the migration step', async () => {
      const harness = await schemaHarness()
      try {
        const error = await openPostgresBuildStore(harness.url, new MemoryBlobStore()).catch(
          (caught: unknown) => caught,
        )
        expect((error as Error).message).toContain(MIGRATE_COMMAND)
      } finally {
        await harness.cleanup()
      }
    })
  })
} else {
  describe('PostgreSQL migration live tests', () => {
    test.skip('set AB_POSTGRES_TEST_URL to run schema migration tests', () => {})
  })
}
