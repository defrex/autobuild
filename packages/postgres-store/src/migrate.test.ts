import { describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { CONTRACT_T0, MemoryBlobStore } from '@defrex/autobuild/plugin-sdk'

import {
  AUTH_SCHEMA_CHECKSUM,
  AUTH_SCHEMA_V1_CHECKSUM,
  AUTH_SCHEMA_V1_DDL,
  AUTH_SCHEMA_V2_CHECKSUM,
  AUTH_SCHEMA_V2_DDL,
  AUTH_SCHEMA_VERSION,
} from './auth-schema'

type Row = Record<string, unknown>
import {
  MIGRATE_COMMAND,
  SCHEMA_CHECKSUM,
  SCHEMA_DDL,
  SCHEMA_V1_CHECKSUM,
  SCHEMA_V1_DDL,
  SCHEMA_V2_CHECKSUM,
  SCHEMA_V2_DDL,
  SCHEMA_V3_CHECKSUM,
  SCHEMA_V3_DDL,
  SCHEMA_V4_CHECKSUM,
  SCHEMA_V4_DDL,
  SCHEMA_V5_CHECKSUM,
  SCHEMA_V5_DDL,
  SCHEMA_V6_CHECKSUM,
  SCHEMA_V6_DDL,
  SCHEMA_V7_CHECKSUM,
  SCHEMA_V7_DDL,
  SCHEMA_VERSION,
  migratePostgres,
} from './schema'
import { FROZEN } from './schema-guard.test.js'
// Mandatory, not optional: importing the guard module runs its pure pin and
// contiguity tests inside this file's `postgres` verify invocation too (bun
// dedupes the module instance, so nothing double-executes), and it keeps one
// definition of the frozen maps. The `.js` spelling maps to
// `schema-guard.test.ts` under the repository's bundler module resolution.
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

// A frozen DDL constant must be pre-trimmed: a deployed marker's checksum is
// taken over the trimmed DDL (the migration runner applies `.trim()` before
// hashing), so an untrimmed constant hashes surrounding whitespace no deployed
// database ever carried and its promotion branch never matches — every real
// database of that version then fails migration with "marker is
// incompatible". This is the AUT-489 round-2 finding (the v7 freeze shipped
// without `.trim()`); the assertion makes the whole frozen family unable to
// regress. Pure constants, so this runs without a live Postgres.
describe('frozen PostgreSQL schema DDL constants', () => {
  for (const [name, ddl] of [
    ['SCHEMA_V1_DDL', SCHEMA_V1_DDL],
    ['SCHEMA_V2_DDL', SCHEMA_V2_DDL],
    ['SCHEMA_V3_DDL', SCHEMA_V3_DDL],
    ['SCHEMA_V4_DDL', SCHEMA_V4_DDL],
    ['SCHEMA_V5_DDL', SCHEMA_V5_DDL],
    ['SCHEMA_V6_DDL', SCHEMA_V6_DDL],
    ['SCHEMA_V7_DDL', SCHEMA_V7_DDL],
    ['SCHEMA_DDL', SCHEMA_DDL],
  ] as const) {
    test(`${name} is pre-trimmed`, () => {
      expect(ddl).toBe(ddl.trim())
    })
  }
})

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

    test('upgrades a genuine v5 database in place: the streams.creation_seq backfill the hosted database is missing, sequence continuity, and preserving prior rows', async () => {
      const harness = await schemaHarness()
      const sql = new SQL(harness.url)
      try {
        // Create a real v5 database — the shape the hosted service deployed
        // before the tiebreak landed without a version bump: v5 DDL, v5
        // marker, plus two
        // same-millisecond build-scoped streams whose id order is reversed
        // from insertion order. Legacy ties are genuinely unorderable, so
        // the pinned insertion order is not asserted — the backfill assigns
        // a distinct, deterministic (created_at, id)-ordered counter per row
        // and otherwise leaves the rows untouched.
        await sql.unsafe(SCHEMA_V5_DDL)
        // The genuine v5 marker is version 5 literally: SCHEMA_VERSION moves
        // on with every schema revision, and a v5 checksum under any other
        // version is (correctly) rejected as incompatible.
        await sql`INSERT INTO ab_schema_migrations VALUES
          (true, 5, ${SCHEMA_V5_CHECKSUM}, ${new Date().toISOString()})`
        await sql`INSERT INTO builds (slug, repo, created_at, updated_at)
          VALUES ('v5-build', 'acme/v5', ${CONTRACT_T0}, ${CONTRACT_T0})`
        for (const id of ['st_legacy-2', 'st_legacy-1']) {
          await sql`INSERT INTO streams (id, scope_kind, build, label, format, status, created_at)
            VALUES (${id}, 'build', 'v5-build', 'before', 'ai-ui-message-stream/v1', 'open', ${CONTRACT_T0})`
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
          const created = await store.createStream({ kind: 'build', build: 'v5-build' }, 'after')
          expect(created.createdAt).toBe(CONTRACT_T0)
          const seqs = await sql`SELECT id, creation_seq FROM streams ORDER BY creation_seq`
          expect(seqs.map((row: Row) => row.id)).toEqual(['st_legacy-1', 'st_legacy-2', created.id])
          expect(
            (await store.listStreams({ kind: 'build', build: 'v5-build' })).map((s) => s.id),
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

    test('upgrades a genuine v6 database in place: the build-digest scan index, preserving prior rows', async () => {
      const harness = await schemaHarness()
      const sql = new SQL(harness.url)
      try {
        // Create a real v6 database: v6 DDL, v6 marker, plus a build with a
        // long non-digest history the index upgrade must leave untouched.
        await sql.unsafe(SCHEMA_V6_DDL)
        // The genuine v6 marker is version 6 literally: SCHEMA_VERSION moves
        // on with every schema revision, and a v6 checksum under any other
        // version is (correctly) rejected as incompatible.
        await sql`INSERT INTO ab_schema_migrations VALUES
          (true, 6, ${SCHEMA_V6_CHECKSUM}, ${new Date().toISOString()})`
        await sql`INSERT INTO builds (slug, repo, created_at, updated_at)
          VALUES ('v6-build', 'acme/v6', ${CONTRACT_T0}, ${CONTRACT_T0})`
        await sql`INSERT INTO events (build, seq, ts, actor, type, payload)
          VALUES ('v6-build', 1, ${CONTRACT_T0}, '"dispatcher"', 'build.created', '{}')`

        await migratePostgres(harness.url)

        const marker = await sql`SELECT version, checksum FROM ab_schema_migrations`
        expect(Number(marker[0]?.version)).toBe(SCHEMA_VERSION)
        expect(marker[0]?.checksum).toBe(SCHEMA_CHECKSUM)

        // The index exists under its pinned name and the legacy row survived.
        // pg_indexes spans every schema in the database, and the live-test
        // suites share one database with concurrently migrating isolated
        // schemas — scope the lookup to this test's schema or a sibling
        // schema's same-named index is counted too.
        const indexes =
          await sql`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'events' AND indexname = 'events_type_build_seq'`
        expect(indexes).toHaveLength(1)
        const legacy = await sql`SELECT seq, type FROM events WHERE build = 'v6-build'`
        expect(legacy.map((row: Row) => Number(row.seq))).toEqual([1])

        // The migrated store digests the legacy row and answers new writes.
        const store = await openPostgresBuildStore(harness.url, new MemoryBlobStore())
        try {
          const digests = await store.getRepoBuildDigests('acme/v6')
          expect([...digests.keys()]).toEqual(['v6-build'])
          expect(digests.get('v6-build')).toEqual({ slug: 'v6-build', observations: [] })
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

    test('upgrades a genuine v7 database in place: the repository-journal state-read index, preserving prior rows', async () => {
      const harness = await schemaHarness()
      const sql = new SQL(harness.url)
      try {
        // Create a real v7 database: v7 DDL, v7 marker, plus a journal with
        // dispatcher facts (the noise the new index must stop scanning) and
        // a durable harvest fact the bounded read must keep.
        await sql.unsafe(SCHEMA_V7_DDL)
        // The genuine v7 marker is version 7 literally: SCHEMA_VERSION moves
        // on with every schema revision, and a v7 checksum under any other
        // version is (correctly) rejected as incompatible.
        await sql`INSERT INTO ab_schema_migrations VALUES
          (true, 7, ${SCHEMA_V7_CHECKSUM}, ${new Date().toISOString()})`
        await sql`INSERT INTO repo_streams (repo, created_at, updated_at)
          VALUES ('acme/v7', ${CONTRACT_T0}, ${CONTRACT_T0})`
        await sql`INSERT INTO repo_events (repo, seq, ts, actor, type, payload)
          VALUES ('acme/v7', 1, ${CONTRACT_T0}, '{"kind":"dispatcher"}', 'dispatcher.run-started',
            '{"run":"r1","pid":1,"effectiveConfig":{"kind":"effective-config","rev":0},"roleWarnings":[]}'),
          ('acme/v7', 2, ${CONTRACT_T0}, '{"kind":"dispatcher"}', 'dispatcher.tick-completed',
            '{"run":"r1","queued":0,"counters":{},"janitorDiagnostics":[],"ticketDiagnostics":[],"dependencyDiagnostics":[]}'),
          ('acme/v7', 3, ${CONTRACT_T0}, '{"kind":"kernel"}', 'harvest.started',
            '{"run":"h1","observations":[{"build":"b","seq":1}],"scan":{"kind":"harvest-scan","rev":0}}')`

        await migratePostgres(harness.url)

        const marker = await sql`SELECT version, checksum FROM ab_schema_migrations`
        expect(Number(marker[0]?.version)).toBe(SCHEMA_VERSION)
        expect(marker[0]?.checksum).toBe(SCHEMA_CHECKSUM)

        // The index exists under its pinned name and the legacy rows survived.
        const indexes =
          await sql`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'repo_events' AND indexname = 'repo_events_type_repo_seq'`
        expect(indexes).toHaveLength(1)
        const legacy = await sql`SELECT seq, type FROM repo_events WHERE repo = 'acme/v7'`
        expect(legacy.map((row: Row) => Number(row.seq))).toEqual([1, 2, 3])

        // The migrated store's bounded read keeps the anchor and the tail
        // from it (the same run's tick fact) plus the durable fact — exactly
        // the oracle over the full replay.
        const store = await openPostgresBuildStore(harness.url, new MemoryBlobStore())
        try {
          const subset = await store.getRepoStateEvents('acme/v7')
          expect(subset.map((event) => event.seq)).toEqual([1, 2, 3])
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

    test('upgrades a genuine v1 auth database in place: the four MCP-plugin tables, preserving prior rows', async () => {
      const harness = await schemaHarness()
      const sql = new SQL(harness.url)
      try {
        // Create a real v1 auth database: v1 DDL, a v1 marker for both the
        // build-store and auth markers (migratePostgres validates both), plus
        // a user written before the MCP tables existed.
        await sql.unsafe(SCHEMA_V1_DDL)
        await sql.unsafe(AUTH_SCHEMA_V1_DDL)
        await sql`INSERT INTO ab_schema_migrations VALUES
          (true, 1, ${SCHEMA_V1_CHECKSUM}, ${new Date().toISOString()})`
        await sql`INSERT INTO ab_auth_schema_migrations VALUES
          (true, 1, ${AUTH_SCHEMA_V1_CHECKSUM}, ${new Date().toISOString()})`
        await sql`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
          VALUES ('u1', 'Ada', 'ada@example.com', true, ${CONTRACT_T0}, ${CONTRACT_T0})`

        await migratePostgres(harness.url)

        const marker = await sql`SELECT version, checksum FROM ab_auth_schema_migrations`
        expect(Number(marker[0]?.version)).toBe(AUTH_SCHEMA_VERSION)
        expect(marker[0]?.checksum).toBe(AUTH_SCHEMA_CHECKSUM)

        // Prior rows survive untouched.
        const users = await sql`SELECT id FROM "user"`
        expect(users.map((row: Row) => row.id)).toEqual(['u1'])

        // The new tables work: a dynamically registered client row inserts
        // and reads back with the exact camelCase columns the plugin writes,
        // including the v3 authenticationScheme column.
        await sql`INSERT INTO "oauthApplication"
          (id, name, "clientId", "clientSecret", "redirectUrls", type, disabled,
           "createdAt", "updatedAt", "authenticationScheme")
          VALUES ('c1', 'e2e-mcp-client', 'client-1', 'secret', 'https://claude.ai', 'web',
                  false, ${CONTRACT_T0}, ${CONTRACT_T0}, 'none')`
        const clients =
          await sql`SELECT name, "authenticationScheme" FROM "oauthApplication" WHERE "clientId" = 'client-1'`
        expect(clients.map((row: Row) => row.name)).toEqual(['e2e-mcp-client'])
        expect(clients[0]?.authenticationScheme).toBe('none')

        // The upgrade is idempotent.
        await migratePostgres(harness.url)
      } finally {
        await sql.close()
        await harness.cleanup()
      }
    })

    test('upgrades a genuine v2 auth database in place: the oauthApplication.authenticationScheme column, preserving prior rows', async () => {
      const harness = await schemaHarness()
      const sql = new SQL(harness.url)
      try {
        // Create a real v2 auth database: v2 DDL, a current build-store
        // marker (migratePostgres validates both), a v2 auth marker, plus a
        // legacy client row written before authenticationScheme existed —
        // legacy rows legitimately lack the field, so it backfills as NULL
        // ("field absent", the builds.repo_origin precedent).
        await sql.unsafe(SCHEMA_DDL)
        await sql.unsafe(AUTH_SCHEMA_V2_DDL)
        await sql`INSERT INTO ab_schema_migrations VALUES
          (true, ${SCHEMA_VERSION}, ${SCHEMA_CHECKSUM}, ${new Date().toISOString()})`
        await sql`INSERT INTO ab_auth_schema_migrations VALUES
          (true, 2, ${AUTH_SCHEMA_V2_CHECKSUM}, ${new Date().toISOString()})`
        await sql`INSERT INTO "oauthApplication"
          (id, name, "clientId", "clientSecret", "redirectUrls", type, disabled,
           "createdAt", "updatedAt")
          VALUES ('legacy', 'legacy-client', 'legacy-id', 'secret', 'https://claude.ai', 'web',
                  false, ${CONTRACT_T0}, ${CONTRACT_T0})`

        await migratePostgres(harness.url)

        const marker = await sql`SELECT version, checksum FROM ab_auth_schema_migrations`
        expect(Number(marker[0]?.version)).toBe(AUTH_SCHEMA_VERSION)
        expect(marker[0]?.checksum).toBe(AUTH_SCHEMA_CHECKSUM)

        // The legacy row survives with authenticationScheme NULL.
        const legacy =
          await sql`SELECT "authenticationScheme" FROM "oauthApplication" WHERE id = 'legacy'`
        expect(legacy[0]?.authenticationScheme).toBeNull()

        // A row carrying the column round-trips.
        await sql`INSERT INTO "oauthApplication"
          (id, name, "clientId", "clientSecret", "redirectUrls", type, disabled,
           "createdAt", "updatedAt", "authenticationScheme")
          VALUES ('c2', 'e2e-mcp-client', 'client-2', 'secret', 'https://claude.ai', 'web',
                  false, ${CONTRACT_T0}, ${CONTRACT_T0}, 'none')`
        const clients =
          await sql`SELECT "authenticationScheme" FROM "oauthApplication" WHERE id = 'c2'`
        expect(clients[0]?.authenticationScheme).toBe('none')

        // The upgrade is idempotent.
        await migratePostgres(harness.url)
      } finally {
        await sql.close()
        await harness.cleanup()
      }
    })

    // The retention baseline (AUT-547): instead of one hand-written fixture
    // per schema version accumulating forever, a loop iterates every entry of
    // the frozen-family map (schema-guard.test.ts) — for each frozen version,
    // seed that version's frozen DDL and its genuine marker plus the legacy
    // rows a deployed database of that version carries, run migratePostgres,
    // and assert the shared upgrade properties. The loop never retires: a
    // new schema bump adds a frozen entry (schema-guard.test.ts's contiguity
    // test fails a bump without a freeze) and the loop covers it
    // automatically. The hand-written fixtures above retain only the two
    // most recent versions per family, for deltas the loop cannot assert
    // (pinned index names, version-specific oracles).
    const LEGACY_SEEDS: Record<number, { sessions?: number; streams?: number }> = {
      // v1: canary builds row only — no streams/sessions tables exist in the
      // v1 DDL.
      1: {},
      // v2: two legacy build-scoped streams (same created_at, ids inserted in
      // reversed order, no creation_seq — the v2 DDL lacks both the session
      // column and creation_seq). No legacy session: the sessions table does
      // not exist at v2.
      2: { streams: 2 },
      // v3: two legacy sessions (v3 sessions lacks creation_seq) plus two
      // legacy build-scoped streams (v3 streams has `session` but no
      // creation_seq) — both tables' backfills run for a v3 marker.
      3: { sessions: 2, streams: 2 },
      // v4/v5: two legacy build-scoped streams. The frozen v4/v5 streams
      // tables still lack creation_seq (the column arrives in the v6 DDL),
      // so the shared STREAMS_CREATION_SEQ_MIGRATION genuinely backfills. No
      // legacy sessions: the sessions backfill branch runs only for a v3
      // marker, and the v4/v5 sessions.creation_seq is NOT NULL with no
      // default, so a deployed v4/v5 database's session rows already carry
      // counters — there is no sessions delta to exercise here.
      4: { streams: 2 },
      5: { streams: 2 },
      // v6/v7: canary builds row only. Their streams already carry
      // creation_seq, and the versions' real subjects (pinned index names,
      // the digest read, the bounded state-read oracle) stay covered by the
      // retained v6/v7 fixtures above.
      6: {},
      7: {},
    }

    /** Assert a backfilled legacy row set carries pairwise-distinct
     * creation_seq values forming exactly {1..N} — order-agnostic, because
     * legacy same-millisecond ties are genuinely unorderable and the
     * (created_at, id) mapping is explicitly not design-critical (see the
     * migration's own comments in schema.ts). */
    const expectBackfillSet = (rows: Row[]): void => {
      expect(rows.map((row) => Number(row.creation_seq)).sort((a, b) => a - b)).toEqual(
        Array.from({ length: rows.length }, (_, index) => index + 1),
      )
    }

    for (const [version, frozen] of FROZEN.build) {
      test(`upgrades a genuine v${version} database in place (the general-property retention baseline)`, async () => {
        const harness = await schemaHarness()
        const sql = new SQL(harness.url)
        try {
          // Seed the deployed shape: this version's frozen DDL and its
          // genuine marker (the version literal — a frozen checksum under any
          // other version is correctly rejected as incompatible), the legacy
          // rows a deployed database of this version carries, and a canary
          // builds row (the one table present since v1) the upgrade must
          // preserve.
          await sql.unsafe(frozen.ddl)
          await sql`INSERT INTO ab_schema_migrations VALUES
            (true, ${version}, ${frozen.checksum}, ${new Date().toISOString()})`
          await sql`INSERT INTO builds (slug, repo, created_at, updated_at)
            VALUES ('guard-canary', 'acme/guard', ${CONTRACT_T0}, ${CONTRACT_T0})`
          const seeds = LEGACY_SEEDS[version] ?? {}
          if (seeds.sessions) {
            // Same-millisecond ties, ids inserted in reversed order: legacy
            // ties are genuinely unorderable, so the backfill's (created_at,
            // id) order is asserted only as distinctness + set {1..N}.
            for (const id of ['os_legacy-2', 'os_legacy-1']) {
              await sql`INSERT INTO sessions (id, repo, operator, created_at, updated_at)
                VALUES (${id}, 'acme/guard', 'op', ${CONTRACT_T0}, ${CONTRACT_T0})`
            }
          }
          if (seeds.streams) {
            for (const id of ['st_legacy-2', 'st_legacy-1']) {
              // The insert omits creation_seq (and, at v2, the session
              // column does not exist yet) — the migration must backfill it.
              await sql`INSERT INTO streams (id, scope_kind, build, label, format, status, created_at)
                VALUES (${id}, 'build', 'guard-canary', 'before', 'ai-ui-message-stream/v1', 'open', ${CONTRACT_T0})`
            }
          }

          await migratePostgres(harness.url)

          const marker = await sql`SELECT version, checksum FROM ab_schema_migrations`
          expect(Number(marker[0]?.version)).toBe(SCHEMA_VERSION)
          expect(marker[0]?.checksum).toBe(SCHEMA_CHECKSUM)
          expect((await sql`SELECT slug FROM builds WHERE slug = 'guard-canary'`).length).toBe(1)

          // Backfill correctness where the branch backfills (streams at
          // v2–v5, sessions at v3): every legacy row carries a distinct
          // creation_seq and the set is {1..N}. A skipped backfill fails the
          // NULLs/set here; a broken setval fails the continuity assertion
          // below.
          if (seeds.streams) {
            expectBackfillSet(
              await sql`SELECT creation_seq FROM streams
                WHERE id IN ('st_legacy-1', 'st_legacy-2')`,
            )
          }
          if (seeds.sessions) {
            expectBackfillSet(
              await sql`SELECT creation_seq FROM sessions
                WHERE id IN ('os_legacy-1', 'os_legacy-2')`,
            )
          }

          const store = await openPostgresBuildStore(harness.url, new MemoryBlobStore())
          try {
            // Sequence continuity where a backfill ran: the new rows'
            // counters sit strictly above the legacy maximum. Deterministic
            // (N legacy rows backfill 1..N and setval positions the next
            // nextval at N+1), but assert the design-critical property, not
            // the literal.
            const session = await store.createSession({ repo: 'acme/guard', operator: 'op' })
            const sessionSeq = Number(
              (await sql`SELECT creation_seq FROM sessions WHERE id = ${session.id}`)[0]
                ?.creation_seq,
            )
            if (seeds.sessions) expect(sessionSeq).toBeGreaterThan(2)
            else expect(sessionSeq).toBeGreaterThanOrEqual(1)
            const stream = await store.createStream(
              { kind: 'build', build: 'guard-canary' },
              'after',
            )
            const streamSeq = Number(
              (await sql`SELECT creation_seq FROM streams WHERE id = ${stream.id}`)[0]
                ?.creation_seq,
            )
            if (seeds.streams) expect(streamSeq).toBeGreaterThan(2)
            else expect(streamSeq).toBeGreaterThanOrEqual(1)

            // The widened-CHECK probe: through the full store's
            // sessionScope(session.id) handle (whose createStream enforces
            // the session scope), create a session-scoped stream and assert
            // it succeeds. The insert carries scope_kind='session' with
            // build NULL, satisfying only the widened
            // streams_scope_kind_check / streams_scope_exactly_one_check — a
            // build-scoped write satisfies both the old and widened CHECKs
            // and pins nothing. The probe runs at every version uniformly:
            // the post-migration lockSession / pruneStreamChunksLocked /
            // insert path runs against migrated tables at every old version,
            // so any scope-related migration regression is caught wherever
            // it lands.
            const scoped = store.scopeSession(session.id)
            const probed = await scoped.createStream(
              { kind: 'session', session: session.id },
              'widened-check probe',
            )
            expect(probed.scope).toEqual({ kind: 'session', session: session.id })

            // The store answers a read over the migrated tables.
            expect(
              (await store.listStreams({ kind: 'build', build: 'guard-canary' })).map(
                (record) => record.id,
              ),
            ).toContain(stream.id)
          } finally {
            await store.close()
          }

          // No creation_seq value appears twice within a table across legacy
          // + new rows — necessary because creation_seq has no UNIQUE
          // constraint, so a collision raises no error.
          const streamCollisions: Row[] = await sql`SELECT creation_seq FROM streams
            GROUP BY creation_seq HAVING count(*) > 1`
          expect(streamCollisions).toHaveLength(0)
          const sessionCollisions: Row[] = await sql`SELECT creation_seq FROM sessions
            GROUP BY creation_seq HAVING count(*) > 1`
          expect(sessionCollisions).toHaveLength(0)

          // The upgrade is idempotent.
          await migratePostgres(harness.url)
        } finally {
          await sql.close()
          await harness.cleanup()
        }
      })
    }

    for (const [version, frozen] of FROZEN.auth) {
      test(`upgrades a genuine v${version} auth database in place (the general-property retention baseline)`, async () => {
        const harness = await schemaHarness()
        const sql = new SQL(harness.url)
        try {
          // Seed a coherent whole database the way the genuine-v2 auth
          // fixture above does: the current build-store DDL and marker
          // (migratePostgres validates both markers), this version's frozen
          // auth DDL and genuine marker, and a canary user row the upgrade
          // must preserve. The v2 iteration additionally seeds the version's
          // actual subject: a legacy oauthApplication row written before
          // authenticationScheme existed.
          await sql.unsafe(SCHEMA_DDL)
          await sql`INSERT INTO ab_schema_migrations VALUES
            (true, ${SCHEMA_VERSION}, ${SCHEMA_CHECKSUM}, ${new Date().toISOString()})`
          await sql.unsafe(frozen.ddl)
          await sql`INSERT INTO ab_auth_schema_migrations VALUES
            (true, ${version}, ${frozen.checksum}, ${new Date().toISOString()})`
          await sql`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
            VALUES ('u_guard', 'Guard', 'guard@example.com', true, ${CONTRACT_T0}, ${CONTRACT_T0})`
          if (version === 2) {
            await sql`INSERT INTO "oauthApplication"
              (id, name, "clientId", "clientSecret", "redirectUrls", type, disabled,
               "createdAt", "updatedAt")
              VALUES ('guard-legacy', 'guard-legacy-client', 'guard-legacy-id', 'secret',
                      'https://claude.ai', 'web', false, ${CONTRACT_T0}, ${CONTRACT_T0})`
          }

          await migratePostgres(harness.url)

          const marker = await sql`SELECT version, checksum FROM ab_auth_schema_migrations`
          expect(Number(marker[0]?.version)).toBe(AUTH_SCHEMA_VERSION)
          expect(marker[0]?.checksum).toBe(AUTH_SCHEMA_CHECKSUM)
          expect((await sql`SELECT id FROM "user" WHERE id = 'u_guard'`).length).toBe(1)
          // The v2 iteration's delta: the legacy oauthApplication row's
          // authenticationScheme backfills as NULL ("field absent", the
          // builds.repo_origin precedent). At v1 the oauthApplication table
          // itself is created by the migration's full DDL, which
          // assertAuthSchema catalog-asserts inside migratePostgres.
          if (version === 2) {
            const legacy =
              await sql`SELECT "authenticationScheme" FROM "oauthApplication" WHERE id = 'guard-legacy'`
            expect(legacy[0]?.authenticationScheme).toBeNull()
          }

          const store = await openPostgresBuildStore(harness.url, new MemoryBlobStore())
          await store.close()

          // The upgrade is idempotent.
          await migratePostgres(harness.url)
        } finally {
          await sql.close()
          await harness.cleanup()
        }
      })
    }

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
