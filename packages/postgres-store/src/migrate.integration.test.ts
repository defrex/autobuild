import { temporaryDirectories as ownTempDirectories } from '@defrex/autobuild/testing'
import { afterEach, describe, expect, test } from 'bun:test'
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
  SCHEMA_V16_DDL,
  SCHEMA_V16_CHECKSUM,
  SCHEMA_V1_CHECKSUM,
  SCHEMA_V1_DDL,
  SCHEMA_V2_DDL,
  SCHEMA_V3_DDL,
  SCHEMA_V4_DDL,
  SCHEMA_V5_DDL,
  SCHEMA_V6_CHECKSUM,
  SCHEMA_V6_DDL,
  SCHEMA_V7_CHECKSUM,
  SCHEMA_V7_DDL,
  SCHEMA_V8_CHECKSUM,
  SCHEMA_V8_DDL,
  SCHEMA_V9_DDL,
  SCHEMA_V9_CHECKSUM,
  SCHEMA_VERSION,
  assertSchema,
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
    ['SCHEMA_V8_DDL', SCHEMA_V8_DDL],
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
          // The version-matched, checksum-mismatched marker is exactly the
          // shape a checksum-only re-pin leaves deployed databases in
          // (AUT-548); its diagnostic must name the in-place-edit cause. The
          // other two scenarios are plain version mismatches and keep the
          // bare messages.
          if (scenario.name === 'checksum-mismatched') {
            expect((error as Error).message).toContain('checksum is mismatched')
            expect((error as Error).message).toContain(
              'edited in place without bumping the version',
            )
          }
          await expect(migratePostgres(harness.url)).rejects.toThrow('incompatible')
          if (scenario.name === 'checksum-mismatched') {
            await expect(migratePostgres(harness.url)).rejects.toThrow(
              'edited in place without bumping the version',
            )
          }
        } finally {
          await sql.close()
          await harness.cleanup()
        }
      })
    }

    test('v16 presence migration preserves streams, events and dispatcher liveness', async () => {
      const harness = await schemaHarness()
      const sql = new SQL(harness.url)
      try {
        await sql.unsafe(SCHEMA_V16_DDL)
        await sql`INSERT INTO ab_schema_migrations VALUES (true,16,${SCHEMA_V16_CHECKSUM},${CONTRACT_T0})`
        await sql`INSERT INTO repo_streams (repo,created_at,updated_at,lease_holder,lease_expires_at,lease_ttl_ms,heartbeat_at)
          VALUES ('presence-migration',${CONTRACT_T0},${CONTRACT_T0},'dispatcher',${CONTRACT_T0},60000,${CONTRACT_T0})`
        await sql`INSERT INTO repo_events (repo,seq,ts,actor,type,payload)
          VALUES ('presence-migration',1,${CONTRACT_T0},'{"kind":"human","user":"owner"}','dispatcher.intake-set','{"enabled":false}')`
        await sql`INSERT INTO streams (id,scope_kind,repo,label,format,status,created_at,creation_seq)
          VALUES ('preserved-stream','repo','presence-migration','log','ui-message','open',${CONTRACT_T0},1)`
        const before = await sql`SELECT * FROM repo_streams`
        await migratePostgres(harness.url)
        expect(await sql`SELECT * FROM repo_streams`).toEqual(before)
        expect(await sql`SELECT * FROM repo_events`).toHaveLength(1)
        expect(await sql`SELECT * FROM streams WHERE id='preserved-stream'`).toHaveLength(1)
        const store = await openPostgresBuildStore(harness.url, new MemoryBlobStore())
        try {
          const identity = { id: 'one', host: 'host', pid: 1, startedAt: CONTRACT_T0 }
          await Promise.all(
            Array.from({ length: 8 }, () =>
              store.upsertOperatorPresence('presence-migration', identity),
            ),
          )
          expect(await store.listOperatorPresence('presence-migration')).toHaveLength(1)
          expect(await sql`SELECT * FROM repo_streams`).toEqual(before)
          expect(await sql`SELECT * FROM repo_events`).toHaveLength(1)
        } finally {
          await store.close()
        }
        await migratePostgres(harness.url)
      } finally {
        await sql.close()
        await harness.cleanup()
      }
    })

    // Retention policy for the hand-written per-version fixtures (AUT-547).
    // Per schema family (build, auth; a family enters this scheme once it
    // gains its first bump): the suite keeps the general-property loop below
    // (the baseline, which follows the frozen map and never retires) plus
    // hand-written per-version fixtures for the **two most recent versions**
    // of the family. On each new schema bump:
    //
    //   1. Add the new version's fixture if its delta needs hand-written
    //      assertions (pinned index names, backfill seeding/continuity beyond
    //      the loop's defaults).
    //   2. Delete the fixture that falls out of the two-version window.
    //   3. Leave the baseline untouched.
    //
    // Retirement is mechanical because the baseline covers every frozen
    // version's generic upgrade behavior — seeded legacy rows, backfill
    // distinctness and set {1..N}, sequence continuity above the legacy
    // maximum, the widened-CHECK session-scoped write probe, per-table
    // collision checks, and idempotence. First application of this policy
    // retired the build-store fixtures for v1–v5 (plus the second v4
    // fixture); their coverage is subsumed per the PR description.
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
          VALUES ('v6-build', 1, ${CONTRACT_T0}, '{"kind":"dispatcher"}', 'build.created', '{"ticket":{"source":"file","id":"V6"},"repo":"acme/v6","baseBranch":"main"}')`

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

    test('upgrades a genuine v8 database in place: the ticket_assets table, preserving prior rows', async () => {
      const harness = await schemaHarness()
      const sql = new SQL(harness.url)
      try {
        await sql.unsafe(SCHEMA_V8_DDL)
        // The genuine v8 marker is version 8 literally (see the v7 test).
        await sql`INSERT INTO ab_schema_migrations VALUES
          (true, 8, ${SCHEMA_V8_CHECKSUM}, ${new Date().toISOString()})`
        await sql`INSERT INTO repo_streams (repo, created_at, updated_at)
          VALUES ('acme/v8', ${CONTRACT_T0}, ${CONTRACT_T0})`
        expect(((await sql`SELECT to_regclass('ticket_assets') AS t`) as Row[])[0]?.t).toBeNull()

        await migratePostgres(harness.url)

        const marker = await sql`SELECT version, checksum FROM ab_schema_migrations`
        expect(Number(marker[0]?.version)).toBe(SCHEMA_VERSION)
        expect(marker[0]?.checksum).toBe(SCHEMA_CHECKSUM)
        expect(
          ((await sql`SELECT repo FROM repo_streams`) as Row[]).map((row) => row.repo),
        ).toEqual(['acme/v8'])

        const store = await openPostgresBuildStore(harness.url, new MemoryBlobStore())
        try {
          const meta = await store.putTicketAsset('acme/v8', 'T-1', {
            kind: 'design',
            name: 'a',
            layout: 'file',
            entries: [{ type: 'file', path: 'a', content: new Uint8Array([1]) }],
          })
          expect(meta.revision).toBe(0)
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

    test.each(['project_journal', 'project_registry_state'])(
      'refuses missing registry table %s',
      async (table) => {
        const harness = await schemaHarness()
        const sql = new SQL(harness.url)
        try {
          await migratePostgres(harness.url)
          await sql.unsafe(`DROP TABLE ${table}`)
          await expect(assertSchema(sql)).rejects.toThrow(`table ${table} is missing or mismatched`)
          await migratePostgres(harness.url)
          await assertSchema(sql)
        } finally {
          await sql.close()
          await harness.cleanup()
        }
      },
    )
    test('refuses malformed registry columns and absent action constraints', async () => {
      const harness = await schemaHarness()
      const sql = new SQL(harness.url)
      try {
        await migratePostgres(harness.url)
        await sql`ALTER TABLE project_journal ALTER COLUMN actor DROP NOT NULL`
        await expect(assertSchema(sql)).rejects.toThrow(
          'table project_journal is missing or mismatched',
        )
        await sql`ALTER TABLE project_journal ALTER COLUMN actor SET NOT NULL`
        await sql`ALTER TABLE project_journal DROP CONSTRAINT project_journal_action_check`
        await expect(assertSchema(sql)).rejects.toThrow('constraints are missing or mismatched')
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

          const cronIndexes =
            await sql`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()
            AND indexname IN ('dispatcher_credentials_expiry', 'dispatcher_credentials_revoked')`
          expect(cronIndexes).toHaveLength(2)
          const marker = await sql`SELECT version, checksum FROM ab_schema_migrations`
          expect(Number(marker[0]?.version)).toBe(SCHEMA_VERSION)
          expect(marker[0]?.checksum).toBe(SCHEMA_CHECKSUM)
          expect((await sql`SELECT slug FROM builds WHERE slug = 'guard-canary'`).length).toBe(1)
          expect(
            (
              await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'repo_streams' AND column_name = 'tick' AND data_type = 'jsonb' AND is_nullable = 'YES'`
            ).length,
          ).toBe(1)

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

