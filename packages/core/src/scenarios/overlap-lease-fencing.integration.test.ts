/**
 * Concurrent-pair integration scenario for durable supervision (§12): two
 * overlapping once-style `abDispatch` invocations against the SAME repository.
 *
 * The single-invocation behavior is covered single-sided plus store-contract
 * tests of `claimRepoLease` / `heartbeatRepo` / `releaseRepoLease` in
 * isolation. This file adds executable evidence of the COMPOSED behavior:
 * exactly one invocation owns the work while the other defers fenced, with the
 * lease handshake between both invocations directly observable through
 * per-invocation recording wrappers around the shared store and build
 * execution.
 *
 * Determinism: the harness's `steppingClock` drives all store timestamps and
 * lease TTLs; the loser starts only after the winner's lease claim is
 * observable in the store (condition-gated poll, never a fixed sleep); the
 * forge and ticket source are fakes — no live provider, no real-time-sleep
 * dependence anywhere in the scenario's correctness.
 */
import { describe, expect, test } from 'bun:test'
import { abDispatch } from '../cli/dispatch'
import { reduceBuild } from '../kernel/reducer'
import type { BuildExecution } from '../ports/workspace/build-execution'
import { spawnExec } from '../ports/workspace/git-worktree'
import type { RepositoryEvent } from '../events/repository'
import type { BuildRecord, BuildStore } from '../store/types'
import { CONFIG_TOML, happyHandlers, makeHarness, readyTicket, type E2eHarness } from './harness'

// ── Local helpers ────────────────────────────────────────────────────────────

/** Condition-gated poll. Gates on observable store state only — never a
 * timing assumption. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for repository lease state')
    await Bun.sleep(10)
  }
}

type RepoLeaseOp = 'claimRepoLease' | 'heartbeatRepo' | 'releaseRepoLease'

interface LeaseCall {
  op: RepoLeaseOp
  repo: string
  holder: string
  /** Return value; `releaseRepoLease` resolves void. */
  result: boolean | undefined
}

/** Thin recording wrapper around the shared store: delegation via
 * `Object.create` (MemoryBuildStore methods live on the prototype), with the
 * three repo-lease methods overridden to record every call before (or instead
 * of, when forced) delegating. `force` pins results for the deliberate
 * lost-fencing injection of the second scenario — delegation is skipped, so
 * the store no longer fences the wrapped invocation. */
function recordingStore(
  store: BuildStore,
  force: Partial<Record<RepoLeaseOp, boolean>> = {},
): { store: BuildStore; calls: LeaseCall[] } {
  const calls: LeaseCall[] = []
  const wrapped = Object.create(store) as BuildStore
  wrapped.claimRepoLease = async (repo: string, holder: string, ttlMs: number) => {
    const result = force.claimRepoLease ?? (await store.claimRepoLease(repo, holder, ttlMs))
    calls.push({ op: 'claimRepoLease', repo, holder, result })
    return result
  }
  wrapped.heartbeatRepo = async (repo: string, holder: string) => {
    const result = force.heartbeatRepo ?? (await store.heartbeatRepo(repo, holder))
    calls.push({ op: 'heartbeatRepo', repo, holder, result })
    return result
  }
  wrapped.releaseRepoLease = async (repo: string, holder: string) => {
    calls.push({ op: 'releaseRepoLease', repo, holder, result: undefined })
    if (force.releaseRepoLease !== undefined) return
    await store.releaseRepoLease(repo, holder)
  }
  return { store: wrapped, calls }
}

/** Recording wrapper around the shared in-process build execution: records
 * which slugs THIS invocation launched, then delegates. */
function recordingBuildExecution(execution: BuildExecution): {
  execution: BuildExecution
  launched: string[]
} {
  const launched: string[] = []
  const wrapped = Object.create(execution) as BuildExecution
  wrapped.start = async (input) => {
    launched.push(input.slug)
    return execution.start(input)
  }
  return { execution: wrapped, launched }
}

/** Start (without awaiting) one real `abDispatch({ once: true })` invocation
 * over the harness's wiring with per-invocation recording wrappers. */
