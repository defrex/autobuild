/**
 * SqliteBuildStore against the shared BuildStore contract (SPEC §7), plus
 * the adapter-specific facts the contract can't see: durability across
 * close/reopen (resumability, §2.2, §7.4), two sequential connections on
 * one file observing each other's appends (§7.2.1), and genuine
 * cross-process contention — the store is the ONLY coordination surface
 * ([D2], §15.2.7), so the dispatcher, runners, and the agent's `ab` CLI
 * write this file from separate processes (§3.3).
 */
import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { humanActor } from '../../events/envelope'
import { reduceDispatchSettings } from '../../kernel/dispatch-settings'
import { manualClock } from '../../testing/fixed'
import {
  buildCreatedWrite,
  CONTRACT_T0,
  describeBuildStoreContract,
  harvestStartedWrite,
  messagePostedWrite,
  sampleBuildInput,
  sampleEventWrite,
} from '../contract'
import { MemoryBlobStore } from '../memory'
import { StreamBatchTooLargeError, StreamClosedError, type StreamPart } from '../streams/types'
import { EVENT_WAIT_POLL_MS } from '../streams/wait'
import { textContent, type BlobStore } from '../types'
import { builds, repoStreams } from './schema'
import { openLocalStore, SqliteBuildStore } from './store'

async function freshRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ab-sqlite-'))
}