// Project-ticket migration evidence uses real artifact bytes outside PostgreSQL.
import { readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DISPATCHER, parseConfig } from '@defrex/autobuild/testing'
import type { BlobStore } from '@defrex/autobuild/plugin-sdk'
import { TICKET_SCHEMA_V1_DDL, TICKET_SCHEMA_V1_CHECKSUM, assertTicketSchema } from './schema'
import { openPostgresTicketDatabase } from './tickets'

async function legacyTickets() {
  const database = await schemaHarness()
  await migratePostgres(database.url)
  const sql = new SQL(database.url)
  await sql.unsafe(
    'DROP TABLE ab_ticket_counters, ab_ticket_blockers, ab_ticket_comments, ab_tickets, ab_ticket_schema_migrations',
  )
  await sql.unsafe(TICKET_SCHEMA_V1_DDL)
  await sql`INSERT INTO ab_ticket_schema_migrations VALUES (true, 1, ${TICKET_SCHEMA_V1_CHECKSUM}, ${CONTRACT_T0})`
  const directory = await mkdtemp(join(tmpdir(), 'ab-ticket-blobs-'))
  const reads: string[] = []
  const blobs: BlobStore = {
    put: async (hash, bytes) => {
      await writeFile(join(directory, hash), bytes)
    },
    get: async (hash) => {
      reads.push(hash)
      try {
        return new Uint8Array(await readFile(join(directory, hash)))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
  }
  const store = await openPostgresBuildStore(database.url, blobs)
  async function project(repo: string, team: string, reload = false) {
    await sql`INSERT INTO project_journal (seq, repo, action, actor, ts) VALUES (nextval('project_journal_seq'), ${repo}, 'added', 'fixture', ${CONTRACT_T0})`
    await store.ensureRepo(repo)
    const config = parseConfig(
      `[tickets]\nsource = "hosted"\nteamKey = "${team}"\nreadyState = "Ready"\n[verify]\nsteps = []\n[finalize]\nsteps = []`,
    )
    const { verify, finalize, ...root } = config
    const artifact = await store.putRepoArtifact(repo, {
      kind: 'dispatcher-effective-config',
      content: JSON.stringify({
        ...root,
        verify: { steps: verify.steps },
        finalize: { steps: finalize.steps },
      }),
    })
    await store.appendRepo(
      repo,
      reload
        ? {
            actor: DISPATCHER,
            type: 'dispatcher.config-reloaded',
            payload: {
              run: repo,
              artifact: { kind: 'config', rev: 1 },
              effectiveConfig: { kind: artifact.kind, rev: artifact.revision },
              effectiveChanged: true,
              restartRequired: [],
            },
          }
        : {
            actor: DISPATCHER,
            type: 'dispatcher.run-started',
            payload: {
              run: repo,
              pid: 1,
              effectiveConfig: { kind: artifact.kind, rev: artifact.revision },
              roleWarnings: [],
            },
          },
    )
    return artifact
  }
  async function seed(team: string) {
    await sql`INSERT INTO ab_tickets VALUES (${team}, 'old-1', 'creation-1', 'Title', 'Body', 'Historical', ARRAY['one'], ${CONTRACT_T0}, ${CONTRACT_T0}), (${team}, 'old-2', NULL, 'Blocker', 'Body', 'Done', ARRAY[]::text[], ${CONTRACT_T0}, ${CONTRACT_T0})`
    await sql`INSERT INTO ab_ticket_comments VALUES (${team}, 'old-1', 7, 'Original comment', ${CONTRACT_T0})`
    await sql`INSERT INTO ab_ticket_blockers VALUES (${team}, 'old-1', 'old-2')`
  }
  const snapshot = async () => ({
    marker: await sql`SELECT * FROM ab_ticket_schema_migrations`,
    tickets: await sql`SELECT * FROM ab_tickets ORDER BY team,id`,
    comments: await sql`SELECT * FROM ab_ticket_comments ORDER BY team,ticket_id,seq`,
    blockers: await sql`SELECT * FROM ab_ticket_blockers ORDER BY team,ticket_id`,
  })
  return {
    ...database,
    sql,
    blobs,
    reads,
    store,
    project,
    seed,
    snapshot,
    cleanup: async () => {
      await store.close()
      await sql.close()
      await rm(directory, { recursive: true, force: true })
      await database.cleanup()
    },
  }
}

if (testUrl) {
  test('v1 ticket migration reads the selected blob and preserves every ticket/comment/blocker value', async () => {
    const world = await legacyTickets()
    const one = 'https://github.com/acme/one',
      two = 'https://github.com/acme/two'
    try {
      await world.project(one, 'OLD')
      const selected = await world.project(one, 'ONE', true)
      await world.project(two, 'TWO')
      // A newer artifact without a selecting event must not change ownership.
      await world.store.putRepoArtifact(one, {
        kind: 'dispatcher-effective-config',
        content: 'invalid unselected artifact',
      })
      await world.seed('ONE')
      await world.seed('TWO')
      const before = await world.snapshot()
      await migratePostgres(world.url, { openBlobs: () => world.blobs })
      await assertTicketSchema(world.sql)
      expect(world.reads).toContain(selected.blobRef)
      const tickets =
        await world.sql`SELECT repo,id,creation_key,title,body,state,labels,created_at,updated_at,revision::text AS revision FROM ab_tickets ORDER BY repo,id`
      expect(tickets).toEqual(
        before.tickets.map(({ team, ...ticket }: Row) => ({
          repo: team === 'ONE' ? one : two,
          revision: '1',
          ...ticket,
        })),
      )
      const comments = await world.sql`SELECT * FROM ab_ticket_comments ORDER BY repo,ticket_id,seq`
      expect(comments).toEqual(
        before.comments.map(({ team, ...comment }: Row) => ({
          repo: team === 'ONE' ? one : two,
          ...comment,
        })),
      )
      const blockers = await world.sql`SELECT * FROM ab_ticket_blockers ORDER BY repo,ticket_id`
      expect(blockers).toEqual(
        before.blockers.map(({ team, ...blocker }: Row) => ({
          repo: team === 'ONE' ? one : two,
          ...blocker,
        })),
      )
      await migratePostgres(world.url)
      const database = await openPostgresTicketDatabase(world.url)
      try {
        const source = database.source({
          teamKey: 'AUT',
          repo: one,
          lifecycle: { triage: 'Backlog', ready: 'Ready', doing: 'Doing', done: 'Done' },
        })
        expect((await source.get('old-1'))?.state).toBe('Historical')
        expect((await source.get('old-1'))?.blockedBy).toEqual(['ONE-2'])
      } finally {
        await database.close()
      }
    } finally {
      await world.cleanup()
    }
  })

  test('ambiguous team migration rolls back; the exact owner command recovers before v2 assertion', async () => {
    const world = await legacyTickets()
    const one = 'https://github.com/acme/one',
      two = 'https://github.com/acme/two'
    try {
      await world.project(one, 'SAME')
      await world.project(two, 'SAME')
      await world.seed('SAME')
      const before = await world.snapshot()
      await expect(migratePostgres(world.url, { openBlobs: () => world.blobs })).rejects.toThrow(
        `conflicting projects: ${one}, ${two}`,
      )
      expect(await world.snapshot()).toEqual(before)
      const child = Bun.spawn(
        [
          process.execPath,
          join(
            dirname(Bun.resolveSync('@defrex/autobuild-hosted-store-service', import.meta.dir)),
            'bin.ts',
          ),
          'tickets',
          'assign-team',
          'SAME',
          one,
          '--user',
          'owner',
        ],
        { env: { ...process.env, AB_POSTGRES_URL: world.url }, stdout: 'pipe', stderr: 'pipe' },
      )
      expect(await child.exited).toBe(0)
      expect(await new Response(child.stderr).text()).toBe('')
      await migratePostgres(world.url, { openBlobs: () => world.blobs })
      expect((await world.sql`SELECT DISTINCT repo FROM ab_tickets`)[0].repo).toBe(one)
      expect((await world.sql`SELECT actor FROM ticket_team_assignments`)[0].actor).toBe('owner')
    } finally {
      await world.cleanup()
    }
  })

  test('missing blob dependency, missing/denied/malformed blob and unclaimed teams leave v1 unchanged', async () => {
    const world = await legacyTickets()
    try {
      await world.project('https://github.com/acme/one', 'ONE')
      await world.seed('UNCLAIMED')
      const before = await world.snapshot()
      for (const openBlobs of [
        undefined,
        () => ({ ...world.blobs, get: async () => null }),
        () => ({
          ...world.blobs,
          get: async () => {
            throw new Error('secret provider failure')
          },
        }),
        () => ({ ...world.blobs, get: async () => new TextEncoder().encode('{broken') }),
        () => world.blobs,
      ]) {
        await expect(migratePostgres(world.url, openBlobs ? { openBlobs } : {})).rejects.toThrow()
        expect(await world.snapshot()).toEqual(before)
      }
    } finally {
      await world.cleanup()
    }
  })
}

if (testUrl)
  test('environment-aware migration CLI reads populated v1 configs through the configured S3 adapter and prefix', async () => {
    const world = await legacyTickets()
    const requests: string[] = []
    let denied = true
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (request) => {
        const path = new URL(request.url).pathname
        requests.push(path)
        if (denied) return new Response('Denied', { status: 403 })
        const prefix = '/bucket/project-prefix/'
        if (!path.startsWith(prefix)) return new Response('', { status: 404 })
        const bytes = await world.blobs.get(path.slice(prefix.length))
        return bytes === null
          ? new Response('', { status: 404 })
          : new Response(new Uint8Array(bytes))
      },
    })
    try {
      await world.project('https://github.com/acme/one', 'ONE')
      await world.seed('ONE')
      const before = await world.snapshot()
      const env = {
        ...process.env,
        AB_POSTGRES_URL: world.url,
        AB_BLOB_BACKEND: 's3',
        AB_BLOB_PREFIX: 'project-prefix',
        AB_S3_ENDPOINT: `http://127.0.0.1:${server.port}`,
        AB_S3_FORCE_PATH_STYLE: 'true',
        AB_S3_BUCKET: 'bucket',
        AB_S3_REGION: 'us-east-1',
        AB_S3_ACCESS_KEY_ID: 'test-key',
        AB_S3_SECRET_ACCESS_KEY: 'never-print-me',
      }
      const run = async () => {
        const child = Bun.spawn(
          [process.execPath, new URL('./bin.ts', import.meta.url).pathname, 'migrate'],
          { env, stdout: 'pipe', stderr: 'pipe' },
        )
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        expect(stdout + stderr).not.toContain('never-print-me')
        return { code, stdout, stderr }
      }
      expect((await run()).code).toBe(1)
      expect(await world.snapshot()).toEqual(before)
      denied = false
      expect((await run()).code).toBe(0)
      expect(requests.some((path) => path.startsWith('/bucket/project-prefix/'))).toBe(true)
      await assertTicketSchema(world.sql)
    } finally {
      server.stop(true)
      await world.cleanup()
    }
  })