function startOnce(
  h: E2eHarness,
  opts: { store: BuildStore; execution: BuildExecution },
): { promise: Promise<void>; stderr: string[] } {
  const stderr: string[] = []
  const promise = abDispatch({
    targetRepo: h.origin,
    env: {},
    exec: spawnExec,
    stdout: () => {},
    stderr: (line) => stderr.push(line),
    once: true,
    wire: () => ({ ...h.wiring, store: opts.store, buildExecution: opts.execution }),
  })
  return { promise, stderr }
}

/** One invocation's observable behavior: its lease handshake records, the
 * builds it launched, and its plain-mode stderr. */
interface Invocation {
  label: string
  calls: LeaseCall[]
  launched: string[]
  stderr: string[]
}

/** The single-owner invariant: all claims and launches belong to exactly one
 * invocation; an invocation that lost the lease authored only its single
 * `dispatcher.tick-yielded`.
 *
 * Deliberately does NOT consult `FakeTicketSource.claims`: that array is an
 * attempt journal (the fake pushes in `claim()` BEFORE the already-claimed
 * check), so its length counts failed claim races too. Ownership is
 * correlated through the repo journal, the handshake records, and the build
 * records' ticket refs instead. */
function expectSingleOwner(
  invocations: Invocation[],
  repoEvents: RepositoryEvent[],
  builds: BuildRecord[],
): void {
  const owners = invocations.filter((invocation) =>
    invocation.calls.some((call) => call.op === 'claimRepoLease' && call.result === true),
  )
  if (owners.length !== 1) {
    throw new Error(
      `expected exactly one lease-owning invocation, found ${owners.length} ` +
        `(${owners.map((owner) => owner.label).join(', ') || 'none'})`,
    )
  }
  const owner = owners[0]!
  const ownerClaims = owner.calls.filter((call) => call.op === 'claimRepoLease')
  const holder = ownerClaims[0]!.holder
  if (!ownerClaims.every((call) => call.result === true && call.holder === holder)) {
    throw new Error(`owner ${owner.label} has a failed or mismatched lease claim`)
  }
  if (owner.calls.some((call) => call.op === 'heartbeatRepo' && call.result !== true)) {
    throw new Error(`owner ${owner.label} recorded a failed heartbeat`)
  }
  const finalCall = owner.calls.at(-1)
  if (
    finalCall === undefined ||
    finalCall.op !== 'releaseRepoLease' ||
    finalCall.holder !== holder
  ) {
    throw new Error(`owner ${owner.label} did not release the repository lease on exit`)
  }

  for (const loser of invocations) {
    if (loser === owner) continue
    const claims = loser.calls.filter((call) => call.op === 'claimRepoLease')
    if (claims.length === 0) {
      throw new Error(`${loser.label} never attempted the repository lease claim`)
    }
    if (!claims.every((call) => call.result === false)) {
      throw new Error(`${loser.label} fenced loser has a "successful" lease claim`)
    }
    if (loser.calls.some((call) => call.op === 'heartbeatRepo')) {
      throw new Error(`${loser.label} heartbeated a lease it never held`)
    }
    if (loser.calls.some((call) => call.op === 'releaseRepoLease')) {
      throw new Error(`${loser.label} released a lease it never held`)
    }
    if (!loser.stderr.some((line) => line.includes('tick yielded'))) {
      throw new Error(`${loser.label} never warned that its tick yielded`)
    }
    if (loser.launched.length > 0) {
      throw new Error(`${loser.label} launched builds despite losing the lease`)
    }
  }

  const yields = repoEvents.filter((event) => event.type === 'dispatcher.tick-yielded')
  if (yields.length !== 1) {
    throw new Error(`expected exactly one dispatcher.tick-yielded, found ${yields.length}`)
  }
  if (yields[0]!.payload.holder !== holder) {
    throw new Error('the yield event names a holder other than the lease owner')
  }

  // Claim-before-launch: a build record can only exist where a lease-owning
  // invocation launched it, and every launch corresponds to exactly one build
  // with its own ticket ref.
  if (owner.launched.length === 0) throw new Error('the owner launched nothing')
  const buildSlugs = builds.map((build) => build.slug)
  for (const slug of buildSlugs) {
    if (!owner.launched.includes(slug)) {
      throw new Error(`build ${slug} was not launched by the single lease owner`)
    }
  }
  for (const slug of owner.launched) {
    if (!buildSlugs.includes(slug)) {
      throw new Error(`launch of ${slug} has no build record`)
    }
  }
  const ticketRefs = builds.map((build) => build.ticket?.id)
  if (new Set(ticketRefs).size !== ticketRefs.length) {
    throw new Error('two builds share one ticket ref')
  }
}

