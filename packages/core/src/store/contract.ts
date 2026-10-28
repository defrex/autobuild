import { repositoryReadFactsReducer } from '../kernel/read-facts'
import { validateReducerValue } from './reducer-value-validation'
import { READ_CATALOG_IDENTITY } from '../events/compatibility'
import { AUTOBUILD_VERSION } from './remote/version'
import { sameParentRejection } from '../kernel/node-restack-state'
import { readBuildFacts, readBuildSelector, readRepositoryFacts } from './reduced-reads'
import { REDUCERS } from '../kernel/reducer-registry'
import { resolveReducerValue } from './reducer-values'
import { prepareAssetSnapshots } from './ticket-asset-snapshots'
import { MemoryBuildStore } from './memory'
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
import { reduceBuild } from '../kernel/reducer'
import { reduceDispatchSettings } from '../kernel/dispatch-settings'
import { projectRepositoryStateEvents } from './repo-state-events'
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

/** Delivery wait for the §7.2 subscribe tests: poll the predicate every 5 ms
 * and fail with `message` only if it never turns true within `deadlineMs`.
 * Replaces fixed 50 ms sleeps that bet on delivery landing inside a
 * wall-clock window — over real HTTP + Postgres round-trips the first poll
 * can land past any small window, while a genuinely broken delivery path
 * still fails at the deadline. */