if (testUrl)
  test('legacy asset ownership is preserved and incompatible ownership stops the whole migration', async () => {
    const world = await legacyTickets()
    const one = 'https://github.com/acme/one',
      two = 'https://github.com/acme/two'
    try {
      await world.project(one, 'ONE')
      await world.project(two, 'TWO')
      await world.seed('ONE')
      const asset = {
        kind: 'reference',
        name: 'proof.txt',
        layout: 'file' as const,
        entries: [
          { type: 'file' as const, path: 'proof.txt', content: new TextEncoder().encode('proof') },
        ],
      }
      await world.store.putTicketAsset(two, 'old-1', asset)
      const before = await world.snapshot()
      await expect(migratePostgres(world.url, { openBlobs: () => world.blobs })).rejects.toThrow(
        'asset ownership mismatch',
      )
      expect(await world.snapshot()).toEqual(before)
      await world.sql`UPDATE ticket_assets SET repo = ${one} WHERE repo = ${two}`
      const rows = await world.sql`SELECT * FROM ticket_assets`
      await migratePostgres(world.url, { openBlobs: () => world.blobs })
      expect(await world.sql`SELECT * FROM ticket_assets`).toEqual(rows)
      const loaded = await world.store.getTicketAsset(one, 'old-1', 'reference', 'proof.txt')
      expect(loaded).not.toBeNull()
      const entry = loaded!.entries[0]!
      expect(entry.type).toBe('file')
      if (entry.type === 'file') expect(new TextDecoder().decode(entry.content)).toBe('proof')
    } finally {
      await world.cleanup()
    }
  })

