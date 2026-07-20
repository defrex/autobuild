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
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { humanActor } from '../../events/envelope'
import { manualClock } from '../../testing/fixed'
import {
  buildCreatedWrite,
  CONTRACT_T0,
  describeBuildStoreContract,
  sampleBuildInput,
  sampleEventWrite,
} from '../contract'
import { textContent } from '../types'
import { openLocalStore } from './store'

async function freshRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ab-sqlite-'))
}

describeBuildStoreContract('SqliteBuildStore', async (opts) => {
  const root = await freshRoot()
  const store = openLocalStore(root, opts?.clock ? { clock: opts.clock } : {})
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
      await first.close()

      const second = openLocalStore(root, { clock })
      try {
        const record = await second.getBuild('persist')
        expect(record?.repo).toBe('acme/rate-limiter')
        expect(record?.ticket?.id).toBe('TICK-1')
        expect(record?.lease).toEqual({
          holder: 'runner-a',
          // heartbeat at T0+1s extended expiry to T0+1s+ttl
          expiresAt: new Date(Date.parse(CONTRACT_T0) + 61_000).toISOString(),
        })
        expect(record?.heartbeatAt).toBe(
          new Date(Date.parse(CONTRACT_T0) + 1000).toISOString(),
        )

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
        ])

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

// ── Cross-process contention ([D2], §3.3, §7.2.1, §7.4) ──────────────────────
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
  test(
    'concurrent cross-process appends: no write is lost, seq serializes 1..N ([D2], §7.2.1)',
    async () => {
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
          expect(log.map((e) => e.seq)).toEqual(
            Array.from({ length: COUNT * 2 }, (_, i) => i + 1),
          )
          for (const session of ['s_a', 's_b']) {
            expect(
              log.filter((e) => e.actor.kind === 'agent' && e.actor.session === session)
                .length,
            ).toBe(COUNT)
          }
        } finally {
          await check.close()
        }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    30_000,
  )

  test(
    'cross-process lease contention: losers get a clean false, never a raw sqlite error; one holder at a time (§7.4, §15.2.6)',
    async () => {
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
    },
    30_000,
  )
})