async function waitForDelivery(
  predicate: () => boolean,
  message: string,
  deadlineMs = 10_000,
): Promise<void> {
  const deadline = performance.now() + deadlineMs
  while (!predicate()) {
    if (performance.now() > deadline) {
      throw new Error(`timed out waiting for ${message}`)
    }
    await Bun.sleep(5)
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
    test('operator presence is concurrent, renewable advisory liveness without journal writes', async () => {
      const clock = manualClock()
      await withStore(factory, { clock }, async (store) => {
        const repo = 'presence-repo'
        const identity = { id: 'a', host: 'host-a', pid: 42, startedAt: clock().toISOString() }
        expect(await store.listOperatorPresence(repo)).toEqual([])
        expect(await store.getRepo(repo)).toBeNull()
        const initial = await store.upsertOperatorPresence(repo, identity)
        expect(initial).toEqual({ ...identity, repo, heartbeatAt: clock().toISOString() })
        expect(await store.getRepo(repo)).toBeNull()
        expect(await store.listOperatorPresence('foreign-repo')).toEqual([])
        await store.ensureRepo(repo)
        await store.createBuild({ slug: 'presence-build', repo })
        await store.claimRepoLease(repo, 'dispatcher', 900_000)
        const repository = await store.getRepo(repo)
        const events = await store.getRepoEvents(repo)
        const buildEvents = await store.getEvents('presence-build')
        clock.advance(299_999)
        expect(await store.listOperatorPresence(repo)).toHaveLength(1)
        clock.advance(1)
        expect(await store.listOperatorPresence(repo)).toEqual([])
        const [revived] = await Promise.all([
          store.upsertOperatorPresence(repo, {
            ...identity,
            pid: 43,
            startedAt: clock().toISOString(),
          }),
          store.upsertOperatorPresence(repo, { ...identity, id: 'b', host: 'host-b' }),
          store.upsertOperatorPresence(repo, identity),
        ])
        expect(revived.startedAt).toBe(identity.startedAt)
        expect((await store.listOperatorPresence(repo)).map((row) => row.id)).toEqual(['a', 'b'])
        expect(await store.getRepo(repo)).toEqual(repository)
        expect(await store.getRepoEvents(repo)).toEqual(events)
        expect(await store.getEvents('presence-build')).toEqual(buildEvents)
        clock.advance(300_000)
        expect(await store.listOperatorPresence(repo)).toEqual([])
      })
    })

    test('operator withdrawal is idempotent, isolated and permits re-registration without journal writes', async () => {
      const clock = manualClock()
      await withStore(factory, { clock }, async (store) => {
        const identity = { id: 'one', host: 'host', pid: 1, startedAt: clock().toISOString() }
        await store.upsertOperatorPresence('withdraw', identity)
        await store.upsertOperatorPresence('withdraw', { ...identity, id: 'two' })
        await store.upsertOperatorPresence('other', identity)
        await store.ensureRepo('withdraw')
        await store.claimRepoLease('withdraw', 'dispatcher', 900_000)
        const before = await store.getRepo('withdraw')
        const events = await store.getRepoEvents('withdraw')
        await store.removeOperatorPresence('withdraw', 'one')
        await store.removeOperatorPresence('withdraw', 'one')
        await store.removeOperatorPresence('unknown', 'one')
        expect(await store.getRepo('unknown')).toBeNull()
        expect((await store.listOperatorPresence('withdraw')).map((row) => row.id)).toEqual(['two'])
        expect(await store.listOperatorPresence('other')).toHaveLength(1)
        await store.upsertOperatorPresence('withdraw', identity)
        expect((await store.listOperatorPresence('withdraw')).map((row) => row.id)).toEqual([
          'one',
          'two',
        ])
        clock.advance(300_000)
        await store.removeOperatorPresence('withdraw', 'one')
        await store.removeOperatorPresence('withdraw', 'two')
        expect(await store.listOperatorPresence('withdraw')).toEqual([])
        const restartedAt = clock().toISOString()
        expect(
          (await store.upsertOperatorPresence('withdraw', { ...identity, startedAt: restartedAt }))
            .startedAt,
        ).toBe(restartedAt)
        expect(await store.getRepo('withdraw')).toEqual(before)
        expect(await store.getRepoEvents('withdraw')).toEqual(events)
      })
    })

    test('operator presence validates identity before mutation', async () => {
      await withStore(factory, undefined, async (store) => {
        const identity = { id: 'ok', host: 'host', pid: 1, startedAt: CONTRACT_T0 }
        for (const bad of [
          { id: '' },
          { host: '' },
          { pid: 0 },
          { pid: 1.5 },
          { startedAt: 'bad' },
          { id: 'x'.repeat(257) },
        ]) {
          await expect(
            store.upsertOperatorPresence('invalid-presence', { ...identity, ...bad }),
          ).rejects.toThrow()
        }
        expect(await store.listOperatorPresence('invalid-presence')).toEqual([])
      })
    })
    test('concurrent repository reads and appends return exact committed prefixes', async () => {
      await withStore(factory, undefined, async (store) => {
        const repo = 'prefix-probe'
        await store.ensureRepo(repo)
        for (let i = 0; i < 8; i++) {
          const [first, , second] = await Promise.all([
            readRepositoryFacts(store, repo),
            store.appendRepo(repo, {
              actor: DISPATCHER,
              type: 'dispatcher.ticket-source-degraded',
              payload: {
                source: 'linear',
                operation: 'ready-scan',
                cause: 'rate-limited',
                message: 'limited',
                resetAt: '2026-10-20T20:00:00.000Z',
              },
            }),
            readRepositoryFacts(store, repo),
          ])
          const events = await store.getRepoEvents(repo)
          for (const answer of [first, second]) {
            expect(validateReducerValue('repositoryReadFacts', answer.value)).toBe(true)
            const acc = repositoryReadFactsReducer.advance(
              repositoryReadFactsReducer.initial(),
              events.slice(0, answer.cursor),
            )
            expect(answer.value).toEqual(repositoryReadFactsReducer.finish(acc))
          }
        }
      })
    })
    test('ticket scan checkpoint CAS is isolated, validated and does not invalidate journal reads', async () => {
      await withStore(factory, {}, async (store) => {
        const repo = 'scan-checkpoint'
        const a = { startedAt: '2026-01-01T00:00:00.000Z', anchor: 'a'.repeat(64) }
        const b = { ...a, startedAt: '2026-01-01T00:01:00.000Z' }
        expect(await store.getRepoTicketScanCheckpoint(repo)).toBeNull()
        expect(await store.getRepo(repo)).toBeNull()
        expect(await store.compareAndSetRepoTicketScanCheckpoint(repo, null, a)).toBe(false)
        await store.ensureRepo(repo)
        const record = await store.getRepo(repo)
        const highWater = await store.getRepoHighWater(repo)
        const position = await store.getRepoChangePosition(repo)
        expect(await store.compareAndSetRepoTicketScanCheckpoint(repo, null, a)).toBe(true)
        expect(await store.compareAndSetRepoTicketScanCheckpoint(repo, null, b)).toBe(false)
        expect(await store.compareAndSetRepoTicketScanCheckpoint(repo, a, b)).toBe(true)
        expect(await store.compareAndSetRepoTicketScanCheckpoint(repo, a, a)).toBe(false)
        expect(await store.getRepoTicketScanCheckpoint(repo)).toEqual(b)
        expect(await store.getRepoTicketScanCheckpoint('other')).toBeNull()
        await expect(
          store.compareAndSetRepoTicketScanCheckpoint(repo, b, { ...a, anchor: 'invalid' }),
        ).rejects.toThrow()
        await expect(
          store.compareAndSetRepoTicketScanCheckpoint(repo, { ...a, startedAt: 'bad' }, b),
        ).rejects.toThrow()
        expect(await store.getRepo(repo)).toEqual(record)
        expect(await store.getRepoHighWater(repo)).toEqual(highWater)
        expect(await store.getRepoChangePosition(repo)).toEqual(position)
        await store.ensureRepo('scan-race')
        const winners = await Promise.all([
          store.compareAndSetRepoTicketScanCheckpoint('scan-race', null, a),
          store.compareAndSetRepoTicketScanCheckpoint('scan-race', null, b),
        ])
        expect(winners.filter(Boolean)).toHaveLength(1)
        expect(await store.getRepoTicketScanCheckpoint('scan-race')).toEqual(winners[0] ? a : b)
        await expect(
          store.compareAndSetRepoTicketScanCheckpoint(repo, b, null as never),
        ).rejects.toThrow()
      })
    })

    describe('builds', () => {
      test('parent rejection deduplication survives persisted payload and snapshot key order', async () => {
        await withStore(factory, undefined, async (store) => {
          const input = sampleBuildInput('parent-diagnostic')
          await store.createBuild(input)
          const rejection = {
            revision: 'revision',
            target: 'missing',
            reason: 'target does not exist',
          }
          await store.append(input.slug, {
            actor: DISPATCHER,
            type: 'node.parent-rejected',
            payload: rejection,
          })
          const previous = (await readBuildFacts(store, input.slug)).value.state.nodeRestack!
            .parentRejection
          expect(sameParentRejection(previous, rejection)).toBe(true)
          const replayed = reduceBuild(await store.getEvents(input.slug)).nodeRestack!
            .parentRejection
          expect(sameParentRejection(replayed, rejection)).toBe(true)
          // Also model a differently ordered transport even on adapters whose
          // native serialization happens to retain insertion order.
          expect(
            sameParentRejection(
              { reason: previous!.reason, target: previous!.target, revision: previous!.revision },
              rejection,
            ),
          ).toBe(true)
          const before = (await store.getEvents(input.slug)).length
          if (!sameParentRejection(previous, rejection))
            await store.append(input.slug, {
              actor: DISPATCHER,
              type: 'node.parent-rejected',
              payload: rejection,
            })
          expect((await store.getEvents(input.slug)).length).toBe(before)
          for (const changed of [
            { ...rejection, revision: 'new' },
            { ...rejection, target: null },
            { ...rejection, reason: 'node closed' },
          ])
            expect(sameParentRejection(previous, changed)).toBe(false)
          await store.append(input.slug, {
            actor: DISPATCHER,
            type: 'node.parent-rejection-cleared',
            payload: { revision: 'corrected', target: null },
          })
          expect(
            (await readBuildFacts(store, input.slug)).value.state.nodeRestack!.parentRejection,
          ).toBeUndefined()
          expect(
            (await store.getEvents(input.slug)).filter((e) => e.type === 'node.parent-rejected'),
          ).toHaveLength(1)
        })
      })

      test('integration facts replay through cached reads and digests without a runner', async () => {
        await withStore(factory, undefined, async (store) => {
          const input = sampleBuildInput('integration-node')
          await store.createBuild({
            ...input,
            branch: 'ab-node/integration-node',
            created: {
              actor: DISPATCHER,
              type: 'build.created',
              payload: {
                ticket: input.ticket!,
                repo: input.repo,
                baseBranch: 'main',
                kind: 'node',
                target: { ticket: { source: 'file', id: 'parent' }, build: 'parent-build' },
              },
            },
          })
          await store.append(input.slug, {
            actor: DISPATCHER,
            type: 'node.opening',
            payload: { branch: 'ab-node/integration-node', parent: 'main', sha: 'opening' },
          })
          await readBuildFacts(store, input.slug)
          await store.append(input.slug, {
            actor: DISPATCHER,
            type: 'node.opened',
            payload: { sha: 'opening' },
          })
          await store.append(input.slug, {
            actor: DISPATCHER,
            type: 'node.compared',
            payload: { parentSha: 'parent', headSha: 'opening', ahead: 0 },
          })
          const current = (await readBuildFacts(store, input.slug)).value.state
          expect(current).toEqual(reduceBuild(await store.getEvents(input.slug)))
          expect(current.status).toBe('collecting')
          expect(current.target?.build).toBe('parent-build')
          expect((await store.getRepoBuildDigests(input.repo)).get(input.slug)).toMatchObject({
            kind: 'node',
            nodeOpened: true,
          })
          await store.append(input.slug, {
            actor: DISPATCHER,
            type: 'pr.opened',
            payload: {
              pr: { number: 1, url: 'https://example.test/pr/1', headSha: 'child' },
            },
          })
          await store.append(input.slug, { actor: DISPATCHER, type: 'pr.closed', payload: {} })
          expect((await store.getRepoBuildDigests(input.repo)).get(input.slug)?.prClosed).toBe(true)
          expect((await store.getBuild(input.slug))?.lease).toBeUndefined()
        })
      })

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

      test('createBuild appends an initial build.created as seq 1, atomically with the record', async () => {
        await withStore(factory, undefined, async (store) => {
          const created = buildCreatedWrite()
          await store.createBuild({ ...sampleBuildInput('with-created'), created })
          const events = await store.getEvents('with-created')
          expect(events.map((event) => [event.seq, event.type])).toEqual([[1, 'build.created']])
          expect(events[0]?.payload).toEqual(created.payload)
          expect(events[0]?.actor).toEqual(created.actor)
          // The next append continues the stream.
          const next = await store.append('with-created', {
            actor: DISPATCHER,
            type: 'build.created',
            payload: created.payload,
          })
          expect(next.seq).toBe(2)
        })
      })

      test('createBuild rejects an invalid or non-build.created initial event and creates nothing', async () => {
        await withStore(factory, undefined, async (store) => {
          await expect(
            store.createBuild({
              ...sampleBuildInput('bad-created'),
              created: { actor: DISPATCHER, type: 'build.created', payload: { nope: 1 } } as never,
            }),
          ).rejects.toThrow()
          await expect(
            store.createBuild({
              ...sampleBuildInput('wrong-type'),
              created: { actor: DISPATCHER, type: 'build.completed', payload: {} } as never,
            }),
          ).rejects.toThrow()
          expect(await store.getBuild('bad-created')).toBeNull()
          expect(await store.getBuild('wrong-type')).toBeNull()
          // The slug is still free, so a valid create succeeds.
          await store.createBuild({
            ...sampleBuildInput('bad-created'),
            created: buildCreatedWrite(),
          })
          expect((await store.getEvents('bad-created')).length).toBe(1)
        })
      })

      test('a duplicate slug with an initial event leaves the first build untouched', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild({
            ...sampleBuildInput('dupe-created'),
            created: buildCreatedWrite(),
          })
          await expect(
            store.createBuild({
              ...sampleBuildInput('dupe-created'),
              created: buildCreatedWrite(),
            }),
          ).rejects.toThrow()
          expect((await store.getEvents('dupe-created')).length).toBe(1)
        })
      })

      test('getBuild returns null for an unknown slug', async () => {
        await withStore(factory, undefined, async (store) => {
          expect(await store.getBuild('never-created')).toBeNull()
        })
      })

      test('optional repo listing preserves records and order without creating journals', async () => {
        const clock = manualClock()
        await withStore(factory, { clock }, async (store) => {
          const repo = "acme/quote'repo"
          await store.createBuild(sampleBuildInput('scoped-old', { repo }))
          clock.advance(1000)
          await store.createBuild(sampleBuildInput('scoped-z', { repo }))
          await store.createBuild(sampleBuildInput('foreign', { repo: 'other' }))
          await store.createBuild(sampleBuildInput('scoped-a', { repo }))
          const before = await store.listBuilds()
          expect(await store.listBuildsForRepo(repo)).toEqual(
            ['scoped-old', 'scoped-a', 'scoped-z'].map(
              (slug) => before.find((b) => b.slug === slug)!,
            ),
          )
          expect(await store.listBuildsForRepo('unknown')).toEqual([])
          await store.ensureRepo('empty-journal')
          const journal = await store.getRepo('empty-journal')
          expect(await store.listBuildsForRepo('empty-journal')).toEqual([])
          expect(await store.getRepo('empty-journal')).toEqual(journal)
          expect(await store.getRepo(repo)).toBeNull()
          expect(await store.getRepo('unknown')).toBeNull()
          expect(await store.listBuilds()).toEqual(before)
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

    describe('build digests (repo-scoped batch read, AUT-487)', () => {
      test('compact admission evidence retains merge SHAs and recovered node contributions', async () => {
        await withStore(factory, undefined, async (store) => {
          const repo = 'acme/dg-presence'
          const slug = 'dg-presence'
          await store.createBuild(sampleBuildInput(slug, { repo }))
          const sha = 'a'.repeat(40)
          const merged = await store.append(slug, {
            actor: DISPATCHER,
            type: 'pr.merged',
            payload: { sha, buildTrailerPresent: false },
          })
          expect((await store.getRepoBuildDigests(repo)).get(slug)).toMatchObject({
            mergedSha: sha,
            readinessChangeSeq: merged.seq,
          })
          const contribution = {
            landing: sha,
            head: 'b'.repeat(40),
            base: 'c'.repeat(40),
            identities: ['build:child'],
          }
          const recovered = await store.append(slug, {
            actor: DISPATCHER,
            type: 'node.contribution-recorded',
            payload: contribution,
          })
          const digest = (await store.getRepoBuildDigests(repo)).get(slug)!
          expect(digest).toMatchObject({
            mergedSha: sha,
            nodeContribution: contribution,
            readinessChangeSeq: recovered.seq,
          })
          digest.nodeContribution!.identities.push('build:mutated')
          expect(
            (await store.getRepoBuildDigests(repo)).get(slug)!.nodeContribution!.identities,
          ).toEqual(['build:child'])
        })
      })

      test('pending integration audits survive completion and clear on settlement', async () => {
        await withStore(factory, undefined, async (store) => {
          const repo = 'acme/audit-digest'
          const slug = 'audit-digest'
          await store.createBuild(sampleBuildInput(slug, { repo }))
          const pending = async () =>
            (await store.getRepoBuildDigests(repo)).get(slug)?.integrationAuditPending
          expect(await pending()).toBeUndefined()
          await store.append(slug, {
            actor: DISPATCHER,
            type: 'integration.landed',
            payload: {
              operation: 'landing-1',
              head: 'head',
              landed: 'landed',
              provenance: 'kernel',
              verified: true,
              fenced: false,
            },
          })
          await store.append(slug, {
            actor: DISPATCHER,
            type: 'build.completed',
            payload: { outcome: 'merged' },
          })
          expect(await pending()).toBe(true)
          await store.append(slug, {
            actor: DISPATCHER,
            type: 'integration.audited',
            payload: {
              operation: 'landing-1',
              verifiedTree: 'tree',
              landedTree: 'tree',
              identities: [],
            },
          })
          expect(await pending()).toBeUndefined()
        })
      })

      test('an unknown repo and a journal-less repo answer build-less maps without writes', async () => {
        await withStore(factory, undefined, async (store) => {
          expect(await store.getRepoBuildDigests('acme/never-seen')).toEqual(new Map())
          // The operation is keyed to build records, not the repository
          // journal record: builds created without `ensureRepo` still digest
          // (the remote route answers before the repo-existence gate).
          await store.createBuild(sampleBuildInput('dg-no-journal', { repo: 'acme/no-journal' }))
          const digests = await store.getRepoBuildDigests('acme/no-journal')
          expect([...digests.keys()]).toEqual(['dg-no-journal'])
          expect(digests.get('dg-no-journal')).toEqual({
            slug: 'dg-no-journal',
            observations: [],
          })
          // Read-only: no journal record was implicitly created.
          expect(await store.getRepo('acme/no-journal')).toBeNull()
          expect(await store.getRepo('acme/never-seen')).toBeNull()
        })
      })
      test('one entry per repo build — including a build with no digest-relevant events — and only that repo', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('dg-a', { repo: 'acme/dga' }))
          await store.createBuild(sampleBuildInput('dg-other', { repo: 'acme/dgb' }))
          // A freshly created queued build whose log holds none of the
          // digest-relevant event types keeps its contractual entry — a join
          // that started from the events side would silently drop it.
          const digests = await store.getRepoBuildDigests('acme/dga')
          expect([...digests.keys()]).toEqual(['dg-a'])
          expect(digests.get('dg-a')).toEqual({ slug: 'dg-a', observations: [] })
          const other = await store.getRepoBuildDigests('acme/dgb')
          expect([...other.keys()]).toEqual(['dg-other'])
        })
      })

      test('accepted targets and relaunch requests survive validated reductions and neutral settlement', async () => {
        await withStore(factory, undefined, async (store) => {
          const slug = 'relaunch-contract'
          await store.createBuild(sampleBuildInput(slug))
          await store.append(slug, buildCreatedWrite())
          const runtime = {
            version: '1',
            commit: 'unknown',
            source: { kind: 'package' as const, location: '/old' },
          }
          const targetRuntime = { ...runtime, source: { ...runtime.source, location: '/new' } }
          await store.append(slug, {
            actor: DISPATCHER,
            type: 'execution.started',
            payload: { provider: 'local', workspaceRef: 'w', instance: 'i' },
          })
          await store.append(slug, {
            actor: DISPATCHER,
            type: 'execution.drain-authorized',
            payload: { instance: 'i', correlation: 'h', run: 'old', runtime, targetRuntime },
          })
          const request = { instance: 'i', correlation: 'h', from: runtime, to: targetRuntime }
          await store.append(slug, {
            actor: KERNEL,
            type: 'execution.relaunch-requested',
            payload: request,
          })
          expect(
            (await readBuildFacts(store, slug)).value.state.drainingExecutions?.i?.relaunch,
          ).toEqual(request)
          await store.append(slug, {
            actor: DISPATCHER,
            type: 'execution.ended',
            payload: { instance: 'i', workspaceRef: 'w', outcome: 'relaunch', exitCode: 0 },
          })
          const facts = (await readBuildFacts(store, slug)).value
          expect(facts.lastExecution).toBe('relaunch')
          expect(facts.executionNoProgress.count).toBe(0)
          expect(facts.state.drainingExecutions?.i?.relaunch).toEqual(request)
          expect(facts.state.drainingExecutions?.i?.authorization).toBeUndefined()
        })
      })

      test('executionOpen and reclaimPending follow the openExecution and pendingPrAttachmentReclaims rules', async () => {
        await withStore(factory, undefined, async (store) => {
          const repo = 'acme/dg-work'
          const slug = 'dg-work'
          await store.createBuild(sampleBuildInput(slug, { repo }))
          await store.append(slug, buildCreatedWrite())
          const flags = async (): Promise<{ executionOpen?: true; reclaimPending?: true }> => {
            const digest = (await store.getRepoBuildDigests(repo)).get(slug)!
            return {
              ...(digest.executionOpen ? { executionOpen: true as const } : {}),
              ...(digest.reclaimPending ? { reclaimPending: true as const } : {}),
            }
          }
          const started = (instance: string): EventWrite<'execution.started'> => ({
            actor: DISPATCHER,
            type: 'execution.started',
            payload: { provider: 'p', workspaceRef: 'w', instance },
          })
          const ended = (instance: string): EventWrite<'execution.ended'> => ({
            actor: DISPATCHER,
            type: 'execution.ended',
            payload: { instance, workspaceRef: 'w', outcome: 'completed' },
          })
          expect(await flags()).toEqual({})

          await store.append(slug, started('a'))
          expect(await flags()).toEqual({ executionOpen: true })
          // A mismatched end leaves the execution open.
          await store.append(slug, ended('other'))
          expect(await flags()).toEqual({ executionOpen: true })
          await store.append(slug, ended('a'))
          expect(await flags()).toEqual({})
          await store.append(slug, started('b'))
          expect(await flags()).toEqual({ executionOpen: true })
          // Completion does not close an execution.
          await store.append(slug, {
            actor: DISPATCHER,
            type: 'build.completed',
            payload: { outcome: 'abandoned' },
          })
          expect(await flags()).toEqual({ executionOpen: true })
          await store.append(slug, ended('b'))
          expect(await flags()).toEqual({})

          const hosted = await store.append(slug, {
            actor: KERNEL,
            type: 'pr-attachment.hosted',
            payload: {
              designationSeq: 1,
              asset: {
                provider: 'github-release',
                repository: 'acme/assets',
                releaseId: 1,
                assetId: 2,
                url: 'https://example.invalid/a.png',
              },
            },
          })
          expect(await flags()).toEqual({ reclaimPending: true })
          // Unknown and backwards acks do not clear it.
          await store.append(slug, {
            actor: DISPATCHER,
            type: 'pr-attachment.reclaimed',
            payload: { hostedSeq: hosted.seq + 100 },
          })
          expect(await flags()).toEqual({ reclaimPending: true })
          await store.append(slug, {
            actor: DISPATCHER,
            type: 'pr-attachment.reclaimed',
            payload: { hostedSeq: hosted.seq },
          })
          expect(await flags()).toEqual({})
        })
      })

      test('the digest equals the full-log ground truth over every lifecycle shape', async () => {
        await withStore(factory, undefined, async (store) => {
          const repo = 'acme/dg-life'
          // Open build: an observation, no terminal fact.
          await store.createBuild(sampleBuildInput('dg-open', { repo }))
          await store.append('dg-open', buildCreatedWrite())
          await store.append('dg-open', sampleEventWrite('open observation'))

          // Done build: observation after completion stays an occurrence.
          await store.createBuild(sampleBuildInput('dg-done', { repo }))
          await store.append('dg-done', buildCreatedWrite())
          await store.append('dg-done', {
            actor: DISPATCHER,
            type: 'build.completed',
            payload: { outcome: 'merged' },
          })
          await store.append('dg-done', sampleEventWrite('after completion'))

          // Cleaning build (mid-abort): renders a row, no terminal completion.
          await store.createBuild(sampleBuildInput('dg-cleaning', { repo }))
          await store.append('dg-cleaning', buildCreatedWrite())
          await store.append('dg-cleaning', {
            actor: KERNEL,
            type: 'build.aborted',
            payload: {},
          })
          await store.append('dg-cleaning', sampleEventWrite('during cleanup'))

          // Abort saga terminated in completion: latest terminal fact wins.
          await store.createBuild(sampleBuildInput('dg-abandoned', { repo }))
          await store.append('dg-abandoned', buildCreatedWrite())
          await store.append('dg-abandoned', {
            actor: KERNEL,
            type: 'build.aborted',
            payload: {},
          })
          await store.append('dg-abandoned', {
            actor: DISPATCHER,
            type: 'build.completed',
            payload: { outcome: 'abandoned' },
          })

          // The reducer's exact terminal rule, pinned: done → aborted → done.
          await store.createBuild(sampleBuildInput('dg-overwrite', { repo }))
          await store.append('dg-overwrite', buildCreatedWrite())
          await store.append('dg-overwrite', {
            actor: DISPATCHER,
            type: 'build.completed',
            payload: { outcome: 'merged' },
          })
          await store.append('dg-overwrite', {
            actor: KERNEL,
            type: 'build.aborted',
            payload: {},
          })
          await store.append('dg-overwrite', {
            actor: DISPATCHER,
            type: 'build.completed',
            payload: { outcome: 'merged' },
          })

          const digests = await store.getRepoBuildDigests(repo)
          const expectedStatuses: Record<string, string> = {}
          const expectedObservations: Record<string, { seq: number; ts: string }[]> = {}
          const expectedMerged: Record<string, string | undefined> = {}
          for (const record of await store.listBuilds()) {
            if (record.repo !== repo) continue
            const events = await store.getEvents(record.slug)
            expectedStatuses[record.slug] = reduceBuild(events).status
            expectedObservations[record.slug] = events
              .filter((event) => event.type === 'observation.recorded')
              .map((event) => ({ seq: event.seq, ts: event.ts }))
            const merges = events
              .filter((event) => event.type === 'pr.merged')
              .map((event) => event.ts)
            expectedMerged[record.slug] = merges[merges.length - 1]
          }
          expect([...digests.keys()].sort()).toEqual(Object.keys(expectedStatuses).sort())
          for (const [slug, digest] of digests) {
            // Terminal presence and kind follow the reducer's status exactly.
            const status = expectedStatuses[slug]!
            expect(digest.terminal).toBe(
              status === 'done' ? 'done' : status === 'aborted' ? 'aborted' : undefined,
            )
            expect(digest.observations).toEqual(expectedObservations[slug] ?? [])
            // The merge fact is the log's latest `pr.merged` ts, absent when
            // the log has none.
            if (expectedMerged[slug] === undefined) expect(digest.merged).toBeUndefined()
            else expect(digest.merged).toBe(expectedMerged[slug])
          }
          // Explicit shape pins (independent of the loop above); the ts
          // values come from the same ground-truth events.
          const tsOf = (slug: string, seq: number): string =>
            expectedObservations[slug]!.find((item) => item.seq === seq)!.ts
          expect(digests.get('dg-open')).toEqual({
            slug: 'dg-open',
            observations: [{ seq: 2, ts: tsOf('dg-open', 2) }],
          })
          expect(digests.get('dg-done')).toEqual({
            slug: 'dg-done',
            readinessChangeSeq: 2,
            terminal: 'done',
            observations: [{ seq: 3, ts: tsOf('dg-done', 3) }],
          })
          expect(digests.get('dg-cleaning')).toEqual({
            slug: 'dg-cleaning',
            readinessChangeSeq: 2,
            terminal: 'aborted',
            observations: [{ seq: 3, ts: tsOf('dg-cleaning', 3) }],
          })
          expect(digests.get('dg-abandoned')).toEqual({
            slug: 'dg-abandoned',
            readinessChangeSeq: 3,
            terminal: 'done',
            observations: [],
          })
          expect(digests.get('dg-overwrite')).toEqual({
            slug: 'dg-overwrite',
            readinessChangeSeq: 4,
            terminal: 'done',
            observations: [],
          })
        })
      })

      test('digests reflect appends through every write path without a refresh step', async () => {
        await withStore(factory, undefined, async (store) => {
          const repo = 'acme/dg-paths'
          await store.createBuild(sampleBuildInput('dg-paths', { repo }))
          expect((await store.getRepoBuildDigests(repo)).get('dg-paths')?.observations).toEqual([])

          await store.append('dg-paths', sampleEventWrite('first'))
          let digest = (await store.getRepoBuildDigests(repo)).get('dg-paths')
          expect(digest?.observations).toEqual([
            { seq: 1, ts: (await store.getEvents('dg-paths'))[0]!.ts },
          ])
          expect(digest?.terminal).toBeUndefined()

          const conditional = await store.appendIfCurrent('dg-paths', 1, sampleEventWrite('second'))
          expect(conditional).not.toBeNull()
          digest = (await store.getRepoBuildDigests(repo)).get('dg-paths')
          expect(digest?.observations.map((item) => item.seq)).toEqual([1, 2])

          await store.appendWithArtifacts('dg-paths', [{ kind: 'dg-notes', content: 'note' }], () =>
            sampleEventWrite('third'),
          )
          digest = (await store.getRepoBuildDigests(repo)).get('dg-paths')
          expect(digest?.observations).toEqual([
            { seq: 1, ts: (await store.getEvents('dg-paths'))[0]!.ts },
            { seq: 2, ts: (await store.getEvents('dg-paths'))[1]!.ts },
            { seq: 3, ts: (await store.getEvents('dg-paths'))[2]!.ts },
          ])
          expect(digest?.merged).toBeUndefined()

          // The merge fact reflects appends through every write path too,
          // keeping the latest `pr.merged` ts.
          const merge = async (sha: string) =>
            (
              await store.append('dg-paths', {
                actor: DISPATCHER,
                type: 'pr.merged',
                payload: { sha },
              })
            ).ts
          const firstMergeTs = await merge('abc111')
          digest = (await store.getRepoBuildDigests(repo)).get('dg-paths')
          expect(digest?.merged).toBe(firstMergeTs)

          const secondMergeTs = await merge('abc222')
          digest = (await store.getRepoBuildDigests(repo)).get('dg-paths')
          expect(digest?.merged).toBe(secondMergeTs)
          expect(secondMergeTs >= firstMergeTs).toBe(true)

          await store.append('dg-paths', {
            actor: DISPATCHER,
            type: 'build.completed',
            payload: { outcome: 'merged' },
          })
          digest = (await store.getRepoBuildDigests(repo)).get('dg-paths')
          expect(digest).toEqual({
            slug: 'dg-paths',
            readinessChangeSeq: 6,
            terminal: 'done',
            merged: secondMergeTs,
            mergedSha: 'abc222',
            observations: [
              { seq: 1, ts: (await store.getEvents('dg-paths'))[0]!.ts },
              { seq: 2, ts: (await store.getEvents('dg-paths'))[1]!.ts },
              { seq: 3, ts: (await store.getEvents('dg-paths'))[2]!.ts },
            ],
          })
        })
      })
    })

    describe('repository journal (workflow and control paper trail)', () => {
      test('change presence is retained and reduced across repository read boundaries', async () => {
        await withStore(factory, undefined, async (store) => {
          const repo = 'presence-contract'
          await store.ensureRepo(repo)
          const payload = {
            destination: 'root:main',
            branch: 'main',
            head: 'a'.repeat(40),
            evidence: 'landing-revision-1',
            identities: ['build:blocker'],
          }
          await store.appendRepo(repo, {
            actor: DISPATCHER,
            type: 'change-presence.observed',
            payload,
          })
          expect((await readRepositoryFacts(store, repo)).value.presence['root:main']).toEqual(
            payload,
          )
          const later = {
            ...payload,
            evidence: 'landing-revision-2',
            identities: ['build:blocker', 'build:second'],
          }
          await store.appendRepo(repo, {
            actor: DISPATCHER,
            type: 'change-presence.observed',
            payload: later,
          })
          expect((await readRepositoryFacts(store, repo)).value.presence['root:main']).toEqual(
            later,
          )
          expect(
            (await store.getRepoStateEvents(repo)).filter(
              (event) => event.type === 'change-presence.observed',
            ),
          ).toHaveLength(2)
        })
      })

      test('tick observations are fenced, bounded, atomic and detached snapshots', async () => {
        const clock = manualClock(CONTRACT_T0)
        await withStore(factory, { clock }, async (store) => {
          const repo = 'tick-contract'
          await store.ensureRepo(repo)
          expect(await store.beginRepoTick(repo, 'owner')).toBeNull()
          await store.claimRepoLease(repo, 'owner', 60_000)
          const startedAt = await store.beginRepoTick(repo, 'owner')
          expect(startedAt).toBe(CONTRACT_T0)
          const failure = { outcome: 'failed' as const, error: 'failure' }
          const events: RepositoryEventWrite[] = [
            {
              actor: DISPATCHER,
              type: 'dispatcher.tick-started',
              payload: { run: 'owner', startedAt: startedAt! },
            },
            {
              actor: DISPATCHER,
              type: 'dispatcher.tick-failed',
              payload: { run: 'owner', error: 'failure' },
            },
          ]
          const before = await store.getRepo(repo)
          expect(
            await store.finishRepoTick(repo, 'foreign', failure, [
              { ...events[0]!, payload: { run: 'foreign' } },
              { ...events[1]!, payload: { run: 'foreign', error: 'failure' } },
            ]),
          ).toBeNull()
          expect(await store.getRepo(repo)).toEqual(before)
          await expect(
            store.finishRepoTick(repo, 'owner', failure, [
              events[0]!,
              { ...events[1]!, payload: {} },
            ]),
          ).rejects.toThrow()
          expect(await store.getRepoEvents(repo)).toEqual([])
          expect(await store.getRepo(repo)).toEqual(before)
          clock.advance(1000)
          const finished = await store.finishRepoTick(repo, 'owner', failure, events)
          expect(finished!.events.map((e) => e.seq)).toEqual([1, 2])
          expect(finished!.observation.finished).toMatchObject({
            startedAt,
            completedAt: clock().toISOString(),
            ...failure,
          })
          finished!.observation.finished!.startedAt = 'mutated'
          expect((await store.getRepo(repo))!.tick!.finished!.startedAt).toBe(startedAt!)
          await store.beginRepoTick(repo, 'owner')
          expect((await store.getRepo(repo))!.tick!.finished!.outcome).toBe('failed')
          clock.advance(60_000)
          const expired = await store.getRepo(repo)
          expect(await store.beginRepoTick(repo, 'owner')).toBeNull()
          expect(await store.finishRepoTick(repo, 'owner', failure, events)).toBeNull()
          expect(await store.getRepo(repo)).toEqual(expired)
          await store.releaseRepoLease(repo, 'owner')
          expect((await store.getRepo(repo))!.tick!.finished!.startedAt).toBe(startedAt!)
        })
      })

      test('restricted handles deny tick mutations and arbitrary finish batches append nothing', async () => {
        await withStore(factory, undefined, async (store) => {
          const repo = 'tick-authority'
          await store.ensureRepo(repo)
          await store.createBuild(sampleBuildInput('tick-scope', { repo }))
          const scoped = store.scopeBuild('tick-scope')
          await expect(scoped.beginRepoTick(repo, 'owner')).rejects.toThrow()
          const failure = { outcome: 'failed' as const, error: 'failed' }
          await expect(scoped.finishRepoTick(repo, 'owner', failure, [])).rejects.toThrow()
          const session = await store.createSession({ repo, operator: 'operator' })
          await expect(
            store.scopeSession(session.id).upsertOperatorPresence(repo, {
              id: 'op',
              host: 'host',
              pid: 1,
              startedAt: CONTRACT_T0,
            }),
          ).rejects.toThrow()
          await expect(store.scopeSession(session.id).listOperatorPresence(repo)).rejects.toThrow()
          await expect(
            store.scopeSession(session.id).beginRepoTick(repo, 'owner'),
          ).rejects.toThrow()
          await expect(
            store.scopeSession(session.id).finishRepoTick(repo, 'owner', failure, []),
          ).rejects.toThrow()
          await store.claimRepoLease(repo, 'owner', 60_000)
          await store.beginRepoTick(repo, 'owner')
          const before = await store.getRepo(repo)
          await expect(
            store.finishRepoTick(repo, 'owner', failure, [
              { actor: DISPATCHER, type: 'dispatcher.tick-started', payload: { run: 'owner' } },
              {
                actor: humanActor('operator'),
                type: 'dispatcher.intake-set',
                payload: { enabled: false },
              },
            ]),
          ).rejects.toThrow()
          expect(await store.getRepoEvents(repo)).toEqual([])
          expect(await store.getRepo(repo)).toEqual(before)
        })
      })

      test('quiet finishes update completion without advancing the journal or heartbeat', async () => {
        const clock = manualClock(CONTRACT_T0)
        await withStore(factory, { clock }, async (store) => {
          const repo = 'quiet-tick-contract'
          await store.ensureRepo(repo)
          await store.claimRepoLease(repo, 'owner', 60_000)
          const { emptyTickReport } = await import('../processes/dispatcher')
          const {
            queued,
            janitorDiagnostics,
            blockedDiagnostics,
            ticketDiagnostics,
            creationDiagnostics,
            dependencyDiagnostics,
            ...counters
          } = emptyTickReport()
          for (let i = 0; i < 20; i++) {
            await store.beginRepoTick(repo, 'owner')
            clock.advance(1000)
            const result = await store.finishRepoTick(
              repo,
              'owner',
              {
                outcome: 'completed',
                counters: {
                  ...counters,
                  forgeRequests: {
                    total: i,
                    restPrimary: i,
                    restNotModified: 0,
                    graphql: 0,
                    unattributed: 0,
                    builds: i ? [{ build: 'active', requests: i }] : [],
                    complete: true,
                  },
                },
              },
              [],
            )
            const finished = (await store.getRepo(repo))!.tick!.finished!
            expect(finished.outcome === 'completed' && finished.counters.forgeRequests?.total).toBe(
              i,
            )
            if (finished.outcome === 'completed')
              expect(finished.counters.forgeRequests?.restPrimary).toBe(i)
            expect(result!.events).toEqual([])
            expect((await store.getRepo(repo))!.tick!.finished!.completedAt).toBe(
              clock().toISOString(),
            )
          }
          expect(await store.getRepoHighWater(repo)).toBe(0)
          expect(await store.getRepoEvents(repo)).toEqual([])
          expect((await store.getRepo(repo))!.heartbeatAt).toBeUndefined()
        })
      })
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

    describe('repository change position', () => {
      test('read-only, monotonic and repository isolated across durable writes and holder changes', async () => {
        const clock = manualClock()
        const { store, cleanup } = await factory({ clock })
        try {
          const repo = 'change-position'
          expect(await store.getRepoChangePosition(repo)).toBe('0')
          expect(await store.getRepo(repo)).toBeNull()
          let previous = 0n
          const advanced = async () => {
            const value = await store.getRepoChangePosition(repo)
            expect(value).toMatch(/^(0|[1-9][0-9]*)$/)
            expect(BigInt(value)).toBeGreaterThan(previous)
            previous = BigInt(value)
          }
          const stable = async () =>
            expect(await store.getRepoChangePosition(repo)).toBe(String(previous))
          await store.createBuild({ slug: 'position-build', repo })
          await advanced()
          expect(await store.getRepo(repo)).toBeNull()
          await store.append('position-build', {
            actor: KERNEL,
            type: 'build.aborted',
            payload: {},
          })
          await advanced()
          await store.appendWithArtifacts(
            'position-build',
            [{ kind: 'notes', content: 'ok' }],
            () => ({ actor: KERNEL, type: 'build.aborted', payload: {} }),
          )
          await advanced()
          expect(
            await store.appendIfCurrent('position-build', 0, {
              actor: KERNEL,
              type: 'build.aborted',
              payload: {},
            }),
          ).toBeNull()
          await stable()
          await store.appendIfCurrent('position-build', 2, {
            actor: KERNEL,
            type: 'build.aborted',
            payload: {},
          })
          await advanced()
          await expect(
            store.append('position-build', {
              actor: KERNEL,
              type: 'build.aborted',
              payload: { invalid: true },
            } as never),
          ).rejects.toThrow()
          await stable()
          await store.ensureRepo(repo)
          await stable()
          const event = {
            actor: humanActor('operator'),
            type: 'dispatcher.intake-set' as const,
            payload: { enabled: true },
          }
          await store.appendRepo(repo, event)
          await advanced()
          await store.appendRepoWithArtifacts(repo, [{ kind: 'notes', content: 'ok' }], () => event)
          await advanced()
          await store.claimRepoLease(repo, 'one', 1000)
          await advanced()
          await store.claimRepoLease(repo, 'one', 1000)
          await store.heartbeatRepo(repo, 'one')
          expect(await store.claimRepoLease(repo, 'two', 1000)).toBe(false)
          await store.releaseRepoLease(repo, 'two')
          await stable()
          clock.advance(1001)
          await stable()
          await store.claimRepoLease(repo, 'two', 1000)
          await advanced()
          await store.beginRepoTick(repo, 'two')
          await stable()
          await store.finishRepoTick(repo, 'two', { outcome: 'failed', error: 'test' }, [
            { actor: DISPATCHER, type: 'dispatcher.tick-started', payload: { run: 'two' } },
            {
              actor: DISPATCHER,
              type: 'dispatcher.tick-failed',
              payload: { run: 'two', error: 'test' },
            },
          ])
          await advanced()
          await store.releaseRepoLease(repo, 'two')
          await advanced()
          await store.createBuild({ slug: 'position-foreign', repo: 'foreign' })
          await store.ensureRepo('foreign')
          await store.appendRepo('foreign', event)
          await store.claimRepoLease('foreign', 'peer', 1000)
          await stable()
        } finally {
          await store.close()
          await cleanup?.()
        }
      })
    })

    describe('getRepoHighWater', () => {
      test('unknown repo rejects like getRepoEvents and creates nothing', async () => {
        await withStore(factory, undefined, async (store) => {
          await expect(store.getRepoHighWater('acme/never-seen')).rejects.toThrow(/unknown repo/)
          expect(await store.getRepo('acme/never-seen')).toBeNull()
        })
      })

      test('an empty journal answers 0', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.ensureRepo('acme/hw-empty')
          expect(await store.getRepoHighWater('acme/hw-empty')).toBe(0)
        })
      })

      test('equals the last appended seq regardless of event type', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.ensureRepo('acme/hw')
          await store.appendRepo('acme/hw', {
            actor: humanActor('op'),
            type: 'dispatcher.intake-set',
            payload: { enabled: false },
          })
          expect(await store.getRepoHighWater('acme/hw')).toBe(1)
          // A run-scoped, non-durable type must still move the mark.
          const tick = await store.appendRepo('acme/hw', {
            actor: DISPATCHER,
            type: 'dispatcher.tick-started',
            payload: { run: 'r1' },
          })
          expect(tick.seq).toBe(2)
          expect(await store.getRepoHighWater('acme/hw')).toBe(2)
          expect((await store.getRepoEvents('acme/hw')).at(-1)?.seq).toBe(2)
        })
      })
    })

    describe('named reducer value reads', () => {
      test('native handles survive open, ended and cached build-state reads', async () => {
        await withStore(factory, undefined, async (store) => {
          const slug = 'native-handle-values'
          await store.createBuild(sampleBuildInput(slug))
          await store.append(slug, {
            actor: KERNEL,
            type: 'session.started',
            payload: {
              session: 's_native',
              phase: 'implement',
              round: 1,
              role: 'implement',
              runner: 'alias',
            },
          })
          expect((await readBuildFacts(store, slug)).value.state.sessions.nativeHandles).toEqual({})
          const handle = {
            version: 1 as const,
            runner: 'codex',
            nativeId: 'thread',
            host: 'worker',
            workspacePath: '/repo',
          }
          await store.append(slug, {
            actor: KERNEL,
            type: 'session.native-handle-recorded',
            payload: { session: 's_native', phase: 'implement', round: 1, handle },
          })
          expect(
            (await readBuildFacts(store, slug)).value.state.sessions.open[0]?.nativeHandle,
          ).toEqual(handle)
          await store.append(slug, {
            actor: KERNEL,
            type: 'session.ended',
            payload: {
              session: 's_native',
              transcript: { kind: 'transcript', rev: 0 },
              usage: { inputTokens: 1, outputTokens: 1, turns: 1 },
            },
          })
          const state = (await readBuildFacts(store, slug)).value.state
          expect(state.sessions).toMatchObject({
            suspended: [],
            open: [],
            nativeHandles: { s_native: handle },
            totals: {
              s_native: {
                activeMs: expect.any(Number),
                usage: { inputTokens: 1, outputTokens: 1, turns: 1 },
                transcripts: [{ kind: 'transcript', rev: 0 }],
              },
            },
          })
          expect(state).toEqual(reduceBuild(await store.getEvents(slug)))
          expect((await readBuildFacts(store, slug)).value.state.sessions).toEqual(state.sessions)
        })
      })

      test('automatic restack identity, publication settlement and base-pinned evidence survive persisted reads', async () => {
        await withStore(factory, undefined, async (store) => {
          const slug = 'automatic-restack-values'
          const old = 'a'.repeat(40),
            base = 'b'.repeat(40),
            head = 'c'.repeat(40)
          await store.createBuild(sampleBuildInput(slug))
          await store.append(slug, {
            actor: KERNEL,
            type: 'workspace.provisioned',
            payload: {
              provider: 'git-worktree',
              ref: '/worktree',
              branch: `ab/${slug}`,
              base: { source: 'remote', sha: old },
            },
          })
          const observed = await store.append(slug, {
            actor: KERNEL,
            type: 'target.moved',
            payload: { branch: 'main', sha: base },
          })
          const transaction = {
            id: 'automatic-1',
            trigger: 'verify-entry' as const,
            cycle: 1,
            observation: observed.seq,
            branch: `ab/${slug}`,
            oldHead: old,
            oldBase: old,
            targetBase: base,
            changeSha: 'd'.repeat(40),
            workspaceHead: old,
            localBranchHead: old,
            message: `Change\n\nAutobuild-Build: ${slug}\n`,
          }
          await store.append(slug, {
            actor: KERNEL,
            type: 'restack.prepared',
            payload: transaction,
          })
          await store.append(slug, {
            actor: KERNEL,
            type: 'restack.replayed',
            payload: { id: transaction.id, conflicted: false },
          })
          const intent = { ...transaction, headSha: head }
          await store.append(slug, {
            actor: KERNEL,
            type: 'restack.publish-intended',
            payload: intent,
          })
          const request = await store.append(slug, {
            actor: KERNEL,
            type: 'publication.requested',
            payload: {
              operation: 'restack',
              branch: transaction.branch,
              sha: head,
              rewrite: intent,
            },
          })
          let facts = (await readBuildFacts(store, slug)).value
          expect(facts.log.restack.active).toEqual(transaction)
          expect(facts.publication.pending()).toBe(true)
          await store.append(slug, {
            actor: KERNEL,
            type: 'restack.rewritten',
            payload: {
              ...intent,
              archives: [{ ref: `refs/autobuild/archive/${slug}/${old}`, sha: old }],
            },
          })
          expect(await readBuildSelector(store, slug, 'publishedBranchHead')).toBe(head)
          expect(await readBuildSelector(store, slug, 'verifyDiffBase')).toBe(old)
          await store.append(slug, { actor: KERNEL, type: 'restack.completed', payload: intent })
          expect(await readBuildSelector(store, slug, 'verifyDiffBase')).toBe(base)
          const evidence = {
            step: 'unit',
            attempt: 1,
            baseSha: base,
            headSha: head,
            restackId: transaction.id,
          }
          await store.append(slug, { actor: KERNEL, type: 'verify.started', payload: evidence })
          await store.append(slug, {
            actor: KERNEL,
            type: 'verify.completed',
            payload: { ...evidence, outcome: 'pass' },
          })
          facts = (await readBuildFacts(store, slug)).value
          expect(facts.log.restack.active).toBeUndefined()
          expect(facts.log.restack.gates['1']).toEqual(intent)
          expect(facts.publication.requestCompleted(request)).toBe(true)
          expect(facts.log.verifyStarted.at(-1)).toMatchObject({
            baseSha: base,
            headSha: head,
            restackId: transaction.id,
          })
          expect(facts.state.verify.results.at(-1)).toMatchObject({ ...evidence, outcome: 'pass' })
        })
      })

      test.each([false, true])(
        'rewrite receipts round-trip and promote verification only on completion (overtaken=%s)',
        async (overtaken) => {
          await withStore(factory, undefined, async (store) => {
            const slug = 'restack-values'
            const old = 'a'.repeat(40)
            const base = 'b'.repeat(40)
            const head = 'c'.repeat(40)
            const observed = 'e'.repeat(40)
            const transaction = {
              id: 'rewrite-1',
              attempt: 1,
              branch: `ab/${slug}`,
              oldHead: old,
              oldBase: old,
              targetBase: base,
              changeSha: 'd'.repeat(40),
              workspaceHead: old,
              localBranchHead: old,
            }
            const artifact = { kind: 'reconcile-notes', rev: 0 }
            await store.createBuild(sampleBuildInput(slug))
            await store.append(slug, {
              actor: KERNEL,
              type: 'workspace.provisioned',
              payload: {
                provider: 'git-worktree',
                ref: '/worktree',
                branch: transaction.branch,
                base: { source: 'remote', sha: old },
              },
            })
            await store.append(slug, {
              actor: KERNEL,
              type: 'reconcile.started',
              payload: { attempt: 1, baseSha: base },
            })
            await store.append(slug, {
              actor: KERNEL,
              type: 'reconcile.prepared',
              payload: transaction,
            })
            expect((await readBuildFacts(store, slug)).value.reconcileTransaction).toEqual(
              transaction,
            )
            expect(await readBuildSelector(store, slug, 'verifyDiffBase')).toBe(old)
            await store.append(slug, {
              actor: KERNEL,
              type: 'reconcile.replayed',
              payload: { id: transaction.id, conflicted: true },
            })
            await store.append(slug, {
              actor: KERNEL,
              type: 'reconcile.publish-intended',
              payload: { ...transaction, headSha: head, conflicted: true, artifact },
            })
            await store.append(slug, {
              actor: KERNEL,
              type: 'reconcile.rewritten',
              payload: {
                ...transaction,
                headSha: head,
                ...(overtaken ? { observedHead: observed } : {}),
                conflicted: true,
                archives: [{ ref: `refs/autobuild/archive/${slug}/${old}`, sha: old }],
              },
            })
            expect(await readBuildSelector(store, slug, 'publishedBranchHead')).toBe(
              overtaken ? observed : head,
            )
            expect(await readBuildSelector(store, slug, 'verifyDiffBase')).toBe(old)
            if (overtaken) {
              expect((await readBuildFacts(store, slug)).value.recoveryCheckpoint).toBe(observed)
              expect(
                (await store.getEvents(slug)).some((event) => event.type === 'reconcile.completed'),
              ).toBe(false)
              return
            }
            await store.append(slug, {
              actor: agentActor('reconcile', 'resolver'),
              type: 'reconcile.completed',
              payload: { headSha: head, rewriteId: transaction.id, artifact },
            })
            expect(await readBuildSelector(store, slug, 'publishedBranchHead')).toBe(head)
            expect(await readBuildSelector(store, slug, 'verifyDiffBase')).toBe(base)
            const facts = (await readBuildFacts(store, slug)).value
            expect(facts.gitTips).toContain(old)
            expect(facts.gitTips).toContain(head)
            expect(facts.reconcileReplay).toEqual({ id: transaction.id, conflicted: true })
          })
        },
      )

      test('all admitted reducers match replay on both scopes and isolate parameter variants', async () => {
        await withStore(factory, undefined, async (store) => {
          const slug = 'values'
          const repo = 'acme/values'
          await store.createBuild(sampleBuildInput(slug))
          await store.ensureRepo(repo)
          await store.append(slug, sampleEventWrite('hello'))
          await store.appendRepo(repo, {
            actor: humanActor('op'),
            type: 'dispatcher.intake-set',
            payload: { enabled: false },
          })
          const buildEvents = await store.getEvents(slug)
          const repoEvents = await store.getRepoEvents(repo)
          for (const [name, entry] of Object.entries(REDUCERS)) {
            const read = entry.valueRead
            const scope =
              read && !('excluded' in read) && read.scope === 'repo'
                ? { kind: 'repo' as const, repo }
                : { kind: 'build' as const, slug }
            if ('excluded' in read) {
              await expect(store.getReducerValue(scope, { reducer: name })).rejects.toThrow(
                'excluded',
              )
              continue
            }
            const variants =
              name === 'terminalGuard'
                ? [
                    { phase: 'plan', round: 1, session: 'session-a' },
                    { phase: 'implement', round: 2, session: 'session-b' },
                  ]
                : name === 'openTick' || name === 'dispatchStatus' || name === 'dispatcherRunFacts'
                  ? [{ run: 'run-a' }, { run: 'run-b' }]
                  : name === 'phaseFailures'
                    ? [
                        { phase: 'plan', round: 1 },
                        { phase: 'implement', round: 2 },
                      ]
                    : name === 'dispatchFailureBudget'
                      ? [
                          { infrastructureOwnsWorkspace: false },
                          { infrastructureOwnsWorkspace: true },
                        ]
                      : [{}]
            for (const args of variants) {
              const request = { reducer: name, args }
              const resolved = resolveReducerValue(scope, request)
              const events = scope.kind === 'repo' ? repoEvents : buildEvents
              const expected = JSON.parse(JSON.stringify(resolved.reducer.reduce(events)))
              const answer = await store.getReducerValue(scope, request)
              expect(answer).toEqual({
                catalogIdentity: READ_CATALOG_IDENTITY,
                version: resolved.reducer.version,
                cursor: events.at(-1)?.seq ?? 0,
                value: expected,
              })
              if (answer.value && typeof answer.value === 'object')
                Object.assign(answer.value, { poison: true })
              expect((await store.getReducerValue(scope, request)).value).toEqual(expected)
            }
          }
        })
      })
      test('public snapshots cannot supply value checkpoints and unknown scopes create nothing', async () => {
        await withStore(factory, undefined, async (store) => {
          const scope = { kind: 'build' as const, slug: 'value-repair' }
          await store.createBuild(sampleBuildInput(scope.slug))
          await store.append(scope.slug, sampleEventWrite('first'))
          const request = { reducer: 'build' }
          const resolved = resolveReducerValue(scope, request)
          await expect(
            store.putReducerSnapshot(scope, resolved.key, {
              version: resolved.reducer.version,
              cursor: 1,
              state: { identity: resolved.identity, acc: resolved.reducer.initial() },
            }),
          ).rejects.toThrow('reserved')
          await expect(
            store.getReducerSnapshot(scope, resolved.key, resolved.reducer.version),
          ).rejects.toThrow('reserved')
          // Block the whole namespace, including the former writable format.
          for (const target of [scope, { kind: 'repo' as const, repo: 'value-repair' }]) {
            await store.ensureRepo('value-repair')
            await expect(
              store.putReducerSnapshot(target, 'value.legacy', {
                version: 1,
                cursor: 0,
                state: {},
              }),
            ).rejects.toThrow('reserved')
          }
          const answer = await store.getReducerValue(scope, request)
          expect(answer.value).toEqual(
            JSON.parse(JSON.stringify(reduceBuild(await store.getEvents(scope.slug)))),
          )
          await expect(
            store.getReducerValue({ kind: 'build', slug: 'unknown' }, request),
          ).rejects.toThrow()
          await expect(
            store.getReducerValue(
              { kind: 'repo', repo: 'unknown' },
              { reducer: 'dispatchSettings' },
            ),
          ).rejects.toThrow()
          expect(await store.getRepo('unknown')).toBeNull()
          await expect(
            store
              .scopeBuild(scope.slug)
              .getReducerValue({ kind: 'repo', repo: 'unknown' }, { reducer: 'dispatchSettings' }),
          ).rejects.toThrow()
          await expect(
            store
              .scopeBuild(scope.slug)
              .getReducerValue({ kind: 'build', slug: 'unknown' }, request),
          ).rejects.toThrow()
        })
      })
    })

    describe('reducer snapshots (a cache beside the log, never an authority)', () => {
      const buildScope = (slug: string) => ({ kind: 'build' as const, slug })
      const repoScope = (repo: string) => ({ kind: 'repo' as const, repo })

      async function buildWithEvents(store: BuildStore, slug: string, count: number) {
        await store.createBuild(sampleBuildInput(slug))
        for (let index = 0; index < count; index += 1) {
          await store.append(slug, sampleEventWrite(`event ${index}`))
        }
      }

      /** Deterministic shuffle so a failure replays. */
      function shuffled<T>(items: T[]): T[] {
        const out = [...items]
        let seed = 7
        for (let index = out.length - 1; index > 0; index -= 1) {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff
          const swap = seed % (index + 1)
          ;[out[index], out[swap]] = [out[swap]!, out[index]!]
        }
        return out
      }

      test('an absent snapshot reads null and an unknown scope reads null with no side effects', async () => {
        await withStore(factory, undefined, async (store) => {
          await buildWithEvents(store, 'snap-absent', 2)
          expect(await store.getReducerSnapshot(buildScope('snap-absent'), 'build', 1)).toBeNull()
          expect(await store.getReducerSnapshot(buildScope('snap-nobuild'), 'build', 1)).toBeNull()
          expect(await store.getReducerSnapshot(repoScope('acme/snap-norepo'), 'j', 1)).toBeNull()
          expect(
            await store.putReducerSnapshot(buildScope('snap-nobuild'), 'build', {
              version: 1,
              cursor: 0,
              state: {},
            }),
          ).toBe(false)
          expect(
            await store.putReducerSnapshot(repoScope('acme/snap-norepo'), 'j', {
              version: 1,
              cursor: 0,
              state: {},
            }),
          ).toBe(false)
          expect(await store.getRepo('acme/snap-norepo')).toBeNull()
          expect(await store.getBuild('snap-nobuild')).toBeNull()
        })
      })

      test('round-trips JSON state per scope and reducer, isolated from callers', async () => {
        await withStore(factory, undefined, async (store) => {
          await buildWithEvents(store, 'snap-rt', 3)
          await store.ensureRepo('acme/snap-rt')
          await store.appendRepo('acme/snap-rt', {
            actor: humanActor('op'),
            type: 'dispatcher.intake-set',
            payload: { enabled: false },
          })
          const state = { counts: { a: 1 }, list: [1, 'two', null], flag: true }
          expect(
            await store.putReducerSnapshot(buildScope('snap-rt'), 'build', {
              version: 2,
              cursor: 3,
              state,
            }),
          ).toBe(true)
          state.counts.a = 99
          const read = await store.getReducerSnapshot(buildScope('snap-rt'), 'build', 2)
          expect(read).toEqual({
            version: 2,
            cursor: 3,
            state: { counts: { a: 1 }, list: [1, 'two', null], flag: true },
          })
          ;(read!.state as { counts: { a: number } }).counts.a = 5
          expect(
            (await store.getReducerSnapshot(buildScope('snap-rt'), 'build', 2))?.state,
          ).toEqual({ counts: { a: 1 }, list: [1, 'two', null], flag: true })
          // Other reducers and the other scope kind are independent.
          expect(await store.getReducerSnapshot(buildScope('snap-rt'), 'logIndex', 2)).toBeNull()
          expect(await store.getReducerSnapshot(repoScope('acme/snap-rt'), 'build', 2)).toBeNull()
          expect(
            await store.putReducerSnapshot(repoScope('acme/snap-rt'), 'journalView', {
              version: 1,
              cursor: 1,
              state: { retained: [] },
            }),
          ).toBe(true)
          expect(
            (await store.getReducerSnapshot(repoScope('acme/snap-rt'), 'journalView', 1))?.cursor,
          ).toBe(1)
          expect((await store.getReducerSnapshot(buildScope('snap-rt'), 'build', 2))?.cursor).toBe(
            3,
          )
        })
      })

      test('a stored snapshot of another version is ignored, then replaced by an advancing write', async () => {
        await withStore(factory, undefined, async (store) => {
          await buildWithEvents(store, 'snap-ver', 5)
          const scope = buildScope('snap-ver')
          await store.putReducerSnapshot(scope, 'build', { version: 1, cursor: 3, state: 'v1' })
          expect(await store.getReducerSnapshot(scope, 'build', 2)).toBeNull()
          // Same cursor, lower version: no-op.
          expect(
            await store.putReducerSnapshot(scope, 'build', { version: 1, cursor: 3, state: 'x' }),
          ).toBe(false)
          // Higher version at an unchanged cursor replaces the old shape.
          expect(
            await store.putReducerSnapshot(scope, 'build', { version: 2, cursor: 3, state: 'v2' }),
          ).toBe(true)
          expect(await store.getReducerSnapshot(scope, 'build', 1)).toBeNull()
          expect((await store.getReducerSnapshot(scope, 'build', 2))?.state).toBe('v2')
          // A lower version cannot replace a newer cache, even at a later cursor.
          expect(
            await store.putReducerSnapshot(scope, 'build', { version: 1, cursor: 4, state: 'v1b' }),
          ).toBe(false)
          expect((await store.getReducerSnapshot(scope, 'build', 2))?.state).toBe('v2')
          expect(await store.getReducerSnapshot(scope, 'build', 1)).toBeNull()
          // But never at a lower cursor, whatever its version.
          expect(
            await store.putReducerSnapshot(scope, 'build', { version: 9, cursor: 2, state: 'old' }),
          ).toBe(false)
          expect((await store.getReducerSnapshot(scope, 'build', 2))?.state).toBe('v2')
        })
      })

      test('an equal or lower cursor is a no-op and the stored row is untouched', async () => {
        await withStore(factory, undefined, async (store) => {
          await buildWithEvents(store, 'snap-mono', 4)
          const scope = buildScope('snap-mono')
          expect(
            await store.putReducerSnapshot(scope, 'build', { version: 1, cursor: 3, state: 'a' }),
          ).toBe(true)
          expect(
            await store.putReducerSnapshot(scope, 'build', { version: 1, cursor: 3, state: 'b' }),
          ).toBe(false)
          expect(
            await store.putReducerSnapshot(scope, 'build', { version: 1, cursor: 2, state: 'c' }),
          ).toBe(false)
          expect(await store.getReducerSnapshot(scope, 'build', 1)).toEqual({
            version: 1,
            cursor: 3,
            state: 'a',
          })
          expect(
            await store.putReducerSnapshot(scope, 'build', { version: 1, cursor: 4, state: 'd' }),
          ).toBe(true)
        })
      })

      test('a cursor ahead of the log tail is refused on write and hidden on read', async () => {
        await withStore(factory, undefined, async (store) => {
          await buildWithEvents(store, 'snap-ahead', 2)
          const scope = buildScope('snap-ahead')
          expect(
            await store.putReducerSnapshot(scope, 'build', { version: 1, cursor: 3, state: 'x' }),
          ).toBe(false)
          expect(await store.getReducerSnapshot(scope, 'build', 1)).toBeNull()
          // Within the tail it is accepted, and stays readable as the log grows.
          expect(
            await store.putReducerSnapshot(scope, 'build', { version: 1, cursor: 2, state: 'ok' }),
          ).toBe(true)
          await store.append('snap-ahead', sampleEventWrite('more'))
          expect((await store.getReducerSnapshot(scope, 'build', 1))?.cursor).toBe(2)
        })
      })

      test('two interleaved writers never regress the stored cursor', async () => {
        await withStore(factory, undefined, async (store) => {
          const tail = 12
          await buildWithEvents(store, 'snap-race', tail)
          const scope = buildScope('snap-race')
          const cursors = shuffled(Array.from({ length: tail }, (_, index) => index + 1))
          const writerA = cursors.filter((_, index) => index % 2 === 0)
          const writerB = cursors.filter((_, index) => index % 2 === 1)
          // Each writer reads back sequentially, so its own series is ordered;
          // reads from different writers overlap and complete in any order, so
          // only per-writer monotonicity is meaningful.
          const write = async (list: number[]): Promise<number[]> => {
            const seen: number[] = []
            for (const cursor of list) {
              await store.putReducerSnapshot(scope, 'build', {
                version: 1,
                cursor,
                state: { cursor },
              })
              const read = await store.getReducerSnapshot(scope, 'build', 1)
              if (read !== null) seen.push(read.cursor)
            }
            return seen
          }
          const series = await Promise.all([write(writerA), write(writerB)])
          const final = await store.getReducerSnapshot(scope, 'build', 1)
          expect(final?.cursor).toBe(tail)
          expect(final?.state).toEqual({ cursor: tail })
          for (const seen of series) {
            for (let index = 1; index < seen.length; index += 1) {
              expect(seen[index]!).toBeGreaterThanOrEqual(seen[index - 1]!)
            }
          }
        })
      })

      test('writers on mixed versions still only ever raise the stored cursor', async () => {
        await withStore(factory, undefined, async (store) => {
          const tail = 9
          await buildWithEvents(store, 'snap-mixed', tail)
          const scope = buildScope('snap-mixed')
          const writes = shuffled(
            Array.from({ length: tail * 3 }, (_, index) => ({
              version: (index % 3) + 1,
              cursor: Math.floor(index / 3) + 1,
            })),
          )
          await Promise.all(
            writes.map((write) =>
              store.putReducerSnapshot(scope, 'build', { ...write, state: write }),
            ),
          )
          // The cursor is the max; at that cursor the highest version won.
          const final = await store.getReducerSnapshot(scope, 'build', 3)
          expect(final).toEqual({ version: 3, cursor: tail, state: { version: 3, cursor: tail } })
        })
      })
    })

    describe('getRepoStateEvents (bounded journal read, AUT-489)', () => {
      /** One no-op hosted dispatcher invocation: the ~4 facts an invocation
       * appends whether or not it did anything. */
      function noopInvocation(run: string): RepositoryEventWrite[] {
        return [
          {
            actor: DISPATCHER,
            type: 'dispatcher.run-started',
            payload: {
              run,
              pid: 1,
              effectiveConfig: { kind: 'effective-config', rev: 0 },
              roleWarnings: [],
            },
          },
          { actor: DISPATCHER, type: 'dispatcher.tick-started', payload: { run } },
          {
            actor: DISPATCHER,
            type: 'dispatcher.tick-completed',
            payload: {
              run,
              queued: 0,
              counters: noopTickCounters(),
              janitorDiagnostics: [],
              ticketDiagnostics: [],
              dependencyDiagnostics: [],
            },
          },
          {
            actor: DISPATCHER,
            type: 'dispatcher.run-stopped',
            payload: { run, outcome: 'normal' },
          },
        ]
      }

      test('ticket migrations survive run turnover and stay repository scoped', async () => {
        await withStore(factory, undefined, async (store) => {
          const repo = 'acme/migration'
          await store.ensureRepo(repo)
          await store.ensureRepo('other/migration')
          const payload = {
            identity: 'cutover',
            from: 'linear',
            to: 'file',
            mapping: { N: 'NODE' },
          }
          await store.appendRepo(repo, {
            actor: { kind: 'human', user: 'operator' },
            type: 'tickets.migration-recorded',
            payload,
          })
          for (const write of noopInvocation('new-run')) await store.appendRepo(repo, write)
          expect(
            (await store.getRepoStateEvents(repo)).find(
              (event) => event.type === 'tickets.migration-recorded',
            )?.payload,
          ).toEqual(payload)
          expect(
            (await store.getRepoStateEvents('other/migration')).some(
              (event) => event.type === 'tickets.migration-recorded',
            ),
          ).toBe(false)
        })
      })

      test('ticket-source health remains durable across newer runs', async () => {
        await withStore(factory, undefined, async (store) => {
          const repo = 'acme/source-health'
          await store.ensureRepo(repo)
          const condition = {
            source: 'fake',
            cause: 'rate-limited' as const,
            operation: 'ready-scan' as const,
            message: 'quota exhausted',
            resetAt: '2026-10-14T12:00:00.000Z',
          }
          await store.appendRepo(repo, {
            actor: DISPATCHER,
            type: 'dispatcher.ticket-source-degraded',
            payload: condition,
          })
          await store.appendRepo(repo, {
            actor: DISPATCHER,
            type: 'dispatcher.ticket-source-dependency-limited',
            payload: { source: 'fake' },
          })
          for (const write of noopInvocation('new-run')) await store.appendRepo(repo, write)
          const bounded = await store.getRepoStateEvents(repo)
          expect(bounded[0]?.type).toBe('dispatcher.ticket-source-degraded')
          expect(bounded[1]?.type).toBe('dispatcher.ticket-source-dependency-limited')
          await store.appendRepo(repo, {
            actor: DISPATCHER,
            type: 'dispatcher.ticket-source-recovered',
            payload: { source: 'fake', cause: 'rate-limited', operation: 'dependency-check' },
          })
          expect(
            (await store.getRepoStateEvents(repo)).filter((event) =>
              event.type.startsWith('dispatcher.ticket-source-'),
            ),
          ).toEqual(
            (await store.getRepoEvents(repo)).filter((event) =>
              event.type.startsWith('dispatcher.ticket-source-'),
            ),
          )
        })
      })

      function noopTickCounters() {
        return {
          merged: 0,
          closed: 0,
          conflicted: 0,
          abandoned: 0,
          discarded: 0,
          janitorFailed: 0,
          recovered: 0,
          dispatchFailed: 0,
          resumed: 0,
          swept: 0,
          dispatched: 0,
          authored: 0,
          bounced: 0,
          claimRaces: 0,
          invalidTickets: 0,
          dependencyBlocked: 0,
          harvestStarted: 0,
          harvestResumed: 0,
          harvestCompleted: 0,
          harvestEscalated: 0,
          harvestFailed: 0,
        }
      }

      test('upgrade handoffs and failures remain run-scoped through reduced reads', async () => {
        await withStore(factory, undefined, async (store) => {
          const repo = 'acme/upgrades'
          await store.ensureRepo(repo)
          const identity = {
            correlation: 'upgrade',
            run: 'old',
            lineage: 'launcher',
            from: {
              version: '1.0.0',
              commit: 'unknown',
              source: { kind: 'package' as const, location: '/old' },
            },
            target: {
              mode: 'pinned' as const,
              key: 'two',
              version: '2.0.0',
              source: 'main',
              base: 'main',
              sha: 'a'.repeat(40),
            },
          }
          const handoff = {
            ...identity,
            to: { ...identity.from, version: '2.0.0' },
            root: '/cache',
            cacheId: 'candidate',
          }
          await store.appendRepo(repo, {
            actor: DISPATCHER,
            type: 'dispatcher.upgrade-detected',
            payload: identity,
          })
          await store.appendRepo(repo, {
            actor: DISPATCHER,
            type: 'dispatcher.handoff-started',
            payload: handoff,
          })
          await store.appendRepo(repo, {
            actor: DISPATCHER,
            type: 'dispatcher.upgrade-failed',
            payload: { ...identity, run: 'foreign', reason: 'registry unavailable' },
          })
          await store.appendRepo(repo, {
            actor: DISPATCHER,
            type: 'dispatcher.upgrade-target-resolved',
            payload: {
              run: 'foreign',
              lineage: identity.lineage,
              target: { ...identity.target, mode: 'source', sha: 'b'.repeat(40) },
            },
          })
          const first = (await readRepositoryFacts(store, repo)).value.upgrades
          expect(first.runs.old?.handoff?.payload).toEqual(handoff)
          expect(first.runs.old?.completed).toBeUndefined()
          expect(first.runs.foreign?.failure?.payload.reason).toBe('registry unavailable')
          expect(first.runs.foreign?.resolved?.payload.target.sha).toBe('b'.repeat(40))
          await store.appendRepo(repo, {
            actor: DISPATCHER,
            type: 'dispatcher.handoff-completed',
            payload: { ...handoff, successor: 'new' },
          })
          await store.appendRepo(repo, {
            actor: DISPATCHER,
            type: 'dispatcher.runtime-rolled-back',
            payload: {
              correlation: 'rollback',
              run: 'restored',
              lineage: identity.lineage,
              predecessor: 'old',
              successor: 'new',
              handoff: identity.correlation,
              takeoverAt: '2026-01-01T00:00:00.000Z',
              failures: 3,
              failed: handoff.to,
              restored: handoff.from,
              failedRoot: '/cache/new',
              restoredRoot: '/cache/old',
              target: identity.target,
              reason: 'three failed exits',
            },
          })
          expect(
            (await readRepositoryFacts(store, repo)).value.upgrades.holds[identity.lineage]?.payload
              .failed.version,
          ).toBe('2.0.0')
          await store.appendRepo(repo, {
            actor: DISPATCHER,
            type: 'dispatcher.rollback-hold-cleared',
            payload: {
              correlation: 'rollback',
              run: 'restored',
              lineage: identity.lineage,
              target: { ...identity.target, key: 'changed' },
            },
          })
          const rollbackState = (await readRepositoryFacts(store, repo)).value.upgrades
          expect(rollbackState.holds[identity.lineage]).toBeUndefined()
          expect(rollbackState.lastRollback?.payload.restored.version).toBe(handoff.from.version)
          const next = (await readRepositoryFacts(store, repo)).value.upgrades
          expect(next.runs.old?.completed?.payload.successor).toBe('new')
          expect(next.runs.foreign?.failure).toBeDefined()
        })
      })

      test('latest-only scans stay bounded across scans, runs and repositories', async () => {
        await withStore(factory, undefined, async (store) => {
          for (const repo of ['acme/scans', 'acme/foreign-scans']) await store.ensureRepo(repo)
          const appendScan = (repo: string, queued: number) =>
            store.appendRepo(repo, {
              actor: DISPATCHER,
              type: 'dispatcher.ticket-scan-completed',
              payload: {
                startedAt: '2026-10-14T00:00:00.000Z',
                mode: 'admission',
                readinessFingerprint: 'r',
                criteriaFingerprint: 'c',
                queued,
                invalidTickets: 0,
                ticketDiagnostics: [],
                dependencyBlocked: 0,
                dependencyDiagnostics: [],
                creationWithheld: 0,
                creationDiagnostics: [],
              },
            })
          await store.appendRepo('acme/scans', {
            actor: humanActor('op'),
            type: 'dispatcher.intake-set',
            payload: { enabled: true },
          })
          const check = async (expected: number, rows: number) => {
            const all = await store.getRepoEvents('acme/scans')
            const bounded = await store.getRepoStateEvents('acme/scans')
            expect(bounded).toEqual(projectRepositoryStateEvents(all))
            expect(bounded).toHaveLength(rows)
            const scans = bounded.filter((e) => e.type === 'dispatcher.ticket-scan-completed')
            expect(scans).toHaveLength(1)
            expect(scans[0]!.payload).toMatchObject({ queued: expected })
            expect(reduceDispatchSettings(bounded)).toEqual(reduceDispatchSettings(all))
          }
          for (let i = 0; i < 200; i++) await appendScan('acme/scans', i)
          await check(199, 2)
          for (let i = 200; i < 400; i++) {
            await appendScan('acme/scans', i)
            await appendScan('acme/foreign-scans', 999)
          }
          await check(399, 2)
          for (let run = 0; run < 20; run++) {
            for (const write of noopInvocation(`scan-run-${run}`))
              await store.appendRepo('acme/scans', write)
            await appendScan('acme/scans', run)
          }
          await check(19, 6)
          for (const write of noopInvocation('scan-final'))
            await store.appendRepo('acme/scans', write)
          await check(19, 6) // latest scan is older than the run anchor
          for (let i = 0; i < 100; i++) await appendScan('acme/scans', i)
          await check(99, 6)
          expect(
            (await store.getRepoEvents('acme/scans')).filter(
              (e) => e.type === 'dispatcher.ticket-scan-completed',
            ),
          ).toHaveLength(520)
        })
        // The full hosted HTTP/Postgres workload took 5.33s with unit/build/
        // integration overlapping on 4 vCPUs (2.77s focused). Keep all 520 scans.
      }, 15_000)

      test('unknown repo rejects like getRepoEvents', async () => {
        await withStore(factory, undefined, async (store) => {
          await expect(store.getRepoStateEvents('acme/never-seen')).rejects.toThrow(/unknown repo/)
        })
      })

      test('an empty journal answers []', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.ensureRepo('acme/empty')
          expect(await store.getRepoStateEvents('acme/empty')).toEqual([])
        })
      })

      test('a journal with durable events but no run-started anchor answers durable types only', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.ensureRepo('acme/no-anchor')
          for (const write of [
            { actor: humanActor('op'), type: 'dispatcher.intake-set', payload: { enabled: false } },
            { actor: KERNEL, type: 'harvest.started', payload: harvestStartedWrite('h1').payload },
            // Run-scoped fact with no anchor anywhere in the journal: if the
            // read degenerated into a whole-journal select, this would leak
            // into the result.
            { actor: DISPATCHER, type: 'dispatcher.tick-started', payload: { run: 'r1' } },
          ] as RepositoryEventWrite[]) {
            await store.appendRepo('acme/no-anchor', write)
          }
          const subset = await store.getRepoStateEvents('acme/no-anchor')
          expect(subset.map((event) => event.type)).toEqual([
            'dispatcher.intake-set',
            'harvest.started',
          ])
        })
      })

      test('a seeded journal answers exactly the oracle over the full replay', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.ensureRepo('acme/state')
          for (const write of [
            ...noopInvocation('r1'),
            { actor: humanActor('op'), type: 'dispatcher.intake-set', payload: { enabled: false } },
            { actor: KERNEL, type: 'harvest.started', payload: harvestStartedWrite('h1').payload },
            {
              actor: humanActor('op'),
              type: 'orchestrator.sandbox.provisioned',
              payload: { operator: 'op', environmentId: 'env', provider: 'p', workspacePath: '/w' },
            },
            ...noopInvocation('r2'),
            {
              actor: humanActor('op'),
              type: 'dispatcher.operator-reported',
              payload: { run: 'r2', level: 'warning', message: 'm' },
            },
          ] as RepositoryEventWrite[]) {
            await store.appendRepo('acme/state', write)
          }
          const subset = await store.getRepoStateEvents('acme/state')
          const full = await store.getRepoEvents('acme/state')
          expect(subset).toEqual(projectRepositoryStateEvents(full))
          // The oracle is also the reducer-equivalence guarantee: latest-run
          // facts survive (criterion 3 — a failed/warning invocation stays
          // visible), and durable facts from before the anchor survive.
          expect(subset.map((event) => event.type)).toContain('dispatcher.operator-reported')
          expect(subset.map((event) => event.type)).toContain('harvest.started')
          expect(subset.filter((event) => event.type === 'dispatcher.run-started')).toHaveLength(1)
        })
      })

      test('the subset is bounded by the invocation count, not by journal length', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.ensureRepo('acme/bounded')
          for (let index = 0; index < 25; index += 1) {
            for (const write of noopInvocation(`r_${index}`)) {
              await store.appendRepo('acme/bounded', write)
            }
          }
          const subset = await store.getRepoStateEvents('acme/bounded')
          // Exactly the latest invocation's four facts: nothing durable was
          // ever written, so the durable part of the subset is empty.
          expect(subset).toHaveLength(4)
        })
      })

      test('settings written after the latest anchor are present', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.ensureRepo('acme/settings-tail')
          for (const write of noopInvocation('r1')) {
            await store.appendRepo('acme/settings-tail', write)
          }
          await store.appendRepo('acme/settings-tail', {
            actor: humanActor('op'),
            type: 'dispatcher.pause-set',
            payload: { enabled: true },
          })
          const subset = await store.getRepoStateEvents('acme/settings-tail')
          expect(subset.map((event) => event.type)).toContain('dispatcher.pause-set')
          expect(reduceDispatchSettings(subset).paused).toBe(true)
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
            compatibility: { writerVersion: AUTOBUILD_VERSION, classification: 'decisive' },
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

      test('merged trailer evidence persists as true, false or historical absence without changing reduction', async () => {
        await withStore(factory, undefined, async (store) => {
          for (const evidence of [undefined, true, false]) {
            const slug = `merge-evidence-${String(evidence)}`
            await store.createBuild(sampleBuildInput(slug))
            await store.append(slug, sampleEventWrite())
            const payload = {
              sha: 'landed',
              ...(evidence === undefined ? {} : { buildTrailerPresent: evidence }),
            }
            await store.append(slug, { actor: DISPATCHER, type: 'pr.merged', payload })
            const events = await store.getEvents(slug)
            expect(events.at(-1)?.payload).toEqual(payload)
            const historical = events.map((event) =>
              event.type === 'pr.merged'
                ? { ...event, payload: { sha: event.payload.sha } }
                : event,
            )
            const { lastEvent: _observedEvent, ...observedState } = reduceBuild(events)
            const { lastEvent: _historicalEvent, ...historicalState } = reduceBuild(historical)
            expect(observedState).toEqual(historicalState)
            expect((await readBuildFacts(store, slug)).value.state).toEqual(reduceBuild(events))
          }
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

    // The bounded wait on the event reads (AUT-334): the same clamp and
    // early-return rules the stream and session reads honor, now on
    // getEvents and getRepoEvents. Mirrors the stream wait suites below.
    describe('bounded wait on event reads (AUT-334)', () => {
      test('events past since return immediately, with or without a wait', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('evt-wait-now'))
          const event = await store.append('evt-wait-now', sampleEventWrite('one'))
          const started = Date.now()
          expect(await store.getEvents('evt-wait-now', 0, { waitSeconds: 5 })).toEqual([event])
          expect(Date.now() - started).toBeLessThan(500)
        })
      })

      test('a quiet stream returns empty no earlier than the bound', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('evt-wait-quiet'))
          const started = Date.now()
          expect(await store.getEvents('evt-wait-quiet', 0, { waitSeconds: 1 })).toEqual([])
          expect(Date.now() - started).toBeGreaterThanOrEqual(950)
        })
      })

      test('a quiet stream without wait returns empty immediately (unchanged form)', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('evt-wait-off'))
          const started = Date.now()
          expect(await store.getEvents('evt-wait-off', 0)).toEqual([])
          expect(Date.now() - started).toBeLessThan(500)
        })
      })

      test('an append during the wait returns early carrying that event', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('evt-wait-wake'))
          const pending = store.getEvents('evt-wait-wake', 0, { waitSeconds: 5 })
          await Bun.sleep(100)
          const event = await store.append('evt-wait-wake', sampleEventWrite('wake'))
          expect(await pending).toEqual([event])
        })
      })

      test('getRepoEvents honors the same bound, symmetrically', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.ensureRepo('acme/evt-wait')
          const started = Date.now()
          const pending = store.getRepoEvents('acme/evt-wait', 0, { waitSeconds: 5 })
          await Bun.sleep(100)
          const event = await store.appendRepo('acme/evt-wait', harvestStartedWrite('h_wait'))
          expect(await pending).toEqual([event])
          // Events past since still answer immediately.
          expect(Date.now() - started).toBeLessThan(5_000)
          const immediateStart = Date.now()
          expect(await store.getRepoEvents('acme/evt-wait', event.seq, { waitSeconds: 1 })).toEqual(
            [],
          )
          // Nothing newer exists, so this is a held read answered at the
          // bound — the symmetric quiet-stream assertion.
          expect(Date.now() - immediateStart).toBeGreaterThanOrEqual(950)
        })
      })
    })

    // Abort on held reads (AUT-380): the optional signal cancels a held read
    // before its bound — resolving with the current result, never rejecting —
    // on every adapter uniformly. Explicit AbortController aborts only; no
    // timing-flaky disconnect simulation.
    describe('abort on held reads (AUT-380)', () => {
      test('a pre-aborted signal answers all four held reads promptly and empty', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('abort-pre'))
          await store.ensureRepo('acme/abort-pre')
          const session = await store.createSession({ repo: 'acme/abort-pre', operator: 'op' })
          const stream = await store.createStream({ kind: 'build', build: 'abort-pre' }, 's')
          const controller = new AbortController()
          controller.abort()
          const started = Date.now()
          await expect(
            store.getEvents('abort-pre', 0, { waitSeconds: 5, signal: controller.signal }),
          ).resolves.toEqual([])
          await expect(
            store.getRepoEvents('acme/abort-pre', 0, { waitSeconds: 5, signal: controller.signal }),
          ).resolves.toEqual([])
          await expect(
            store.getSessionEvents(session.id, 1, {
              waitSeconds: 5,
              signal: controller.signal,
            }),
          ).resolves.toEqual([])
          const streamRead = await store.readStream(stream.id, {
            waitSeconds: 5,
            signal: controller.signal,
          })
          expect(streamRead.chunks).toEqual([])
          expect(streamRead.status).toBe('open')
          // Even Postgres's 1 s poll budget satisfies this: abort resolves
          // the sleep, it does not wait for the next poll tick.
          expect(Date.now() - started).toBeLessThan(500)
        })
      })

      test('a mid-hold abort on a quiet session read resolves empty well under the bound', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.ensureRepo('acme/abort-mid')
          const session = await store.createSession({ repo: 'acme/abort-mid', operator: 'op' })
          const controller = new AbortController()
          // since=1: the session's own creation event is backlog; the hold
          // must establish past it or there is nothing held to abort.
          const pending = store.getSessionEvents(session.id, 1, {
            waitSeconds: 10,
            signal: controller.signal,
          })
          await Bun.sleep(100)
          const started = Date.now()
          controller.abort()
          await expect(pending).resolves.toEqual([])
          expect(Date.now() - started).toBeLessThan(5_000)
        })
      })
    })

    describe('artifacts', () => {
      test('optional latest metadata follows artifact-only revisions without mutation', async () => {
        await withStore(factory, undefined, async (store) => {
          if (!store.getLatestArtifactMeta) return
          await store.createBuild(sampleBuildInput('latest-meta'))
          expect(await store.getLatestArtifactMeta('latest-meta', 'pin')).toBeNull()
          for (let revision = 0; revision < 3; revision++) {
            const meta = await store.putArtifact('latest-meta', {
              kind: 'pin',
              content: `revision ${revision}`,
              metadata: { nested: { revision } },
            })
            expect(await store.getLatestArtifactMeta('latest-meta', 'pin')).toEqual(meta)
            expect((await store.getArtifact('latest-meta', 'pin'))?.meta).toEqual(meta)
            const copy = (await store.getLatestArtifactMeta('latest-meta', 'pin'))!
            copy.metadata.nested = 'changed'
            expect(await store.getLatestArtifactMeta('latest-meta', 'pin')).toEqual(meta)
          }
          expect(await store.getEvents('latest-meta')).toEqual([])
          await expect(store.getLatestArtifactMeta('unknown', 'pin')).rejects.toThrow(
            'unknown build',
          )
        })
      })

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

    describe('conditional artifact deposits', () => {
      test('invalid conditional bundles roll back deposits and retention pruning', async () => {
        await withStore(factory, { retention: { maxRevisions: 1 } }, async (store) => {
          const slug = 'conditional-rollback'
          await store.createBuild(sampleBuildInput(slug))
          const kind = 'build-runner-effective-config'
          await store.putArtifact(slug, { kind, content: 'retained' })
          const before = await store.getBuild(slug)
          await expect(
            store.appendWithArtifactsIfCurrent(
              slug,
              0,
              [
                { kind, content: 'new' },
                { kind, content: 'newer' },
              ],
              (deposited) => ({
                ...planCompletedWrite(deposited[0]!.revision),
                payload: {
                  round: 0,
                  artifact: { kind: 'plan', rev: deposited[0]!.revision },
                  verifySteps: [],
                },
              }),
            ),
          ).rejects.toThrow()
          expect(await store.getBuild(slug)).toEqual(before)
          expect(await store.getEvents(slug)).toEqual([])
          const artifacts = await store.listArtifacts(slug, kind)
          expect(artifacts.map((a) => a.revision)).toEqual([0])
          const retained = await store.getArtifact(slug, kind, 0)
          expect(new TextDecoder().decode(retained!.content)).toBe('retained')
        })
      })
      test('one concurrent writer wins; stale deposits allocate no revision or timestamp', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('conditional-bundle'))
          const before = await store.getBuild('conditional-bundle')
          const results = await Promise.all(
            [1, 2].map((n) =>
              store.appendWithArtifactsIfCurrent(
                'conditional-bundle',
                0,
                [{ kind: 'plan', content: `plan ${n}` }],
                (deposited) => planCompletedWrite(deposited[0]!.revision),
              ),
            ),
          )
          expect(results.filter(Boolean)).toHaveLength(1)
          expect(await store.listArtifacts('conditional-bundle', 'plan')).toHaveLength(1)
          const winner = await store.getBuild('conditional-bundle')
          expect(winner?.createdAt).toBe(before?.createdAt)
          expect(
            await store.appendWithArtifactsIfCurrent(
              'conditional-bundle',
              0,
              [{ kind: 'plan', content: 'stale' }],
              () => planCompletedWrite(99),
            ),
          ).toBeNull()
          expect(await store.getBuild('conditional-bundle')).toEqual(winner)
          expect(await store.listArtifacts('conditional-bundle', 'plan')).toHaveLength(1)
          const next = await store.appendWithArtifactsIfCurrent(
            'conditional-bundle',
            1,
            [{ kind: 'plan', content: 'next' }],
            (deposited) => planCompletedWrite(deposited[0]!.revision),
          )
          expect(next?.artifacts[0]?.revision).toBe(1)
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
      test('node writer is independent, exclusive, holder checked and recoverable after expiry', async () => {
        const clock = manualClock(CONTRACT_T0)
        await withStore(factory, { clock }, async (store) => {
          const slug = 'node-writer'
          await store.createBuild(sampleBuildInput(slug))
          expect(await store.claimLease(slug, 'runner', 60_000)).toBe(true)
          expect(await store.claimNodeWriter(slug, 'one', 1000)).toBe(true)
          expect(await store.claimNodeWriter(slug, 'two', 1000)).toBe(false)
          expect(await store.renewNodeWriter(slug, 'two')).toBe(false)
          await store.releaseNodeWriter(slug, 'two')
          clock.advance(900)
          expect(await store.renewNodeWriter(slug, 'one')).toBe(true)
          expect((await store.getBuild(slug))?.updatedAt).toBe(atT0(900))
          clock.advance(900)
          expect(await store.claimNodeWriter(slug, 'two', 1000)).toBe(false)
          clock.advance(100)
          expect(await store.renewNodeWriter(slug, 'one')).toBe(false)
          expect(await store.claimNodeWriter(slug, 'two', 1000)).toBe(true)
          await store.releaseNodeWriter(slug, 'one')
          expect(await store.claimNodeWriter(slug, 'three', 1000)).toBe(false)
          await store.releaseNodeWriter(slug, 'two')
          expect(await store.claimNodeWriter(slug, 'three', 1000)).toBe(true)
          expect((await store.getBuild(slug))?.lease?.holder).toBe('runner')
          expect(await store.getEvents(slug)).toEqual([])
        })
      })

      test('writer takeover retains the durable operation and its revision boundary', async () => {
        const clock = manualClock(CONTRACT_T0)
        await withStore(factory, { clock }, async (store) => {
          const slug = 'writer-reservation'
          await store.createBuild(sampleBuildInput(slug))
          expect(await store.claimNodeWriter(slug, 'one', 1000)).toBe(true)
          const reserved = await store.appendIfCurrent(slug, 0, {
            actor: KERNEL,
            type: 'node.writer-reserved',
            payload: {
              id: 'operation',
              operation: 'restack',
              expected: 'a'.repeat(40),
              parent: 'b'.repeat(40),
              oldBase: 'c'.repeat(40),
              archive: `refs/autobuild/archive/${slug}/${'a'.repeat(40)}`,
              changes: [],
              merges: [],
              upstreamBuilds: [],
            },
          })
          clock.advance(1000)
          expect(await store.claimNodeWriter(slug, 'two', 1000)).toBe(true)
          await store.releaseNodeWriter(slug, 'one')
          expect(await store.claimNodeWriter(slug, 'three', 1000)).toBe(false)
          const recovered = (await readBuildFacts(store, slug)).value.state.nodeRestack!
          expect(recovered.active?.id).toBe('operation')
          expect(recovered.reservedSeq).toBe(reserved!.seq)
          expect(
            await store.appendIfCurrent(slug, 0, {
              actor: KERNEL,
              type: 'node.writer-settled',
              payload: { id: 'operation', outcome: 'abandoned' },
            }),
          ).toBeNull()
          expect(
            await store.appendIfCurrent(slug, reserved!.seq, {
              actor: KERNEL,
              type: 'node.writer-settled',
              payload: { id: 'operation', outcome: 'abandoned' },
            }),
          ).not.toBeNull()
        })
      })

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

    describe('ticket assets (SPEC §7.1)', () => {
      const REPO = 'https://github.com/acme/rate-limiter'
      const enc = (text: string) => new TextEncoder().encode(text)
      const fileAsset = (name: string, content: Uint8Array, kind = 'design') => ({
        kind,
        name,
        layout: 'file' as const,
        entries: [{ type: 'file' as const, path: name, content }],
      })
      const treeAsset = (
        name: string,
        entries: { type: 'file'; path: string; content: Uint8Array }[] | never[] = [],
        extra: { type: 'dir'; path: string }[] = [],
        kind = 'design',
      ) => ({
        kind,
        name,
        layout: 'tree' as const,
        entries: [...entries, ...extra],
      })

      test('stores a single file and returns its exact bytes, binary and zero-byte included', async () => {
        await withStore(factory, undefined, async (store) => {
          const binary = Uint8Array.from([0, 255, 1, 254, 128, 0])
          const meta = await store.putTicketAsset(REPO, 'T-1', fileAsset('shot.png', binary))
          expect(meta).toMatchObject({
            repo: REPO,
            ticketId: 'T-1',
            kind: 'design',
            name: 'shot.png',
            revision: 0,
            layout: 'file',
            size: 6,
          })
          expect(meta.entries).toEqual([
            { type: 'file', path: 'shot.png', size: 6, blobRef: contentHash(binary) },
          ])
          const got = await store.getTicketAsset(REPO, 'T-1', 'design', 'shot.png')
          expect(got?.meta).toEqual(meta)
          expect(got?.entries).toEqual([{ type: 'file', path: 'shot.png', content: binary }])

          await store.putTicketAsset(REPO, 'T-1', fileAsset('empty.bin', new Uint8Array(0)))
          const empty = await store.getTicketAsset(REPO, 'T-1', 'design', 'empty.bin')
          expect(empty?.entries).toEqual([
            { type: 'file', path: 'empty.bin', content: new Uint8Array(0) },
          ])
          expect(empty?.meta.size).toBe(0)
        })
      })

      test('stores trees: nested files, an empty tree, and nested empty directories', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.putTicketAsset(
            REPO,
            'T-1',
            treeAsset(
              'site',
              [
                { type: 'file', path: 'index.html', content: enc('<h1>hi</h1>') },
                { type: 'file', path: 'img/a.png', content: Uint8Array.from([1, 2, 3]) },
              ],
              [{ type: 'dir', path: 'img/empty' }],
            ),
          )
          await store.putTicketAsset(REPO, 'T-1', treeAsset('hollow'))
          const site = await store.getTicketAsset(REPO, 'T-1', 'design', 'site')
          expect(site?.meta.layout).toBe('tree')
          expect(site?.meta.size).toBe(14)
          expect(site?.meta.entries.map((e) => `${e.type}:${e.path}`)).toEqual([
            'file:index.html',
            'file:img/a.png',
            'dir:img/empty',
          ])
          expect(site?.entries).toEqual([
            { type: 'file', path: 'index.html', content: enc('<h1>hi</h1>') },
            { type: 'file', path: 'img/a.png', content: Uint8Array.from([1, 2, 3]) },
            { type: 'dir', path: 'img/empty' },
          ])
          const hollow = await store.getTicketAsset(REPO, 'T-1', 'design', 'hollow')
          expect(hollow?.meta).toMatchObject({ layout: 'tree', size: 0, entries: [] })
          expect(hollow?.entries).toEqual([])

          const list = await store.listTicketAssets(REPO, 'T-1')
          expect(list.map((a) => [a.name, a.fileCount, a.dirCount, a.size])).toEqual([
            ['hollow', 0, 0, 0],
            ['site', 2, 1, 14],
          ])
          expect(list.every((a) => !('entries' in a))).toBe(true)
        })
      })

      test('re-attaching the same kind and name creates a new revision; old ones stay', async () => {
        await withStore(factory, undefined, async (store) => {
          expect(
            (await store.putTicketAsset(REPO, 'T-1', fileAsset('a', enc('one')))).revision,
          ).toBe(0)
          expect(
            (await store.putTicketAsset(REPO, 'T-1', fileAsset('a', enc('two!')))).revision,
          ).toBe(1)
          const latest = await store.getTicketAsset(REPO, 'T-1', 'design', 'a')
          expect(latest?.meta.revision).toBe(1)
          expect(latest?.entries[0]).toMatchObject({ content: enc('two!') })
          const first = await store.getTicketAsset(REPO, 'T-1', 'design', 'a', 0)
          expect(first?.entries[0]).toMatchObject({ content: enc('one') })
          expect(await store.getTicketAsset(REPO, 'T-1', 'design', 'a', 2)).toBeNull()

          const current = await store.listTicketAssets(REPO, 'T-1')
          expect(current.map((a) => [a.name, a.revision, a.size])).toEqual([['a', 1, 4]])
          const all = await store.listTicketAssets(REPO, 'T-1', { revisions: true })
          expect(all.map((a) => a.revision)).toEqual([0, 1])
        })
      })

      test('lists are isolated by repo, ticket id, kind and name', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.putTicketAsset(REPO, 'T-1', fileAsset('a', enc('x')))
          await store.putTicketAsset(REPO, 'T-1', fileAsset('a', enc('y'), 'ref'))
          await store.putTicketAsset(REPO, 'T-1', fileAsset('b', enc('z')))
          await store.putTicketAsset(REPO, 'T-2', fileAsset('a', enc('other')))
          await store.putTicketAsset('/other/repo', 'T-1', fileAsset('a', enc('other')))
          expect(
            (await store.listTicketAssets(REPO, 'T-1')).map((a) => `${a.kind}/${a.name}`),
          ).toEqual(['design/a', 'design/b', 'ref/a'])
          expect((await store.listTicketAssets(REPO, 'T-2')).map((a) => a.name)).toEqual(['a'])
          expect(await store.listTicketAssets(REPO, 'T-3')).toEqual([])
          expect(await store.getTicketAsset(REPO, 'T-1', 'ref', 'b')).toBeNull()
          expect(await store.getTicketAsset('/other/repo', 'T-2', 'design', 'a')).toBeNull()
          // Revision counters are per (repo, ticket, kind, name).
          expect((await store.putTicketAsset(REPO, 'T-2', fileAsset('b', enc('1')))).revision).toBe(
            0,
          )
        })
      })

      test('removal hides the asset but earlier revisions stay readable by explicit rev', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.putTicketAsset(REPO, 'T-1', fileAsset('a', enc('one')))
          await store.putTicketAsset(REPO, 'T-1', fileAsset('a', enc('two')))
          const removed = await store.removeTicketAsset(REPO, 'T-1', 'design', 'a')
          expect(removed).toMatchObject({ kind: 'design', name: 'a', revision: 1 })
          expect(await store.getTicketAsset(REPO, 'T-1', 'design', 'a')).toBeNull()
          expect(await store.listTicketAssets(REPO, 'T-1')).toEqual([])
          const pinned = await store.getTicketAsset(REPO, 'T-1', 'design', 'a', 0)
          expect(pinned?.entries[0]).toMatchObject({ content: enc('one') })
          const pinnedLatest = await store.getTicketAsset(REPO, 'T-1', 'design', 'a', 1)
          expect(pinnedLatest?.entries[0]).toMatchObject({ content: enc('two') })
          // Tombstones are not revisions to list.
          expect(
            (await store.listTicketAssets(REPO, 'T-1', { revisions: true })).map((a) => a.revision),
          ).toEqual([0, 1])
          // Removing again, or removing an unknown asset, is a null no-op.
          expect(await store.removeTicketAsset(REPO, 'T-1', 'design', 'a')).toBeNull()
          expect(await store.removeTicketAsset(REPO, 'T-1', 'design', 'ghost')).toBeNull()

          // Re-attaching takes the next revision; the tombstone consumed 2.
          const again = await store.putTicketAsset(REPO, 'T-1', fileAsset('a', enc('three')))
          expect(again.revision).toBe(3)
          expect((await store.listTicketAssets(REPO, 'T-1')).map((a) => a.revision)).toEqual([3])
          expect((await store.getTicketAsset(REPO, 'T-1', 'design', 'a'))?.meta.revision).toBe(3)
          expect(await store.getTicketAsset(REPO, 'T-1', 'design', 'a', 2)).toBeNull()
        })
      })

      test('advertises limits and refuses an over-limit put, naming the limit, storing nothing', async () => {
        await withStore(factory, undefined, async (store) => {
          const limits = await store.ticketAssetLimits(REPO)
          expect(limits.maxEntries).toBe(1000)
          expect(limits.maxBytes).toBeGreaterThan(0)
          expect(limits.maxBytes).toBeLessThanOrEqual(25 * 1024 * 1024)
          const tooBig = fileAsset('big.bin', new Uint8Array(limits.maxBytes + 1))
          await expect(store.putTicketAsset(REPO, 'T-1', tooBig)).rejects.toThrow(
            /ticket asset exceeds .*\d+-byte.*limit/,
          )
          expect(await store.listTicketAssets(REPO, 'T-1', { revisions: true })).toEqual([])
          expect(await store.getTicketAsset(REPO, 'T-1', 'design', 'big.bin')).toBeNull()
        })
      })

      test('rejects invalid names, paths and structures, storing nothing', async () => {
        await withStore(factory, undefined, async (store) => {
          const f = (path: string) => ({ type: 'file' as const, path, content: enc('x') })
          const bad = [
            { ...fileAsset('a', enc('x')), name: 'has space' },
            { ...fileAsset('a', enc('x')), kind: '' },
            treeAsset('t', [f('../escape')]),
            treeAsset('t', [f('/abs')]),
            treeAsset('t', [f('a//b')]),
            treeAsset('t', [f('a'), f('a')]),
            treeAsset('t', [f('a'), f('a/b')]),
            treeAsset('t', [f('a')], [{ type: 'dir', path: 'a' }]),
            { ...fileAsset('a', enc('x')), entries: [] },
            {
              kind: 'design',
              name: 'a',
              layout: 'file' as const,
              entries: [f('a'), { type: 'dir' as const, path: 'd' }],
            },
          ]
          for (const asset of bad) {
            await expect(store.putTicketAsset(REPO, 'T-1', asset)).rejects.toThrow()
          }
          expect(await store.listTicketAssets(REPO, 'T-1', { revisions: true })).toEqual([])
        })
      })

      test('a failed put does not consume a revision', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.putTicketAsset(REPO, 'T-1', fileAsset('a', enc('ok')))
          await expect(
            store.putTicketAsset(REPO, 'T-1', { ...fileAsset('a', enc('x')), name: 'a b' }),
          ).rejects.toThrow()
          expect(
            (await store.putTicketAsset(REPO, 'T-1', fileAsset('a', enc('ok2')))).revision,
          ).toBe(1)
        })
      })

      test('scoped handles reject ticket-asset operations', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('ta-scope'))
          const scoped = store.scopeBuild('ta-scope')
          await expect(
            scoped.putTicketAsset(REPO, 'T-1', fileAsset('a', enc('x'))),
          ).rejects.toThrow(/build-scoped store/)
          await expect(scoped.getTicketAsset(REPO, 'T-1', 'design', 'a')).rejects.toThrow(
            /build-scoped store/,
          )
          await expect(scoped.listTicketAssets(REPO, 'T-1')).rejects.toThrow(/build-scoped store/)
          await expect(scoped.removeTicketAsset(REPO, 'T-1', 'design', 'a')).rejects.toThrow(
            /build-scoped store/,
          )
          await expect(scoped.ticketAssetLimits(REPO)).rejects.toThrow(/build-scoped store/)
        })
      })
    })

    describe('pinned ticket assets (SPEC §6.3)', () => {
      const REPO = 'https://github.com/acme/rate-limiter'
      const enc = (text: string) => new TextEncoder().encode(text)
      const file = (name: string, text: string, kind = 'design') => ({
        kind,
        name,
        layout: 'file' as const,
        entries: [{ type: 'file' as const, path: name, content: enc(text) }],
      })
      const pinOf = (meta: { kind: string; name: string; revision: number; size: number }) => ({
        kind: meta.kind,
        name: meta.name,
        revision: meta.revision,
        layout: 'file' as const,
        size: meta.size,
        fileCount: 1,
        dirCount: 0,
      })
      const text = (asset: { entries: { type: string; content?: Uint8Array }[] } | null) =>
        asset === null ? null : new TextDecoder().decode(asset.entries[0]?.content)

      async function pinnedBuild(
        store: BuildStore,
        slug: string,
        assets: import('../events/payloads').PinnedAsset[],
      ): Promise<void> {
        const created = buildCreatedWrite()
        await store.createBuild({
          ...sampleBuildInput(slug),
          created: { ...created, payload: { ...created.payload, repo: REPO, assets } },
        })
      }

      test('snapshot pins read independent bytes, historical revisions and scoped access', async () => {
        await withStore(factory, undefined, async (store) => {
          const source = new MemoryBuildStore()
          await source.putTicketAsset(REPO, 'TICK-1', file('a.txt', 'remote one'))
          await store.putTicketAsset(REPO, 'TICK-1', file('a.txt', 'local conflict'))
          const pins = await prepareAssetSnapshots(source, store, REPO, 'TICK-1')
          await pinnedBuild(store, 'snapshot-pin', pins)
          await source.putTicketAsset(REPO, 'TICK-1', file('a.txt', 'remote two'))
          const newer = await prepareAssetSnapshots(source, store, REPO, 'TICK-1')
          await store.append('snapshot-pin', {
            actor: KERNEL,
            type: 'spec.revised',
            payload: { artifact: { kind: 'spec', rev: 1 }, escalation: 1, assets: newer },
          })
          await source.removeTicketAsset(REPO, 'TICK-1', 'design', 'a.txt')
          expect(text(await store.getPinnedTicketAsset('snapshot-pin', 'design', 'a.txt'))).toBe(
            'remote two',
          )
          expect(text(await store.getPinnedTicketAsset('snapshot-pin', 'design', 'a.txt', 0))).toBe(
            'remote one',
          )
          expect(await store.getPinnedTicketAsset('snapshot-pin', 'design', 'a.txt', 2)).toBeNull()
          const scoped = store.scopeBuild('snapshot-pin')
          expect(text(await scoped.getPinnedTicketAsset('snapshot-pin', 'design', 'a.txt'))).toBe(
            'remote two',
          )
        })
      })

      test('reads the pinned revision after the ticket replaces and then removes the asset', async () => {
        await withStore(factory, undefined, async (store) => {
          const v0 = await store.putTicketAsset(REPO, 'TICK-1', file('a.txt', 'one'))
          await pinnedBuild(store, 'pin-a', [pinOf(v0)])
          await store.putTicketAsset(REPO, 'TICK-1', file('a.txt', 'two'))
          expect(text(await store.getPinnedTicketAsset('pin-a', 'design', 'a.txt'))).toBe('one')
          await store.removeTicketAsset(REPO, 'TICK-1', 'design', 'a.txt')
          expect(await store.getTicketAsset(REPO, 'TICK-1', 'design', 'a.txt')).toBeNull()
          const pinned = await store.getPinnedTicketAsset('pin-a', 'design', 'a.txt')
          expect(text(pinned)).toBe('one')
          expect(pinned?.meta.revision).toBe(0)
        })
      })

      test('answers null for what the build never pinned, and for an unpinned revision', async () => {
        await withStore(factory, undefined, async (store) => {
          const v0 = await store.putTicketAsset(REPO, 'TICK-1', file('a.txt', 'one'))
          await store.putTicketAsset(REPO, 'TICK-1', file('a.txt', 'two'))
          await store.putTicketAsset(REPO, 'TICK-1', file('late.txt', 'late'))
          await pinnedBuild(store, 'pin-b', [pinOf(v0)])
          expect(await store.getPinnedTicketAsset('pin-b', 'design', 'late.txt')).toBeNull()
          expect(await store.getPinnedTicketAsset('pin-b', 'other-kind', 'a.txt')).toBeNull()
          expect(await store.getPinnedTicketAsset('pin-b', 'design', 'a.txt', 1)).toBeNull()
          expect(text(await store.getPinnedTicketAsset('pin-b', 'design', 'a.txt', 0))).toBe('one')
        })
      })

      test('a build with no pin and an unknown build', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.putTicketAsset(REPO, 'TICK-1', file('a.txt', 'one'))
          await store.createBuild({ ...sampleBuildInput('pin-none'), created: buildCreatedWrite() })
          expect(await store.getPinnedTicketAsset('pin-none', 'design', 'a.txt')).toBeNull()
          await expect(store.getPinnedTicketAsset('never', 'design', 'a.txt')).rejects.toThrow()
        })
      })

      test('a spec.revised re-pin moves the latest pinned revision; earlier pins stay readable by rev', async () => {
        await withStore(factory, undefined, async (store) => {
          const v0 = await store.putTicketAsset(REPO, 'TICK-1', file('a.txt', 'one'))
          await pinnedBuild(store, 'pin-c', [pinOf(v0)])
          const v1 = await store.putTicketAsset(REPO, 'TICK-1', file('a.txt', 'two'))
          await store.append('pin-c', {
            actor: KERNEL,
            type: 'spec.revised',
            payload: { artifact: { kind: 'spec', rev: 1 }, escalation: 1, assets: [pinOf(v1)] },
          })
          expect(text(await store.getPinnedTicketAsset('pin-c', 'design', 'a.txt'))).toBe('two')
          expect(text(await store.getPinnedTicketAsset('pin-c', 'design', 'a.txt', 0))).toBe('one')
          // Re-pinning to nothing leaves no latest pin; revisions pinned earlier stay readable.
          await store.append('pin-c', {
            actor: KERNEL,
            type: 'spec.revised',
            payload: { artifact: { kind: 'spec', rev: 2 }, escalation: 1, assets: [] },
          })
          expect(await store.getPinnedTicketAsset('pin-c', 'design', 'a.txt')).toBeNull()
          expect(text(await store.getPinnedTicketAsset('pin-c', 'design', 'a.txt', 1))).toBe('two')
        })
      })

      test('a build-scoped handle reads only its own pins', async () => {
        await withStore(factory, undefined, async (store) => {
          const v0 = await store.putTicketAsset(REPO, 'TICK-1', file('a.txt', 'one'))
          await pinnedBuild(store, 'pin-own', [pinOf(v0)])
          await pinnedBuild(store, 'pin-other', [pinOf(v0)])
          const scoped = store.scopeBuild('pin-own')
          expect(text(await scoped.getPinnedTicketAsset('pin-own', 'design', 'a.txt'))).toBe('one')
          await expect(scoped.getPinnedTicketAsset('pin-other', 'design', 'a.txt')).rejects.toThrow(
            /build-scoped store/,
          )
          // The other ticket-asset reads stay rejected.
          await expect(scoped.getTicketAsset(REPO, 'TICK-1', 'design', 'a.txt')).rejects.toThrow(
            /build-scoped store/,
          )
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
          await expect(
            scoped.upsertOperatorPresence('repo', {
              id: 'op',
              host: 'host',
              pid: 1,
              startedAt: CONTRACT_T0,
            }),
          ).rejects.toThrow(/build-scoped store/)
          await expect(scoped.listOperatorPresence('repo')).rejects.toThrow(/build-scoped store/)
          await expect(scoped.listBuildsForRepo('repo')).rejects.toThrow(/build-scoped store/)
          await expect(scoped.getRepoChangePosition('repo')).rejects.toThrow(/build-scoped store/)
          await expect(scoped.createBuild(sampleBuildInput('scope-c'))).rejects.toThrow(
            /build-scoped store/,
          )
          await expect(scoped.ensureRepo('acme/rate-limiter')).rejects.toThrow(/build-scoped store/)
          await expect(scoped.getRepoEvents('acme/rate-limiter')).rejects.toThrow(
            /build-scoped store/,
          )
          await expect(scoped.getRepoStateEvents('acme/rate-limiter')).rejects.toThrow(
            /build-scoped store/,
          )
          await expect(scoped.getRepoBuildDigests('acme/rate-limiter')).rejects.toThrow(
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
          await waitForDelivery(() => received.includes(1), 'the first event')
          await store.append('sub-order', sampleEventWrite('two'))
          await store.append('sub-order', sampleEventWrite('three'))
          await waitForDelivery(() => received.length >= 3, 'all three events')
          unsubscribe()
          // Settle past unsubscribe: a duplicate delivery would still show
          // up in the exact-array pin below.
          await Bun.sleep(50)
          expect(received).toEqual([1, 2, 3])
        })
      }, 30_000)

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
          await waitForDelivery(() => received.length >= 2, 'the events from seq 2')
          unsubscribe()
          await Bun.sleep(50)
          expect(received).toEqual([2, 3])
        })
      }, 30_000)

      test('unsubscribe stops delivery', async () => {
        await withStore(factory, undefined, async (store) => {
          await store.createBuild(sampleBuildInput('sub-stop'))
          const received: number[] = []
          const unsubscribe = store.subscribe('sub-stop', { pollMs: 10 }, (event) => {
            received.push(event.seq)
          })
          await store.append('sub-stop', sampleEventWrite('one'))
          await waitForDelivery(() => received.length >= 1, 'the first event')
          unsubscribe()
          await store.append('sub-stop', sampleEventWrite('two'))
          // Generous observation window: a still-subscribed client would
          // have completed ≥ 50 poll cycles at pollMs=10 (and on the
          // held-read remote path the append-wake plus round-trip is well
          // under 1 s), so a late delivery cannot hide inside it.
          await Bun.sleep(1_000)
          expect(received).toEqual([1])
        })
      }, 30_000)
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

        test('appendSessionEventIfCurrent (atomic session compare-and-append): win, stale miss leaves the log untouched, concurrent race yields exactly one winner', async () => {
          await withStore(factory, undefined, async (store) => {
            const session = await store.createSession({ repo: 'acme/a', operator: 'op' })
            // session.created is seq 1, so the current tail is 1.
            const won = await store.appendSessionEventIfCurrent(
              session.id,
              1,
              messagePostedWrite('winner'),
            )
            expect(won?.seq).toBe(2)
            expect((await store.getSessionEvents(session.id)).map((e) => e.seq)).toEqual([1, 2])

            // A stale expected sequence appends nothing and leaves the record
            // untouched.
            const before = await store.getSession(session.id)
            expect(
              await store.appendSessionEventIfCurrent(session.id, 1, messagePostedWrite('stale')),
            ).toBeNull()
            expect(await store.getSession(session.id)).toEqual(before)
            expect((await store.getSessionEvents(session.id)).map((e) => e.seq)).toEqual([1, 2])

            // Two contenders for one sequence produce exactly one winner.
            const results = await Promise.all([
              store.appendSessionEventIfCurrent(session.id, 2, messagePostedWrite('a')),
              store.appendSessionEventIfCurrent(session.id, 2, messagePostedWrite('b')),
            ])
            expect(results.filter((result) => result !== null)).toHaveLength(1)
            expect(results.filter((result) => result === null)).toHaveLength(1)
            const next = await store.appendSessionEventIfCurrent(
              session.id,
              3,
              messagePostedWrite('next'),
            )
            expect(next?.seq).toBe(4)

            // Invalid candidates and unknown sessions reject without writes.
            const invalid = {
              actor: humanActor('op'),
              type: 'no.such-type',
              payload: {},
            } as unknown as SessionEventWrite
            expect(
              await store.appendSessionEventIfCurrent(session.id, 4, invalid).then(
                () => 'no-error',
                (error: unknown) => error,
              ),
            ).toBeInstanceOf(EventValidationError)
            const negativeSeq = await store
              .appendSessionEventIfCurrent(session.id, -1, messagePostedWrite())
              .then(
                () => 'no-error',
                (error: unknown) => error,
              )
            expect(negativeSeq).toBeInstanceOf(Error)
            const unknownSession = await store
              .appendSessionEventIfCurrent('os_ghost', 0, messagePostedWrite())
              .then(
                () => 'no-error',
                (error: unknown) => error,
              )
            expect(unknownSession).toBeInstanceOf(Error)
            expect((await store.getSessionEvents(session.id)).map((e) => e.seq)).toEqual([
              1, 2, 3, 4,
            ])
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
              () => scoped.listBuildsForRepo('acme/a'),
              () => scoped.getRepoChangePosition('acme/a'),
              () => scoped.createBuild(sampleBuildInput('scope-build-2')),
              () => scoped.ensureRepo('acme/a'),
              () => scoped.appendRepo('acme/a', harvestStartedWrite()),
              () => scoped.getRepoEvents('acme/a'),
              () => scoped.getRepoStateEvents('acme/a'),
              () => scoped.getRepoBuildDigests('acme/a'),
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
              // A current client can reject malformed actors before transport.
              // If transported, enforceVia still rejects unauthorized attribution
              // before the server catalog sees the shape (SPEC §15.1).
              if (viaAuthority !== undefined) {
                expect(
                  err instanceof AuthError || err instanceof EventValidationError,
                  `via ${JSON.stringify(via)} must reject before writing`,
                ).toBe(true)
                if (err instanceof AuthError)
                  expect(err.message).toBe(
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