/** Build the released main-v9/ticket-v1 topology directly: no registry,
 * credential table, or current-schema opener can accidentally prepare it. */
async function releasedV9Tickets(repositories: string[]) {
  const database = await schemaHarness()
  const sql = new SQL(database.url, { prepare: false })
  const directory = await mkdtemp(join(tmpdir(), 'ab-v9-ticket-blobs-'))
  await sql.unsafe(SCHEMA_V9_DDL)
  await sql`INSERT INTO ab_schema_migrations VALUES (true, 9, ${SCHEMA_V9_CHECKSUM}, ${CONTRACT_T0})`
  await sql.unsafe(TICKET_SCHEMA_V1_DDL)
  await sql`INSERT INTO ab_ticket_schema_migrations VALUES (true, 1, ${TICKET_SCHEMA_V1_CHECKSUM}, ${CONTRACT_T0})`
  async function publishConfig(repo: string) {
    const { verify, finalize, ...root } = parseConfig(
      '[tickets]\nsource = "hosted"\nteamKey = "ENG"\nreadyState = "Ready"\n[verify]\nsteps = []\n[finalize]\nsteps = []',
    )
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        ...root,
        verify: { steps: verify.steps },
        finalize: { steps: finalize.steps },
      }),
    )
    const hash = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
    await writeFile(join(directory, hash), bytes)
    await sql`INSERT INTO repo_streams (repo,created_at,updated_at) VALUES (${repo},${CONTRACT_T0},${CONTRACT_T0})`
    await sql`INSERT INTO repo_artifacts VALUES (${repo},'dispatcher-effective-config',1,${hash},'{}'::jsonb,${CONTRACT_T0})`
    await sql`INSERT INTO repo_events VALUES (${repo},1,${CONTRACT_T0},${JSON.stringify(DISPATCHER)}::jsonb,'dispatcher.run-started',${JSON.stringify({ run: repo, pid: 1, effectiveConfig: { kind: 'dispatcher-effective-config', rev: 1 }, roleWarnings: [] })}::jsonb)`
  }
  for (const repo of repositories) await publishConfig(repo)
  await sql`INSERT INTO ab_tickets VALUES ('ENG','ENG-1','creation-1','Original','Body','Historical',ARRAY['label'],${CONTRACT_T0},${CONTRACT_T0}), ('ENG','ENG-2',NULL,'Blocker','Body','Done',ARRAY[]::text[],${CONTRACT_T0},${CONTRACT_T0})`
  await sql`INSERT INTO ab_ticket_comments VALUES ('ENG','ENG-1',7,'Comment',${CONTRACT_T0})`
  await sql`INSERT INTO ab_ticket_blockers VALUES ('ENG','ENG-1','ENG-2')`
  const requests: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      requests.push(path)
      if (!path.startsWith('/bucket/v9-prefix/')) return new Response('', { status: 404 })
      try {
        return new Response(
          new Uint8Array(await readFile(join(directory, path.slice('/bucket/v9-prefix/'.length)))),
        )
      } catch {
        return new Response('', { status: 404 })
      }
    },
  })
  const env = {
    ...process.env,
    AB_POSTGRES_URL: database.url,
    AB_WEB_REPOSITORIES: repositories.join(','),
    AB_BLOB_BACKEND: 's3',
    AB_BLOB_PREFIX: 'v9-prefix',
    AB_S3_ENDPOINT: `http://127.0.0.1:${server.port}`,
    AB_S3_FORCE_PATH_STYLE: 'true',
    AB_S3_BUCKET: 'bucket',
    AB_S3_REGION: 'us-east-1',
    AB_S3_ACCESS_KEY_ID: 'fixture',
    AB_S3_SECRET_ACCESS_KEY: 'fixture-secret',
  }
  const run = async (owner: boolean, args: string[]) => {
    const bin = owner
      ? join(
          dirname(Bun.resolveSync('@defrex/autobuild-hosted-store-service', import.meta.dir)),
          'bin.ts',
        )
      : new URL('./bin.ts', import.meta.url).pathname
    const child = Bun.spawn([process.execPath, bin, ...args], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(stdout + stderr).not.toContain('fixture-secret')
    return { code, stdout, stderr }
  }
  const snapshot = async () => ({
    tickets: (
      await sql`SELECT to_jsonb(t) - 'readable_id' - 'ticket_number' AS value FROM ab_tickets t ORDER BY id`
    ).map((row: { value: Row }) => row.value),
    comments: await sql`SELECT * FROM ab_ticket_comments`,
    blockers: await sql`SELECT * FROM ab_ticket_blockers`,
  })
  return {
    sql,
    env,
    run,
    snapshot,
    requests,
    publishConfig,
    cleanup: async () => {
      server.stop(true)
      await sql.close()
      await rm(directory, { recursive: true, force: true })
      await database.cleanup()
    },
  }
}