/** Both invocations observed through per-invocation wrappers. */
function asInvocations(
  winner: { calls: LeaseCall[]; launched: string[]; stderr: string[] },
  loser: { calls: LeaseCall[]; launched: string[]; stderr: string[] },
): Invocation[] {
  return [
    { label: 'winner', calls: winner.calls, launched: winner.launched, stderr: winner.stderr },
    { label: 'loser', calls: loser.calls, launched: loser.launched, stderr: loser.stderr },
  ]
}

// ── Scenarios ────────────────────────────────────────────────────────────────

// These scenarios drive the REAL `abDispatch` entry, so the store is keyed by
// the resolved repository identity (§12): the checkout's normalized origin
// remote — here the harness's bare `origin` remote, `h.remote` — not the
// checkout path (`h.origin`, which only direct-dispatcher scenarios key by).

describe('concurrent-pair overlap lease fencing', () => {
  test('two overlapping once invocations: exactly one owns the work, the other yields fenced', async () => {
    const h = await makeHarness({
      handlers: happyHandlers(),
      tickets: [readyTicket('T-OVERLAP')],
    })
    const winnerStore = recordingStore(h.store)
    const winnerExec = recordingBuildExecution(h.wiring.buildExecution)
    const loserStore = recordingStore(h.store)
    const loserExec = recordingBuildExecution(h.wiring.buildExecution)
    try {
      // Winner starts first; its startup lease claim is the gate for the
      // loser's start — observable store state, never a delay.
      const winner = startOnce(h, { store: winnerStore.store, execution: winnerExec.execution })
      await waitFor(async () => (await h.store.getRepo(h.remote))?.lease !== undefined)
      const loser = startOnce(h, { store: loserStore.store, execution: loserExec.execution })

      await loser.promise
      await winner.promise

      // The winner owned the work to completion: one build, PR open.
      const builds = await h.store.listBuilds()
      expect(builds).toHaveLength(1)
      const events = await h.events(builds[0]!.slug)
      expect(reduceBuild(events).prState).toBe('open')

      // The lease handshake between both invocations, recorded at the seam.
      const winnerClaims = winnerStore.calls.filter((call) => call.op === 'claimRepoLease')
      expect(winnerClaims.length).toBeGreaterThan(0)
      expect(winnerClaims.every((call) => call.result === true)).toBe(true)
      const holder = winnerClaims[0]!.holder
      expect(winnerStore.calls.at(-1)).toMatchObject({
        op: 'releaseRepoLease',
        holder,
      })
      expect(loserStore.calls).toHaveLength(1)
      expect(loserStore.calls[0]).toMatchObject({ op: 'claimRepoLease', result: false })
      expect(loserExec.launched).toEqual([])
      expect(loser.stderr.some((line) => line.includes('tick yielded'))).toBe(true)

      // The yield is durable evidence naming the winner as holder. The loser
      // journals its synthesized run id too (every dispatcher now carries one),
      // so the payload is `{ run, holder }` — holder identifies the winner.
      const repoEvents = await h.store.getRepoEvents(h.remote)
      const yields = repoEvents.filter((event) => event.type === 'dispatcher.tick-yielded')
      expect(yields).toHaveLength(1)
      expect(yields[0]!.payload).toEqual({
        run: expect.stringMatching(/-dispatch-/),
        holder,
      })

      // The lease is released after the owner's once-pass.
      expect((await h.store.getRepo(h.remote))?.lease).toBeUndefined()

      // The loser yielded before its tick, so the single ready ticket was
      // claimed exactly once (sound here: no claim race ever happened).
      expect(h.tickets.claims).toEqual(['T-OVERLAP'])
      expect(h.cliErrors).toEqual([])

      expectSingleOwner(
        asInvocations(
          { ...winnerStore, launched: winnerExec.launched, stderr: winner.stderr },
          { ...loserStore, launched: loserExec.launched, stderr: loser.stderr },
        ),
        repoEvents,
        builds,
      )
    } finally {
      await h.cleanup()
    }
  }, 60_000)

  test('deliberate double-dispatch injection (lost fencing) fails the single-owner invariant', async () => {
    const h = await makeHarness({
      handlers: happyHandlers(),
      // Two ready tickets + capacity 2 (the committed CONFIG_TOML): an
      // unfenced second invocation can really claim and launch a second build.
      tickets: [
        readyTicket('T-FENCE-A', { title: 'Fence the lease handshake' }),
        readyTicket('T-FENCE-B', { title: 'Overlap the dispatch pair' }),
      ],
      // The in-process child advances the shared stepping clock while the
      // winner's pass still prepares the second ticket; no renewal runs on
      // that synthetic clock, so a 60 s lease would lapse mid-pass.
      configToml: LONG_LEASE_TOML,
    })
    const winnerStore = recordingStore(h.store)
    const winnerExec = recordingBuildExecution(h.wiring.buildExecution)
    // Lost fencing: the loser's store wrapper forces the lease handshake true
    // and skips delegation — the store no longer fences this invocation.
    const loserStore = recordingStore(h.store, {
      claimRepoLease: true,
      heartbeatRepo: true,
    })
    const loserExec = recordingBuildExecution(h.wiring.buildExecution)
    try {
      const winner = startOnce(h, { store: winnerStore.store, execution: winnerExec.execution })
      await waitFor(async () => (await h.store.getRepo(h.remote))?.lease !== undefined)
      const loser = startOnce(h, { store: loserStore.store, execution: loserExec.execution })

      // The injected builds' terminal states are deliberately not asserted;
      // only the double dispatch being observable is required.
      await Promise.all([winner.promise.catch(() => {}), loser.promise.catch(() => {})])

      // Non-vacuity, correlated through success evidence rather than attempt
      // counts: FakeTicketSource.claims journals every claim attempt (4 here —
      // each invocation attempts both seeds once, 2 succeed, 2 lose the race),
      // so the assertions below use the two build records (created only after
      // a successful claim) and the two distinct ticket refs.
      const claims = [...new Set(h.tickets.claims)].sort()
      expect(claims).toEqual(['T-FENCE-A', 'T-FENCE-B'])
      const builds = await h.store.listBuilds()
      expect(builds).toHaveLength(2)
      expect([...new Set(builds.map((build) => build.ticket?.id))].sort()).toEqual([
        'T-FENCE-A',
        'T-FENCE-B',
      ])

      // Both handshakes show a "successful" lease claim: the winner's real
      // claim and the loser's forced one (never delegated, so never false).
      expect(
        winnerStore.calls.some((call) => call.op === 'claimRepoLease' && call.result === true),
      ).toBe(true)
      const loserClaims = loserStore.calls.filter((call) => call.op === 'claimRepoLease')
      expect(loserClaims.length).toBeGreaterThan(0)
      expect(loserClaims.every((call) => call.result === true)).toBe(true)

      const repoEvents = await h.store.getRepoEvents(h.remote)

      // The required AC-4 evidence: the same invariant check that passed the
      // fenced scenario detects the lost fencing and throws.
      expect(() =>
        expectSingleOwner(
          asInvocations(
            { ...winnerStore, launched: winnerExec.launched, stderr: winner.stderr },
            { ...loserStore, launched: loserExec.launched, stderr: loser.stderr },
          ),
          repoEvents,
          builds,
        ),
      ).toThrow()
    } finally {
      await h.cleanup()
    }
  }, 120_000)
})