describeBuildStoreContract('SqliteBuildStore', async (opts) => {
  const root = await freshRoot()
  const store = openLocalStore(root, {
    ...(opts?.clock ? { clock: opts.clock } : {}),
    ...(opts?.retention ? { retention: opts.retention } : {}),
  })
  return {
    store,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
})

describe('SqliteBuildStore durability', () => {
  test('close + reopen from the same dir preserves builds, events, artifacts, and lease columns', async () => {
    const root = await freshRoot()
    try {
      const clock = manualClock(CONTRACT_T0)
      const first = openLocalStore(root, { clock })
      await first.createBuild(sampleBuildInput('persist'))
      await first.append('persist', buildCreatedWrite())
      await first.putArtifact('persist', {
        kind: 'spec',
        content: 'the spec body',
        metadata: { phase: 'spec' },
      })
      expect(await first.claimLease('persist', 'runner-a', 60_000)).toBe(true)
      clock.advance(1000)
      expect(await first.heartbeat('persist', 'runner-a')).toBe(true)
      await first.ensureRepo('acme/rate-limiter')
      await first.appendRepo('acme/rate-limiter', {
        actor: humanActor('operator'),
        type: 'dispatcher.intake-set',
        payload: { enabled: false },
      })
      await first.appendRepo('acme/rate-limiter', {
        actor: humanActor('operator'),
        type: 'dispatcher.auto-merge-default-set',
        payload: { enabled: true },
      })
      await first.appendRepo('acme/rate-limiter', {
        actor: humanActor('operator'),
        type: 'dispatcher.pause-set',
        payload: { enabled: true },
      })
      await first.close()

      const second = openLocalStore(root, { clock })
      try {
        const record = await second.getBuild('persist')
        expect(record?.repo).toBe('https://github.com/acme/rate-limiter')
        expect(record?.ticket?.id).toBe('TICK-1')
        expect(record?.lease).toEqual({
          holder: 'runner-a',
          // heartbeat at T0+1s extended expiry to T0+1s+ttl
          expiresAt: new Date(Date.parse(CONTRACT_T0) + 61_000).toISOString(),
        })
        expect(record?.heartbeatAt).toBe(new Date(Date.parse(CONTRACT_T0) + 1000).toISOString())

        const log = await second.getEvents('persist')
        expect(log.map((e) => [e.seq, e.type])).toEqual([[1, 'build.created']])
        expect(log[0]?.payload).toEqual(buildCreatedWrite().payload)

        const spec = await second.getArtifact('persist', 'spec')
        expect(textContent(spec!)).toBe('the spec body')
        expect(spec?.meta.metadata).toEqual({ phase: 'spec' })

        expect(
          (await second.getRepoEvents('acme/rate-limiter')).map((event) => ({
            seq: event.seq,
            type: event.type,
            payload: event.payload,
          })),
        ).toEqual([
          {
            seq: 1,
            type: 'dispatcher.intake-set',
            payload: { enabled: false },
          },
          {
            seq: 2,
            type: 'dispatcher.auto-merge-default-set',
            payload: { enabled: true },
          },
          {
            seq: 3,
            type: 'dispatcher.pause-set',
            payload: { enabled: true },
          },
        ])

        // The repository-wide hold is durable across a real file-level reopen,
        // and is releasable afterwards through the reopened store.
        expect(reduceDispatchSettings(await second.getRepoEvents('acme/rate-limiter')).paused).toBe(
          true,
        )
        await second.appendRepo('acme/rate-limiter', {
          actor: humanActor('operator'),
          type: 'dispatcher.pause-set',
          payload: { enabled: false },
        })
        expect(reduceDispatchSettings(await second.getRepoEvents('acme/rate-limiter')).paused).toBe(
          false,
        )

        // The reopened store keeps assigning seq where the log left off.
        const next = await second.append('persist', sampleEventWrite('after reopen'))
        expect(next.seq).toBe(2)
      } finally {
        await second.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('streams created before a reopen still read with their chunks and artifact after it', async () => {
    const root = await freshRoot()
    try {
      const clock = manualClock(CONTRACT_T0)
      const first = openLocalStore(root, { clock })
      await first.createBuild(sampleBuildInput('persist-streams'))
      await first.ensureRepo('acme/rate-limiter')
      const stream = await first.createStream(
        { kind: 'build', build: 'persist-streams' },
        'turn one',
      )
      await first.appendStreamParts(stream.id, [
        { type: 'start', messageId: 'm' },
        { type: 'text-start', id: 't' },
      ])
      await first.appendStreamParts(stream.id, [
        { type: 'text-delta', id: 't', delta: 'durable' },
        { type: 'text-end', id: 't' },
      ])
      const closed = await first.closeStream(stream.id, 'completed')
      const repoStream = await first.createStream(
        { kind: 'repo', repo: 'acme/rate-limiter' },
        'harvest stream',
      )
      await first.appendStreamParts(repoStream.id, [{ type: 'text-delta', id: 'u', delta: 'r' }])
      await first.close()

      const second = openLocalStore(root, { clock })
      try {
        const record = await second.getStream(stream.id)
        expect(record?.status).toBe('closed')
        expect(record?.outcome).toBe('completed')
        expect(record?.artifact).toEqual(closed.artifact)
        const read = await second.readStream(stream.id)
        expect(read.chunks.map((chunk) => chunk.seq)).toEqual([1, 2])
        const artifact = await second.getArtifact('persist-streams', `stream:${stream.id}`)
        expect(JSON.parse(textContent(artifact!))).toEqual([
          { id: 'm', role: 'assistant', parts: [{ type: 'text', text: 'durable', state: 'done' }] },
        ])

        // The open repo-side stream resumes: appends continue the sequence.
        const resumed = await second.readStream(repoStream.id)
        expect(resumed.chunks).toHaveLength(1)
        const next = await second.appendStreamParts(repoStream.id, [{ type: 'text-end', id: 'u' }])
        expect(next.seq).toBe(2)
        expect(
          (await second.listStreams({ kind: 'build', build: 'persist-streams' })).map((r) => r.id),
        ).toEqual([stream.id])
      } finally {
        await second.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('opening a pre-origin store adds repo_origin without a migration step and keeps old rows', async () => {
    const root = await freshRoot()
    try {
      const legacy = new Database(join(root, 'autobuild.sqlite'), { create: true })
      legacy.exec(`CREATE TABLE builds (
        slug TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        ticket TEXT,
        branch TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        lease_holder TEXT,
        lease_expires_at TEXT,
        lease_ttl_ms INTEGER,
        heartbeat_at TEXT
      )`)
      legacy
        .prepare(`INSERT INTO builds (slug, repo, created_at, updated_at) VALUES (?, ?, ?, ?)`)
        .run('legacy', 'acme/legacy', CONTRACT_T0, CONTRACT_T0)
      legacy.close()

      const store = openLocalStore(root)
      try {
        const old = await store.getBuild('legacy')
        expect(old?.slug).toBe('legacy')
        expect(old?.repoOrigin).toBeUndefined()
        const created = await store.createBuild(
          sampleBuildInput('fresh', { repoOrigin: 'https://github.com/acme/rate-limiter' }),
        )
        expect(created.repoOrigin).toBe('https://github.com/acme/rate-limiter')
        expect((await store.getBuild('legacy'))?.repoOrigin).toBeUndefined()
      } finally {
        await store.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('opening a pre-tiebreak store backfills streams.creation_seq in insertion order and keeps old rows', async () => {
    const root = await freshRoot()
    try {
      // Hand-build a database whose streams table predates the listStreams
      // creation-order tiebreak: the current DDL minus creation_seq, with two
      // same-millisecond streams whose id order is reversed from insertion
      // order.
      const legacy = new Database(join(root, 'autobuild.sqlite'), { create: true })
      legacy.exec(`CREATE TABLE builds (
        slug TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        ticket TEXT,
        branch TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        lease_holder TEXT,
        lease_expires_at TEXT,
        lease_ttl_ms INTEGER,
        heartbeat_at TEXT
      )`)
      legacy.exec(`CREATE TABLE streams (
        id TEXT PRIMARY KEY,
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('build','repo','session')),
        build TEXT,
        repo TEXT,
        session TEXT,
        label TEXT NOT NULL,
        format TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open','closed')),
        outcome TEXT,
        artifact_kind TEXT,
        artifact_revision INTEGER,
        artifact_blob_ref TEXT,
        created_at TEXT NOT NULL,
        closed_at TEXT,
        CHECK (
          (scope_kind = 'build' AND build IS NOT NULL AND repo IS NULL AND session IS NULL)
          OR
          (scope_kind = 'repo' AND build IS NULL AND repo IS NOT NULL AND session IS NULL)
          OR
          (scope_kind = 'session' AND build IS NULL AND repo IS NULL AND session IS NOT NULL)
        )
      )`)
      legacy
        .prepare(`INSERT INTO builds (slug, repo, created_at, updated_at) VALUES (?, ?, ?, ?)`)
        .run('legacy-tie', 'acme/legacy', CONTRACT_T0, CONTRACT_T0)
      for (const id of ['st_legacy-2', 'st_legacy-1']) {
        legacy
          .prepare(
            `INSERT INTO streams (id, scope_kind, build, label, format, status, created_at)
             VALUES (?, 'build', 'legacy-tie', 'before', 'ai-ui-message-stream/v1', 'open', ?)`,
          )
          .run(id, CONTRACT_T0)
      }
      legacy.close()

      const clock = manualClock(CONTRACT_T0)
      const store = openLocalStore(root, { clock })
      try {
        // Both rows survived, backfilled in insertion order (rowid) — not id
        // order, which is reversed here.
        expect(
          (await store.listStreams({ kind: 'build', build: 'legacy-tie' })).map((s) => s.id),
        ).toEqual(['st_legacy-2', 'st_legacy-1'])
        // A fresh same-millisecond creation gets a counter above the backfill
        // and sorts after both migrated rows.
        const created = await store.createStream({ kind: 'build', build: 'legacy-tie' }, 'after')
        expect(created.createdAt).toBe(CONTRACT_T0)
        expect(
          (await store.listStreams({ kind: 'build', build: 'legacy-tie' })).map((s) => s.id),
        ).toEqual(['st_legacy-2', 'st_legacy-1', created.id])
      } finally {
        await store.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("two stores opened on the same file see each other's appends (sequential)", async () => {
    const root = await freshRoot()
    try {
      const a = openLocalStore(root)
      const b = openLocalStore(root)
      try {
        await a.createBuild(sampleBuildInput('shared'))
        expect((await b.getBuild('shared'))?.slug).toBe('shared')

        const e1 = await a.append('shared', sampleEventWrite('from a'))
        const e2 = await b.append('shared', sampleEventWrite('from b'))
        expect(e1.seq).toBe(1)
        expect(e2.seq).toBe(2) // b's seq continues a's — one shared log

        expect((await a.getEvents('shared')).map((e) => e.seq)).toEqual([1, 2])
        expect((await b.getEvents('shared')).map((e) => e.seq)).toEqual([1, 2])
      } finally {
        await a.close()
        await b.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('SqliteBuildStore write pattern', () => {
  /**
   * Counting spy on the store's private drizzle instance. `depositInTx` /
   * `depositRepoInTx` read `this.db.update` at call time, so replacing the
   * method intercepts updates inside the transaction while still dispatching
   * to the real drizzle — the tests observe the actual SQLite write path.
   */
  function spyUpdates(store: unknown): { count(table: unknown): number; restore(): void } {
    const db = (store as { db: { update: (table: unknown) => unknown } }).db
    if (!db) throw new Error('store has no private `db` field — spy setup is stale')
    const original = db.update.bind(db)
    const counts = new Map<unknown, number>()
    db.update = (table: unknown) => {
      counts.set(table, (counts.get(table) ?? 0) + 1)
      return original(table)
    }
    return {
      count: (table) => counts.get(table) ?? 0,
      restore: () => {
        db.update = original
      },
    }
  }

  test('putArtifact issues exactly one builds update per deposit', async () => {
    const root = await freshRoot()
    try {
      const clock = manualClock(CONTRACT_T0)
      const store = openLocalStore(root, { clock })
      try {
        await store.createBuild(sampleBuildInput('spy'))
        clock.advance(1000)
        const spy = spyUpdates(store)
        const meta = await store.putArtifact('spy', { kind: 'spec', content: 'the spec body' })
        expect(spy.count(builds)).toBe(1)
        spy.restore()
        // Observable state unchanged: one idempotent write at the deposit ts.
        expect((await store.getBuild('spy'))?.updatedAt).toBe(meta.createdAt)
        expect(meta.createdAt).toBe(new Date(Date.parse(CONTRACT_T0) + 1000).toISOString())
      } finally {
        await store.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a deposit that prunes still issues exactly one builds update (regression guard)', async () => {
    const root = await freshRoot()
    try {
      const clock = manualClock(CONTRACT_T0)
      const store = openLocalStore(root, { clock, retention: { maxRevisions: 1 } })
      try {
        await store.createBuild(sampleBuildInput('pruned'))
        await store.putArtifact('pruned', {
          kind: 'build-runner-effective-config',
          content: 'cfg-0',
        })
        clock.advance(1000)
        const spy = spyUpdates(store)
        await store.putArtifact('pruned', {
          kind: 'build-runner-effective-config',
          content: 'cfg-1',
        })
        expect(spy.count(builds)).toBe(1)
        spy.restore()
        // Prune behavior unchanged: only the newest revision survives.
        expect(
          (await store.listArtifacts('pruned', 'build-runner-effective-config')).map(
            (m) => m.revision,
          ),
        ).toEqual([1])
        expect(await store.getArtifact('pruned', 'build-runner-effective-config', 0)).toBeNull()
        expect(
          new TextDecoder().decode(
            (await store.getArtifact('pruned', 'build-runner-effective-config'))!.content,
          ),
        ).toBe('cfg-1')
        // updatedAt advanced exactly once — to the second deposit's ts.
        expect((await store.getBuild('pruned'))?.updatedAt).toBe(
          new Date(Date.parse(CONTRACT_T0) + 1000).toISOString(),
        )
      } finally {
        await store.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('putRepoArtifact issues exactly one repoStreams update per deposit, including the prune case', async () => {
    const root = await freshRoot()
    try {
      const clock = manualClock(CONTRACT_T0)
      const store = openLocalStore(root, { clock, retention: { maxRevisions: 1 } })
      try {
        await store.ensureRepo('acme/spied')
        await store.putRepoArtifact('acme/spied', {
          kind: 'dispatcher-effective-config',
          content: 'cfg-0',
        })
        clock.advance(1000)
        const spy = spyUpdates(store)
        await store.putRepoArtifact('acme/spied', {
          kind: 'dispatcher-effective-config',
          content: 'cfg-1',
        })
        expect(spy.count(repoStreams)).toBe(1)
        spy.restore()
        expect(
          (await store.listRepoArtifacts('acme/spied', 'dispatcher-effective-config')).map(
            (m) => m.revision,
          ),
        ).toEqual([1])
        expect(
          await store.getRepoArtifact('acme/spied', 'dispatcher-effective-config', 0),
        ).toBeNull()
        expect((await store.getRepo('acme/spied'))?.updatedAt).toBe(
          new Date(Date.parse(CONTRACT_T0) + 1000).toISOString(),
        )
      } finally {
        await store.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// ── Cross-process contention ([D2], §3.3, §7.2.1, §7.4) ─────────────────────
//
// bun:sqlite transactions are synchronous, so two connections inside ONE
// process can never interleave mid-transaction — real contention needs real
// processes. Each worker opens the store file itself, meets the other at a
// file barrier (so the loops genuinely overlap), then hammers the same
// build. Deferred transactions fail these tests with raw "database is
// locked" losses; BEGIN IMMEDIATE (`writeTx`) queues writers on
// busy_timeout instead.

/** One worker process: `bun worker.ts <root> <a|b> <append|lease> <count>`. */
const WORKER_SOURCE = `
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openLocalStore } from ${JSON.stringify(join(import.meta.dir, 'store.ts'))}

const [root, name, mode, countStr] = process.argv.slice(2) as [string, string, string, string]
const count = Number(countStr)
const store = openLocalStore(root)

// Barrier: announce readiness, then wait for the other worker.
writeFileSync(join(root, 'ready-' + name), '')
while (!existsSync(join(root, 'ready-a')) || !existsSync(join(root, 'ready-b'))) {
  await Bun.sleep(2)
}

const errors: string[] = []
let wins = 0
let exclusionViolations = 0

for (let i = 0; i < count; i++) {
  try {
    if (mode === 'append') {
      await store.append('shared', {
        actor: { kind: 'agent', role: 'implement', session: 's_' + name },
        type: 'observation.recorded',
        payload: { id: 'o_' + name + '_' + i, kind: 'followup', summary: name + ' ' + i },
      })
    } else if (mode === 'conditional') {
      const appended = await store.appendIfCurrent('conditional', 0, {
        actor: { kind: 'agent', role: 'implement', session: 's_' + name },
        type: 'observation.recorded',
        payload: { id: 'o_' + name, kind: 'followup', summary: name },
      })
      if (appended !== null) wins++
    } else {
      const claimed = await store.claimLease('contested', name, 60_000)
      if (claimed) {
        wins++
        // While held, the holder must be us — an unexpired lease cannot be
        // stolen (§7.4), so anything else is a double grant.
        const record = await store.getBuild('contested')
        if (record?.lease?.holder !== name) exclusionViolations++
        await store.releaseLease('contested', name)
      }
    }
  } catch (error) {
    errors.push(String(error))
  }
}

await store.close()
console.log(JSON.stringify({ errors: errors.slice(0, 3), errorCount: errors.length, wins, exclusionViolations }))
`

interface WorkerReport {
  errors: string[]
  errorCount: number
  wins: number
  exclusionViolations: number
}

async function runWorker(script: string, args: string[]): Promise<WorkerReport> {
  const proc = Bun.spawn([process.execPath, script, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) throw new Error(`worker exited ${exitCode}: ${stderr}`)
  return JSON.parse(stdout) as WorkerReport
}

describe('SqliteBuildStore cross-process contention', () => {
  test('concurrent cross-process appends: no write is lost, seq serializes 1..N ([D2], §7.2.1)', async () => {
    const root = await freshRoot()
    try {
      const setup = openLocalStore(root)
      await setup.createBuild(sampleBuildInput('shared'))
      await setup.close()
      const script = join(root, 'worker.ts')
      await Bun.write(script, WORKER_SOURCE)

      const COUNT = 50
      const [a, b] = await Promise.all([
        runWorker(script, [root, 'a', 'append', String(COUNT)]),
        runWorker(script, [root, 'b', 'append', String(COUNT)]),
      ])
      // No append may fail with a raw "database is locked" — a lost
      // `ab done`/heartbeat collision becomes a spurious phase.failed.
      expect(a.errors).toEqual([])
      expect(b.errors).toEqual([])
      expect(a.errorCount + b.errorCount).toBe(0)

      const check = openLocalStore(root)
      try {
        const log = await check.getEvents('shared')
        expect(log.map((e) => e.seq)).toEqual(Array.from({ length: COUNT * 2 }, (_, i) => i + 1))
        for (const session of ['s_a', 's_b']) {
          expect(
            log.filter((e) => e.actor.kind === 'agent' && e.actor.session === session).length,
          ).toBe(COUNT)
        }
      } finally {
        await check.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  test('cross-process conditional append has exactly one winner for one expected tail', async () => {
    const root = await freshRoot()
    try {
      const setup = openLocalStore(root)
      await setup.createBuild(sampleBuildInput('conditional'))
      await setup.close()
      const script = join(root, 'worker.ts')
      await Bun.write(script, WORKER_SOURCE)

      const [a, b] = await Promise.all([
        runWorker(script, [root, 'a', 'conditional', '1']),
        runWorker(script, [root, 'b', 'conditional', '1']),
      ])
      expect(a.errors).toEqual([])
      expect(b.errors).toEqual([])
      expect(a.wins + b.wins).toBe(1)

      const check = openLocalStore(root)
      try {
        expect((await check.getEvents('conditional')).map((event) => event.seq)).toEqual([1])
      } finally {
        await check.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  test('cross-process lease contention: losers get a clean false, never a raw sqlite error; one holder at a time (§7.4, §15.2.6)', async () => {
    const root = await freshRoot()
    try {
      const setup = openLocalStore(root)
      await setup.createBuild(sampleBuildInput('contested'))
      await setup.close()
      const script = join(root, 'worker.ts')
      await Bun.write(script, WORKER_SOURCE)

      const ITERATIONS = 150
      const [a, b] = await Promise.all([
        runWorker(script, [root, 'a', 'lease', String(ITERATIONS)]),
        runWorker(script, [root, 'b', 'lease', String(ITERATIONS)]),
      ])
      // The dispatcher's sweep and a live runner's attach share this
      // claim path: a contended loser must see `false`, not a crash.
      expect(a.errors).toEqual([])
      expect(b.errors).toEqual([])
      expect(a.errorCount + b.errorCount).toBe(0)
      // Exactly one holder at a time — no double grants.
      expect(a.exclusionViolations + b.exclusionViolations).toBe(0)
      // The loop was not vacuous: claims really succeeded.
      expect(a.wins + b.wins).toBeGreaterThan(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('SqliteBuildStore close/append interleaving (AUT-348)', () => {
  // A BlobStore whose first put() suspends on a gate — closeStream's prepare
  // window. The gate fires before the close's blob write lands and the test
  // decides when the close resumes: forced ordering, no timing.
  function gatedBlobs() {
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
    return { blobs, entered, release }
  }

  async function openRaw(root: string, blobs: BlobStore): Promise<SqliteBuildStore> {
    const database = new Database(join(root, 'autobuild.sqlite'), { create: true })
    return new SqliteBuildStore({ database, blobs })
  }

  test('an append issued during a same-instance close waits for the commit and rejects with StreamClosedError', async () => {
    const root = await freshRoot()
    const { blobs, entered, release } = gatedBlobs()
    const store = await openRaw(root, blobs)
    try {
      await store.createBuild(sampleBuildInput('st-close-race'))
      const stream = await store.createStream({ kind: 'build', build: 'st-close-race' }, 'turn')
      await store.appendStreamParts(stream.id, [{ type: 'start', messageId: 'm' }])
      await store.appendStreamParts(stream.id, [{ type: 'text-start', id: 't' }])
      await store.appendStreamParts(stream.id, [{ type: 'text-delta', id: 't', delta: 'hello' }])

      const closing = store.closeStream(stream.id, 'completed')
      await entered // the close is suspended inside blobs.put — its prepare window
      const pending = store.appendStreamParts(stream.id, [
        { type: 'text-delta', id: 't', delta: 'late' },
      ])
      release()
      await closing
      const err = await pending.catch((e: unknown) => e)
      expect(err).toBeInstanceOf(StreamClosedError)

      // The late append persisted nothing: three chunks, all pre-close, and
      // the artifact's chunkCount/document cover only those.
      const read = await store.readStream(stream.id)
      expect(read.chunks).toHaveLength(3)
      const artifact = await store.getArtifact('st-close-race', `stream:${stream.id}`)
      expect(artifact?.meta.metadata).toMatchObject({ chunkCount: 3 })
      const document = JSON.parse(textContent(artifact!)) as Array<{
        parts: Array<{ type: string; text?: string; state?: string }>
      }>
      expect(document[0]?.parts.some((part) => part.type === 'text' && part.text === 'late')).toBe(
        false,
      )
      expect(document[0]?.parts).toContainEqual({ type: 'text', text: 'hello', state: 'streaming' })
    } finally {
      await store.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a cross-connection append inside the prepare window is included in the finalized artifact', async () => {
    const root = await freshRoot()
    const { blobs, entered, release } = gatedBlobs()
    // Two instances on one database file — the cross-connection writer shape
    // the per-instance mutex cannot see. The shared gated blob store forces
    // instance B's append to commit while instance A's close sits in its
    // prepare phase, exercising the commit-time chunk re-verification.
    const a = await openRaw(root, blobs)
    const b = await openRaw(root, blobs)
    try {
      await a.createBuild(sampleBuildInput('st-cross'))
      const stream = await a.createStream({ kind: 'build', build: 'st-cross' }, 'turn')
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

      // The retry loop re-prepared from the newer chunk set: all three
      // acknowledged appends are in chunkCount and the document.
      const artifact = await a.getArtifact('st-cross', `stream:${stream.id}`)
      expect(artifact?.meta.metadata).toMatchObject({ chunkCount: 3 })
      const document = JSON.parse(textContent(artifact!)) as Array<{ parts: unknown[] }>
      expect(document[0]?.parts).toContainEqual({
        type: 'text',
        text: 'late',
        state: 'streaming',
      })
    } finally {
      await a.close()
      await b.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a close held on stream A does not serialize an append on stream B', async () => {
    const root = await freshRoot()
    const { blobs, entered, release } = gatedBlobs()
    const store = await openRaw(root, blobs)
    try {
      await store.createBuild(sampleBuildInput('st-two-streams'))
      const a = await store.createStream({ kind: 'build', build: 'st-two-streams' }, 'a')
      const b = await store.createStream({ kind: 'build', build: 'st-two-streams' }, 'b')
      await store.appendStreamParts(a.id, [{ type: 'start', messageId: 'am' }])

      const closing = store.closeStream(a.id, 'completed')
      await entered // A's close holds its lock, suspended inside blobs.put
      const chunk = await store.appendStreamParts(b.id, [{ type: 'start', messageId: 'bm' }])
      expect(chunk.seq).toBe(1)
      release()
      const record = await closing
      expect(record.status).toBe('closed')
      expect((await store.readStream(b.id)).chunks).toHaveLength(1)
    } finally {
      await store.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('SqliteBuildStore append rejection precedence (SPEC §7.6)', () => {
  // Local-side adapters validate the batch and check the ceiling BEFORE
  // resolving the stream, so an invalid batch on an unknown stream reports
  // the validation or ceiling error — not unknown-stream. The remote server
  // deliberately runs the opposite order (SPEC §7.6); that side is pinned in
  // remote.test.ts, and the shared contract suite cannot host this test
  // because it also runs over the remote transport. Both orders must write
  // nothing.
  test('an invalid batch on an unknown stream rejects with the part-validation error and writes nothing', async () => {
    const root = await freshRoot()
    const store = openLocalStore(root)
    try {
      await store.createBuild(sampleBuildInput('st-ghost'))

      const empty = await store.appendStreamParts('st_ghost', []).catch((e: unknown) => e)
      expect(empty).toBeInstanceOf(Error)
      expect((empty as Error).message).toContain('stream parts must be a nonempty array')

      const noType = await store
        .appendStreamParts('st_ghost', [{ delta: 'x' } as unknown as StreamPart])
        .catch((e: unknown) => e)
      expect(noType).toBeInstanceOf(Error)
      expect((noType as Error).message).toContain('must carry a nonempty string "type"')
      expect((noType as Error).message).not.toContain('unknown stream')

      expect(await store.getStream('st_ghost')).toBeNull()
    } finally {
      await store.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('an oversized batch on an unknown stream rejects with StreamBatchTooLargeError and writes nothing', async () => {
    const root = await freshRoot()
    const store = openLocalStore(root)
    try {
      await store.createBuild(sampleBuildInput('st-ghost-big'))

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
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('SqliteBuildStore held event pacing (AUT-394)', () => {
  // Every held event read — build, repository, and session — must poll at
  // the one-second event-wait budget, not the 25 ms STREAM_WAIT_POLL_MS
  // stream default: the writer appends at ~500 ms, so a 1 s poll first
  // observes it at ~1000 ms. The ≥ 900 ms lower bound fails a regression
  // to the stream default (which resolves at ~525 ms); the < 2 s upper
  // bound is the one-poll worst-case convention from the Postgres live
  // suite (1 s poll plus scheduler slack), not a hard delivery guarantee.
  // A scheduler pause can only inflate elapsed time, so the lower bound —
  // the regression guard — is pause-safe.
  test('a held build-event read observes an append within the one-poll worst-case budget, no faster (AUT-394)', async () => {
    const root = await freshRoot()
    const store = openLocalStore(root)
    try {
      await store.createBuild(sampleBuildInput('pacing'))

      const started = Date.now()
      const pending = store.getEvents('pacing', 0, { waitSeconds: 5 })
      await Bun.sleep(500)
      const event = await store.append('pacing', sampleEventWrite('cross'))
      expect(await pending).toEqual([event])
      expect(Date.now() - started).toBeGreaterThanOrEqual(900)
      expect(Date.now() - started).toBeLessThan(2_000)
    } finally {
      await store.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a held repository-event read observes an append within the one-poll worst-case budget, no faster (AUT-394)', async () => {
    const root = await freshRoot()
    const store = openLocalStore(root)
    try {
      await store.ensureRepo('acme/pacing')

      const started = Date.now()
      const pending = store.getRepoEvents('acme/pacing', 0, { waitSeconds: 5 })
      await Bun.sleep(500)
      const event = await store.appendRepo('acme/pacing', harvestStartedWrite('h_x'))
      expect(await pending).toEqual([event])
      expect(Date.now() - started).toBeGreaterThanOrEqual(900)
      expect(Date.now() - started).toBeLessThan(2_000)
    } finally {
      await store.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a held session-event read observes an append within the one-poll worst-case budget, no faster (AUT-394)', async () => {
    const root = await freshRoot()
    const store = openLocalStore(root)
    try {
      const session = await store.createSession({ repo: 'acme/pacing', operator: 'op' })
      // session.created (seq 1) auto-appends; warm the path once so the held
      // read starts from an established initial poll.
      expect((await store.getSessionEvents(session.id)).map((event) => event.seq)).toEqual([1])

      const started = Date.now()
      const pending = store.getSessionEvents(session.id, 1, { waitSeconds: 5 })
      await Bun.sleep(500)
      const event = await store.appendSessionEvent(session.id, messagePostedWrite('cross'))
      expect(await pending).toEqual([event])
      expect(Date.now() - started).toBeGreaterThanOrEqual(900)
      expect(Date.now() - started).toBeLessThan(2_000)
    } finally {
      await store.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('EVENT_WAIT_POLL_MS pins the one-second hosted poll interval (AUT-394)', () => {
    expect(EVENT_WAIT_POLL_MS).toBe(1000)
  })
})