if (testUrl) {
  test('released main-v9 + populated ticket-v1 migrates via the environment CLI with a one-time legacy registry import', async () => {
    const repo = 'https://github.com/acme/released'
    const world = await releasedV9Tickets([repo])
    try {
      const before = await world.snapshot()
      expect(
        (await world.sql`SELECT to_regclass('project_journal') AS table_name`)[0].table_name,
      ).toBeNull()
      const result = await world.run(false, ['migrate'])
      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
      expect(Number((await world.sql`SELECT version FROM ab_schema_migrations`)[0].version)).toBe(
        SCHEMA_VERSION,
      )
      await assertTicketSchema(world.sql)
      const registry = await world.sql`SELECT repo,actor FROM project_journal`
      expect(registry).toEqual([{ repo, actor: 'system:AB_WEB_REPOSITORIES' }])
      expect(
        (await world.sql`SELECT legacy_imported FROM project_registry_state`)[0].legacy_imported,
      ).toBe(true)
      const after = await world.snapshot()
      for (const key of ['tickets', 'comments', 'blockers'] as const)
        expect(after[key]).toEqual(
          before[key].map(({ team: _team, ...row }: Row) => ({
            repo,
            ...row,
            ...(key === 'tickets' ? { revision: 1, kind: 'work', target_id: null } : {}),
          })),
        )
      expect(world.requests.length).toBeGreaterThan(0)
      // Subsequent malformed retired environment is not reinterpreted.
      world.env.AB_WEB_REPOSITORIES = 'not-a-repository'
      expect((await world.run(false, ['migrate'])).code).toBe(0)
      expect(await world.sql`SELECT repo,actor FROM project_journal`).toEqual(registry)
    } finally {
      await world.cleanup()
    }
  })

  test('released v9 ambiguity rolls back main and ticket schemas; both owner recovery commands work before rerunning migration', async () => {
    const repos = [
      'https://github.com/acme/one',
      'https://github.com/acme/two',
      'https://github.com/acme/three',
    ]
    const world = await releasedV9Tickets(repos)
    world.env.AB_WEB_REPOSITORIES = repos.slice(0, 2).join(',')
    try {
      const before = await world.snapshot()
      const failed = await world.run(false, ['migrate'])
      expect(failed.code).toBe(1)
      expect(failed.stderr).toContain(`conflicting projects: ${repos[0]}, ${repos[1]}`)
      expect(await world.snapshot()).toEqual(before)
      expect(Number((await world.sql`SELECT version FROM ab_schema_migrations`)[0].version)).toBe(9)
      expect(
        Number((await world.sql`SELECT version FROM ab_ticket_schema_migrations`)[0].version),
      ).toBe(1)
      expect(
        (await world.sql`SELECT to_regclass('project_journal') AS table_name`)[0].table_name,
      ).toBeNull()
      const assigned = await world.run(true, [
        'tickets',
        'assign-team',
        'ENG',
        repos[0]!,
        '--user',
        'owner',
      ])
      expect(assigned.stderr).toBe('')
      expect(assigned.code).toBe(0)
      const added = await world.run(true, ['projects', 'add', repos[2]!, '--user', 'owner'])
      expect(added.stderr).toBe('')
      expect(added.code).toBe(0)
      expect(Number((await world.sql`SELECT version FROM ab_schema_migrations`)[0].version)).toBe(9)
      expect(await world.snapshot()).toEqual(before)
      expect(
        (await world.sql`SELECT to_regclass('project_credentials') AS table_name`)[0].table_name,
      ).toBeNull()
      expect((await world.run(false, ['migrate'])).code).toBe(0)
      await assertSchema(world.sql)
      await assertTicketSchema(world.sql)
      expect([...(await world.sql`SELECT DISTINCT repo FROM ab_tickets`)]).toEqual([
        { repo: repos[0] },
      ])
      expect((await world.sql`SELECT actor FROM ticket_team_assignments`)[0].actor).toBe('owner')
    } finally {
      await world.cleanup()
    }
  })
}

if (testUrl)
  test('released v9 without legacy environment remains recoverable by explicit project registration and team assignment', async () => {
    const repo = 'https://github.com/acme/recovery'
    const world = await releasedV9Tickets([repo])
    world.env.AB_WEB_REPOSITORIES = ''
    try {
      const before = await world.snapshot()
      const failed = await world.run(false, ['migrate'])
      expect(failed.code).toBe(1)
      expect(failed.stderr).toContain('no project claims this team')
      expect((await world.run(true, ['projects', 'add', repo, '--user', 'owner'])).code).toBe(0)
      expect(
        (await world.run(true, ['tickets', 'assign-team', 'ENG', repo, '--user', 'owner'])).code,
      ).toBe(0)
      expect(Number((await world.sql`SELECT version FROM ab_schema_migrations`)[0].version)).toBe(9)
      expect(await world.snapshot()).toEqual(before)
      expect((await world.run(false, ['migrate'])).code).toBe(0)
      await assertSchema(world.sql)
      await assertTicketSchema(world.sql)
      expect([...(await world.sql`SELECT DISTINCT repo FROM ab_tickets`)]).toEqual([{ repo }])
    } finally {
      await world.cleanup()
    }
  })

import { openTicketAssignmentsFromEnv } from './ticket-assignments'