// ── A stalled holder that wakes after its lease expired ──────────────────────

/** An hour-long repository lease: the stepping clock advances on every read,
 * so a pass must not lapse unless a scenario stalls it on purpose. */
const LONG_LEASE_TOML = CONFIG_TOML.replace(
  '[policy]\n',
  '[policy]\ndispatchLeaseTimeoutSeconds = 3600\ndispatchLeaseRenewalSeconds = 20\n',
)
const STALL_MS = 3_601_000

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** Block the ticket path on the durable `ticket-preparation.intended` append:
 * it commits, then the host stalls until `release`. */
function stallAtIntended(store: BuildStore) {
  const stalled = deferred()
  const release = deferred()
  const append = store.appendRepo.bind(store)
  store.appendRepo = async (repo, event) => {
    const appended = await append(repo, event)
    if (event.type === 'ticket-preparation.intended') {
      stalled.resolve()
      await release.promise
    }
    return appended
  }
  return { stalled: stalled.promise, release: release.resolve }
}

/** Repository telemetry and stop facts authored by one run. */
async function runFacts(h: E2eHarness, run: string) {
  const events = await h.store.getRepoEvents(h.remote)
  const own = events.filter((event) => (event.payload as { run?: string }).run === run)
  return {
    telemetry: own.filter((event) =>
      ['dispatcher.tick-started', 'dispatcher.tick-completed', 'dispatcher.tick-failed'].includes(
        event.type,
      ),
    ).length,
    selfYields: events.filter(
      (event) => event.type === 'dispatcher.tick-yielded' && event.payload.holder === run,
    ).length,
    stops: own
      .filter((event) => event.type === 'dispatcher.run-stopped')
      .map((event) => (event.payload as { reason?: string }).reason ?? 'normal'),
  }
}

