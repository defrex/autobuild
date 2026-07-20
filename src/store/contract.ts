/**
 * Reusable contract suites for the BuildStore seam (SPEC §7). The in-memory
 * adapter's behavior *is* the contract; every adapter — SQLite (§7.2.1),
 * remote HTTP (§7.2.2) — runs these identical suites unchanged.
 *
 * Factories receive an optional injectable clock (mirroring the adapters'
 * constructors) because lease expiry (§15.2.6, §7.4) and store-assigned
 * timestamps (§15.1) are only testable deterministically with time control.
 */
import { describe, expect, test } from 'bun:test'
import {
  EventValidationError,
  type EventWrite,
} from '../events/catalog'
import {
  agentActor,
  DISPATCHER,
  humanActor,
  KERNEL,
} from '../events/envelope'
import type { RepositoryEventWrite } from '../events/repository'
import { manualClock } from '../testing/fixed'
import {
  contentHash,
  textContent,
  toBytes,
  type BlobStore,
  type BuildStore,
  type Clock,
  type NewBuildInput,
} from './types'

// ── Factory seams ────────────────────────────────────────────────────────────

export interface BuildStoreHarness {
  store: BuildStore
  cleanup?: () => Promise<void>
}

/**
 * Adapters are constructed with an injectable clock (see MemoryBuildStore's
 * constructor); the factory passes it through so the suite controls time.
 */
export type BuildStoreFactory = (opts?: {
  clock?: Clock
}) => Promise<BuildStoreHarness>

export interface BlobStoreHarness {
  blobs: BlobStore
  cleanup?: () => Promise<void>
}

export type BlobStoreFactory = () => Promise<BlobStoreHarness>

// ── Shared fixtures (exported so wave-2 adapters reuse them) ─────────────────

/** The contract's fixed epoch — matches `manualClock`'s default. */
export const CONTRACT_T0 = '2026-07-15T12:00:00.000Z'

/** `Date.toISOString()` shape — what a store-assigned `ts` must look like. */
export const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export function sampleBuildInput(slug: string): NewBuildInput {
  return {
    slug,
    repo: 'acme/rate-limiter',
    ticket: {
      source: 'linear',
      id: 'TICK-1',
      url: 'https://linear.app/acme/issue/TICK-1',
      title: 'Add rate limiting to auth',
    },
    branch: `ab/${slug}`,
  }
}

/** A minimal always-valid write — observations may come from any phase (§12). */
export function sampleEventWrite(
  summary = 'sample observation',
): EventWrite<'observation.recorded'> {
  return {
    actor: agentActor('implement', 's_test'),
    type: 'observation.recorded',
    payload: { id: 'o_1', kind: 'followup', summary },
  }
}

export function harvestStartedWrite(
  run = 'h_1',
  rev = 0,
): RepositoryEventWrite<'harvest.started'> {
  return {
    actor: KERNEL,
    type: 'harvest.started',
    payload: {
      run,
      observations: [{ build: 'build-a', seq: 1 }],
      scan: { kind: 'harvest-scan', rev },
    },
  }
}

export function buildCreatedWrite(): EventWrite<'build.created'> {
  return {
    actor: DISPATCHER,
    type: 'build.created',
    payload: {
      ticket: {
        source: 'linear',
        id: 'TICK-1',
        url: 'https://linear.app/acme/issue/TICK-1',
        title: 'Add rate limiting to auth',
      },
      repo: 'acme/rate-limiter',
      baseBranch: 'main',
    },
  }
}

export function planCompletedWrite(
  rev: number,
  round = 1,
): EventWrite<'plan.completed'> {
  return {
    actor: agentActor('plan', 's_plan'),
    type: 'plan.completed',
    payload: {
      round,
      artifact: { kind: 'plan', rev },
      verifySteps: ['types', 'unit'],
    },
  }
}