if (testUrl) {
  test('registered projects without a dispatcher run or effective-config reference make no team claim', async () => {
    const world = await legacyTickets()
    const owner = 'https://github.com/acme/owner'
    const fresh = 'https://github.com/acme/fresh'
    const unconfigured = 'https://github.com/acme/unconfigured'
    try {
      const artifact = await world.project(owner, 'ONE')
      await world.seed('ONE')
      for (const repo of [fresh, unconfigured]) {
        await world.sql`INSERT INTO project_journal (seq,repo,action,actor,ts) VALUES (nextval('project_journal_seq'),${repo},'added','owner',${CONTRACT_T0})`
      }
      await world.store.ensureRepo(unconfigured)
      // Historical run without a config ref: no claim, not an unreadable ref.
      await world.sql`INSERT INTO repo_events (repo,seq,ts,actor,type,payload) VALUES (${unconfigured},1,${CONTRACT_T0},${DISPATCHER},'dispatcher.run-started',${{ run: 'unconfigured', pid: 1, roleWarnings: [] }})`
      await migratePostgres(world.url, { openBlobs: () => world.blobs })
      await assertTicketSchema(world.sql)
      expect(new Set(world.reads)).toEqual(new Set([artifact.blobRef]))
      expect((await world.sql`SELECT DISTINCT repo FROM ab_tickets`)[0].repo).toBe(owner)
      expect(
        Number((await world.sql`SELECT count(*) AS count FROM project_journal`)[0].count),
      ).toBe(3)
    } finally {
      await world.cleanup()
    }
  })

  test('v9 legacy import tolerates a listed project that never ran a dispatcher', async () => {
    const owner = 'https://github.com/acme/released'
    const fresh = 'https://github.com/acme/fresh'
    const world = await releasedV9Tickets([owner])
    world.env.AB_WEB_REPOSITORIES = `${owner},${fresh}`
    try {
      const result = await world.run(false, ['migrate'])
      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
      await assertTicketSchema(world.sql)
      expect([...(await world.sql`SELECT repo FROM project_journal ORDER BY repo`)]).toEqual([
        { repo: fresh },
        { repo: owner },
      ])
      expect([...(await world.sql`SELECT DISTINCT repo FROM ab_tickets`)]).toEqual([
        { repo: owner },
      ])
    } finally {
      await world.cleanup()
    }
  })

  test('a legacy team with no configured claimant fails closed and owner assignment recovers without removing the fresh project', async () => {
    const fresh = 'https://github.com/acme/fresh'
    const world = await releasedV9Tickets([])
    world.env.AB_WEB_REPOSITORIES = fresh
    try {
      const before = await world.snapshot()
      const result = await world.run(false, ['migrate'])
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('no project claims this team')
      expect(result.stderr).toContain('assign-team')
      expect(await world.snapshot()).toEqual(before)
      expect(
        (await world.run(true, ['tickets', 'assign-team', 'ENG', fresh, '--user', 'owner'])).code,
      ).toBe(0)
      world.requests.length = 0
      const missingConfig = await world.run(false, ['migrate'])
      expect(missingConfig.code).toBe(1)
      expect(missingConfig.stderr).toContain('no nonblank effective tickets.teamKey')
      await world.publishConfig(fresh)
      expect((await world.run(false, ['migrate'])).code).toBe(0)
      expect(world.requests.length).toBeGreaterThan(0)
      await assertTicketSchema(world.sql)
      expect([...(await world.sql`SELECT DISTINCT repo FROM ab_tickets`)]).toEqual([
        { repo: fresh },
      ])
      expect([...(await world.sql`SELECT repo FROM project_journal`)]).toEqual([{ repo: fresh }])
    } finally {
      await world.cleanup()
    }
  })

  test('unreadable unrelated configs stop ownership discovery; explicit ownership still requires the owning project config', async () => {
    for (const failure of [
      'missing-blob',
      'denied-blob',
      'invalid-json',
      'invalid-config',
      'missing-revision',
    ]) {
      const world = await legacyTickets()
      const owner = 'https://github.com/acme/owner'
      const unrelated = 'https://github.com/acme/unreadable'
      try {
        await world.project(owner, 'ONE')
        const artifact = await world.project(unrelated, 'OTHER')
        await world.seed('ONE')
        if (failure === 'missing-revision')
          await world.sql`DELETE FROM repo_artifacts WHERE repo = ${unrelated}`
        const blobs: BlobStore = {
          ...world.blobs,
          get: async (hash) => {
            if (hash !== artifact.blobRef) return world.blobs.get(hash)
            if (failure === 'missing-blob') return null
            if (failure === 'denied-blob') throw new Error('provider-secret-must-not-leak')
            if (failure === 'invalid-json') return new TextEncoder().encode('{broken')
            if (failure === 'invalid-config') return new TextEncoder().encode('{}')
            return world.blobs.get(hash)
          },
        }
        const before = await world.snapshot()
        let failureMessage: string | undefined
        try {
          await migratePostgres(world.url, { openBlobs: () => blobs })
        } catch (error) {
          failureMessage = (error as Error).message
        }
        expect(failureMessage).toContain('Ticket migration stopped unchanged:')
        expect(failureMessage).toContain('assign every remaining legacy team (ONE)')
        expect(failureMessage).not.toContain('provider-secret-must-not-leak')
        expect(await world.snapshot()).toEqual(before)
        const assignments = await openTicketAssignmentsFromEnv({ AB_POSTGRES_URL: world.url })
        try {
          await assignments.assign('ONE', owner, 'owner')
        } finally {
          await assignments.close()
        }
        await migratePostgres(world.url, {
          openBlobs: () => blobs,
        })
        await assertTicketSchema(world.sql)
        expect((await world.sql`SELECT DISTINCT repo FROM ab_tickets`)[0].repo).toBe(owner)
        expect(
          Number((await world.sql`SELECT count(*) AS count FROM project_journal`)[0].count),
        ).toBe(2)
      } finally {
        await world.cleanup()
      }
    }
  })
}

if (testUrl)
  test('partial assignments do not suppress unreadable configuration when another legacy team still needs ownership', async () => {
    const world = await legacyTickets()
    const one = 'https://github.com/acme/one',
      two = 'https://github.com/acme/two'
    try {
      await world.project(one, 'ONE')
      const unreadable = await world.project(two, 'TWO')
      await world.seed('ONE')
      await world.seed('TWO')
      const assignments = await openTicketAssignmentsFromEnv({ AB_POSTGRES_URL: world.url })
      try {
        await assignments.assign('ONE', one, 'owner')
        const blobs = {
          ...world.blobs,
          get: async (hash: string) => (hash === unreadable.blobRef ? null : world.blobs.get(hash)),
        }
        const before = await world.snapshot()
        await expect(migratePostgres(world.url, { openBlobs: () => blobs })).rejects.toThrow(
          'assign every remaining legacy team (TWO)',
        )
        expect(await world.snapshot()).toEqual(before)
        await assignments.assign('TWO', two, 'owner')
        await expect(migratePostgres(world.url, { openBlobs: () => blobs })).rejects.toThrow(
          'Readable ticket migration stopped unchanged',
        )
        expect(await world.snapshot()).toEqual(before)
        await migratePostgres(world.url, { openBlobs: () => world.blobs })
        await assertTicketSchema(world.sql)
        expect(
          (await world.sql`SELECT repo FROM ab_tickets WHERE id = 'old-1' ORDER BY repo`).map(
            (row: { repo: string }) => row.repo,
          ),
        ).toEqual([one, two])
      } finally {
        await assignments.close()
      }
    } finally {
      await world.cleanup()
    }
  })