describe('a stalled holder wakes after its repository lease expired', () => {
  test('a peer took over: the stalled holder claims nothing, launches nothing and stops superseded', async () => {
    const h = await makeHarness({
      handlers: happyHandlers(),
      tickets: [readyTicket('T-STALL')],
      configToml: LONG_LEASE_TOML,
    })
    const stalledStore = recordingStore(h.store)
    const stall = stallAtIntended(stalledStore.store)
    const stalledExec = recordingBuildExecution(h.wiring.buildExecution)
    const peerStore = recordingStore(h.store)
    const peerExec = recordingBuildExecution(h.wiring.buildExecution)
    try {
      const stalled = startOnce(h, { store: stalledStore.store, execution: stalledExec.execution })
      await stall.stalled
      h.clock.advance(STALL_MS)
      const peer = startOnce(h, { store: peerStore.store, execution: peerExec.execution })
      await peer.promise
      stall.release()
      await stalled.promise

      const stalledRun = stalledStore.calls[0]!.holder
      // Only the peer reached the ticket source and the executor.
      expect(h.tickets.claims).toEqual(['T-STALL'])
      expect(stalledExec.launched).toEqual([])
      const builds = await h.store.listBuilds()
      expect(builds).toHaveLength(1)
      expect(peerExec.launched).toEqual([builds[0]!.slug])
      expect(builds[0]!.ticket?.id).toBe('T-STALL')
      expect(await runFacts(h, stalledRun)).toEqual({
        telemetry: 0,
        selfYields: 0,
        stops: ['superseded'],
      })
      expect(h.cliErrors).toEqual([])
    } finally {
      stall.release()
      await h.cleanup()
    }
  }, 60_000)

  test('no peer: the stalled holder reclaims its lease and later claims the ticket', async () => {
    const h = await makeHarness({
      handlers: happyHandlers(),
      tickets: [readyTicket('T-RECLAIM')],
      configToml: LONG_LEASE_TOML,
    })
    const recorded = recordingStore(h.store)
    const stall = stallAtIntended(recorded.store)
    const execution = recordingBuildExecution(h.wiring.buildExecution)
    const stop = new AbortController()
    const stderr: string[] = []
    let ticks = 0
    try {
      const running = abDispatch({
        targetRepo: h.origin,
        env: {},
        exec: spawnExec,
        stdout: () => {},
        stderr: (line) => stderr.push(line),
        signal: stop.signal,
        plain: true,
        sleep: async () => {
          ticks++
          if (execution.launched.length > 0 || ticks > 10) stop.abort()
        },
        wire: () => ({ ...h.wiring, store: recorded.store, buildExecution: execution.execution }),
      })
      await stall.stalled
      h.clock.advance(STALL_MS)
      stall.release()
      await running

      const run = recorded.calls[0]!.holder
      const claims = recorded.calls.filter((call) => call.op === 'claimRepoLease')
      expect(claims.length).toBeGreaterThanOrEqual(2)
      expect(claims.every((call) => call.result === true && call.holder === run)).toBe(true)
      const builds = await h.store.listBuilds()
      expect(builds).toHaveLength(1)
      expect(builds[0]!.ticket?.id).toBe('T-RECLAIM')
      expect(execution.launched).toEqual([builds[0]!.slug])
      const facts = await runFacts(h, run)
      expect(facts.selfYields).toBe(0)
      expect(facts.stops).toEqual(['normal'])
      expect(stderr.some((line) => line.includes('superseded'))).toBe(false)
    } finally {
      stall.release()
      stop.abort()
      await h.cleanup()
    }
  }, 60_000)
})
