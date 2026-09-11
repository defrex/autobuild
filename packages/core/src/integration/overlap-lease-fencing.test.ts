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
import { happyHandlers, makeHarness, readyTicket, type E2eHarness } from './harness'

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

      // The yield is durable evidence naming the winner as holder, with no
      // run-surprise payload (no kernelRunId ⇒ no `run` key).
      const repoEvents = await h.store.getRepoEvents(h.remote)
      const yields = repoEvents.filter((event) => event.type === 'dispatcher.tick-yielded')
      expect(yields).toHaveLength(1)
      expect(yields[0]!.payload).toEqual({ holder })

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