if (testUrl)
  test('v2 readable migration orders tied timestamps per project, rolls back missing blobs, and preserves aliases and asset pins', async () => {
    const world = await legacyTickets()
    const repo = 'https://github.com/acme/one',
      two = 'https://github.com/acme/two'
    try {
      await world.sql.unsafe(
        'DROP TABLE ab_ticket_blockers, ab_ticket_comments, ab_tickets, ab_ticket_schema_migrations',
      )
      await world.sql.unsafe(TICKET_SCHEMA_V2_DDL)
      await world.sql`INSERT INTO ab_ticket_schema_migrations VALUES (true,2,${TICKET_SCHEMA_V2_CHECKSUM},${CONTRACT_T0})`
      await world.project(repo, 'ENG')
      await world.project(two, 'ENG')
      for (const project of [repo, two]) {
        await world.sql`INSERT INTO ab_tickets VALUES (${project},'ticket-b','key-b','Second','Body','Ready',ARRAY[]::text[],${CONTRACT_T0},${CONTRACT_T0}), (${project},'ticket-a','key-a','First','Body','Ready',ARRAY[]::text[],${CONTRACT_T0},${CONTRACT_T0})`
        await world.sql`INSERT INTO ab_ticket_comments VALUES (${project},'ticket-b',1,'kept',${CONTRACT_T0})`
        await world.sql`INSERT INTO ab_ticket_blockers VALUES (${project},'ticket-b','ticket-a')`
      }
      await world.store.putTicketAsset(repo, 'ticket-a', {
        kind: 'reference',
        name: 'proof',
        layout: 'file',
        entries: [{ type: 'file', path: 'proof', content: new TextEncoder().encode('old') }],
      })
      await world.store.createBuild({
        slug: 'legacy-pin',
        repo,
        ticket: { source: 'hosted', id: 'ticket-a' },
        created: {
          actor: DISPATCHER,
          type: 'build.created',
          payload: {
            ticket: { source: 'hosted', id: 'ticket-a' },
            repo,
            baseBranch: 'main',
            assets: [
              {
                kind: 'reference',
                name: 'proof',
                revision: 0,
                layout: 'file',
                size: 3,
                fileCount: 1,
                dirCount: 0,
              },
            ],
          },
        },
      })
      const originalEvents = await world.store.getEvents('legacy-pin')
      await expect(migratePostgres(world.url)).rejects.toThrow('require blob access')
      expect(
        Number((await world.sql`SELECT version FROM ab_ticket_schema_migrations`)[0].version),
      ).toBe(2)
      expect(
        (
          await world.sql`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'ab_tickets' AND column_name = 'readable_id'`
        ).length,
      ).toBe(0)
      await migratePostgres(world.url, { openBlobs: () => world.blobs })
      await migratePostgres(world.url)
      const db = await openPostgresTicketDatabase(world.url)
      try {
        const source = db.source({
          repo,
          teamKey: 'NEW',
          lifecycle: { triage: 'Backlog', ready: 'Ready', doing: 'Doing', done: 'Done' },
        })
        expect((await source.get('ticket-a'))?.ref.id).toBe('ENG-1')
        expect((await source.get('ticket-b'))?.blockedBy).toEqual(['ENG-1'])
        expect((await source.create({ title: 'Third', body: 'Body' })).ref.id).toBe('NEW-3')
        expect((await world.store.getBuild('legacy-pin'))?.ticket?.id).toBe('ENG-1')
        expect(
          (await world.store.listBuilds()).find((b) => b.slug === 'legacy-pin')?.ticket?.id,
        ).toBe('ENG-1')
        expect(await world.store.getEvents('legacy-pin')).toEqual(originalEvents)
        const asset = await world.store.getTicketAsset(repo, 'eng-1', 'reference', 'proof')
        expect(asset?.meta.revision).toBe(0)
        await world.store.putTicketAsset(repo, 'ENG-1', {
          kind: 'reference',
          name: 'proof',
          layout: 'file',
          entries: [{ type: 'file', path: 'proof', content: new TextEncoder().encode('new') }],
        })
        expect(
          (await world.store.getTicketAsset(repo, 'ticket-a', 'reference', 'proof'))?.meta.revision,
        ).toBe(1)
        expect(
          (await world.store.getPinnedTicketAsset('legacy-pin', 'reference', 'proof'))?.meta
            .revision,
        ).toBe(0)
        expect(
          (await world.store.listTicketAssets(repo, 'eng-1', { revisions: true })).length,
        ).toBe(2)
        await world.store.removeTicketAsset(repo, 'eNg-1', 'reference', 'proof')
        expect(await world.store.getTicketAsset(repo, 'ticket-a', 'reference', 'proof')).toBeNull()
        expect(Number((await world.sql`SELECT count(*) AS n FROM ab_ticket_comments`)[0].n)).toBe(2)
      } finally {
        await db.close()
      }
    } finally {
      await world.cleanup()
    }
  })

import { PostgresTicketPolicyStore } from './ticket-policy'
for (const version of testUrl ? [2, 3, 4] : [])
  test(`v${version} readable migration uses independent policy without blobs and prefers it to uploaded config`, async () => {
    const world = await legacyTickets()
    const independent = 'https://github.com/acme/independent'
    const uploaded = 'https://github.com/acme/uploaded'
    try {
      await world.sql.unsafe(
        'DROP TABLE ab_ticket_blockers, ab_ticket_comments, ab_tickets, ab_ticket_schema_migrations',
      )
      await world.sql.unsafe(
        version === 2
          ? TICKET_SCHEMA_V2_DDL
          : version === 3
            ? TICKET_SCHEMA_V3_DDL
            : TICKET_SCHEMA_V4_DDL,
      )
      await world.sql`INSERT INTO ab_ticket_schema_migrations VALUES (true,${version},${version === 2 ? TICKET_SCHEMA_V2_CHECKSUM : version === 3 ? TICKET_SCHEMA_V3_CHECKSUM : TICKET_SCHEMA_V4_CHECKSUM},${CONTRACT_T0})`
      await world.sql`INSERT INTO project_journal (seq, repo, action, actor, ts) VALUES (nextval('project_journal_seq'), ${independent}, 'added', 'fixture', ${CONTRACT_T0})`
      await world.project(uploaded, 'OLD')
      const policies = new PostgresTicketPolicyStore(world.sql)
      for (const repo of [independent, uploaded]) {
        await policies.put(
          repo,
          {
            version: 1,
            tickets: {
              source: 'hosted',
              teamKey: 'NEW',
              triageState: 'triage',
              readyState: 'ready',
              claimedState: 'doing',
              doneState: 'done',
              createState: 'triage',
              proposalState: 'triage',
            },
          },
          'fixture',
        )
        await world.sql`INSERT INTO ab_tickets (repo,id,creation_key,title,body,state,labels,created_at,updated_at) VALUES (${repo},'ticket-old',NULL,'Original','Body','triage',ARRAY[]::text[],${CONTRACT_T0},${CONTRACT_T0})`
      }
      if (version >= 3) await world.sql`UPDATE ab_tickets SET revision = 9007199254740993`
      if (version === 4)
        await world.sql`INSERT INTO ab_ticket_states (repo,name,about) VALUES (${independent},'icebox','Deferred work')`
      await migratePostgres(world.url)
      await migratePostgres(world.url)
      const rows =
        await world.sql`SELECT repo, readable_id, revision::text AS revision FROM ab_tickets ORDER BY repo`
      expect(rows.map((row: { readable_id: string }) => row.readable_id)).toEqual([
        'NEW-1',
        'NEW-1',
      ])
      expect(rows.map((row: { revision: string }) => row.revision)).toEqual(
        Array(2).fill(version >= 3 ? '9007199254740993' : '1'),
      )
      if (version === 4)
        expect(
          (
            await world.sql`SELECT about FROM ab_ticket_states WHERE repo = ${independent} AND name = 'icebox'`
          )[0].about,
        ).toBe('Deferred work')
      expect(world.reads).toEqual([])
    } finally {
      await world.cleanup()
    }
  })
import {
  TICKET_SCHEMA_V4_DDL,
  TICKET_SCHEMA_V4_CHECKSUM,
  TICKET_SCHEMA_V3_DDL,
  TICKET_SCHEMA_V3_CHECKSUM,
  TICKET_SCHEMA_V2_DDL,
  TICKET_SCHEMA_V2_CHECKSUM,
  TICKET_SCHEMA_CHECKSUM,
  TICKET_SCHEMA_VERSION,
} from './schema'

const mkdtemp = ownTempDirectories(afterEach)

