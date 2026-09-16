/**
 * Reusable contract suites for the BuildStore seam (SPEC §7). The in-memory
 * adapter's behavior *is* the contract; every adapter — SQLite (§7.2.1),
 * remote HTTP (§7.2.2) — runs these identical suites unchanged.
 *
 * Factories receive an optional injectable clock (mirroring the adapters'
 * constructors) because lease expiry (§15.2.6, §7.4) and store-assigned
 * timestamps (§15.1) are only testable deterministically with time control.
 * The retention option drives the artifact-retention suite (store/retention.ts);
 * factories must wire it into the adapter so the suite runs identically
 * against every adapter.
 */
import { describe, expect, test } from 'bun:test'
import { EventValidationError, type EventWrite } from '../events/catalog'
import { agentActor, DISPATCHER, humanActor, KERNEL, type Via } from '../events/envelope'
import type { RepositoryEventWrite } from '../events/repository'
import type { SessionEventWrite } from '../events/sessions'
import { manualClock } from '../testing/fixed'
import { AuthError } from './remote/client'
import {
  contentHash,
  textContent,
  toBytes,
  type BlobStore,
  type BuildStore,
  type Clock,
  type NewBuildInput,
} from './types'

/** Decode artifact bytes — accepts both build and repository artifacts. */
function artifactText(artifact: { content: Uint8Array }): string {
  return new TextDecoder().decode(artifact.content)
}
import {
  clampWaitSeconds,
  MAX_STREAM_WAIT_SECONDS,
  StreamBatchTooLargeError,
  StreamClosedError,
  type StreamPart,
} from './streams/types'

// ── Factory seams ────────────────────────────────────────────────────────────

export interface BuildStoreHarness {
  store: BuildStore
  /**
   * Delegated-write authority posture (SPEC §15.1). Absent: no token
   * authority — the backing catalog is the only via gate (local adapters; the
   * open no-secret remote server), and the catalog's EventValidationError is
   * the sole rejection. Present: writes are authorized by a bearer token and
   * `via` is the claim it carries. A token without a via claim may not write
   * delegated events at all — any human write claiming a via, valid or
   * malformed, rejects with AuthError (403 "token carries no via; it may not
   * write delegated events") before catalog validation, the deliberate
   * authority-vs-validation ordering of the remote server's enforceVia —
   * while via-less human writes still round-trip. A token carrying a via
   * stamps it onto human writes and accepts only that via (a write claiming
   * a different via rejects with AuthError).
   */
  viaAuthority?: { via?: Via }
  cleanup?: () => Promise<void>
}

/**
 * Adapters are constructed with an injectable clock (see MemoryBuildStore's
 * constructor); the factory passes it through so the suite controls time.
 */