async function withStore(
  factory: BuildStoreFactory,
  opts: { clock?: Clock } | undefined,
  run: (store: BuildStore) => Promise<void>,
): Promise<void> {
  const { store, cleanup } = await factory(opts)
  try {
    await run(store)
  } finally {
    await store.close()
    await cleanup?.()
  }
}

function atT0(offsetMs: number): string {
  return new Date(Date.parse(CONTRACT_T0) + offsetMs).toISOString()
}

// ── The BuildStore contract ──────────────────────────────────────────────────

export function describeBuildStoreContract(
  name: string,
  factory: BuildStoreFactory,
): void {
  describe(`BuildStore contract: ${name}`, () => {
    describe('builds', () => {
      test('createBuild returns a record with store-assigned createdAt/updatedAt', async () => {
        const clock = manualClock(CONTRACT_T0)
        await withStore(factory, { clock }, async (store) => {
          const input = sampleBuildInput('create-a')
          const record = await store.createBuild(input)
          expect(record.slug).toBe('create-a')
          expect(record.repo).toBe(input.repo)
          expect(record.ticket).toEqual(input.ticket)
          expect(record.branch).toBe('ab/create-a')
          expect(record.createdAt).toBe(CONTRACT_T0)
          expect(record.updatedAt).toBe(CONTRACT_T0)
          expect(await store.getBuild('create-a')).toEqual(record)
        })
      })

      test('duplicate slug rejects', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('dupe'))
          const err = await store
            .createBuild(sampleBuildInput('dupe'))
            .catch((e: unknown) => e)
          expect(err).toBeInstanceOf(Error)
          expect((await store.listBuilds()).length).toBe(1)
        })
      })

      test('getBuild returns null for an unknown slug', async () => {
        await withStore(factory, undefined, async (store) => {
          expect(await store.getBuild('never-created')).toBeNull()
        })
      })

      test('listBuilds lists all builds', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('list-a'))
          await store.createBuild(sampleBuildInput('list-b'))
          const slugs = (await store.listBuilds()).map((b) => b.slug).sort()
          expect(slugs).toEqual(['list-a', 'list-b'])
        })
      })
    })

    describe('repository journal (workflow and control paper trail)', () => {
      test('ensureRepo is idempotent and repo event seq is independent', async () => {
        const clock = manualClock(CONTRACT_T0)
        await withStore(factory, { clock }, async (store) => {
          const first = await store.ensureRepo('acme/a')
          expect(first).toEqual({
            repo: 'acme/a',
            createdAt: CONTRACT_T0,
            updatedAt: CONTRACT_T0,
          })
          expect(await store.ensureRepo('acme/a')).toEqual(first)
          await store.ensureRepo('acme/b')
          const a1 = await store.appendRepo('acme/a', harvestStartedWrite('ha'))
          const b1 = await store.appendRepo('acme/b', harvestStartedWrite('hb'))
          expect([a1.seq, b1.seq]).toEqual([1, 1])
          expect((await store.getRepoEvents('acme/a'))[0]?.repo).toBe('acme/a')
        })
      })

      test('repository event validation is strict and actor-aware', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.ensureRepo('acme/a')
          const err = await store
            .appendRepo('acme/a', {
              actor: agentActor('harvest', 'hs_1'),
              type: 'harvest.started',
              payload: harvestStartedWrite().payload,
            })
            .catch((error: unknown) => error)
          expect(err).toBeInstanceOf(EventValidationError)
          expect(await store.getRepoEvents('acme/a')).toEqual([])
        })
      })

      test('dispatcher settings round-trip with strict payload and actor validation', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.ensureRepo('acme/settings')
          await store.appendRepo('acme/settings', {
            actor: humanActor('operator'),
            type: 'dispatcher.intake-set',
            payload: { enabled: false },
          })
          await store.appendRepo('acme/settings', {
            actor: humanActor('operator'),
            type: 'dispatcher.auto-merge-default-set',
            payload: { enabled: true },
          })

          for (const invalid of [
            {
              actor: KERNEL,
              type: 'dispatcher.intake-set',
              payload: { enabled: true },
            },
            {
              actor: humanActor('operator'),
              type: 'dispatcher.auto-merge-default-set',
              payload: { enabled: 'yes' },
            },
          ] as const) {
            const error = await store
              .appendRepo('acme/settings', invalid as RepositoryEventWrite)
              .catch((caught: unknown) => caught)
            expect(error).toBeInstanceOf(EventValidationError)
          }

          expect(await store.getRepoEvents('acme/settings')).toMatchObject([
            {
              seq: 1,
              actor: humanActor('operator'),
              type: 'dispatcher.intake-set',
              payload: { enabled: false },
            },
            {
              seq: 2,
              actor: humanActor('operator'),
              type: 'dispatcher.auto-merge-default-set',
              payload: { enabled: true },
            },
          ])
        })
      })

      test('harvest control requests are human-only and acknowledgements are kernel-only', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.ensureRepo('acme/control')
          await store.appendRepo('acme/control', {
            actor: humanActor('operator'),
            type: 'harvest.pause-requested',
            payload: {},
          })
          await store.appendRepo('acme/control', {
            actor: KERNEL,
            type: 'harvest.paused',
            payload: {},
          })

          for (const invalid of [
            {
              actor: KERNEL,
              type: 'harvest.resume-requested',
              payload: {},
            },
            {
              actor: humanActor('operator'),
              type: 'harvest.resumed',
              payload: {},
            },
          ] as const) {
            const error = await store
              .appendRepo('acme/control', invalid)
              .catch((caught: unknown) => caught)
            expect(error).toBeInstanceOf(EventValidationError)
          }
          expect(
            (await store.getRepoEvents('acme/control')).map((event) => event.type),
          ).toEqual(['harvest.pause-requested', 'harvest.paused'])
        })
      })

      test('repository artifacts are versioned and deposit atomically with events', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.ensureRepo('acme/a')
          const result = await store.appendRepoWithArtifacts(
            'acme/a',
            [{ kind: 'harvest-scan', content: '{"observations":[]}' }],
            (deposited) =>
              harvestStartedWrite('h_atomic', deposited[0]!.revision),
          )
          expect(result.artifacts[0]?.revision).toBe(0)
          expect(result.event.payload.scan).toEqual({
            kind: 'harvest-scan',
            rev: 0,
          })
          const artifact = await store.getRepoArtifact(
            'acme/a',
            'harvest-scan',
          )
          expect(new TextDecoder().decode(artifact?.content)).toBe(
            '{"observations":[]}',
          )

          const error = await store
            .appendRepoWithArtifacts(
              'acme/a',
              [{ kind: 'harvest-scan', content: 'bad' }],
              () => ({ ...harvestStartedWrite('bad'), actor: agentActor('x', 's') }),
            )
            .catch((caught: unknown) => caught)
          expect(error).toBeInstanceOf(EventValidationError)
          expect(
            (await store.listRepoArtifacts('acme/a', 'harvest-scan')).map(
              (meta) => meta.revision,
            ),
          ).toEqual([0])
        })
      })

      test('repository lease is exclusive, expires, heartbeats, and releases', async () => {
        const clock = manualClock(CONTRACT_T0)
        await withStore(factory, { clock }, async (store) => {
          await store.ensureRepo('acme/a')
          expect(await store.claimRepoLease('acme/a', 'one', 1000)).toBe(true)
          expect(await store.claimRepoLease('acme/a', 'two', 1000)).toBe(false)
          clock.advance(500)
          expect(await store.heartbeatRepo('acme/a', 'one')).toBe(true)
          clock.advance(900)
          expect(await store.claimRepoLease('acme/a', 'two', 1000)).toBe(false)
          await store.releaseRepoLease('acme/a', 'one')
          expect(await store.claimRepoLease('acme/a', 'two', 1000)).toBe(true)
        })
      })
    })

    describe('append', () => {
      test('assigns seq 1..n per build, independently across builds (§15.1)', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('seq-a'))
          await store.createBuild(sampleBuildInput('seq-b'))
          const a1 = await store.append('seq-a', sampleEventWrite('a1'))
          const a2 = await store.append('seq-a', sampleEventWrite('a2'))
          const b1 = await store.append('seq-b', sampleEventWrite('b1'))
          const a3 = await store.append('seq-a', sampleEventWrite('a3'))
          expect([a1.seq, a2.seq, a3.seq]).toEqual([1, 2, 3])
          expect(b1.seq).toBe(1)
        })
      })

      test('returns the full envelope with store-assigned ISO ts from the injected clock', async () => {
        const clock = manualClock(CONTRACT_T0)
        await withStore(factory, { clock }, async (store) => {
          await store.createBuild(sampleBuildInput('envelope'))
          const envelope = await store.append('envelope', buildCreatedWrite())
          expect(envelope).toEqual({
            build: 'envelope',
            seq: 1,
            ts: CONTRACT_T0,
            actor: { kind: 'dispatcher' },
            type: 'build.created',
            payload: buildCreatedWrite().payload,
          })
          expect(envelope.ts).toMatch(ISO_TS)
        })
      })

      test('payload round-trips typed through getEvents', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('round-trip'))
          await store.append('round-trip', buildCreatedWrite())
          const [event] = await store.getEvents('round-trip')
          expect(event?.type).toBe('build.created')
          if (event?.type !== 'build.created') throw new Error('unreachable')
          expect(event.payload).toEqual(buildCreatedWrite().payload)
          expect(event.payload.ticket.id).toBe('TICK-1')
          expect(event.actor).toEqual({ kind: 'dispatcher' })
        })
      })
    })

    describe('append validation (the enforced ontology, §8)', () => {
      test('unknown event type throws EventValidationError and appends nothing', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('val-type'))
          await store.append('val-type', sampleEventWrite())
          const bogus = {
            actor: KERNEL,
            type: 'no.such-type',
            payload: {},
          } as unknown as EventWrite
          const err = await store.append('val-type', bogus).catch((e: unknown) => e)
          expect(err).toBeInstanceOf(EventValidationError)
          expect((await store.getEvents('val-type')).length).toBe(1)
        })
      })

      test('malformed payload (missing field) throws EventValidationError and appends nothing', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('val-missing'))
          await store.append('val-missing', sampleEventWrite())
          const missing = {
            actor: DISPATCHER,
            type: 'build.created',
            payload: { repo: 'acme/rate-limiter' },
          } as unknown as EventWrite
          const err = await store
            .append('val-missing', missing)
            .catch((e: unknown) => e)
          expect(err).toBeInstanceOf(EventValidationError)
          expect((await store.getEvents('val-missing')).length).toBe(1)
        })
      })

      test('malformed payload (unknown extra key — payloads are strict) throws and appends nothing', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('val-extra'))
          await store.append('val-extra', sampleEventWrite())
          const extra = {
            actor: KERNEL,
            type: 'workspace.released',
            payload: { surprise: true },
          } as unknown as EventWrite
          const err = await store.append('val-extra', extra).catch((e: unknown) => e)
          expect(err).toBeInstanceOf(EventValidationError)
          expect((await store.getEvents('val-extra')).length).toBe(1)
        })
      })

      test('disallowed actor kind (agent emitting pr.merged) throws and appends nothing', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('val-actor'))
          await store.append('val-actor', sampleEventWrite())
          const err = await store
            .append('val-actor', {
              actor: agentActor('code-review', 's_9f2'),
              type: 'pr.merged',
              payload: { sha: 'abc1234' },
            })
            .catch((e: unknown) => e)
          expect(err).toBeInstanceOf(EventValidationError)
          expect((await store.getEvents('val-actor')).length).toBe(1)
        })
      })

      test('dispatcher escalation answers are limited to the retry resolution', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('val-dispatcher-answer'))
          const err = await store
            .append('val-dispatcher-answer', {
              actor: DISPATCHER,
              type: 'escalation.answered',
              payload: { id: 'esc_1', answer: 'continue', resolution: 'guidance' },
            })
            .catch((e: unknown) => e)
          expect(err).toBeInstanceOf(EventValidationError)
          expect(await store.getEvents('val-dispatcher-answer')).toEqual([])

          await store.append('val-dispatcher-answer', {
            actor: DISPATCHER,
            type: 'escalation.answered',
            payload: { id: 'esc_1', answer: 'retry', resolution: 'retry' },
          })
          expect((await store.getEvents('val-dispatcher-answer')).map((e) => e.type)).toEqual([
            'escalation.answered',
          ])
        })
      })
    })

    describe('getEvents', () => {
      test('since is strictly greater-than, in seq order; default 0 = all (§7.2)', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('since'))
          await store.append('since', sampleEventWrite('one'))
          await store.append('since', sampleEventWrite('two'))
          await store.append('since', sampleEventWrite('three'))

          const all = await store.getEvents('since')
          expect(all.map((e) => e.seq)).toEqual([1, 2, 3])

          const after1 = await store.getEvents('since', 1)
          expect(after1.map((e) => e.seq)).toEqual([2, 3])

          expect(await store.getEvents('since', 3)).toEqual([])
        })
      })

      test('write operations on an unknown build reject', async () => {
        await withStore(factory, undefined, async (store) => {
          const appendErr = await store
            .append('ghost', sampleEventWrite())
            .catch((e: unknown) => e)
          expect(appendErr).toBeInstanceOf(Error)
          const putErr = await store
            .putArtifact('ghost', { kind: 'plan', content: 'x' })
            .catch((e: unknown) => e)
          expect(putErr).toBeInstanceOf(Error)
          const leaseErr = await store
            .claimLease('ghost', 'runner-a', 1000)
            .catch((e: unknown) => e)
          expect(leaseErr).toBeInstanceOf(Error)
        })
      })
    })

    describe('artifacts', () => {
      test('revisions are 0-based per kind (§6.3): first deposit rev 0, next rev 1', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('revs'))
          const p0 = await store.putArtifact('revs', { kind: 'plan', content: 'plan v0' })
          const p1 = await store.putArtifact('revs', { kind: 'plan', content: 'plan v1' })
          const s0 = await store.putArtifact('revs', { kind: 'spec', content: 'spec v0' })
          expect(p0.revision).toBe(0)
          expect(p1.revision).toBe(1)
          expect(s0.revision).toBe(0)
        })
      })

      test('same content twice yields the same blobRef (content-addressed, §7.1) but distinct revisions', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('dedupe'))
          const a = await store.putArtifact('dedupe', { kind: 'plan', content: 'identical' })
          const b = await store.putArtifact('dedupe', { kind: 'plan', content: 'identical' })
          expect(a.blobRef).toBe(contentHash(toBytes('identical')))
          expect(b.blobRef).toBe(a.blobRef)
          expect([a.revision, b.revision]).toEqual([0, 1])
        })
      })

      test('metadata round-trips', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('meta'))
          const metadata = { phase: 'plan', round: 2, tags: ['a', 'b'] }
          await store.putArtifact('meta', { kind: 'plan', content: 'p', metadata })
          const artifact = await store.getArtifact('meta', 'plan')
          expect(artifact?.meta.metadata).toEqual(metadata)
        })
      })

      test('getArtifact: latest when rev omitted, pinned @rev, null when absent', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('get'))
          await store.putArtifact('get', { kind: 'plan', content: 'v0' })
          await store.putArtifact('get', { kind: 'plan', content: 'v1' })

          const latest = await store.getArtifact('get', 'plan')
          expect(latest?.meta.revision).toBe(1)
          expect(textContent(latest!)).toBe('v1')

          const pinned = await store.getArtifact('get', 'plan', 0)
          expect(pinned?.meta.revision).toBe(0)
          expect(textContent(pinned!)).toBe('v0')

          expect(await store.getArtifact('get', 'plan', 7)).toBeNull()
          expect(await store.getArtifact('get', 'never-deposited')).toBeNull()
        })
      })

      test('listArtifacts filters by kind and orders by (kind, revision)', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('list'))
          await store.putArtifact('list', { kind: 'plan', content: 'p0' })
          await store.putArtifact('list', { kind: 'spec', content: 's0' })
          await store.putArtifact('list', { kind: 'plan', content: 'p1' })

          const all = await store.listArtifacts('list')
          expect(all.map((m) => [m.kind, m.revision])).toEqual([
            ['plan', 0],
            ['plan', 1],
            ['spec', 0],
          ])

          const plans = await store.listArtifacts('list', 'plan')
          expect(plans.map((m) => [m.kind, m.revision])).toEqual([
            ['plan', 0],
            ['plan', 1],
          ])
        })
      })
    })

    describe('appendWithArtifacts (atomic deposits, D6 — §8.5)', () => {
      test('success: the event payload references deposited revs via makeEvent(deposited)', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('bundle'))
          const { event, artifacts } = await store.appendWithArtifacts(
            'bundle',
            [
              { kind: 'plan', content: 'the plan', metadata: { round: 1 } },
              { kind: 'transcript', content: 'transcript body' },
            ],
            (deposited) => planCompletedWrite(deposited[0]!.revision),
          )
          expect(artifacts.map((m) => [m.kind, m.revision])).toEqual([
            ['plan', 0],
            ['transcript', 0],
          ])
          expect(event.type).toBe('plan.completed')
          expect(event.payload).toEqual({
            round: 1,
            artifact: { kind: 'plan', rev: 0 },
            verifySteps: ['types', 'unit'],
          })

          const log = await store.getEvents('bundle')
          expect(log.map((e) => e.type)).toEqual(['plan.completed'])
          const plan = await store.getArtifact('bundle', 'plan')
          expect(textContent(plan!)).toBe('the plan')
          expect(plan?.meta.metadata).toEqual({ round: 1 })
        })
      })

      test('failure: an invalid artifact input mid-bundle persists nothing — no orphan deposits', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('bundle-bad-input'))
          const err = await store
            .appendWithArtifacts(
              'bundle-bad-input',
              [
                { kind: 'plan', content: 'the plan' },
                { kind: '', content: 'kindless' }, // invalid: kind is required
              ],
              (deposited) => planCompletedWrite(deposited[0]!.revision),
            )
            .catch((e: unknown) => e)
          expect(err).toBeInstanceOf(Error)
          // D6: "no state where an artifact exists without its event" — the
          // first input must not survive its bundle-mate's rejection.
          expect(await store.listArtifacts('bundle-bad-input')).toEqual([])
          expect(await store.getEvents('bundle-bad-input')).toEqual([])
        })
      })

      test('failure: an invalid event rolls back the whole deposit and propagates the error', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('rollback'))
          await store.putArtifact('rollback', { kind: 'plan', content: 'original plan' })
          await store.append('rollback', sampleEventWrite('pre-existing'))

          const err = await store
            .appendWithArtifacts(
              'rollback',
              [
                { kind: 'plan', content: 'round 2 plan' },
                { kind: 'plan', content: 'round 3 plan' },
              ],
              // kernel may not emit plan.completed (§15.3) → EventValidationError
              () => ({ ...planCompletedWrite(1, 2), actor: KERNEL }),
            )
            .catch((e: unknown) => e)
          expect(err).toBeInstanceOf(EventValidationError)

          const plans = await store.listArtifacts('rollback', 'plan')
          expect(plans.map((m) => m.revision)).toEqual([0])
          const latest = await store.getArtifact('rollback', 'plan')
          expect(textContent(latest!)).toBe('original plan')
          expect((await store.getEvents('rollback')).length).toBe(1)
        })
      })
    })

    describe('leases (§15.2.6, §7.4 — mutable liveness, never events)', () => {
      test('claim on an unheld lease succeeds and is visible on the record', async () => {
        const clock = manualClock(CONTRACT_T0)
        await withStore(factory, { clock }, async (store) => {
          await store.createBuild(sampleBuildInput('lease-claim'))
          expect(await store.claimLease('lease-claim', 'runner-a', 60_000)).toBe(true)
          const record = await store.getBuild('lease-claim')
          expect(record?.lease).toEqual({
            holder: 'runner-a',
            expiresAt: atT0(60_000),
          })
        })
      })

      test('a second holder is rejected while the lease is unexpired', async () => {
        const clock = manualClock(CONTRACT_T0)
        await withStore(factory, { clock }, async (store) => {
          await store.createBuild(sampleBuildInput('lease-contend'))
          expect(await store.claimLease('lease-contend', 'runner-a', 1000)).toBe(true)
          clock.advance(999)
          expect(await store.claimLease('lease-contend', 'runner-b', 1000)).toBe(false)
          expect((await store.getBuild('lease-contend'))?.lease?.holder).toBe('runner-a')
        })
      })

      test('the same holder renews, extending expiry', async () => {
        const clock = manualClock(CONTRACT_T0)
        await withStore(factory, { clock }, async (store) => {
          await store.createBuild(sampleBuildInput('lease-renew'))
          expect(await store.claimLease('lease-renew', 'runner-a', 1000)).toBe(true)
          clock.advance(600)
          expect(await store.claimLease('lease-renew', 'runner-a', 1000)).toBe(true)
          expect((await store.getBuild('lease-renew'))?.lease?.expiresAt).toBe(atT0(1600))
          // t=1300: past the original expiry (t=1000) but inside the renewal.
          clock.advance(700)
          expect(await store.claimLease('lease-renew', 'runner-b', 1000)).toBe(false)
          // t=1700: past the renewed expiry (t=1600).
          clock.advance(400)
          expect(await store.claimLease('lease-renew', 'runner-b', 1000)).toBe(true)
        })
      })

      test('an expired lease is claimable by a new holder (dead sandbox takeover, §7.4)', async () => {
        const clock = manualClock(CONTRACT_T0)
        await withStore(factory, { clock }, async (store) => {
          await store.createBuild(sampleBuildInput('lease-expire'))
          expect(await store.claimLease('lease-expire', 'runner-a', 1000)).toBe(true)
          clock.advance(1001)
          expect(await store.claimLease('lease-expire', 'runner-b', 1000)).toBe(true)
          expect((await store.getBuild('lease-expire'))?.lease?.holder).toBe('runner-b')
        })
      })

      test('heartbeat is true only for the current unexpired holder, and extends expiry', async () => {
        const clock = manualClock(CONTRACT_T0)
        await withStore(factory, { clock }, async (store) => {
          await store.createBuild(sampleBuildInput('lease-beat'))
          expect(await store.heartbeat('lease-beat', 'runner-a')).toBe(false) // no lease
          expect(await store.claimLease('lease-beat', 'runner-a', 1000)).toBe(true)
          expect(await store.heartbeat('lease-beat', 'runner-b')).toBe(false) // not the holder

          clock.advance(800)
          expect(await store.heartbeat('lease-beat', 'runner-a')).toBe(true)
          const record = await store.getBuild('lease-beat')
          expect(record?.heartbeatAt).toBe(atT0(800))
          expect(record?.lease?.expiresAt).toBe(atT0(1800))

          // t=1700: without the heartbeat the lease would have died at t=1000.
          clock.advance(900)
          expect(await store.claimLease('lease-beat', 'runner-b', 1000)).toBe(false)

          // t=1900: past the extended expiry — the holder's heartbeat is dead too.
          clock.advance(200)
          expect(await store.heartbeat('lease-beat', 'runner-a')).toBe(false)
          expect(await store.claimLease('lease-beat', 'runner-b', 1000)).toBe(true)
        })
      })

      test('releaseLease by the holder frees it; by a non-holder is a no-op', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('lease-release'))
          expect(await store.claimLease('lease-release', 'runner-a', 60_000)).toBe(true)

          await store.releaseLease('lease-release', 'runner-b') // no-op
          expect(await store.claimLease('lease-release', 'runner-c', 1000)).toBe(false)

          await store.releaseLease('lease-release', 'runner-a')
          expect((await store.getBuild('lease-release'))?.lease).toBeUndefined()
          expect(await store.claimLease('lease-release', 'runner-c', 1000)).toBe(true)
        })
      })
    })

    describe('subscribe (§7.2 — polling delivery)', () => {
      test('delivers appended events in order, each exactly once', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('sub-order'))
          const received: number[] = []
          const unsubscribe = store.subscribe('sub-order', { pollMs: 10 }, (event) => {
            received.push(event.seq)
          })
          await store.append('sub-order', sampleEventWrite('one'))
          await Bun.sleep(50)
          await store.append('sub-order', sampleEventWrite('two'))
          await store.append('sub-order', sampleEventWrite('three'))
          await Bun.sleep(50)
          unsubscribe()
          expect(received).toEqual([1, 2, 3])
        })
      })

      test('fromSeq skips earlier events', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('sub-from'))
          await store.append('sub-from', sampleEventWrite('one'))
          await store.append('sub-from', sampleEventWrite('two'))
          const received: number[] = []
          const unsubscribe = store.subscribe(
            'sub-from',
            { fromSeq: 1, pollMs: 10 },
            (event) => received.push(event.seq),
          )
          await store.append('sub-from', sampleEventWrite('three'))
          await Bun.sleep(50)
          unsubscribe()
          expect(received).toEqual([2, 3])
        })
      })

      test('unsubscribe stops delivery', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('sub-stop'))
          const received: number[] = []
          const unsubscribe = store.subscribe('sub-stop', { pollMs: 10 }, (event) => {
            received.push(event.seq)
          })
          await store.append('sub-stop', sampleEventWrite('one'))
          await Bun.sleep(50)
          unsubscribe()
          await store.append('sub-stop', sampleEventWrite('two'))
          await Bun.sleep(40)
          expect(received).toEqual([1])
        })
      })
    })
  })
}