if (testUrl)
  test.each([2, 3])(
    'ticket v%i upgrade backfills exact states and empty persisted policy roles, and rejects structural drift',
    async (version) => {
      const world = await schemaHarness()
      const sql = new SQL(world.url)
      try {
        await migratePostgres(world.url)
        await sql`DROP TABLE ab_ticket_states, ab_ticket_counters`
        await sql`ALTER TABLE ab_tickets DROP COLUMN readable_id, DROP COLUMN ticket_number, DROP COLUMN kind, DROP COLUMN target_id`
        await sql`ALTER TABLE ab_tickets DROP COLUMN revision`
        await sql.unsafe(version === 2 ? TICKET_SCHEMA_V2_DDL : TICKET_SCHEMA_V3_DDL)
        if (version === 3)
          await sql`ALTER TABLE ab_tickets ADD COLUMN revision bigint NOT NULL DEFAULT 1`
        await sql`UPDATE ab_ticket_schema_migrations SET version = ${version}, checksum = ${version === 2 ? TICKET_SCHEMA_V2_CHECKSUM : version === 3 ? TICKET_SCHEMA_V3_CHECKSUM : TICKET_SCHEMA_V4_CHECKSUM}`
        const repo = 'https://github.com/acme/v2'
        await sql`INSERT INTO project_journal (seq,repo,action,actor,ts) VALUES (1,${repo},'added','owner',now())`
        await sql`INSERT INTO ab_tickets (repo,id,title,body,state,labels,created_at,updated_at) VALUES (${repo},'old','Title','Body','Former State','{}',now(),now())`
        await sql`INSERT INTO project_ticket_policy (repo,registration,policy,writer,updated_at) VALUES (${repo},1,${{ version: 1, tickets: { source: 'hosted', teamKey: 'ENG', triageState: 'Empty old', readyState: 'READY', claimedState: 'ready', doneState: 'Done', createState: 'Draft', proposalState: 'Proposals' } }},'owner',now())`
        await migratePostgres(world.url)
        await migratePostgres(world.url)
        await assertTicketSchema(sql)
        const rows =
          await sql`SELECT name FROM ab_ticket_states WHERE repo = ${repo} ORDER BY name COLLATE "C"`
        expect(rows.map((r: Row) => r.name)).toEqual([
          'Done',
          'Draft',
          'Empty old',
          'Former State',
          'Proposals',
          'READY',
          'ready',
        ])
        expect((await sql`SELECT id, state FROM ab_tickets WHERE repo = ${repo}`)[0]).toEqual({
          id: 'old',
          state: 'Former State',
        })
        const [marker] = await sql`SELECT version, checksum FROM ab_ticket_schema_migrations`
        expect(Number(marker.version)).toBe(TICKET_SCHEMA_VERSION)
        expect(marker.checksum).toBe(TICKET_SCHEMA_CHECKSUM)
        await sql`ALTER TABLE ab_ticket_states DROP CONSTRAINT ab_ticket_states_about_check`
        await expect(assertTicketSchema(sql)).rejects.toThrow('constraints')
      } finally {
        await sql.close()
        await world.cleanup()
      }
    },
  )

if (testUrl)
  test('populated frozen ticket v5 upgrades idempotently without changing revisions or relations', async () => {
    const world = await schemaHarness()
    try {
      await migratePostgres(world.url)
      const sql = new SQL(world.url)
      try {
        await sql`ALTER TABLE ab_tickets DROP COLUMN kind, DROP COLUMN target_id`
        await sql`UPDATE ab_ticket_schema_migrations SET version = 5, checksum = ${FROZEN.ticket.get(5)!.checksum}`
        await sql`INSERT INTO ab_tickets (repo,id,readable_id,ticket_number,title,body,state,labels,created_at,updated_at,revision) VALUES ('repo','internal','ENG-1',1,'Existing','Body','done',ARRAY[]::text[],now(),now(),42)`
        await sql`INSERT INTO ab_ticket_comments VALUES ('repo','internal',1,'Comment',now())`
        await migratePostgres(world.url)
        const before = await sql`SELECT * FROM ab_tickets`
        expect(before[0]).toMatchObject({
          kind: 'work',
          target_id: null,
          readable_id: 'ENG-1',
          revision: '42',
        })
        await migratePostgres(world.url)
        expect(await sql`SELECT * FROM ab_tickets`).toEqual(before)
        expect((await sql`SELECT body FROM ab_ticket_comments`)[0].body).toBe('Comment')
      } finally {
        await sql.close()
      }
    } finally {
      await world.cleanup()
    }
  })

if (testUrl)
  test.each([
    'ALTER TABLE ab_tickets DROP COLUMN kind',
    'ALTER TABLE ab_tickets DROP CONSTRAINT ab_tickets_kind_check',
    'ALTER TABLE ab_tickets DROP CONSTRAINT ab_tickets_target_fk',
    'ALTER TABLE ab_tickets DROP CONSTRAINT ab_tickets_target_self_check',
    'DROP INDEX ab_tickets_target_idx',
  ])('ticket tree structural guard refuses %s', async (ddl) => {
    const world = await schemaHarness()
    const sql = new SQL(world.url)
    try {
      await migratePostgres(world.url)
      await sql.unsafe(ddl)
      await expect(assertTicketSchema(sql)).rejects.toThrow('missing or mismatched')
    } finally {
      await sql.close()
      await world.cleanup()
    }
  })

test.skipIf(!testUrl)(
  'fresh and v19-upgraded schemas deliver the bounded project admission index',
  async () => {
    const { SCHEMA_V19_CHECKSUM } = await import('./schema')
    const world = await schemaHarness()
    const sql = new SQL(world.url)
    try {
      await migratePostgres(world.url)
      const index = () =>
        sql`SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'project_journal_repo_seq'`
      expect(String((await index())[0].indexdef)).toEndWith('(repo, seq DESC)')
      await sql`DROP INDEX project_journal_repo_seq`
      await expect(assertSchema(sql)).rejects.toThrow('project admission index')
      await sql`UPDATE ab_schema_migrations SET version = 19, checksum = ${SCHEMA_V19_CHECKSUM}`
      await migratePostgres(world.url)
      expect(String((await index())[0].indexdef)).toEndWith('(repo, seq DESC)')
      await assertSchema(sql)
    } finally {
      await sql.close()
      await world.cleanup()
    }
  },
)

if (testUrl)
  test.each(['dispatcher_credentials_expiry', 'dispatcher_credentials_revoked'])(
    'schema guard refuses missing cron index %s',
    async (index) => {
      const world = await schemaHarness()
      const sql = new SQL(world.url)
      try {
        await migratePostgres(world.url)
        await sql.unsafe(`DROP INDEX ${index}`)
        await expect(assertSchema(sql)).rejects.toThrow(
          'dispatcher credential index is missing or mismatched',
        )
      } finally {
        await sql.close()
        await world.cleanup()
      }
    },
  )