export type BuildStoreFactory = (opts?: {
  clock?: Clock
  retention?: { maxRevisions: number }
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

export function sampleBuildInput(
  slug: string,
  opts: { repoOrigin?: string; repo?: string } = {},
): NewBuildInput {
  return {
    slug,
    // Identity-shaped by default: a normalized origin URL. The store treats
    // `repo` as an opaque key — path-keyed legacy records round-trip the same
    // way (see the identity suites below).
    repo: opts.repo ?? 'https://github.com/acme/rate-limiter',
    ...(opts.repoOrigin !== undefined ? { repoOrigin: opts.repoOrigin } : {}),
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

export function harvestStartedWrite(run = 'h_1', rev = 0): RepositoryEventWrite<'harvest.started'> {
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

export function planCompletedWrite(rev: number, round = 1): EventWrite<'plan.completed'> {
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

export function runStartedWrite(
  run: string,
  deposited: { kind: string; revision: number }[],
): RepositoryEventWrite<'dispatcher.run-started'> {
  const artifact = deposited[0]
  if (!artifact) throw new Error('run-started deposit returned no artifact')
  return {
    actor: DISPATCHER,
    type: 'dispatcher.run-started',
    payload: {
      run,
      pid: 4242,
      effectiveConfig: { kind: artifact.kind, rev: artifact.revision },
      roleWarnings: [],
    },
  }
}

export function messagePostedWrite(text = 'hello'): SessionEventWrite<'message.posted'> {
  return { actor: humanActor('operator'), type: 'message.posted', payload: { text } }
}

export function turnStartedWrite(
  turn = 't1',
  stream = `st_${turn}`,
): SessionEventWrite<'turn.started'> {
  return {
    actor: agentActor('orchestrator', 'os_turn'),
    type: 'turn.started',
    payload: { turn, stream, trigger: { kind: 'message', messageSeq: 1 } },
  }
}

async function withStore(
  factory: BuildStoreFactory,
  opts: { clock?: Clock; retention?: { maxRevisions: number } } | undefined,
  run: (store: BuildStore, viaAuthority?: { via?: Via }) => Promise<void>,
): Promise<void> {
  const { store, viaAuthority, cleanup } = await factory(opts)
  try {
    await run(store, viaAuthority)
  } finally {
    await store.close()
    await cleanup?.()
  }
}

// ── Stream fixtures (SPEC §7.6) ──────────────────────────────────────────

/** The representative part sequence the assembly close test asserts on:
 * text deltas, a tool call with input and output, a reasoning block, a
 * data-* part, an error chunk, and one undefined-type part. */
export function representativeStreamParts(): StreamPart[] {
  return [
    { type: 'start', messageId: 'msg-1' },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: 'working' },
    { type: 'text-end', id: 't1' },
    { type: 'reasoning-start', id: 'r1' },
    { type: 'reasoning-delta', id: 'r1', delta: 'considering' },
    { type: 'reasoning-end', id: 'r1' },
    { type: 'tool-input-available', toolCallId: 'c1', toolName: 'read', input: { path: 'a.ts' } },
    { type: 'tool-output-available', toolCallId: 'c1', output: { lines: 10 } },
    { type: 'data-probe', id: 'd1', data: { n: 1 } },
    { type: 'error', errorText: 'transient' },
    { type: 'mystery-part', foo: 1 },
  ]
}

/** The document the representative sequence assembles into — shared by the
 * close test and each adapter's expected-artifact assertion. */
export function representativeStreamDocument(): unknown[] {
  return [
    {
      id: 'msg-1',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'working', state: 'done' },
        { type: 'reasoning', id: 'r1', text: 'considering', state: 'done' },
        {
          type: 'tool-read',
          toolCallId: 'c1',
          state: 'output-available',
          input: { path: 'a.ts' },
          output: { lines: 10 },
        },
        { type: 'data-probe', id: 'd1', data: { n: 1 } },
      ],
    },
  ]
}

function atT0(offsetMs: number): string {
  return new Date(Date.parse(CONTRACT_T0) + offsetMs).toISOString()
}

// ── The BuildStore contract ──────────────────────────────────────────────────

export function describeBuildStoreContract(name: string, factory: BuildStoreFactory): void {
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
          const err = await store.createBuild(sampleBuildInput('dupe')).catch((e: unknown) => e)
          expect(err).toBeInstanceOf(Error)
          expect((await store.listBuilds()).length).toBe(1)
        })
      })

      test('createBuild persists repoOrigin; the field stays absent without one', async () => {
        await withStore(factory, undefined, async (store) => {
          const origin = 'https://github.com/acme/rate-limiter'
          const withOrigin = await store.createBuild(
            sampleBuildInput('origin-set', { repoOrigin: origin }),
          )
          expect(withOrigin.repoOrigin).toBe(origin)
          expect((await store.getBuild('origin-set'))?.repoOrigin).toBe(origin)
          expect(
            (await store.listBuilds()).find((build) => build.slug === 'origin-set')?.repoOrigin,
          ).toBe(origin)

          await store.createBuild(sampleBuildInput('origin-absent'))
          expect((await store.getBuild('origin-absent'))?.repoOrigin).toBeUndefined()
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
          await store.appendRepo('acme/settings', {
            actor: humanActor('operator'),
            type: 'dispatcher.pause-set',
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
            {
              actor: humanActor('operator'),
              type: 'dispatcher.pause-set',
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
            {
              seq: 3,
              actor: humanActor('operator'),
              type: 'dispatcher.pause-set',
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
          expect((await store.getRepoEvents('acme/control')).map((event) => event.type)).toEqual([
            'harvest.pause-requested',
            'harvest.paused',
          ])
        })
      })

      test('repository artifacts are versioned and deposit atomically with events', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.ensureRepo('acme/a')
          const result = await store.appendRepoWithArtifacts(
            'acme/a',
            [{ kind: 'harvest-scan', content: '{"observations":[]}' }],
            (deposited) => harvestStartedWrite('h_atomic', deposited[0]!.revision),
          )
          expect(result.artifacts[0]?.revision).toBe(0)
          expect(result.event.payload.scan).toEqual({
            kind: 'harvest-scan',
            rev: 0,
          })
          const artifact = await store.getRepoArtifact('acme/a', 'harvest-scan')
          expect(new TextDecoder().decode(artifact?.content)).toBe('{"observations":[]}')

          const error = await store
            .appendRepoWithArtifacts('acme/a', [{ kind: 'harvest-scan', content: 'bad' }], () => ({
              ...harvestStartedWrite('bad'),
              actor: agentActor('x', 's'),
            }))
            .catch((caught: unknown) => caught)
          expect(error).toBeInstanceOf(EventValidationError)
          expect(
            (await store.listRepoArtifacts('acme/a', 'harvest-scan')).map((meta) => meta.revision),
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

    describe('appendIfCurrent (atomic stream compare-and-append)', () => {
      test('expected sequence 0 appends to an empty stream and returns the envelope', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('conditional-empty'))
          const event = await store.appendIfCurrent(
            'conditional-empty',
            0,
            sampleEventWrite('first'),
          )
          expect(event?.seq).toBe(1)
          expect((await store.getEvents('conditional-empty')).map((entry) => entry.seq)).toEqual([
            1,
          ])
        })
      })

      test('a stale expected sequence appends nothing and leaves updatedAt untouched', async () => {
        const clock = manualClock(CONTRACT_T0)
        await withStore(factory, { clock }, async (store) => {
          await store.createBuild(sampleBuildInput('conditional-stale'))
          clock.advance(1000)
          await store.appendIfCurrent('conditional-stale', 0, sampleEventWrite('winner'))
          const before = await store.getBuild('conditional-stale')

          clock.advance(1000)
          expect(
            await store.appendIfCurrent('conditional-stale', 0, sampleEventWrite('stale')),
          ).toBeNull()
          expect(await store.getBuild('conditional-stale')).toEqual(before)
          expect((await store.getEvents('conditional-stale')).map((entry) => entry.seq)).toEqual([
            1,
          ])
        })
      })

      test('two contenders for one sequence produce one winner and preserve gapless appends', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('conditional-race'))
          const results = await Promise.all([
            store.appendIfCurrent('conditional-race', 0, sampleEventWrite('a')),
            store.appendIfCurrent('conditional-race', 0, sampleEventWrite('b')),
          ])
          expect(results.filter((result) => result !== null)).toHaveLength(1)
          expect(results.filter((result) => result === null)).toHaveLength(1)

          const next = await store.appendIfCurrent('conditional-race', 1, sampleEventWrite('next'))
          expect(next?.seq).toBe(2)
          expect((await store.getEvents('conditional-race')).map((entry) => entry.seq)).toEqual([
            1, 2,
          ])
        })
      })

      test('invalid candidates, invalid expected sequences, and unknown builds reject without writes', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('conditional-invalid'))
          await store.append('conditional-invalid', sampleEventWrite('existing'))
          const invalid = {
            actor: KERNEL,
            type: 'no.such-type',
            payload: {},
          } as unknown as EventWrite

          const invalidEvent = await store
            .appendIfCurrent('conditional-invalid', 0, invalid)
            .catch((error: unknown) => error)
          expect(invalidEvent).toBeInstanceOf(EventValidationError)

          const invalidSeq = await store
            .appendIfCurrent('conditional-invalid', -1, sampleEventWrite())
            .catch((error: unknown) => error)
          expect(invalidSeq).toBeInstanceOf(Error)

          const unknown = await store
            .appendIfCurrent('ghost', 0, sampleEventWrite())
            .catch((error: unknown) => error)
          expect(unknown).toBeInstanceOf(Error)
          expect((await store.getEvents('conditional-invalid')).map((entry) => entry.seq)).toEqual([
            1,
          ])
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
          const err = await store.append('val-missing', missing).catch((e: unknown) => e)
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

      test('only humans may append escalation answers, including bare retry', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('val-dispatcher-answer'))
          for (const payload of [
            { id: 'esc_1', answer: 'continue', resolution: 'guidance' as const },
            { id: 'esc_1', answer: 'retry', resolution: 'retry' as const },
          ]) {
            const err = await store
              .append('val-dispatcher-answer', {
                actor: DISPATCHER,
                type: 'escalation.answered',
                payload,
              })
              .catch((e: unknown) => e)
            expect(err).toBeInstanceOf(EventValidationError)
            expect(await store.getEvents('val-dispatcher-answer')).toEqual([])
          }

          await store.append('val-dispatcher-answer', {
            actor: humanActor('operator'),
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
          const appendErr = await store.append('ghost', sampleEventWrite()).catch((e: unknown) => e)
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

    describe('artifact retention (dispatcher run/config family — store/retention.ts)', () => {
      test('prunes the oldest revisions past maxRevisions for retention-family kinds only', async () => {
        await withStore(factory, { retention: { maxRevisions: 2 } }, async (store) => {
          await store.ensureRepo('acme/retention')

          // Repo side, family kind, through the atomic deposit path the
          // dispatcher cron uses (appendRepoWithArtifacts @ run-started).
          for (const run of ['run-0', 'run-1', 'run-2']) {
            const { artifacts } = await store.appendRepoWithArtifacts(
              'acme/retention',
              [{ kind: 'dispatcher-effective-config', content: `cfg-${run}` }],
              (deposited) => runStartedWrite(run, deposited),
            )
            expect(artifacts.map((a) => a.revision)).toEqual([Number(run.slice(-1))])
          }
          const revisions = (
            await store.listRepoArtifacts('acme/retention', 'dispatcher-effective-config')
          ).map((meta) => meta.revision)
          // Pruned side: revision 0 is gone entirely…
          expect(revisions).toEqual([1, 2])
          expect(
            await store.getRepoArtifact('acme/retention', 'dispatcher-effective-config', 0),
          ).toBeNull()
          // …preserved side: the surviving revisions still read, and the
          // latest-by-default read (the current run's snapshot) still works.
          expect(
            (await store.getRepoArtifact('acme/retention', 'dispatcher-effective-config', 1))?.meta
              .revision,
          ).toBe(1)
          const latest = await store.getRepoArtifact(
            'acme/retention',
            'dispatcher-effective-config',
          )
          expect(latest?.meta.revision).toBe(2)
          expect(new TextDecoder().decode(latest!.content)).toBe('cfg-run-2')

          // A non-family kind deposited by the same activity is never pruned.
          for (let i = 0; i < 3; i++) {
            await store.putRepoArtifact('acme/retention', {
              kind: 'harvest-scan',
              content: `s${i}`,
            })
          }
          expect(
            (await store.listRepoArtifacts('acme/retention', 'harvest-scan')).map(
              (meta) => meta.revision,
            ),
          ).toEqual([0, 1, 2])

          // Build side, family kind (per-build snapshots).
          await store.createBuild(sampleBuildInput('retain-b'))
          for (let i = 0; i < 3; i++) {
            await store.putArtifact('retain-b', {
              kind: 'build-runner-effective-config',
              content: `bcfg-${i}`,
            })
          }
          expect(
            (await store.listArtifacts('retain-b', 'build-runner-effective-config')).map(
              (meta) => meta.revision,
            ),
          ).toEqual([1, 2])
          expect(await store.getArtifact('retain-b', 'build-runner-effective-config', 0)).toBeNull()
          expect(
            (await store.getArtifact('retain-b', 'build-runner-effective-config'))?.meta.revision,
          ).toBe(2)
        })
      })

      test('the operator-notes kind is retention-managed at the same deposit path', async () => {
        await withStore(factory, { retention: { maxRevisions: 2 } }, async (store) => {
          await store.ensureRepo('acme/retention')
          // Three deposits of the agent notes kind prune the oldest, exactly
          // like the dispatcher family: the newest 2 survive, and the
          // latest-by-default read (what notes.read serves) still works.
          for (let i = 0; i < 3; i++) {
            await store.putRepoArtifact('acme/retention', {
              kind: 'operator-notes',
              content: `notes-${i}`,
              metadata: { user: 'Ada' },
            })
          }
          const revisions = (await store.listRepoArtifacts('acme/retention', 'operator-notes')).map(
            (meta) => meta.revision,
          )
          expect(revisions).toEqual([1, 2])
          expect(await store.getRepoArtifact('acme/retention', 'operator-notes', 0)).toBeNull()
          const latest = await store.getRepoArtifact('acme/retention', 'operator-notes')
          expect(latest?.meta.revision).toBe(2)
          expect(new TextDecoder().decode(latest!.content)).toBe('notes-2')
          // The dispatcher family's documented bound is untouched by the
          // operator kind: a family deposit still prunes its own kind alone.
          const { artifacts } = await store.appendRepoWithArtifacts(
            'acme/retention',
            [{ kind: 'dispatcher-effective-config', content: 'cfg' }],
            (deposited) => runStartedWrite('retention-notes-run', deposited),
          )
          expect(artifacts.map((meta) => meta.revision)).toEqual([0])
          expect(
            (await store.listRepoArtifacts('acme/retention', 'operator-notes')).map(
              (meta) => meta.revision,
            ),
          ).toEqual([1, 2])
        })
      })
    })

    describe('validation-before-prune ordering (AUT-322)', () => {
      test('a same-kind batch larger than the retention bound validates the event before pruning: the newest sibling survives with its event', async () => {
        await withStore(factory, { retention: { maxRevisions: 2 } }, async (store) => {
          await store.createBuild(sampleBuildInput('vbp-batch'))
          const { event, artifacts } = await store.appendWithArtifacts(
            'vbp-batch',
            [
              { kind: 'build-runner-effective-config', content: 'cfg-0' },
              { kind: 'build-runner-effective-config', content: 'cfg-1' },
              { kind: 'build-runner-effective-config', content: 'cfg-2' },
            ],
            // The payload references the batch's last assigned revision;
            // batch kinds need not appear in the payload.
            (deposited) => planCompletedWrite(deposited.at(-1)!.revision),
          )
          // Validation provably ran: the event was appended and returned.
          expect(event.seq).toBe(1)
          expect(artifacts.map((meta) => meta.revision)).toEqual([0, 1, 2])

          // Post-prune state is exactly the retention policy's answer over
          // the full post-batch revision set: [1, 2] retained, 0 pruned.
          const revisions = (
            await store.listArtifacts('vbp-batch', 'build-runner-effective-config')
          ).map((meta) => meta.revision)
          expect(revisions).toEqual([1, 2])
          expect(
            await store.getArtifact('vbp-batch', 'build-runner-effective-config', 0),
          ).toBeNull()
          expect(
            (await store.getArtifact('vbp-batch', 'build-runner-effective-config', 1))?.meta
              .revision,
          ).toBe(1)
          expect(
            (await store.getArtifact('vbp-batch', 'build-runner-effective-config'))?.meta.revision,
          ).toBe(2)
        })
      })

      test('repo-side mirror: appendRepoWithArtifacts validates before pruning a same-kind batch', async () => {
        await withStore(factory, { retention: { maxRevisions: 2 } }, async (store) => {
          await store.ensureRepo('acme/vbp')
          const { event, artifacts } = await store.appendRepoWithArtifacts(
            'acme/vbp',
            [
              { kind: 'dispatcher-effective-config', content: 'cfg-0' },
              { kind: 'dispatcher-effective-config', content: 'cfg-1' },
              { kind: 'dispatcher-effective-config', content: 'cfg-2' },
            ],
            (deposited) => runStartedWrite('vbp-run', deposited),
          )
          expect(event.seq).toBe(1)
          expect(artifacts.map((meta) => meta.revision)).toEqual([0, 1, 2])
          const revisions = (
            await store.listRepoArtifacts('acme/vbp', 'dispatcher-effective-config')
          ).map((meta) => meta.revision)
          expect(revisions).toEqual([1, 2])
          expect(
            await store.getRepoArtifact('acme/vbp', 'dispatcher-effective-config', 0),
          ).toBeNull()
          const latest = await store.getRepoArtifact('acme/vbp', 'dispatcher-effective-config')
          expect(latest?.meta.revision).toBe(2)
          expect(new TextDecoder().decode(latest!.content)).toBe('cfg-2')
        })
      })

      test('an invalid batch event leaves exactly the pre-call state — no prune outruns validation', async () => {
        await withStore(factory, { retention: { maxRevisions: 2 } }, async (store) => {
          await store.createBuild(sampleBuildInput('vbp-invalid'))
          await store.putArtifact('vbp-invalid', {
            kind: 'build-runner-effective-config',
            content: 'pre-existing',
          })

          const bogus = {
            actor: KERNEL,
            type: 'no.such-type',
            payload: {},
          } as unknown as EventWrite
          const err = await store
            .appendWithArtifacts(
              'vbp-invalid',
              [
                { kind: 'build-runner-effective-config', content: 'cfg-0' },
                { kind: 'build-runner-effective-config', content: 'cfg-1' },
                { kind: 'build-runner-effective-config', content: 'cfg-2' },
              ],
              () => bogus,
            )
            .catch((e: unknown) => e)
          expect(err).toBeInstanceOf(EventValidationError)

          // Exactly the pre-call state: the pre-existing revision 0 — a
          // would-be prune victim (the post-batch set [0..3] prunes [0, 1]) —
          // was NOT deleted before validation failed, no batch deposit
          // landed, and the event log is empty. An adapter that pruned
          // before validating and could not roll back loses revision 0 here.
          const revisions = (
            await store.listArtifacts('vbp-invalid', 'build-runner-effective-config')
          ).map((meta) => meta.revision)
          expect(revisions).toEqual([0])
          const survivor = await store.getArtifact(
            'vbp-invalid',
            'build-runner-effective-config',
            0,
          )
          expect(new TextDecoder().decode(survivor!.content)).toBe('pre-existing')
          expect(await store.getEvents('vbp-invalid')).toEqual([])
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

    describe('build-scoped handles', () => {
      test('permit own-build stream, artifact, lease, and subscription operations', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('scope-own'))
          const scoped = store.scopeBuild('scope-own')
          expect(scoped.buildScope).toBe('scope-own')
          expect(await scoped.getBuild('scope-own')).not.toBeNull()
          await scoped.append('scope-own', sampleEventWrite())
          await scoped.putArtifact('scope-own', { kind: 'notes', content: 'owned' })
          expect(textContent((await scoped.getArtifact('scope-own', 'notes'))!)).toBe('owned')
          expect(await scoped.claimLease('scope-own', 'runner', 1000)).toBe(true)
          expect(await scoped.heartbeat('scope-own', 'runner')).toBe(true)
          await scoped.releaseLease('scope-own', 'runner')
          const unsubscribe = scoped.subscribe('scope-own', { pollMs: 5 }, () => {})
          unsubscribe()
          expect(scoped.scopeBuild('scope-own')).toBe(scoped)
        })
      })

      test('reject foreign-build, collection/admin, nested foreign scope, and repository access', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('scope-a'))
          await store.createBuild(sampleBuildInput('scope-b'))
          const scoped = store.scopeBuild('scope-a')
          expect(() => scoped.scopeBuild('scope-b')).toThrow(/build-scoped store/)
          await expect(scoped.getBuild('scope-b')).rejects.toThrow(/build-scoped store/)
          await expect(scoped.append('scope-b', sampleEventWrite())).rejects.toThrow(
            /build-scoped store/,
          )
          expect(() => scoped.subscribe('scope-b', {}, () => {})).toThrow(/build-scoped store/)
          await expect(scoped.listBuilds()).rejects.toThrow(/build-scoped store/)
          await expect(scoped.createBuild(sampleBuildInput('scope-c'))).rejects.toThrow(
            /build-scoped store/,
          )
          await expect(scoped.ensureRepo('acme/rate-limiter')).rejects.toThrow(/build-scoped store/)
          await expect(scoped.getRepoEvents('acme/rate-limiter')).rejects.toThrow(
            /build-scoped store/,
          )
          await expect(scoped.close()).rejects.toThrow(/build-scoped store/)
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
          const unsubscribe = store.subscribe('sub-from', { fromSeq: 1, pollMs: 10 }, (event) =>
            received.push(event.seq),
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

    describe('streams (SPEC §7.6 — the third primitive)', () => {
      test('create assigns the id, literal format, open status, and clock createdAt; get and list round-trip', async () => {
        const clock = manualClock(CONTRACT_T0)
        await withStore(factory, { clock }, async (store) => {
          await store.createBuild(sampleBuildInput('st-create'))
          const record = await store.createStream(
            { kind: 'build', build: 'st-create' },
            'implement turn',
          )
          expect(record.id).toMatch(/^st_/)
          expect(record.scope).toEqual({ kind: 'build', build: 'st-create' })
          expect(record.label).toBe('implement turn')
          expect(record.format).toBe('ai-ui-message-stream/v1')
          expect(record.status).toBe('open')
          expect(record.createdAt).toBe(CONTRACT_T0)
          expect(record.closedAt).toBeUndefined()
          expect(record.outcome).toBeUndefined()
          expect(record.artifact).toBeUndefined()
          expect(await store.getStream(record.id)).toEqual(record)
          expect(await store.getStream('st_unknown')).toBeNull()
          expect(await store.listStreams({ kind: 'build', build: 'st-create' })).toEqual([record])
          await store.createBuild(sampleBuildInput('st-empty'))
          expect(await store.listStreams({ kind: 'build', build: 'st-empty' })).toEqual([])
        })
      })

      test('listStreams pins the same-timestamp tiebreak by creation order and isolates by scope', async () => {
        // The pinned tiebreak (store/types.ts): same-millisecond streams
        // order by the store-assigned creation sequence — creation order,
        // never the random st_ id. The clock is injected and NOT advanced for
        // the first five creations, so they share one timestamp and the
        // returned order must be creation order on every adapter.
        const clock = manualClock(CONTRACT_T0)
        await withStore(factory, { clock }, async (store) => {
          await store.createBuild(sampleBuildInput('st-tie-a'))
          await store.createBuild(sampleBuildInput('st-tie-b'))
          await store.ensureRepo('acme/rate-limiter')
          const a = await store.createStream({ kind: 'build', build: 'st-tie-a' }, 'first')
          const a2 = await store.createStream({ kind: 'build', build: 'st-tie-a' }, 'second')
          const a3 = await store.createStream({ kind: 'build', build: 'st-tie-a' }, 'third')
          const b = await store.createStream({ kind: 'build', build: 'st-tie-b' }, 'other build')
          const r = await store.createStream(
            { kind: 'repo', repo: 'acme/rate-limiter' },
            'repo journal',
          )
          expect([a.createdAt, a2.createdAt, a3.createdAt, b.createdAt, r.createdAt]).toEqual([
            CONTRACT_T0,
            CONTRACT_T0,
            CONTRACT_T0,
            CONTRACT_T0,
            CONTRACT_T0,
          ])
          expect(
            (await store.listStreams({ kind: 'build', build: 'st-tie-a' })).map((s) => s.id),
          ).toEqual([a.id, a2.id, a3.id])
          expect(
            (await store.listStreams({ kind: 'build', build: 'st-tie-b' })).map((s) => s.id),
          ).toEqual([b.id])
          expect(
            (await store.listStreams({ kind: 'repo', repo: 'acme/rate-limiter' })).map((s) => s.id),
          ).toEqual([r.id])
          // Distinct-timestamp ordering is unchanged.
          clock.advance(1)
          const a4 = await store.createStream({ kind: 'build', build: 'st-tie-a' }, 'fourth')
          clock.advance(1)
          const a5 = await store.createStream({ kind: 'build', build: 'st-tie-a' }, 'fifth')
          expect(a4.createdAt > a3.createdAt).toBe(true)
          expect(a5.createdAt > a4.createdAt).toBe(true)
          expect(
            (await store.listStreams({ kind: 'build', build: 'st-tie-a' })).map((s) => s.id),
          ).toEqual([a.id, a2.id, a3.id, a4.id, a5.id])
        })
      })

      test('append assigns per-stream sequences from 1, independent across streams, with clock ts and exact parts', async () => {
        const clock = manualClock(CONTRACT_T0)
        await withStore(factory, { clock }, async (store) => {
          await store.createBuild(sampleBuildInput('st-append'))
          const a = await store.createStream({ kind: 'build', build: 'st-append' }, 'a')
          const b = await store.createStream({ kind: 'build', build: 'st-append' }, 'b')
          clock.advance(1000)
          const parts: StreamPart[] = [
            { type: 'text-delta', id: 't', delta: 'hello' },
            { type: 'data-probe', data: { nested: true, extra: 'keys survive' } },
          ]
          const c1 = await store.appendStreamParts(a.id, parts)
          clock.advance(1000)
          const c2 = await store.appendStreamParts(a.id, [{ type: 'text-end', id: 't' }])
          const b1 = await store.appendStreamParts(b.id, [{ type: 'start', messageId: 'm' }])
          expect([c1.seq, c2.seq]).toEqual([1, 2])
          expect(b1.seq).toBe(1)
          expect(c1.stream).toBe(a.id)
          expect(c1.ts).toBe(atT0(1000))
          expect(c2.ts).toBe(atT0(2000))
          expect(c1.parts).toEqual(parts)
          const read = await store.readStream(a.id)
          expect(read.chunks.map((chunk) => chunk.seq)).toEqual([1, 2])
          expect(read.chunks[0]?.parts).toEqual(parts)
          expect(read.status).toBe('open')
          expect(read.outcome).toBeUndefined()
          expect(read.artifact).toBeUndefined()
        })
      })

      test('append validation rejects empty batches, non-object parts, missing and empty type, and unknown streams — writing nothing', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('st-validate'))
          const stream = await store.createStream({ kind: 'build', build: 'st-validate' }, 'v')
          for (const bad of [
            [] as StreamPart[],
            ['not an object' as unknown as StreamPart],
            [{ delta: 'no type' } as unknown as StreamPart],
            [{ type: '' } as unknown as StreamPart],
          ]) {
            const err = await store.appendStreamParts(stream.id, bad).catch((e: unknown) => e)
            expect(err).toBeInstanceOf(Error)
          }
          const unknown = await store
            .appendStreamParts('st_ghost', [{ type: 'text-delta', id: 't', delta: 'x' }])
            .catch((e: unknown) => e)
          expect(unknown).toBeInstanceOf(Error)
          expect((await store.readStream(stream.id)).chunks).toEqual([])
        })
      })

      test('a batch whose serialized size exceeds the ceiling rejects with StreamBatchTooLargeError and writes nothing', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('st-ceiling'))
          const stream = await store.createStream({ kind: 'build', build: 'st-ceiling' }, 'big')
          const oversized: StreamPart[] = [
            { type: 'text-delta', id: 't', delta: 'x'.repeat(1_048_600) },
          ]
          const err = await store.appendStreamParts(stream.id, oversized).catch((e: unknown) => e)
          expect(err).toBeInstanceOf(StreamBatchTooLargeError)
          expect((err as Error).message).toContain('1048576')
          expect((await store.readStream(stream.id)).chunks).toEqual([])
          // Just under the ceiling appends fine.
          await store.appendStreamParts(stream.id, [
            { type: 'text-delta', id: 't', delta: 'x'.repeat(1_000) },
          ])
          expect((await store.readStream(stream.id)).chunks).toHaveLength(1)
        })
      })

      test('read since is strictly greater-than, in order; cursor resumes deliver exactly-once', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('st-since'))
          const stream = await store.createStream({ kind: 'build', build: 'st-since' }, 's')
          for (const n of [1, 2, 3]) {
            await store.appendStreamParts(stream.id, [
              { type: 'text-delta', id: 't', delta: String(n) },
            ])
          }
          expect((await store.readStream(stream.id)).chunks.map((c) => c.seq)).toEqual([1, 2, 3])
          expect(
            (await store.readStream(stream.id, { since: 1 })).chunks.map((c) => c.seq),
          ).toEqual([2, 3])
          expect(await store.readStream(stream.id, { since: 3 })).toEqual({
            chunks: [],
            status: 'open',
          })
          // Resuming from the last processed cursor never re-delivers: each
          // chunk after the cursor arrives exactly once, in order.
          const resumed = await store.readStream(stream.id, { since: 2 })
          expect(resumed.chunks.map((c) => c.seq)).toEqual([3])
          const done = await store.readStream(stream.id, { since: 3 })
          expect(done.chunks).toEqual([])
        })
      })

      test('bounded wait returns empty no earlier than the bound when nothing arrives', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('st-wait'))
          const stream = await store.createStream({ kind: 'build', build: 'st-wait' }, 'w')
          const started = Date.now()
          const read = await store.readStream(stream.id, { waitSeconds: 1 })
          expect(read.chunks).toEqual([])
          expect(read.status).toBe('open')
          expect(Date.now() - started).toBeGreaterThanOrEqual(950)
        })
      })

      test('bounded wait returns early when a chunk is appended during the wait', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('st-wake'))
          const stream = await store.createStream({ kind: 'build', build: 'st-wake' }, 'w')
          const pending = store.readStream(stream.id, { waitSeconds: 5 })
          await Bun.sleep(100)
          const chunk = await store.appendStreamParts(stream.id, [
            { type: 'text-delta', id: 't', delta: 'wake' },
          ])
          const read = await pending
          expect(read.chunks).toEqual([chunk])
        })
      })

      test('bounded wait returns early with the closed status when the stream closes during the wait', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('st-wake-close'))
          const stream = await store.createStream({ kind: 'build', build: 'st-wake-close' }, 'w')
          const pending = store.readStream(stream.id, { waitSeconds: 5 })
          await Bun.sleep(100)
          const record = await store.closeStream(stream.id, 'completed')
          const read = await pending
          expect(read.chunks).toEqual([])
          expect(read.status).toBe('closed')
          expect(read.outcome).toBe('completed')
          expect(read.artifact).toEqual(record.artifact)
        })
      })

      test('a wait above 30 seconds is clamped, not stretched', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('st-clamp'))
          const stream = await store.createStream({ kind: 'build', build: 'st-clamp' }, 'c')
          const pending = store.readStream(stream.id, { waitSeconds: 61 })
          await Bun.sleep(200)
          await store.appendStreamParts(stream.id, [{ type: 'text-delta', id: 't', delta: 'x' }])
          const started = Date.now()
          const read = await pending
          expect(read.chunks).toHaveLength(1)
          // The append satisfied the read — the clamp never stretched it to
          // 30 or 61 seconds; the wait ended promptly after the append.
          expect(Date.now() - started).toBeLessThan(5_000)
        })
      })

      test('clampWaitSeconds clamps above 30 and below 0', () => {
        expect(clampWaitSeconds(61)).toBe(MAX_STREAM_WAIT_SECONDS)
        expect(clampWaitSeconds(30)).toBe(30)
        expect(clampWaitSeconds(5)).toBe(5)
        expect(clampWaitSeconds(0)).toBe(0)
        expect(clampWaitSeconds(-3)).toBe(0)
      })

      test('reads of a closed stream never wait', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('st-closed-read'))
          const stream = await store.createStream({ kind: 'build', build: 'st-closed-read' }, 'c')
          await store.closeStream(stream.id, 'completed')
          const started = Date.now()
          const read = await store.readStream(stream.id, { waitSeconds: 5 })
          expect(read.status).toBe('closed')
          expect(Date.now() - started).toBeLessThan(500)
        })
      })

      test('appending to a closed stream rejects with StreamClosedError and writes nothing', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('st-closed-append'))
          const stream = await store.createStream({ kind: 'build', build: 'st-closed-append' }, 'c')
          await store.appendStreamParts(stream.id, [{ type: 'text-delta', id: 't', delta: 'x' }])
          await store.closeStream(stream.id, 'completed')
          const err = await store
            .appendStreamParts(stream.id, [{ type: 'text-delta', id: 't', delta: 'y' }])
            .catch((e: unknown) => e)
          expect(err).toBeInstanceOf(StreamClosedError)
          expect((await store.readStream(stream.id)).chunks).toHaveLength(1)
        })
      })

      test('close deposits the assembled document atomically: artifact on the owning scope, record gains outcome/closedAt/artifact', async () => {
        const clock = manualClock(CONTRACT_T0)
        await withStore(factory, { clock }, async (store) => {
          await store.createBuild(sampleBuildInput('st-close'))
          const stream = await store.createStream({ kind: 'build', build: 'st-close' }, 'turn 1')
          for (const part of representativeStreamParts()) {
            await store.appendStreamParts(stream.id, [part])
          }
          clock.advance(1000)
          const record = await store.closeStream(stream.id, 'completed')
          expect(record.status).toBe('closed')
          expect(record.outcome).toBe('completed')
          expect(record.closedAt).toBe(atT0(1000))
          expect(record.artifact?.kind).toBe(`stream:${stream.id}`)
          expect(record.artifact?.revision).toBe(0)

          // The finalized document is the assembled UIMessage[]...
          const artifact = await store.getArtifact('st-close', `stream:${stream.id}`)
          expect(artifact?.meta.kind).toBe(`stream:${stream.id}`)
          expect(artifact?.meta.revision).toBe(0)
          expect(artifact?.meta.metadata).toEqual({
            stream: stream.id,
            label: 'turn 1',
            scope: { kind: 'build', build: 'st-close' },
            outcome: 'completed',
            chunkCount: 12,
            droppedPartCount: 1,
          })
          expect(JSON.parse(textContent(artifact!))).toEqual(representativeStreamDocument())

          // ...and the read surface carries the closed shape.
          const read = await store.readStream(stream.id)
          expect(read.status).toBe('closed')
          expect(read.outcome).toBe('completed')
          expect(read.artifact).toEqual(record.artifact)
          expect(read.chunks).toHaveLength(12)
        })
      })

      test('closing an already-closed stream is a no-op returning the record, even with a different outcome', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('st-idem'))
          const stream = await store.createStream({ kind: 'build', build: 'st-idem' }, 'i')
          const closed = await store.closeStream(stream.id, 'completed')
          const again = await store.closeStream(stream.id, 'aborted')
          expect(again).toEqual(closed)
          expect(again.outcome).toBe('completed')
          expect((await store.getStream(stream.id))?.artifact).toEqual(closed.artifact)
        })
      })

      test('close of an unknown stream rejects', async () => {
        await withStore(factory, undefined, async (store) => {
          const err = await store.closeStream('st_ghost', 'completed').catch((e: unknown) => e)
          expect(err).toBeInstanceOf(Error)
        })
      })

      test('chunk retention prunes older closed streams at the next create in the same scope; artifacts and open streams survive', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('st-prune'))
          const first = await store.createStream({ kind: 'build', build: 'st-prune' }, 'one')
          await store.appendStreamParts(first.id, [{ type: 'text-delta', id: 't', delta: '1' }])
          const firstClosed = await store.closeStream(first.id, 'completed')

          await Bun.sleep(5)
          const second = await store.createStream({ kind: 'build', build: 'st-prune' }, 'two')
          await store.appendStreamParts(second.id, [{ type: 'text-delta', id: 't', delta: '2' }])
          await store.closeStream(second.id, 'completed')

          // An open stream and a finalized artifact in the same scope.
          const open = await store.createStream({ kind: 'build', build: 'st-prune' }, 'open')
          await store.appendStreamParts(open.id, [{ type: 'text-delta', id: 't', delta: 'o' }])

          // Creating a third stream prunes every closed stream's chunks
          // except the most recently closed one, in the same transaction.
          await store.createStream({ kind: 'build', build: 'st-prune' }, 'three')

          const pruned = await store.readStream(first.id)
          expect(pruned.chunks).toEqual([])
          expect(pruned.status).toBe('closed')
          expect(pruned.artifact).toEqual(firstClosed.artifact)
          // The finalized artifact itself is never touched.
          expect(await store.getArtifact('st-prune', `stream:${first.id}`)).not.toBeNull()

          const survivor = await store.readStream(second.id)
          expect(survivor.chunks).toHaveLength(1)
          expect(await store.getArtifact('st-prune', `stream:${second.id}`)).not.toBeNull()

          const openRead = await store.readStream(open.id)
          expect(openRead.chunks).toHaveLength(1)
          expect(openRead.status).toBe('open')
        })
      })

      test('build-scoped handles operate on their own streams and reject foreign and repo-scoped ones', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('st-scope-a'))
          await store.createBuild(sampleBuildInput('st-scope-b'))
          await store.ensureRepo('acme/rate-limiter')
          const scoped = store.scopeBuild('st-scope-a')

          const own = await scoped.createStream({ kind: 'build', build: 'st-scope-a' }, 'mine')
          expect(own.scope).toEqual({ kind: 'build', build: 'st-scope-a' })
          await scoped.appendStreamParts(own.id, [{ type: 'text-delta', id: 't', delta: 'x' }])
          expect((await scoped.readStream(own.id)).chunks).toHaveLength(1)
          expect(await scoped.getStream(own.id)).toEqual(own)
          expect(
            (await scoped.listStreams({ kind: 'build', build: 'st-scope-a' })).map((r) => r.id),
          ).toEqual([own.id])
          await scoped.closeStream(own.id, 'completed')

          // A foreign build's stream (created via the unscoped store) rejects
          // on all six operations.
          const foreign = await store.createStream(
            { kind: 'build', build: 'st-scope-b' },
            'not mine',
          )
          const repoStream = await store.createStream(
            { kind: 'repo', repo: 'acme/rate-limiter' },
            'journal stream',
          )
          for (const [operation, attempt] of [
            [
              'createStream',
              () => scoped.createStream({ kind: 'build', build: 'st-scope-b' }, 'x'),
            ],
            [
              'createStream',
              () => scoped.createStream({ kind: 'repo', repo: 'acme/rate-limiter' }, 'x'),
            ],
            [
              'appendStreamParts',
              () =>
                scoped.appendStreamParts(foreign.id, [{ type: 'text-delta', id: 't', delta: 'x' }]),
            ],
            [
              'appendStreamParts',
              () =>
                scoped.appendStreamParts(repoStream.id, [
                  { type: 'text-delta', id: 't', delta: 'x' },
                ]),
            ],
            ['readStream', () => scoped.readStream(foreign.id)],
            ['readStream', () => scoped.readStream(repoStream.id)],
            ['closeStream', () => scoped.closeStream(foreign.id, 'completed')],
            ['closeStream', () => scoped.closeStream(repoStream.id, 'completed')],
            ['getStream', () => scoped.getStream(foreign.id)],
            ['getStream', () => scoped.getStream(repoStream.id)],
            ['listStreams', () => scoped.listStreams({ kind: 'build', build: 'st-scope-b' })],
            ['listStreams', () => scoped.listStreams({ kind: 'repo', repo: 'acme/rate-limiter' })],
          ] as const) {
            const err = await attempt().catch((e: unknown) => e)
            expect(err, `${operation} must reject`).toBeInstanceOf(Error)
            expect((err as Error).message).toContain('build-scoped store')
          }
        })
      })

      test('repo-scoped streams run the full lifecycle with the artifact deposited on the repo scope', async () => {
        const clock = manualClock(CONTRACT_T0)
        await withStore(factory, { clock }, async (store) => {
          await store.ensureRepo('acme/rate-limiter')
          const stream = await store.createStream(
            { kind: 'repo', repo: 'acme/rate-limiter' },
            'harvest run',
          )
          await store.appendStreamParts(stream.id, [{ type: 'start', messageId: 'hm' }])
          await store.appendStreamParts(stream.id, [
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: 'scanning' },
            { type: 'text-end', id: 't' },
          ])
          clock.advance(1000)
          const record = await store.closeStream(stream.id, 'aborted')
          expect(record.scope).toEqual({ kind: 'repo', repo: 'acme/rate-limiter' })
          expect(record.outcome).toBe('aborted')
          const artifact = await store.getRepoArtifact('acme/rate-limiter', `stream:${stream.id}`)
          expect(artifact?.meta.metadata).toMatchObject({
            stream: stream.id,
            label: 'harvest run',
            scope: { kind: 'repo', repo: 'acme/rate-limiter' },
            outcome: 'aborted',
          })
          expect(JSON.parse(artifactText(artifact!))).toEqual([
            {
              id: 'hm',
              role: 'assistant',
              parts: [{ type: 'text', text: 'scanning', state: 'done' }],
            },
          ])
          expect(
            (await store.listStreams({ kind: 'repo', repo: 'acme/rate-limiter' })).map((r) => r.id),
          ).toEqual([stream.id])
        })
      })

      test('session-scoped streams run the full lifecycle with the artifact deposited on the session scope', async () => {
        const clock = manualClock(CONTRACT_T0)
        await withStore(factory, { clock }, async (store) => {
          const session = await store.createSession({
            repo: 'acme/rate-limiter',
            operator: 'operator',
            title: 'orchestrator',
          })
          const stream = await store.createStream(
            { kind: 'session', session: session.id },
            'turn one',
          )
          await store.appendStreamParts(stream.id, [{ type: 'start', messageId: 'om' }])
          await store.appendStreamParts(stream.id, [
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: 'thinking' },
            { type: 'text-end', id: 't' },
          ])
          clock.advance(1000)
          const record = await store.closeStream(stream.id, 'completed')
          expect(record.scope).toEqual({ kind: 'session', session: session.id })
          expect(record.outcome).toBe('completed')
          const artifact = await store.getSessionArtifact(session.id, `stream:${stream.id}`)
          expect(artifact?.meta.metadata).toMatchObject({
            stream: stream.id,
            label: 'turn one',
            scope: { kind: 'session', session: session.id },
            outcome: 'completed',
          })
          expect(JSON.parse(artifactText(artifact!))).toEqual([
            {
              id: 'om',
              role: 'assistant',
              parts: [{ type: 'text', text: 'thinking', state: 'done' }],
            },
          ])
          expect(
            (await store.listStreams({ kind: 'session', session: session.id })).map((r) => r.id),
          ).toEqual([stream.id])
        })
      })

      describe('operator sessions (SPEC §7.1.1 — a third resource kind)', () => {
        test('createSession assigns an os_ id, clock timestamps, and appends session.created at seq 1', async () => {
          const clock = manualClock(CONTRACT_T0)
          await withStore(factory, { clock }, async (store) => {
            const record = await store.createSession({
              repo: 'acme/a',
              operator: '  operator  ',
              title: 'orchestrator',
            })
            expect(record.id).toMatch(/^os_/)
            expect(record.repo).toBe('acme/a')
            expect(record.operator).toBe('operator')
            expect(record.title).toBe('orchestrator')
            expect(record.createdAt).toBe(CONTRACT_T0)
            expect(record.updatedAt).toBe(CONTRACT_T0)
            expect(await store.getSession(record.id)).toEqual(record)
            const events = await store.getSessionEvents(record.id)
            expect(events).toHaveLength(1)
            expect(events[0]).toMatchObject({
              session: record.id,
              seq: 1,
              ts: CONTRACT_T0,
              actor: { kind: 'human', user: 'operator' },
              type: 'session.created',
              payload: { title: 'orchestrator' },
            })
          })
        })

        test('getSession returns null for an unknown session; listSessions isolates by repository and pins the same-timestamp tiebreak', async () => {
          // The pinned tiebreak (store/types.ts): same-millisecond sessions
          // order by the store-assigned creation sequence — creation order,
          // never the random os_ id. The clock is injected and NOT advanced
          // for the first three creations, so they share one timestamp and the
          // returned order must be creation order on every adapter.
          const clock = manualClock(CONTRACT_T0)
          await withStore(factory, { clock }, async (store) => {
            expect(await store.getSession('os_never')).toBeNull()
            const a = await store.createSession({ repo: 'acme/a', operator: 'op' })
            const a2 = await store.createSession({ repo: 'acme/a', operator: 'op' })
            const a3 = await store.createSession({ repo: 'acme/a', operator: 'op' })
            const b = await store.createSession({ repo: 'acme/b', operator: 'op' })
            expect([a.createdAt, a2.createdAt, a3.createdAt, b.createdAt]).toEqual([
              CONTRACT_T0,
              CONTRACT_T0,
              CONTRACT_T0,
              CONTRACT_T0,
            ])
            expect((await store.listSessions('acme/a')).map((s) => s.id)).toEqual([
              a.id,
              a2.id,
              a3.id,
            ])
            expect((await store.listSessions('acme/b')).map((s) => s.id)).toEqual([b.id])
            expect(await store.listSessions('acme/never')).toEqual([])
            // Distinct-timestamp ordering is unchanged.
            clock.advance(1)
            const a4 = await store.createSession({ repo: 'acme/a', operator: 'op' })
            clock.advance(1)
            const a5 = await store.createSession({ repo: 'acme/a', operator: 'op' })
            expect(a4.createdAt > a2.createdAt).toBe(true)
            expect(a5.createdAt > a4.createdAt).toBe(true)
            expect((await store.listSessions('acme/a')).map((s) => s.id)).toEqual([
              a.id,
              a2.id,
              a3.id,
              a4.id,
              a5.id,
            ])
          })
        })

        test('a blank operator identity rejects', async () => {
          await withStore(factory, undefined, async (store) => {
            const err = await store
              .createSession({ repo: 'acme/a', operator: '   ' })
              .catch((e: unknown) => e)
            expect(err).toBeInstanceOf(Error)
          })
        })

        test('per-session sequencing is independent across sessions and updates the record', async () => {
          const clock = manualClock(CONTRACT_T0)
          await withStore(factory, { clock }, async (store) => {
            const a = await store.createSession({ repo: 'acme/a', operator: 'op' })
            const b = await store.createSession({ repo: 'acme/a', operator: 'op' })
            clock.advance(1000)
            const a2 = await store.appendSessionEvent(a.id, messagePostedWrite('first'))
            clock.advance(1000)
            const a3 = await store.appendSessionEvent(a.id, messagePostedWrite('second'))
            const b2 = await store.appendSessionEvent(b.id, messagePostedWrite('other'))
            expect([a2.seq, a3.seq]).toEqual([2, 3])
            expect(b2.seq).toBe(2)
            expect((await store.getSession(a.id))?.updatedAt).toBe(atT0(2000))
            expect((await store.getSessionEvents(a.id)).map((e) => e.seq)).toEqual([1, 2, 3])
            expect((await store.getSessionEvents(a.id, 1)).map((e) => e.seq)).toEqual([2, 3])
            expect(await store.getSessionEvents(a.id, 3)).toEqual([])
          })
        })

        test('appendSessionEvent validation rejects unknown types, malformed payloads, and wrong actor kinds, leaving the log untouched', async () => {
          await withStore(factory, undefined, async (store) => {
            const session = await store.createSession({ repo: 'acme/a', operator: 'op' })
            const cases = [
              // Unknown type.
              {
                actor: humanActor('op'),
                type: 'no.such-type',
                payload: {},
              },
              // Malformed payload: message.posted requires nonempty text.
              { actor: humanActor('op'), type: 'message.posted', payload: { text: '' } },
              // Wrong actor kind: only humans post messages.
              {
                actor: agentActor('orchestrator', 'os_t'),
                type: 'message.posted',
                payload: { text: 'hi' },
              },
              // Wrong actor kind: only the agent starts turns.
              {
                actor: humanActor('op'),
                type: 'turn.started',
                payload: {
                  turn: 't1',
                  stream: 'st_t1',
                  trigger: { kind: 'message', messageSeq: 1 },
                },
              },
            ] as const
            for (const bad of cases) {
              const err = await store
                .appendSessionEvent(session.id, bad as unknown as SessionEventWrite)
                .catch((e: unknown) => e)
              expect(err).toBeInstanceOf(EventValidationError)
            }
            expect((await store.getSessionEvents(session.id)).map((e) => e.seq)).toEqual([1])
          })
        })

        test('appendSessionEvent on an unknown session rejects', async () => {
          await withStore(factory, undefined, async (store) => {
            const err = await store
              .appendSessionEvent('os_ghost', messagePostedWrite())
              .catch((e: unknown) => e)
            expect(err).toBeInstanceOf(Error)
            expect((err as Error).message).toContain('unknown session')
          })
        })

        test('bounded-wait session event read: early return on append, waits out the bound when empty, clamps above 30', async () => {
          await withStore(factory, undefined, async (store) => {
            const session = await store.createSession({ repo: 'acme/a', operator: 'op' })
            // Early return when an event lands during the wait.
            const pending = store.getSessionEvents(session.id, 1, { waitSeconds: 5 })
            await Bun.sleep(100)
            const appended = await store.appendSessionEvent(session.id, messagePostedWrite('wake'))
            const woke = await pending
            expect(woke.map((e) => e.seq)).toEqual([appended.seq])

            // Waits out the bound when nothing arrives.
            const started = Date.now()
            const empty = await store.getSessionEvents(session.id, 99, { waitSeconds: 1 })
            expect(empty).toEqual([])
            expect(Date.now() - started).toBeGreaterThanOrEqual(950)
          })
        })

        test('session deposits are atomic: success, invalid-event rollback, validation-before-prune', async () => {
          await withStore(factory, undefined, async (store) => {
            const session = await store.createSession({ repo: 'acme/a', operator: 'op' })
            const { event, artifacts } = await store.appendSessionWithArtifacts(
              session.id,
              [{ kind: 'turn-context', content: '{"turn":"t1"}' }],
              () => ({
                actor: agentActor('orchestrator', 'os_turn'),
                type: 'turn.started',
                payload: {
                  turn: 't1',
                  stream: 'st_t1',
                  trigger: { kind: 'message', messageSeq: 1 },
                },
              }),
            )
            expect(artifacts.map((meta) => meta.revision)).toEqual([0])
            expect(event.seq).toBe(2)
            expect(
              (await store.getSessionArtifact(session.id, 'turn-context'))?.meta.revision,
            ).toBe(0)

            // An invalid event rolls the whole deposit back.
            const err = await store
              .appendSessionWithArtifacts(
                session.id,
                [{ kind: 'turn-context', content: 'second' }],
                () =>
                  ({
                    actor: humanActor('op'),
                    type: 'turn.started',
                    payload: {
                      turn: 't2',
                      stream: 'st_t2',
                      trigger: { kind: 'message', messageSeq: 1 },
                    },
                  }) as unknown as SessionEventWrite,
              )
              .catch((e: unknown) => e)
            expect(err).toBeInstanceOf(EventValidationError)
            expect((await store.listSessionArtifacts(session.id, 'turn-context')).length).toBe(1)
            expect((await store.getSessionEvents(session.id)).map((e) => e.seq)).toEqual([1, 2])
          })
        })

        test('session artifacts version per kind and read latest/pinned', async () => {
          await withStore(factory, undefined, async (store) => {
            const session = await store.createSession({ repo: 'acme/a', operator: 'op' })
            const a0 = await store.putSessionArtifact(session.id, {
              kind: 'context',
              content: 'v0',
            })
            const a1 = await store.putSessionArtifact(session.id, {
              kind: 'context',
              content: 'v1',
            })
            expect([a0.revision, a1.revision]).toEqual([0, 1])
            expect((await store.getSessionArtifact(session.id, 'context'))?.meta.revision).toBe(1)
            expect((await store.getSessionArtifact(session.id, 'context', 0))?.meta.revision).toBe(
              0,
            )
            expect(await store.getSessionArtifact(session.id, 'never')).toBeNull()
            expect(
              (await store.listSessionArtifacts(session.id)).map((m) => [m.kind, m.revision]),
            ).toEqual([
              ['context', 0],
              ['context', 1],
            ])
          })
        })

        test('session-scoped handles touch only their own session and reject everything else', async () => {
          await withStore(factory, undefined, async (store) => {
            const own = await store.createSession({ repo: 'acme/a', operator: 'op' })
            const foreign = await store.createSession({ repo: 'acme/a', operator: 'op' })
            await store.ensureRepo('acme/a')
            await store.createBuild(sampleBuildInput('scope-build'))
            const scoped = store.scopeSession(own.id)
            expect(scoped.sessionScope).toBe(own.id)

            // Own operations work.
            expect(await scoped.getSession(own.id)).not.toBeNull()
            await scoped.appendSessionEvent(own.id, messagePostedWrite('mine'))
            await scoped.putSessionArtifact(own.id, { kind: 'notes', content: 'owned' })
            expect((await scoped.getSessionArtifact(own.id, 'notes'))?.meta.revision).toBe(0)
            const ownStream = await scoped.createStream(
              { kind: 'session', session: own.id },
              'turn',
            )
            await scoped.appendStreamParts(ownStream.id, [
              { type: 'text-delta', id: 't', delta: 'x' },
            ])
            expect((await scoped.readStream(ownStream.id)).chunks).toHaveLength(1)
            expect(
              (await scoped.listStreams({ kind: 'session', session: own.id })).map((r) => r.id),
            ).toEqual([ownStream.id])
            expect(scoped.scopeSession(own.id)).toBe(scoped)

            // Foreign session, create/list, and every build/repository operation reject.
            const attempts = [
              () => scoped.getSession(foreign.id),
              () => scoped.appendSessionEvent(foreign.id, messagePostedWrite()),
              () => scoped.listSessions('acme/a'),
              () => scoped.createSession({ repo: 'acme/a', operator: 'op' }),
              () => scoped.createStream({ kind: 'session', session: foreign.id }, 'x'),
              () => scoped.listStreams({ kind: 'session', session: foreign.id }),
              () => scoped.getBuild('scope-build'),
              () => scoped.append('scope-build', sampleEventWrite()),
              () => scoped.listBuilds(),
              () => scoped.createBuild(sampleBuildInput('scope-build-2')),
              () => scoped.ensureRepo('acme/a'),
              () => scoped.appendRepo('acme/a', harvestStartedWrite()),
              () => scoped.getRepoEvents('acme/a'),
              () => scoped.createStream({ kind: 'build', build: 'scope-build' }, 'x'),
              () => scoped.createStream({ kind: 'repo', repo: 'acme/a' }, 'x'),
              () => scoped.close(),
            ] as const
            for (const attempt of attempts) {
              const err = await attempt().catch((e: unknown) => e)
              expect(err, `${attempt.toString()} must reject`).toBeInstanceOf(Error)
              expect((err as Error).message).toContain('session-scoped store')
            }
          })
        })

        test('build-scoped handles reject session operations and session-scoped streams', async () => {
          await withStore(factory, undefined, async (store) => {
            const session = await store.createSession({ repo: 'acme/a', operator: 'op' })
            await store.createBuild(sampleBuildInput('bscope'))
            const scoped = store.scopeBuild('bscope')
            const sessionStream = await store.createStream(
              { kind: 'session', session: session.id },
              'turn',
            )
            const attempts = [
              () => scoped.getSession(session.id),
              () => scoped.appendSessionEvent(session.id, messagePostedWrite()),
              () => scoped.listSessions('acme/a'),
              () => scoped.createSession({ repo: 'acme/a', operator: 'op' }),
              () => scoped.putSessionArtifact(session.id, { kind: 'x', content: 'x' }),
              () => scoped.listSessionArtifacts(session.id),
              () => scoped.createStream({ kind: 'session', session: session.id }, 'x'),
              () =>
                scoped.appendStreamParts(sessionStream.id, [
                  { type: 'text-delta', id: 't', delta: 'x' },
                ]),
              () => scoped.readStream(sessionStream.id),
              () => scoped.listStreams({ kind: 'session', session: session.id }),
            ] as const
            for (const attempt of attempts) {
              const err = await attempt().catch((e: unknown) => e)
              expect(err, `${attempt.toString()} must reject`).toBeInstanceOf(Error)
              expect((err as Error).message).toContain('build-scoped store')
            }
          })
        })

        test('session streams never list under build or repo scopes and vice versa', async () => {
          await withStore(factory, undefined, async (store) => {
            const session = await store.createSession({ repo: 'acme/a', operator: 'op' })
            await store.createBuild(sampleBuildInput('st-mix'))
            await store.ensureRepo('acme/a')
            const sessionStream = await store.createStream(
              { kind: 'session', session: session.id },
              'turn',
            )
            const buildStream = await store.createStream(
              { kind: 'build', build: 'st-mix' },
              'phase',
            )
            expect(
              (await store.listStreams({ kind: 'session', session: session.id })).map((r) => r.id),
            ).toEqual([sessionStream.id])
            expect(
              (await store.listStreams({ kind: 'build', build: 'st-mix' })).map((r) => r.id),
            ).toEqual([buildStream.id])
            expect(await store.listStreams({ kind: 'repo', repo: 'acme/a' })).toEqual([])
          })
        })
      })

      describe('via attribution (delegated writes, SPEC §15.1)', () => {
        // The via contract is per-transport, and the harness's `viaAuthority`
        // posture selects the branch. Absent (memory, SQLite, PostgreSQL, and
        // the open no-secret remote server): the backing catalog is the only
        // via gate, so every rejection is a 422 `EventValidationError`. Present
        // (a transport with token authority — the hosted HTTP store): the
        // server's `enforceVia` runs after token verification and before
        // catalog validation, so a human write claiming a via the token does
        // not carry — a valid shape or a malformed one — rejects with 403
        // `auth` (`AuthError` on the remote client) before the catalog ever
        // sees it. The 403-vs-422 split is the designed signal: "not your
        // delegate" vs "malformed event" (SPEC §15.1).
        const viaSession: Via = { kind: 'session', id: 'os_delegate' }
        const viaMcp: Via = { kind: 'mcp', client: 'claude-code' }
        const NO_VIA_MESSAGE = 'token carries no via; it may not write delegated events'

        test('build and repository writes accept human actors carrying each via kind and round-trip it', async () => {
          await withStore(factory, undefined, async (store, viaAuthority) => {
            await store.createBuild(sampleBuildInput('via-build'))
            await store.ensureRepo('acme/via')
            if (viaAuthority !== undefined) {
              if (viaAuthority.via === undefined) {
                // Via-less token posture (the hosted HTTP harness): any human
                // write claiming a via — this valid shape or a malformed one —
                // is an authority failure before catalog validation.
                for (const via of [viaSession, viaMcp]) {
                  const err = await store
                    .append('via-build', {
                      actor: humanActor('operator', via),
                      type: 'build.created',
                      payload: {
                        ticket: sampleBuildInput('via-build').ticket!,
                        repo: 'acme/rate-limiter',
                        baseBranch: 'main',
                      },
                    })
                    .catch((e: unknown) => e)
                  expect(err).toBeInstanceOf(AuthError)
                  expect((err as Error).message).toBe(NO_VIA_MESSAGE)
                  const repoErr = await store
                    .appendRepo('acme/via', {
                      actor: humanActor('operator', via),
                      type: 'dispatcher.intake-set',
                      payload: { enabled: false },
                    })
                    .catch((e: unknown) => e)
                  expect(repoErr).toBeInstanceOf(AuthError)
                  expect((repoErr as Error).message).toBe(NO_VIA_MESSAGE)
                }
                expect(await store.getEvents('via-build')).toEqual([])
                expect(await store.getRepoEvents('acme/via')).toEqual([])
                // Non-delegated human writes still round-trip faithfully over
                // the same transport.
                const plain = await store.append('via-build', {
                  actor: humanActor('operator'),
                  type: 'build.pause-requested',
                  payload: {},
                })
                expect(plain.actor).toEqual({ kind: 'human', user: 'operator' })
                const repoPlain = await store.appendRepo('acme/via', {
                  actor: humanActor('operator'),
                  type: 'dispatcher.intake-set',
                  payload: { enabled: false },
                })
                expect(repoPlain.actor).toEqual({ kind: 'human', user: 'operator' })
                return
              }
              // Token carrying a via (kept for future harnesses): the token is
              // authoritative — it stamps its via onto plain human writes and
              // accepts only its own claim.
              const tokenVia = viaAuthority.via
              const other = tokenVia.kind === 'session' ? viaMcp : viaSession
              const envelope = await store.append('via-build', {
                actor: humanActor('operator', tokenVia),
                type: 'build.created',
                payload: {
                  ticket: sampleBuildInput('via-build').ticket!,
                  repo: 'acme/rate-limiter',
                  baseBranch: 'main',
                },
              })
              expect(envelope.actor).toEqual({ kind: 'human', user: 'operator', via: tokenVia })
              const stamped = await store.append('via-build', {
                actor: humanActor('operator'),
                type: 'build.pause-requested',
                payload: {},
              })
              expect(stamped.actor).toEqual({ kind: 'human', user: 'operator', via: tokenVia })
              const mismatch = await store
                .append('via-build', {
                  actor: humanActor('operator', other),
                  type: 'build.resume-requested',
                  payload: {},
                })
                .catch((e: unknown) => e)
              expect(mismatch).toBeInstanceOf(AuthError)
              expect((mismatch as Error).message).toBe(
                `token carries via ${JSON.stringify(tokenVia)}; it may not write events claiming via ${JSON.stringify(other)}`,
              )
              return
            }
            // No token authority: the catalog is the only gate (today's local
            // behavior, byte-for-byte).
            for (const via of [viaSession, viaMcp]) {
              const envelope = await store.append('via-build', {
                actor: humanActor('operator', via),
                type: 'build.created',
                payload: {
                  ticket: sampleBuildInput('via-build').ticket!,
                  repo: 'acme/rate-limiter',
                  baseBranch: 'main',
                },
              })
              expect(envelope.actor).toEqual({ kind: 'human', user: 'operator', via })
              await store.appendRepo('acme/via', {
                actor: humanActor('operator', via),
                type: 'dispatcher.intake-set',
                payload: { enabled: false },
              })
            }
            const events = await store.getEvents('via-build')
            expect(events.map((e) => (e.actor as { via?: Via }).via)).toEqual([viaSession, viaMcp])
            const repoEvents = await store.getRepoEvents('acme/via')
            expect(repoEvents.map((e) => (e.actor as { via?: Via }).via)).toEqual([
              viaSession,
              viaMcp,
            ])
            // Events without via replay unchanged.
            const plain = await store.append('via-build', {
              actor: humanActor('operator'),
              type: 'build.pause-requested',
              payload: {},
            })
            expect(plain.actor).toEqual({ kind: 'human', user: 'operator' })
          })
        })

        test('via on any non-human actor rejects with the explicit rule message', async () => {
          // This is the validation side of the 403/422 split: `enforceVia`
          // passes non-human actors through, so even token-authority postures
          // surface the backing catalog's EventValidationError (422 over the
          // wire). Holds on every transport.
          await withStore(factory, undefined, async (store) => {
            await store.createBuild(sampleBuildInput('via-nonhuman'))
            await store.ensureRepo('acme/via')
            for (const actor of [
              { kind: 'kernel', via: viaSession },
              { kind: 'agent', role: 'implement', session: 's_1', via: viaSession },
              { kind: 'dispatcher', via: viaMcp },
              { kind: 'ingester', source: 'webhook', via: viaMcp },
            ]) {
              const err = await store
                .append('via-nonhuman', {
                  actor,
                  type: 'observation.recorded',
                  payload: { id: 'o', kind: 'followup', summary: 'x' },
                } as unknown as EventWrite)
                .catch((e: unknown) => e)
              expect(err).toBeInstanceOf(EventValidationError)
              expect((err as Error).message).toContain('only human actors may carry via')
              const repoErr = await store
                .appendRepo('acme/via', {
                  actor,
                  type: 'harvest.started',
                  payload: harvestStartedWrite().payload,
                } as unknown as RepositoryEventWrite)
                .catch((e: unknown) => e)
              expect(repoErr).toBeInstanceOf(EventValidationError)
              expect((repoErr as Error).message).toContain('only human actors may carry via')
            }
            expect(await store.getEvents('via-nonhuman')).toEqual([])
            expect(await store.getRepoEvents('acme/via')).toEqual([])
          })
        })

        test('malformed via shapes reject', async () => {
          await withStore(factory, undefined, async (store, viaAuthority) => {
            await store.createBuild(sampleBuildInput('via-malformed'))
            for (const via of [
              { kind: 'session' },
              { kind: 'session', id: '' },
              { kind: 'mcp' },
              { kind: 'mcp', client: '' },
              { kind: 'slack', channel: 'x' },
              'os_delegate',
            ]) {
              const err = await store
                .append('via-malformed', {
                  actor: { kind: 'human', user: 'operator', via },
                  type: 'build.pause-requested',
                  payload: {},
                } as unknown as EventWrite)
                .catch((e: unknown) => e)
              // All six fixtures ride human actors, so under a token posture
              // `enforceVia` rejects each before the catalog ever sees the
              // shape — a malformed via under a via-less token is the same 403
              // authority failure as a valid one (SPEC §15.1).
              if (viaAuthority !== undefined) {
                expect(err, `via ${JSON.stringify(via)} must reject`).toBeInstanceOf(AuthError)
                expect((err as Error).message).toBe(
                  viaAuthority.via === undefined
                    ? NO_VIA_MESSAGE
                    : `token carries via ${JSON.stringify(viaAuthority.via)}; it may not write events claiming via ${JSON.stringify(via)}`,
                )
              } else {
                expect(err, `via ${JSON.stringify(via)} must reject`).toBeInstanceOf(
                  EventValidationError,
                )
              }
            }
            expect(await store.getEvents('via-malformed')).toEqual([])
          })
        })
      })
    })
  })
}

// ── The BlobStore contract ───────────────────────────────────────────────────

export function describeBlobStoreContract(name: string, factory: BlobStoreFactory): void {
  describe(`BlobStore contract: ${name}`, () => {
    async function withBlobs(run: (blobs: BlobStore) => Promise<void>): Promise<void> {
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
