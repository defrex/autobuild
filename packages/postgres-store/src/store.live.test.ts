import { describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import {
  MemoryBlobStore,
  StreamBatchTooLargeError,
  describeBuildStoreContract,
  harvestStartedWrite,
  messagePostedWrite,
  sampleBuildInput,
  sampleEventWrite,
  type BlobStore,
  type StreamPart,
} from '@defrex/autobuild/plugin-sdk'
import { migratePostgres } from './schema'
import { EVENT_WAIT_POLL_MS, PostgresBuildStore, openPostgresBuildStore } from './store'

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

async function runWorker(
  url: string,
  mode: 'build' | 'repo' | 'conditional',
  resource: string,
  count: number,
): Promise<string> {
  const child = Bun.spawn(
    [
      process.execPath,
      `${import.meta.dir}/testing/concurrent-worker.ts`,
      url,
      mode,
      resource,
      String(count),
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`concurrency worker failed (${exitCode}): ${stderr}`)
  return stdout.trim()
}

if (testUrl) {
  describeBuildStoreContract('PostgreSQL', async (options) => {
    const database = await isolatedDatabase()
    const store = await openPostgresBuildStore(database.url, new MemoryBlobStore(), {
      ...(options?.clock ? { clock: options.clock } : {}),
      ...(options?.retention ? { retention: options.retention } : {}),
    })
    return { store, cleanup: database.cleanup }
  })

  describe('PostgreSQL durability and concurrency', () => {
    test('concurrent repository ensures create one absent row and return the winning record', async () => {
      const database = await isolatedDatabase()
      // Each independent contender needs one connection, not a default pool.
      // The schema was migrated above; keep the eight-way database race bounded
      // even on PostgreSQL instances with the default max_connections limit.
      const stores = Array.from(
        { length: 8 },
        () =>
          new PostgresBuildStore(new SQL(database.url, { max: 1 }), {
            blobs: new MemoryBlobStore(),
          }),
      )
      const assertionSql = new SQL(database.url, { max: 1 })
      try {
        const records = await Promise.all(stores.map((store) => store.ensureRepo('acme/new-repo')))
        expect(records).toHaveLength(stores.length)
        expect(
          records.every((record) => JSON.stringify(record) === JSON.stringify(records[0])),
        ).toBe(true)

        const rows = await assertionSql`SELECT * FROM repo_streams WHERE repo = ${'acme/new-repo'}`
        expect(rows).toHaveLength(1)
        const createdAt = rows[0]?.created_at
        const updatedAt = rows[0]?.updated_at
        expect(records[0]).toEqual({
          repo: 'acme/new-repo',
          createdAt:
            createdAt instanceof Date
              ? createdAt.toISOString()
              : new Date(String(createdAt)).toISOString(),
          updatedAt:
            updatedAt instanceof Date
              ? updatedAt.toISOString()
              : new Date(String(updatedAt)).toISOString(),
        })
      } finally {
        await assertionSql.close()
        await Promise.all(stores.map((store) => store.close()))
        await database.cleanup()
      }
    })

    test('concurrent creation of one absent build has one winner and normalized losers', async () => {
      const database = await isolatedDatabase()
      // Each independent contender needs one connection, not a default pool.
      // The schema was migrated above; keep the eight-way database race bounded
      // even on PostgreSQL instances with the default max_connections limit.
      const stores = Array.from(
        { length: 8 },
        () =>
          new PostgresBuildStore(new SQL(database.url, { max: 1 }), {
            blobs: new MemoryBlobStore(),
          }),
      )
      const assertionSql = new SQL(database.url, { max: 1 })
      try {
        const results = await Promise.allSettled(
          stores.map((store) => store.createBuild(sampleBuildInput('new-shared-build'))),
        )
        const fulfilled = results.filter((result) => result.status === 'fulfilled')
        const rejected = results.filter((result) => result.status === 'rejected')
        expect(fulfilled).toHaveLength(1)
        expect(rejected).toHaveLength(stores.length - 1)
        expect(rejected.map((result) => result.reason?.message)).toEqual(
          Array.from(
            { length: stores.length - 1 },
            () => 'build "new-shared-build" already exists',
          ),
        )

        const rows = await assertionSql`SELECT * FROM builds WHERE slug = ${'new-shared-build'}`
        expect(rows).toHaveLength(1)
        expect(rows[0]?.slug).toBe('new-shared-build')
        expect(rows[0]?.repo).toBe(sampleBuildInput('new-shared-build').repo)
      } finally {
        await assertionSql.close()
        await Promise.all(stores.map((store) => store.close()))
        await database.cleanup()
      }
    })

    test('fresh independent instances see prior writes and serialize streams', async () => {
      const database = await isolatedDatabase()
      const blobs = new MemoryBlobStore()
      const first = await openPostgresBuildStore(database.url, blobs)
      const second = await openPostgresBuildStore(database.url, blobs)
      try {
        await first.createBuild(sampleBuildInput('shared'))
        await first.ensureRepo('acme/shared')
        await Promise.all(
          Array.from({ length: 20 }, (_, index) =>
            (index % 2 ? first : second).append('shared', sampleEventWrite(String(index))),
          ),
        )
        await Promise.all(
          Array.from({ length: 20 }, (_, index) =>
            (index % 2 ? first : second).appendRepo('acme/shared', {
              actor: { kind: 'human', user: 'operator' },
              type: 'dispatcher.pause-set',
              payload: { enabled: index % 2 === 0 },
            }),
          ),
        )
        const contenders = await Promise.all([
          first.appendIfCurrent('shared', 20, sampleEventWrite('winner-a')),
          second.appendIfCurrent('shared', 20, sampleEventWrite('winner-b')),
        ])
        expect(contenders.filter(Boolean)).toHaveLength(1)
        expect((await second.getEvents('shared')).map((event) => event.seq)).toEqual(
          Array.from({ length: 21 }, (_, index) => index + 1),
        )
        expect((await first.getRepoEvents('acme/shared')).map((event) => event.seq)).toEqual(
          Array.from({ length: 20 }, (_, index) => index + 1),
        )
        await first.close()
        const fresh = await openPostgresBuildStore(database.url, blobs)
        try {
          expect(await fresh.getBuild('shared')).not.toBeNull()
        } finally {
          await fresh.close()
        }
      } finally {
        await second.close()
        await database.cleanup()
      }
    })

    test('separate processes serialize build/repository appends and conditional races', async () => {
      const database = await isolatedDatabase()
      const store = await openPostgresBuildStore(database.url, new MemoryBlobStore())
      try {
        await store.createBuild(sampleBuildInput('process-shared'))
        await store.ensureRepo('acme/process-shared')
        await Promise.all([
          runWorker(database.url, 'build', 'process-shared', 15),
          runWorker(database.url, 'build', 'process-shared', 15),
          runWorker(database.url, 'repo', 'acme/process-shared', 15),
          runWorker(database.url, 'repo', 'acme/process-shared', 15),
        ])
        expect((await store.getEvents('process-shared')).map((event) => event.seq)).toEqual(
          Array.from({ length: 30 }, (_, index) => index + 1),
        )
        expect(
          (await store.getRepoEvents('acme/process-shared')).map((event) => event.seq),
        ).toEqual(Array.from({ length: 30 }, (_, index) => index + 1))
        const conditional = await Promise.all([
          runWorker(database.url, 'conditional', 'process-shared', 30),
          runWorker(database.url, 'conditional', 'process-shared', 30),
        ])
        expect(conditional.sort()).toEqual(['stale', 'winner'])
      } finally {
        await store.close()
        await database.cleanup()
      }
    })

    // Nominal bound (AUT-334): the 2 s assertion covers the poll-interval
    // worst case — the 1 s EVENT_WAIT_POLL_MS poll plus up to ~1 s of query
    // and CI scheduler slack — not a hard one-second delivery guarantee.
    test('a held event read observes a cross-connection append within the one-poll worst-case budget (AUT-334)', async () => {
      const database = await isolatedDatabase()
      const blobs = new MemoryBlobStore()
      const reader = await openPostgresBuildStore(database.url, blobs)
      const writer = await openPostgresBuildStore(database.url, blobs)
      try {
        await reader.createBuild(sampleBuildInput('evt-wait-x'))
        await reader.ensureRepo('acme/evt-wait-x')

        // Build events: instance A holds, instance B appends; A resolves with
        // the event well under the bound (the 1 s poll plus query slack).
        const pendingBuild = reader.getEvents('evt-wait-x', 0, { waitSeconds: 5 })
        await Bun.sleep(200)
        const event = await writer.append('evt-wait-x', sampleEventWrite('cross'))
        const started = Date.now()
        expect(await pendingBuild).toEqual([event])
        expect(Date.now() - started).toBeLessThan(2_000)

        // Repository journal, symmetric.
        const pendingRepo = reader.getRepoEvents('acme/evt-wait-x', 0, { waitSeconds: 5 })
        await Bun.sleep(200)
        const repoEvent = await writer.appendRepo('acme/evt-wait-x', harvestStartedWrite('h_x'))
        const repoStarted = Date.now()
        expect(await pendingRepo).toEqual([repoEvent])
        expect(Date.now() - repoStarted).toBeLessThan(2_000)
      } finally {
        await reader.close()
        await writer.close()
        await database.cleanup()
      }
    })

    test('EVENT_WAIT_POLL_MS pins the one-second hosted poll interval (AUT-334)', () => {
      expect(EVENT_WAIT_POLL_MS).toBe(1000)
    })

    // Session events, same budget (AUT-381): the held read starts with an
    // empty initial poll (sinceSeq past session.created), the writer appends
    // at ~500 ms, and a 1 s poll first observes it at ~1000 ms. The ≥ 900 ms
    // lower bound fails a regression to the 25 ms stream default (which
    // resolves at ~525 ms); the < 2 s upper bound is the same one-poll
    // worst-case convention as the AUT-334 test above (1 s poll plus query
    // and CI scheduler slack), not a hard delivery guarantee.
    test('a held session-event read observes a cross-connection append within the one-poll worst-case budget (AUT-381)', async () => {
      const database = await isolatedDatabase()
      const blobs = new MemoryBlobStore()
      const reader = await openPostgresBuildStore(database.url, blobs)
      const writer = await openPostgresBuildStore(database.url, blobs)
      try {
        const session = await reader.createSession({
          repo: 'acme/evt-wait-x',
          operator: 'operator',
          title: 'sess-wait-x',
        })
        // session.created (seq 1) auto-appends; warm the path once so the
        // held read's initial poll hits a pooled connection.
        expect((await reader.getSessionEvents(session.id)).map((event) => event.seq)).toEqual([1])

        const started = Date.now()
        const pendingSession = reader.getSessionEvents(session.id, 1, { waitSeconds: 5 })
        await Bun.sleep(500)
        const event = await writer.appendSessionEvent(session.id, messagePostedWrite('cross'))
        expect(await pendingSession).toEqual([event])
        expect(Date.now() - started).toBeGreaterThanOrEqual(900)
        expect(Date.now() - started).toBeLessThan(2_000)
      } finally {
        await reader.close()
        await writer.close()
        await database.cleanup()
      }
    })

    test('a cross-connection append inside a close prepare window is included in the finalized artifact (AUT-348)', async () => {
      const database = await isolatedDatabase()
      // A shared gated blob store: instance A's close suspends inside its
      // prepare-phase blobs.put until instance B's append has committed —
      // forced ordering, no timing (AUT-348).
      const backing = new MemoryBlobStore()
      let signalEntered!: () => void
      let release!: () => void
      const entered = new Promise<void>((resolve) => {
        signalEntered = resolve
      })
      const gateOpen = new Promise<void>((resolve) => {
        release = resolve
      })
      let armed = true
      const blobs: BlobStore = {
        put: async (hash, bytes) => {
          if (armed) {
            armed = false
            signalEntered()
            await gateOpen
          }
          await backing.put(hash, bytes)
        },
        get: (hash) => backing.get(hash),
      }
      const a = await openPostgresBuildStore(database.url, blobs)
      const b = await openPostgresBuildStore(database.url, blobs)
      try {
        await a.createBuild(sampleBuildInput('st-pg-close-race'))
        const stream = await a.createStream({ kind: 'build', build: 'st-pg-close-race' }, 'turn')
        await a.appendStreamParts(stream.id, [{ type: 'start', messageId: 'm' }])
        await a.appendStreamParts(stream.id, [{ type: 'text-start', id: 't' }])

        const closing = a.closeStream(stream.id, 'completed')
        await entered
        const chunk = await b.appendStreamParts(stream.id, [
          { type: 'text-delta', id: 't', delta: 'late' },
        ])
        expect(chunk.seq).toBe(3) // B's append was acknowledged before the close commits
        release()
        const record = await closing
        expect(record.status).toBe('closed')

        // The commit's re-read-under-lock re-assembled from the newer chunk
        // set: all three acknowledged appends are in chunkCount and the doc.
        const artifact = await a.getArtifact('st-pg-close-race', `stream:${stream.id}`)
        expect(artifact?.meta.metadata).toMatchObject({ chunkCount: 3 })
        const document = JSON.parse(new TextDecoder().decode(artifact!.content)) as Array<{
          parts: Array<{ type: string; text?: string; state?: string }>
        }>
        expect(document[0]?.parts).toContainEqual({
          type: 'text',
          text: 'late',
          state: 'streaming',
        })
      } finally {
        await a.close()
        await b.close()
        await database.cleanup()
      }
    })

    test('a close held on stream A does not serialize an append on stream B (AUT-348)', async () => {
      const database = await isolatedDatabase()
      const backing = new MemoryBlobStore()
      let signalEntered!: () => void
      let release!: () => void
      const entered = new Promise<void>((resolve) => {
        signalEntered = resolve
      })
      const gateOpen = new Promise<void>((resolve) => {
        release = resolve
      })
      let armed = true
      const blobs: BlobStore = {
        put: async (hash, bytes) => {
          if (armed) {
            armed = false
            signalEntered()
            await gateOpen
          }
          await backing.put(hash, bytes)
        },
        get: (hash) => backing.get(hash),
      }
      const store = await openPostgresBuildStore(database.url, blobs)
      try {
        await store.createBuild(sampleBuildInput('st-pg-two-streams'))
        const a = await store.createStream({ kind: 'build', build: 'st-pg-two-streams' }, 'a')
        const b = await store.createStream({ kind: 'build', build: 'st-pg-two-streams' }, 'b')
        await store.appendStreamParts(a.id, [{ type: 'start', messageId: 'am' }])

        const closing = store.closeStream(a.id, 'completed')
        await entered // A's close is suspended inside its prepare-phase put
        const chunk = await store.appendStreamParts(b.id, [{ type: 'start', messageId: 'bm' }])
        expect(chunk.seq).toBe(1)
        release()
        const record = await closing
        expect(record.status).toBe('closed')
        expect((await store.readStream(b.id)).chunks).toHaveLength(1)
      } finally {
        await store.close()
        await database.cleanup()
      }
    })

    // Local-side adapters validate the batch and check the ceiling BEFORE
    // resolving the stream, so an invalid batch on an unknown stream reports
    // the validation or ceiling error — not unknown-stream. The remote server
    // deliberately runs the opposite order (SPEC §7.6); that side is pinned
    // in core's remote.test.ts. Both orders must write nothing. Runs only
    // where AB_POSTGRES_TEST_URL is set — the unit verify step does not
    // exercise it; the order here is otherwise fixed by the SPEC §7.6 text.
    test('append rejection precedence: an invalid or oversized batch on an unknown stream rejects before any lookup and writes nothing', async () => {
      const database = await isolatedDatabase()
      const store = await openPostgresBuildStore(database.url, new MemoryBlobStore())
      try {
        await store.createBuild(sampleBuildInput('st-pg-ghost'))

        const empty = await store.appendStreamParts('st_ghost', []).catch((e: unknown) => e)
        expect(empty).toBeInstanceOf(Error)
        expect((empty as Error).message).toContain('stream parts must be a nonempty array')

        const noType = await store
          .appendStreamParts('st_ghost', [{ delta: 'x' } as unknown as StreamPart])
          .catch((e: unknown) => e)
        expect(noType).toBeInstanceOf(Error)
        expect((noType as Error).message).toContain('must carry a nonempty string "type"')
        expect((noType as Error).message).not.toContain('unknown stream')

        // Shape-valid (a text-delta with a long delta) so the ceiling — not
        // part validation — is the rejection observed.
        const oversized = await store
          .appendStreamParts('st_ghost', [
            { type: 'text-delta', id: 't', delta: 'x'.repeat(1_048_600) },
          ])
          .catch((e: unknown) => e)
        expect(oversized).toBeInstanceOf(StreamBatchTooLargeError)
        expect((oversized as Error).message).toContain('1048576')
        expect((oversized as Error).message).not.toContain('unknown stream')

        expect(await store.getStream('st_ghost')).toBeNull()
      } finally {
        await store.close()
        await database.cleanup()
      }
    })
  })

  describe('PostgreSQL reducer snapshots: additive table', () => {
    const scope = { kind: 'build', slug: 'snap-live' } as const

    test('a database without the snapshot table serves full replay with no errors, then gains it on migrate', async () => {
      const database = await isolatedDatabase()
      const raw = new SQL(database.url)
      const store = await openPostgresBuildStore(database.url, new MemoryBlobStore())
      try {
        await store.createBuild(sampleBuildInput('snap-live'))
        await store.append('snap-live', sampleEventWrite('one'))
        await raw.unsafe('DROP TABLE reducer_snapshots')
        // The frozen-schema assertion does not know the table: a store opens
        // against a database that lacks it.
        const second = await openPostgresBuildStore(database.url, new MemoryBlobStore())
        expect(await second.getReducerSnapshot(scope, 'build', 1)).toBeNull()
        expect(
          await second.putReducerSnapshot(scope, 'build', { version: 1, cursor: 1, state: {} }),
        ).toBe(false)
        expect((await second.getEvents('snap-live')).length).toBe(1)
        await second.close()
        // The failure is not cached: once the table exists the same store works.
        await migratePostgres(database.url)
        expect(
          await store.putReducerSnapshot(scope, 'build', {
            version: 1,
            cursor: 1,
            state: { a: 1 },
          }),
        ).toBe(true)
        expect(await store.getReducerSnapshot(scope, 'build', 1)).toEqual({
          version: 1,
          cursor: 1,
          state: { a: 1 },
        })
      } finally {
        await store.close()
        await raw.close()
        await database.cleanup()
      }
    })

    test('the migration is idempotent and leaves stored snapshots untouched', async () => {
      const database = await isolatedDatabase()
      const store = await openPostgresBuildStore(database.url, new MemoryBlobStore())
      try {
        await store.createBuild(sampleBuildInput('snap-live'))
        await store.append('snap-live', sampleEventWrite('one'))
        await store.putReducerSnapshot(scope, 'build', { version: 1, cursor: 1, state: [1, 2] })
        await migratePostgres(database.url)
        await migratePostgres(database.url)
        expect((await store.getReducerSnapshot(scope, 'build', 1))?.state).toEqual([1, 2])
      } finally {
        await store.close()
        await database.cleanup()
      }
    })
  })
} else {
  describe('PostgreSQL live contract', () => {
    test.skip('set AB_POSTGRES_TEST_URL to run the PostgreSQL contract and concurrency suite', () => {})
  })
}

if (testUrl)
  test('current ticket projections preserve missing-source refs and arbitrary asset keys without ticket tables', async () => {
    const database = await isolatedDatabase()
    const sql = new SQL(database.url)
    const store = await openPostgresBuildStore(database.url, new MemoryBlobStore())
    try {
      await sql.unsafe(
        'DROP TABLE ab_ticket_blockers, ab_ticket_comments, ab_tickets, ab_ticket_counters, ab_ticket_schema_migrations',
      )
      await store.createBuild({
        slug: 'missing-source',
        repo: 'one',
        ticket: { source: 'hosted', id: 'ticket-legacy' },
      })
      expect((await store.getBuild('missing-source'))?.ticket?.id).toBe('ticket-legacy')
      const asset = await store.putTicketAsset('one', 'file-1', {
        kind: 'reference',
        name: 'proof',
        layout: 'file',
        entries: [{ type: 'file', path: 'proof', content: new TextEncoder().encode('proof') }],
      })
      expect(asset.ticketId).toBe('file-1')
      expect(
        (await store.getTicketAsset('one', 'file-1', 'reference', 'proof'))?.meta.ticketId,
      ).toBe('file-1')
      expect(await store.listTicketAssets('one', 'file-1')).toHaveLength(1)
      expect((await store.removeTicketAsset('one', 'file-1', 'reference', 'proof'))?.ticketId).toBe(
        'file-1',
      )
    } finally {
      await store.close()
      await sql.close()
      await database.cleanup()
    }
  })

if (testUrl)
  test('listing hosted build refs uses a bounded query count across projects and exact raw history remains intact', async () => {
    const database = await isolatedDatabase()
    const sql = new SQL(database.url)
    const statements: string[] = []
    function tracked<T extends SQL>(connection: T): T {
      return new Proxy(connection, {
        apply(target, _receiver, args) {
          statements.push((args[0] as TemplateStringsArray).join('?'))
          return Reflect.apply(target, target, args)
        },
        get(target, key) {
          if (key === 'reserve') return async () => tracked(await target.reserve())
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    }
    const store = new PostgresBuildStore(tracked(sql), { blobs: new MemoryBlobStore() })
    try {
      const now = new Date().toISOString()
      for (const repo of ['one', 'two']) {
        await sql`INSERT INTO ab_tickets (repo,id,readable_id,ticket_number,title,body,state,created_at,updated_at)
        VALUES (${repo},'ticket-legacy',${repo === 'one' ? 'ENG-1' : 'OTHER-1'},1,'Title','Body','Ready',${now},${now})`
        for (let i = 0; i < 20; i++) {
          const ticket = {
            source: 'hosted',
            id: i % 2 ? (repo === 'one' ? 'eng-1' : 'other-1') : 'ticket-legacy',
          }
          await sql`INSERT INTO builds (slug,repo,ticket,created_at,updated_at) VALUES (${`${repo}-${i}`},${repo},${ticket},${now},${now})`
        }
      }
      await sql`INSERT INTO builds (slug,repo,ticket,created_at,updated_at) VALUES ('foreign-source','one',${{ source: 'linear', id: 'ticket-legacy' }},${now},${now}), ('missing','one',${{ source: 'hosted', id: 'missing' }},${now},${now})`
      const before = await sql`SELECT slug,ticket FROM builds ORDER BY slug`
      statements.length = 0
      const first = await store.listBuilds()
      expect(statements.length).toBe(3) // optional schema discovery + one joined listing
      expect(
        first.filter((r) => r.slug.startsWith('one-')).every((r) => r.ticket?.id === 'ENG-1'),
      ).toBe(true)
      expect(
        first.filter((r) => r.slug.startsWith('two-')).every((r) => r.ticket?.id === 'OTHER-1'),
      ).toBe(true)
      expect(first.find((r) => r.slug === 'foreign-source')?.ticket?.id).toBe('ticket-legacy')
      expect(first.find((r) => r.slug === 'missing')?.ticket?.id).toBe('missing')
      statements.length = 0
      expect(await store.listBuilds()).toEqual(first)
      expect(statements.length).toBe(1)
      expect(await sql`SELECT slug,ticket FROM builds ORDER BY slug`).toEqual(before)
    } finally {
      await store.close()
      await database.cleanup()
    }
  })

if (testUrl)
  test('fresh Postgres connections read only value deltas and repair corrupt or ahead rows', async () => {
    const database = await isolatedDatabase()
    const blobs = new MemoryBlobStore()
    const writer = await openPostgresBuildStore(database.url, blobs)
    const reader = await openPostgresBuildStore(database.url, blobs)
    const sql = new SQL(database.url)
    try {
      await writer.createBuild(sampleBuildInput('value-cost'))
      await writer.ensureRepo('value-cost')
      const event = sampleEventWrite()
      // Repeat valid facts at the SQL boundary so seeding does not dominate the test.
      await sql`INSERT INTO events(build,seq,ts,actor,type,payload) SELECT 'value-cost',n,now(),${JSON.stringify(event.actor)}::jsonb,${event.type},${JSON.stringify(event.payload)}::jsonb FROM generate_series(1,3000) n`
      await sql`INSERT INTO repo_events(repo,seq,ts,actor,type,payload) SELECT 'value-cost',n,now(),' {"kind":"human","user":"operator"}'::jsonb,'dispatcher.intake-set','{"enabled":true}'::jsonb FROM generate_series(1,3000) n`
      const scopes = [
        { kind: 'build' as const, slug: 'value-cost' },
        { kind: 'repo' as const, repo: 'value-cost' },
      ]
      for (const scope of scopes)
        await writer.getReducerValue(scope, {
          reducer: scope.kind === 'build' ? 'setupStreak' : 'effectiveConfig',
        })
      const costs = { events: 0, metadata: 0 }
      const run = Reflect.get(reader, 'run').bind(reader)
      Reflect.set(reader, 'run', (body: (query: unknown) => Promise<unknown>) =>
        run((q: unknown) =>
          body(
            new Proxy(q as object, {
              get(target, key) {
                const method = Reflect.get(target, key)
                if (key === 'unsafe' && typeof method === 'function')
                  return (...args: unknown[]) =>
                    Promise.resolve(Reflect.apply(method, target, args)).then((rows) => {
                      const events = /SELECT \* FROM (?:repo_)?events\b/i.test(String(args[0]))
                      costs[events ? 'events' : 'metadata'] += Array.isArray(rows) ? rows.length : 0
                      return rows
                    })
                return typeof method === 'function' ? method.bind(target) : method
              },
              apply(target, thisArg, args) {
                const result = Reflect.apply(target as CallableFunction, thisArg, args)
                const eventQuery = /SELECT \* FROM (?:repo_)?events\b/i.test(args[0].join(' '))
                return Promise.resolve(result).then((rows) => {
                  costs[eventQuery ? 'events' : 'metadata'] += Array.isArray(rows) ? rows.length : 0
                  return rows
                })
              },
            }),
          ),
        ),
      )
      const { resolveReducerValue } = await import('@defrex/autobuild/store-adapter')
      for (const scope of scopes) {
        const request = { reducer: scope.kind === 'build' ? 'setupStreak' : 'effectiveConfig' }
        costs.events = 0
        costs.metadata = 0
        await reader.getReducerValue(scope, request)
        expect(costs.events).toBe(0)
        expect(costs.metadata).toBeLessThanOrEqual(4)
        if (scope.kind === 'build') await writer.append(scope.slug, sampleEventWrite())
        else
          await writer.appendRepo(scope.repo, {
            actor: { kind: 'human', user: 'operator' },
            type: 'dispatcher.intake-set',
            payload: { enabled: true },
          })
        costs.events = 0
        costs.metadata = 0
        const advanced = await reader.getReducerValue(scope, request)
        expect(advanced.cursor).toBe(3001)
        expect(costs.events).toBe(1)
        expect(costs.metadata).toBeLessThanOrEqual(5)
        const { key } = resolveReducerValue(scope, request)
        for (const cursor of [3001, 99999]) {
          await sql`UPDATE reducer_snapshots SET cursor=${cursor},state='{"invalid":true}'::jsonb WHERE reducer=${key}`
          expect(await reader.getReducerValue(scope, request)).toEqual(advanced)
          costs.events = 0
          expect(await reader.getReducerValue(scope, request)).toEqual(advanced)
          expect(costs.events).toBe(0)
        }
        await sql`DELETE FROM reducer_snapshots WHERE reducer=${key}`
        expect(await reader.getReducerValue(scope, request)).toEqual(advanced)
        await sql`UPDATE reducer_snapshots SET state='"not JSON"'::jsonb WHERE reducer=${key}`
        expect(await reader.getReducerValue(scope, request)).toEqual(advanced)
        costs.events = 0
        await reader.getReducerValue(scope, request)
        expect(costs.events).toBe(0)
        const originalPut = Reflect.get(reader, 'putSnapshot').bind(reader)
        let release!: () => void
        let entered!: () => void
        const started = new Promise<void>((resolve) => {
          entered = resolve
        })
        const gate = new Promise<void>((resolve) => {
          release = resolve
        })
        Reflect.set(
          reader,
          'putSnapshot',
          async (
            target: import('@defrex/autobuild/store-adapter').SnapshotScope,
            name: string,
            snapshot: import('@defrex/autobuild/store-adapter').ReducerSnapshot,
          ) => {
            entered()
            await gate
            return originalPut(target, name, snapshot)
          },
        )
        if (scope.kind === 'build') await writer.append(scope.slug, sampleEventWrite())
        else
          await writer.appendRepo(scope.repo, {
            actor: { kind: 'human', user: 'operator' },
            type: 'dispatcher.intake-set',
            payload: { enabled: true },
          })
        const delayed = reader.getReducerValue(scope, request)
        await started
        if (scope.kind === 'build') await writer.append(scope.slug, sampleEventWrite())
        else
          await writer.appendRepo(scope.repo, {
            actor: { kind: 'human', user: 'operator' },
            type: 'dispatcher.intake-set',
            payload: { enabled: true },
          })
        const winner = await writer.getReducerValue(scope, request)
        release()
        expect((await delayed).cursor).toBe(3002)
        expect(winner.cursor).toBe(3003)
        Reflect.set(reader, 'putSnapshot', originalPut)
        expect(await reader.getReducerValue(scope, request)).toEqual(winner)
        await sql`UPDATE reducer_snapshots SET state='{"corrupt":true}'::jsonb WHERE reducer=${key}`
        const originalRun = Reflect.get(reader, 'run').bind(reader)
        let releaseRepair!: () => void
        let enteredRepair!: () => void
        const repairStarted = new Promise<void>((resolve) => {
          enteredRepair = resolve
        })
        const repairGate = new Promise<void>((resolve) => {
          releaseRepair = resolve
        })
        Reflect.set(reader, 'run', (body: (q: unknown) => Promise<unknown>) =>
          originalRun((q: unknown) =>
            body(
              new Proxy(q as object, {
                apply(target, thisArg, args) {
                  const execute = () => Reflect.apply(target as CallableFunction, thisArg, args)
                  if (String(args[0][0]).startsWith('UPDATE reducer_snapshots')) {
                    enteredRepair()
                    return repairGate.then(execute)
                  }
                  return execute()
                },
              }),
            ),
          ),
        )
        const staleRepair = reader.getReducerValue(scope, request)
        await repairStarted
        if (scope.kind === 'build') await writer.append(scope.slug, sampleEventWrite())
        else
          await writer.appendRepo(scope.repo, {
            actor: { kind: 'human', user: 'operator' },
            type: 'dispatcher.intake-set',
            payload: { enabled: true },
          })
        const repairedWinner = await writer.getReducerValue(scope, request)
        releaseRepair()
        expect((await staleRepair).cursor).toBe(3003)
        expect(repairedWinner.cursor).toBe(3004)
        Reflect.set(reader, 'run', originalRun)
        expect(await reader.getReducerValue(scope, request)).toEqual(repairedWinner)
      }
      for (const run of ['parameter-a', 'parameter-b']) {
        const scope = { kind: 'repo' as const, repo: 'value-cost' }
        const request = { reducer: 'openTick', args: { run } }
        await writer.getReducerValue(scope, request)
        costs.events = 0
        costs.metadata = 0
        expect((await reader!.getReducerValue(scope, request)).value).toBe(false)
        expect(costs.events).toBe(0)
        expect(costs.metadata).toBeLessThanOrEqual(4)
      }
    } finally {
      await reader.close()
      await writer.close()
      await sql.close()
      await database.cleanup()
    }
  }, 30_000)