// ── The BlobStore contract ───────────────────────────────────────────────────

export function describeBlobStoreContract(
  name: string,
  factory: BlobStoreFactory,
): void {
  describe(`BlobStore contract: ${name}`, () => {
    async function withBlobs(
      run: (blobs: BlobStore) => Promise<void>,
    ): Promise<void> {
      const { blobs, cleanup } = await factory()
      try {
        await run(blobs)
      } finally {
        await cleanup?.()
      }
    }

    test('put then get round-trips bytes', async () => {
      await withBlobs(async (blobs) => {
        const bytes = toBytes('blob content')
        const hash = contentHash(bytes)
        await blobs.put(hash, bytes)
        expect(await blobs.get(hash)).toEqual(bytes)
      })
    })

    test('get returns null when absent', async () => {
      await withBlobs(async (blobs) => {
        expect(await blobs.get(contentHash(toBytes('never stored')))).toBeNull()
      })
    })

    test('put is idempotent for the same hash (§7.1: content-addressed)', async () => {
      await withBlobs(async (blobs) => {
        const bytes = toBytes('same content')
        const hash = contentHash(bytes)
        await blobs.put(hash, bytes)
        await blobs.put(hash, bytes)
        expect(await blobs.get(hash)).toEqual(bytes)
      })
    })

    test('distinct hashes are independent', async () => {
      await withBlobs(async (blobs) => {
        const a = toBytes('content a')
        const b = toBytes('content b')
        await blobs.put(contentHash(a), a)
        await blobs.put(contentHash(b), b)
        expect(await blobs.get(contentHash(a))).toEqual(a)
        expect(await blobs.get(contentHash(b))).toEqual(b)
      })
    })
  })
}
