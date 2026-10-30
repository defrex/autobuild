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
    test('scan cadence is visible through fresh connections without journal writes', async () => {
      const database = await isolatedDatabase()
      const first = await openPostgresBuildStore(database.url, new MemoryBlobStore())
      try {
        await first.ensureRepo('cadence')
        const cadence = {
          scanSeq: 1,
          startedAt: new Date().toISOString(),
          mode: 'admission' as const,
          readinessFingerprint: 'a',
          criteriaFingerprint: 'b',
        }
        await first.putScanCadence('cadence', cadence)
        const second = await openPostgresBuildStore(database.url, new MemoryBlobStore())
        try {
          expect(await second.getScanCadence('cadence')).toEqual(cadence)
          expect(await second.getRepoEvents('cadence')).toEqual([])
          const sql = new SQL(database.url)
          try {
            await sql`UPDATE scan_cadence SET value=to_jsonb(${'broken'}::text) WHERE repo='cadence'`
            expect(await second.getScanCadence('cadence')).toBeNull()
            await second.putScanCadence('cadence', cadence)
            expect(await second.getScanCadence('cadence')).toEqual(cadence)
          } finally {
            await sql.close()
          }
        } finally {
          await second.close()
        }
      } finally {
        await first.close()
        await database.cleanup()
      }
    })

    test('latest artifact metadata never reads blob content', async () => {
      const database = await isolatedDatabase()
      const blobs = new MemoryBlobStore()
      let reads = 0
      const get = blobs.get.bind(blobs)
      blobs.get = async (ref) => {
        reads++
        return get(ref)
      }
      const store = await openPostgresBuildStore(database.url, blobs)
      try {
        await store.createBuild(sampleBuildInput('meta-only'))
        const meta = await store.putArtifact('meta-only', { kind: 'pin', content: 'content' })
        expect(await store.getLatestArtifactMeta('meta-only', 'pin')).toEqual(meta)
        expect(await store.getLatestArtifactMeta('meta-only', 'absent')).toBeNull()
        expect(reads).toBe(0)
        await store.getArtifact('meta-only', 'pin')
        expect(reads).toBe(1)
      } finally {
        await store.close()
        await database.cleanup()
      }
    })

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
    // in the integration step, with AB_POSTGRES_TEST_URL set — unit tests do
    // not exercise it; the order here is otherwise fixed by the SPEC §7.6 text.
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
      expect(await store.listBuildsForRepo('one')).toEqual(await store.listBuilds())
      const rawOwn = await store.listBuildsForRepo('one')
      await store.createBuild({ slug: 'legacy-foreign', repo: 'two' })
      expect(await store.listBuildsForRepo('one')).toEqual(rawOwn)
      expect(await store.listBuildsForRepo("quote'repo")).toEqual([])

      expect((await store.listBuildsForRepo('one'))[0]?.ticket?.id).toBe('ticket-legacy')
      expect(await store.listBuildsForRepo('empty')).toEqual([])

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
    const returned: { statement: string; rows: Record<string, unknown>[]; args: unknown[] }[] = []
    function tracked<T extends SQL>(connection: T): T {
      return new Proxy(connection, {
        apply(target, _receiver, args) {
          const statement = (args[0] as TemplateStringsArray).join('?')
          statements.push(statement)
          const query = Reflect.apply(target, target, args)
          if (!statement.includes('projected_ticket_id')) return query
          return query.then((rows: Record<string, unknown>[]) => {
            returned.push({ statement, rows, args })
            return rows
          })
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
        for (let i = 19; i >= 0; i--) {
          const ticket = {
            source: 'hosted',
            id: i % 2 ? (repo === 'one' ? 'eng-1' : 'other-1') : 'ticket-legacy',
          }
          const created = i < 10 ? new Date(Date.parse(now) - 1000).toISOString() : now
          await sql`INSERT INTO builds (slug,repo,ticket,created_at,updated_at) VALUES (${`${repo}-${i}`},${repo},${ticket},${created},${created})`
        }
      }
      await sql`INSERT INTO builds (slug,repo,ticket,created_at,updated_at) VALUES ('foreign-source','one',${{ source: 'linear', id: 'ticket-legacy' }},${now},${now}), ('missing','one',${{ source: 'hosted', id: 'missing' }},${now},${now})`
      const before = await sql`SELECT slug,ticket FROM builds ORDER BY slug`
      statements.length = 0
      const first = await store.listBuilds()
      expect(statements.length).toBe(3) // optional schema discovery + one joined listing
      expect(first.map((r) => r.slug)).toEqual(
        [...first]
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.slug.localeCompare(b.slug))
          .map((r) => r.slug),
      )
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
      for (const repo of ['empty', 'one', 'two', "quote'repo"]) {
        returned.length = 0
        statements.length = 0
        expect(await store.listBuildsForRepo(repo)).toEqual(first.filter((r) => r.repo === repo))
        expect(statements).toHaveLength(1)
        expect(returned).toHaveLength(1)
        const observation = returned[0]!
        expect(observation.rows.map((r) => r.slug)).toEqual(
          first.filter((r) => r.repo === repo).map((r) => r.slug),
        )
        expect(observation.rows.every((r) => r.repo === repo)).toBe(true)
        // Explain the exact parameterized query executed by the adapter.
        const parts = observation.args[0] as TemplateStringsArray
        const query = parts.reduce((text, part, i) => text + (i ? `$${i}` : '') + part, '')
        const plan = await sql.unsafe(
          `EXPLAIN (ANALYZE, FORMAT JSON) ${query}`,
          observation.args.slice(1) as string[],
        )
        const limits: number[] = []
        const visit = (node: Record<string, unknown>) => {
          if (node['Node Type'] === 'Limit') limits.push(Number(node['Actual Loops']))
          for (const child of (node.Plans ?? []) as Record<string, unknown>[]) visit(child)
        }
        visit(plan[0]['QUERY PLAN'][0].Plan)
        expect(limits.length).toBeGreaterThan(0)
        expect(limits.every((loops) => loops <= observation.rows.length)).toBe(true)
      }
      expect(await store.listBuilds()).toEqual(first)
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
        const originalRun = Reflect.get(reader, 'tx').bind(reader)
        let releaseRepair!: () => void
        let enteredRepair!: () => void
        const repairStarted = new Promise<void>((resolve) => {
          enteredRepair = resolve
        })
        const repairGate = new Promise<void>((resolve) => {
          releaseRepair = resolve
        })
        Reflect.set(reader, 'tx', (body: (q: unknown) => Promise<unknown>) =>
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
        Reflect.set(reader, 'tx', originalRun)
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

if (testUrl)
  test('additive position migration preserves lockstep, concurrent increments and precision', async () => {
    const database = await isolatedDatabase()
    const sql = new SQL(database.url)
    try {
      const marker = await sql`SELECT * FROM ab_schema_migrations`
      // Simulate an existing current-version database before the additive rollout.
      await sql`DROP TABLE repo_change_positions`
      await migratePostgres(database.url)
      const blobs = new MemoryBlobStore()
      const store = await openPostgresBuildStore(database.url, blobs)
      try {
        await store.createBuild({ slug: 'counter-a', repo: 'repo' })
        await store.createBuild({ slug: 'counter-b', repo: 'repo' })
        await Promise.all([
          runWorker(database.url, 'build', 'counter-a', 20),
          runWorker(database.url, 'build', 'counter-b', 20),
        ])
        expect(await store.getRepoChangePosition('repo')).toBe('42')
        await expect(
          sql.begin(async (tx) => {
            await tx`INSERT INTO builds(slug, repo, created_at, updated_at) VALUES ('rollback', 'repo', now(), now())`
            throw new Error('rollback')
          }),
        ).rejects.toThrow('rollback')
        expect(await store.getRepoChangePosition('repo')).toBe('42')
        await sql`UPDATE repo_change_positions SET position = 9007199254740993 WHERE repo = 'repo'`
        expect(await store.getRepoChangePosition('repo')).toBe('9007199254740993')
        await migratePostgres(database.url)
        expect(await store.getRepoChangePosition('repo')).toBe('9007199254740993')
        expect(await sql`SELECT * FROM ab_schema_migrations`).toEqual(marker)
        await sql`INSERT INTO builds(slug, repo, created_at, updated_at) VALUES ('old-writer', 'repo', now(), now())`
        expect(await store.getRepoChangePosition('repo')).toBe('9007199254740994')
        expect(await store.getRepoChangePosition('foreign')).toBe('0')
      } finally {
        await store.close()
      }
    } finally {
      await sql.close()
      await database.cleanup()
    }
  })

if (testUrl) {
  test('mixed-version persisted events retain opaque bytes and replay under catalog-specific checkpoints', async () => {
    const {
      newerFact,
      readBuildFacts,
      readBuildStreamSeed,
      readRepositoryFacts,
      deferMixedVersion,
    } = await import('@defrex/autobuild/testing')
    const { resolveReducerValue } = await import('@defrex/autobuild/store-adapter')
    const database = await isolatedDatabase()
    const store = await openPostgresBuildStore(database.url, new MemoryBlobStore())
    const sql = new SQL(database.url, { max: 1 })
    try {
      await store.createBuild(sampleBuildInput('mixed'))
      await store.append('mixed', sampleEventWrite('known'))
      const writeFuture = async (seq: number, classification: 'advisory' | 'decisive') => {
        const fact = newerFact(seq, classification)
        await sql`INSERT INTO events (build, seq, ts, actor, type, payload, compatibility) VALUES (${'mixed'}, ${seq}, ${fact.ts}::timestamptz, ${JSON.stringify(fact.actor)}::jsonb, ${fact.type}, ${JSON.stringify(fact.payload)}::jsonb, ${JSON.stringify(fact.compatibility)}::jsonb)`
      }
      const amended =
        await sql`UPDATE events SET payload = payload || '{"future":{"enabled":true}}'::jsonb WHERE build=${'mixed'} AND seq=1 RETURNING payload`
      expect(amended).toHaveLength(1)
      expect((await store.getEvents('mixed'))[0]!.payload as unknown).toHaveProperty('future', {
        enabled: true,
      })
      await writeFuture(2, 'advisory')
      expect((await readBuildFacts(store, 'mixed')).value.state.compatibility.unknownFacts).toBe(1)
      expect((await readBuildFacts(store, 'mixed')).value.state.compatibility.decisiveFacts).toBe(0)
      await writeFuture(3, 'decisive')
      const facts = (await readBuildFacts(store, 'mixed')).value
      expect(facts.state.compatibility.decisiveFacts).toBe(1)
      expect(facts.state.lastSeq).toBe(3)
      expect((await readBuildStreamSeed(store, 'mixed')).value.build.compatibility).toEqual(
        facts.state.compatibility,
      )
      const raw = (await store.getEvents('mixed'))[2]!
      expect(raw.type as string).toBe(newerFact(3).type)
      expect(raw.payload as unknown).toEqual(newerFact(3).payload)
      expect(raw.compatibility).toEqual(newerFact(3).compatibility)
      const resolved = resolveReducerValue(
        { kind: 'build', slug: 'mixed' },
        { reducer: 'buildReadFacts' },
      )
      await sql`UPDATE reducer_snapshots SET version=${resolved.reducer.version + 1}, state=${JSON.stringify({ future: true })}::jsonb WHERE reducer=${resolved.key}`
      const before =
        await sql`SELECT version,cursor,state FROM reducer_snapshots WHERE reducer=${resolved.key}`
      await writeFuture(4, 'decisive')
      expect((await readBuildFacts(store, 'mixed')).value.state.compatibility.decisiveFacts).toBe(2)
      expect(
        await sql`SELECT version,cursor,state FROM reducer_snapshots WHERE reducer=${resolved.key}`,
      ).toEqual(before)
      await Promise.all([deferMixedVersion(store, 'mixed'), deferMixedVersion(store, 'mixed')])
      expect(
        (await store.getEvents('mixed')).filter((e) => e.type === 'build.compatibility-deferred'),
      ).toHaveLength(1)
      await store.ensureRepo('mixed-repo')
      const fact = newerFact(1)
      await sql`INSERT INTO repo_events (repo, seq, ts, actor, type, payload, compatibility) VALUES (${'mixed-repo'}, 1, ${fact.ts}::timestamptz, ${JSON.stringify(fact.actor)}::jsonb, ${fact.type}, ${JSON.stringify(fact.payload)}::jsonb, ${JSON.stringify(fact.compatibility)}::jsonb)`
      expect(
        (await readRepositoryFacts(store, 'mixed-repo')).value.compatibility.decisiveFacts,
      ).toBe(1)
      // Invalid known data is corruption, rather than a compatibility miss.
      await sql`UPDATE events SET payload=${JSON.stringify({ id: 123 })}::jsonb WHERE build=${'mixed'} AND seq=1`
      await sql`DELETE FROM reducer_snapshots WHERE scope_key=${'mixed'}`
      await expect(readBuildFacts(store, 'mixed')).rejects.toThrow()
    } finally {
      await store.close()
      await sql.close()
      await database.cleanup()
    }
  })
}

if (testUrl)
  for (const order of ['older-first', 'newer-first']) {
    test(`PostgreSQL keeps equal-version catalogs independent after upgrade (${order})`, async () => {
      const { buildCreatedWrite, catalogIdentity, readBuildFacts, deferMixedVersion } =
        await import('@defrex/autobuild/testing')
      const { resolveReducerValue } = await import('@defrex/autobuild/store-adapter')
      const database = await isolatedDatabase()
      const store = await openPostgresBuildStore(database.url, new MemoryBlobStore())
      const sql = new SQL(database.url, { max: 1 })
      try {
        await store.createBuild(sampleBuildInput('supported'))
        await store.append('supported', buildCreatedWrite())
        const known = await store.getEvents('supported')
        const pause = await store.append('supported', {
          actor: { kind: 'human', user: 'fixture' },
          type: 'build.pause-requested',
          payload: {},
        })
        const scope = { kind: 'build', slug: 'supported' } as const
        const request = { reducer: 'buildReadFacts' }
        const current = resolveReducerValue(scope, request)
        const older = resolveReducerValue(
          scope,
          request,
          catalogIdentity({ 'build.created': 'decisive' }),
        )
        expect(older.reducer.version).toBe(current.reducer.version)
        const olderAcc = older.reducer.advance(older.reducer.initial(), known)
        olderAcc.build.compatibility = {
          unknownFacts: 1,
          decisiveFacts: 1,
          lastSeq: 2,
          decisiveBoundary: 2,
          types: ['build.pause-requested'],
          writerVersions: [pause.compatibility!.writerVersion],
          legacyVersionUnavailable: false,
          decisiveTypes: ['build.pause-requested'],
          decisiveWriterVersions: [pause.compatibility!.writerVersion],
          decisiveLegacyVersionUnavailable: false,
        }
        expect(older.entry.validate(olderAcc)).toBe(true)
        const installOlder = () =>
          sql`INSERT INTO reducer_snapshots (scope_kind,scope_key,reducer,version,cursor,state,updated_at) VALUES (${'build'},${'supported'},${older.key},${older.reducer.version},2,${JSON.stringify({ identity: older.identity, acc: olderAcc })}::jsonb,${new Date().toISOString()}::timestamptz)`
        if (order === 'older-first') await installOlder()
        expect(
          (await readBuildFacts(store, 'supported')).value.state.compatibility.decisiveFacts,
        ).toBe(0)
        if (order === 'newer-first') await installOlder()
        const before = await sql`SELECT * FROM reducer_snapshots WHERE reducer=${older.key}`
        expect(
          (await readBuildFacts(store, 'supported')).value.state.compatibility.unknownFacts,
        ).toBe(0)
        expect(await deferMixedVersion(store, 'supported')).toBe(false)
        expect(await sql`SELECT * FROM reducer_snapshots WHERE reducer=${older.key}`).toEqual(
          before,
        )
        const rows = await sql`SELECT reducer FROM reducer_snapshots WHERE scope_key=${'supported'}`
        expect(rows.map((row: { reducer: string }) => row.reducer).sort()).toEqual(
          [older.key, current.key].sort(),
        )
      } finally {
        await store.close()
        await sql.close()
        await database.cleanup()
      }
    })
  }

if (testUrl)
  test('dispatcher credential deletion and bounded indexed pruning isolate project and purpose', async () => {
    const database = await isolatedDatabase()
    const sql = new SQL(database.url)
    try {
      const { PostgresCredentialStore } = await import('./credentials')
      const { PostgresProjectRegistry } = await import('./projects')
      const projects = new PostgresProjectRegistry(sql)
      const repo = 'https://github.com/acme/cron'
      const other = 'https://github.com/acme/other'
      await projects.add(repo, 'test')
      await projects.add(other, 'test')
      const credentials = new PostgresCredentialStore(sql, projects)
      const owner = await credentials.issue(repo, 'owner')
      const overlap = await credentials.issue(repo, 'overlap', { purpose: 'dispatcher' })
      const foreign = await credentials.issue(other, 'foreign', { purpose: 'dispatcher' })
      const exact = await credentials.issue(repo, 'tick', { purpose: 'dispatcher' })
      expect(await credentials.deleteDispatcherCredential(repo, owner.credential.id)).toBe(0)
      expect(await credentials.deleteDispatcherCredential(repo, foreign.credential.id)).toBe(0)
      expect(
        await credentials.deleteDispatcherCredential(
          'git@github.com:acme/cron.git',
          exact.credential.id,
        ),
      ).toBe(1)
      expect(await credentials.authenticate(exact.token, new Date())).toBeNull()
      const cutoff = new Date()
      // Seed a historical backlog without minting 250 live secrets.
      await sql`INSERT INTO project_credentials (id, digest, repo, created_at, created_by, purpose, expires_at, revoked_at)
      SELECT md5(n::text), repeat('a', 64), ${repo}, ${cutoff.toISOString()}, 'legacy', 'dispatcher',
        CASE WHEN n <= 125 THEN ${cutoff.toISOString()}::timestamptz ELSE NULL END,
        CASE WHEN n > 125 THEN ${cutoff.toISOString()}::timestamptz ELSE NULL END
      FROM generate_series(1,250) n`
      // Owner and another project's expired rows must survive both sweeps.
      await sql`UPDATE project_credentials SET expires_at = ${cutoff.toISOString()}
      WHERE id IN (${owner.credential.id}, ${foreign.credential.id})`
      expect(await credentials.pruneDispatcherCredentials(repo, cutoff)).toBe(100)
      expect(await credentials.pruneDispatcherCredentials(repo, cutoff)).toBe(100)
      expect(await credentials.pruneDispatcherCredentials(repo, cutoff)).toBe(50)
      expect(await credentials.pruneDispatcherCredentials(repo, cutoff)).toBe(0)
      expect((await credentials.list(repo)).map((row) => row.id).sort()).toEqual(
        [owner.credential.id, overlap.credential.id].sort(),
      )
      expect(await credentials.list(other)).toHaveLength(1)
      expect(await credentials.authenticate(overlap.token, cutoff)).not.toBeNull()
      // Force index consideration to prove both candidate predicates have matching partial indexes.
      await sql`SET enable_seqscan = off`
      for (const column of ['expires_at', 'revoked_at']) {
        const plan = await sql.unsafe(
          `EXPLAIN SELECT id FROM project_credentials WHERE repo = '${repo}' AND purpose = 'dispatcher' AND ${column} <= now() ORDER BY ${column}, id LIMIT 100`,
        )
        expect(JSON.stringify(plan)).toContain(
          column === 'expires_at'
            ? 'dispatcher_credentials_expiry'
            : 'dispatcher_credentials_revoked',
        )
      }
    } finally {
      await sql.close()
      await database.cleanup()
    }
  })

if (testUrl)
  test('placement publication serializes independent connections, persists canonical values and fences old generations', async () => {
    const database = await isolatedDatabase()
    const sql = new SQL(database.url)
    const { MemoryBlobStore } = await import('@defrex/autobuild/plugin-sdk')
    const { PostgresProjectRegistry } = await import('./projects')
    const { withHostedProjectContext, rememberProjectGeneration } = await import(
      './request-context'
    )
    const first = await openPostgresBuildStore(database.url, new MemoryBlobStore())
    const second = await openPostgresBuildStore(database.url, new MemoryBlobStore())
    try {
      const projects = new PostgresProjectRegistry(sql)
      const repo = 'https://github.com/acme/placement'
      await projects.add(repo, 'test')
      const hosted = { hosted: true, origin: 'https://store.test' } as const
      const known = { status: 'known', placement: hosted } as const
      expect(
        await Promise.all([
          first.syncDispatchPlacement(repo, hosted),
          second.syncDispatchPlacement(repo, hosted),
        ]),
      ).toEqual([known, known])
      expect(await first.getRepoHighWater(repo)).toBe(1)
      for (let i = 0; i < 3; i++) {
        await Promise.all([
          first.syncDispatchPlacement(repo, { hosted: false }),
          second.syncDispatchPlacement(repo, hosted),
        ])
        const log = await first.getRepoEvents(repo)
        expect(
          (await second.getRepoStateEvents(repo)).filter(
            (event) => event.type === 'dispatcher.placement-set',
          ),
        ).toEqual(log.filter((event) => event.type === 'dispatcher.placement-set').slice(-1))
        expect(
          (await second.getReducerValue({ kind: 'repo', repo }, { reducer: 'dispatchPlacement' }))
            .value,
        ).toEqual({ status: 'known', placement: log.at(-1)!.payload })
        for (let j = 1; j < log.length; j++)
          expect(log[j]!.payload).not.toEqual(log[j - 1]!.payload)
      }
      const before = await first.getRepoHighWater(repo)
      const final = (await first.getRepoEvents(repo)).at(-1)!.payload as typeof hosted
      await Promise.all([
        first.syncDispatchPlacement(repo, final),
        second.syncDispatchPlacement(repo, final),
      ])
      expect(await first.getRepoHighWater(repo)).toBe(before)
      const [generation] = await sql`SELECT generation FROM project_generations WHERE repo=${repo}`
      await withHostedProjectContext(async () => {
        rememberProjectGeneration(repo, String(generation.generation))
        await projects.remove(repo, 'test')
        await projects.add(repo, 'test')
        await expect(first.syncDispatchPlacement(repo, { hosted: false })).rejects.toThrow(
          'project not registered',
        )
      })
      expect(await first.getRepoHighWater(repo)).toBe(before)
    } finally {
      await first.close()
      await second.close()
      await sql.close()
      await database.cleanup()
    }
  })
