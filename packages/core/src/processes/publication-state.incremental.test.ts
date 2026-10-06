import { describe, expect, test } from 'bun:test'
import type { AbEvent } from '../events/catalog'
import { checkIncremental, pick, seededRandom, shuffled } from '../kernel/incremental-contract'
import {
  PUBLICATION_STATE_REDUCER_VERSION,
  abandonedPublicationPending,
  latestUncompletedPublicationRequest,
  publicationLostRecorded,
  publicationPending,
  publicationRequestCompleted,
  publicationRequestSettled,
  publicationStateReducer,
  type PublicationLedger,
  type PublicationRequest,
  type PublicationView,
} from './publication-state'

function event(seq: number, type: string, payload: unknown): AbEvent {
  return {
    seq,
    ts: '2026-01-01T00:00:00.000Z',
    actor: { kind: 'kernel' },
    type,
    payload,
  } as AbEvent
}

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const provisioned = (seq: number, ref: string) =>
  event(seq, 'workspace.provisioned', {
    provider: 'vercel-sandbox',
    ref,
    remote: true,
    branch: 'ab/build',
    base: { source: 'existing', sha: B },
  })
const released = (seq: number, ref?: string) =>
  event(seq, 'workspace.released', {
    provider: 'vercel-sandbox',
    ...(ref === undefined ? {} : { ref }),
    reason: 'replacement',
  })
const implementRequest = (seq: number, sha = A) =>
  event(seq, 'publication.requested', {
    operation: 'implement',
    branch: 'ab/build',
    sha,
    round: 1,
    base: B,
    artifact: { kind: 'implement-notes', rev: 0 },
  })
const implementDone = (seq: number, head = A) =>
  event(seq, 'implement.completed', {
    round: 1,
    commits: { base: B, head },
    artifact: { kind: 'implement-notes', rev: 0 },
  })
const reconcileRequest = (seq: number, sha = A) =>
  event(seq, 'publication.requested', { operation: 'reconcile', branch: 'ab/build', sha })
const reconcileDone = (seq: number, mergeCommit = A) =>
  event(seq, 'reconcile.completed', { mergeCommit })
const finalizeRequest = (seq: number, sha = A) =>
  event(seq, 'publication.requested', { operation: 'finalize', branch: 'ab/build', sha })
const finalizeDone = (seq: number, headSha = A) =>
  event(seq, 'finalize.completed', { pr: { headSha } })
const stepRequest = (seq: number, step: string, sha = A) =>
  event(seq, 'publication.requested', {
    operation: 'finalize-step',
    step,
    branch: 'ab/build',
    sha,
  })
const stepDone = (seq: number, step: string, ok: boolean, headSha?: string) =>
  event(seq, 'finalize.step-completed', {
    step,
    ok,
    ...(headSha === undefined ? {} : { headSha }),
  })
const lost = (seq: number, request: number) =>
  event(seq, 'publication.lost', {
    request,
    operation: 'implement',
    branch: 'ab/build',
    sha: A,
    reason: 'replacement',
  })
const noise = (seq: number) => event(seq, 'observation.recorded', { kind: 'note', note: 'n' })

/** The original whole-array implementations, as the oracle. */
const oracle = {
  completed(events: readonly AbEvent[], request: PublicationRequest): boolean {
    return events.some((e) => {
      if (e.seq <= request.seq) return false
      const p = request.payload
      if (p.operation === 'implement')
        return (
          e.type === 'implement.completed' &&
          e.payload.round === p.round &&
          e.payload.commits.base === p.base &&
          e.payload.commits.head === p.sha
        )
      if (p.operation === 'reconcile')
        return e.type === 'reconcile.completed' && e.payload.mergeCommit === p.sha
      if (p.operation === 'finalize')
        return e.type === 'finalize.completed' && e.payload.pr.headSha === p.sha
      return (
        e.type === 'finalize.step-completed' &&
        e.payload.step === p.step &&
        (!e.payload.ok || e.payload.headSha === p.sha)
      )
    })
  },
  settled(events: readonly AbEvent[], request: PublicationRequest): boolean {
    let ref: string | undefined
    for (const e of events) {
      if (e.seq > request.seq) break
      if (e.type === 'workspace.provisioned') ref = e.payload.ref
      else if (e.type === 'workspace.released') ref = undefined
    }
    return (
      oracle.completed(events, request) ||
      events.some(
        (e) =>
          e.seq > request.seq &&
          e.type === 'workspace.released' &&
          (!('ref' in e.payload) || ref === undefined || e.payload.ref === ref),
      )
    )
  },
  latest(events: readonly AbEvent[]): PublicationRequest | undefined {
    const r = events.findLast(
      (e) => e.type === 'publication.requested' && !oracle.completed(events, e),
    )
    return r?.type === 'publication.requested' ? r : undefined
  },
  lost: (events: readonly AbEvent[], request: PublicationRequest) =>
    events.some((e) => e.type === 'publication.lost' && e.payload.request === request.seq),
  abandoned(events: readonly AbEvent[]) {
    const r = oracle.latest(events)
    return r !== undefined && oracle.settled(events, r)
  },
  pending: (events: readonly AbEvent[]) =>
    events.some((r) => r.type === 'publication.requested' && !oracle.settled(events, r)),
}

/** Every selector's answer, for the requests in `log`. */
function observe(view: PublicationView, log: readonly AbEvent[]) {
  const requests = log.filter((e): e is PublicationRequest => e.type === 'publication.requested')
  return {
    latest: view.latestUncompletedRequest()?.seq,
    abandoned: view.abandonedPending(),
    pending: view.pending(),
    perRequest: requests.map((r) => [
      r.seq,
      view.requestCompleted(r),
      view.requestSettled(r),
      view.lostRecorded(r),
    ]),
  }
}

function expectMatchesOracle(log: readonly AbEvent[]) {
  const requests = log.filter((e): e is PublicationRequest => e.type === 'publication.requested')
  expect(latestUncompletedPublicationRequest(log)?.seq).toBe(oracle.latest(log)?.seq)
  expect(abandonedPublicationPending(log)).toBe(oracle.abandoned(log))
  expect(publicationPending(log)).toBe(oracle.pending(log))
  for (const r of requests) {
    expect(publicationRequestCompleted(log, r)).toBe(oracle.completed(log, r))
    expect(publicationRequestSettled(log, r)).toBe(oracle.settled(log, r))
    expect(publicationLostRecorded(log, r)).toBe(oracle.lost(log, r))
  }
}

function check(log: readonly AbEvent[]) {
  expectMatchesOracle(log)
  // The view holds closures, which cannot be cloned; the contract compares
  // its observable answers instead.
  const observable = {
    ...publicationStateReducer,
    finish: (acc: PublicationLedger) => observe(publicationStateReducer.finish(acc), log),
    reduce: (events: readonly AbEvent[]) => observe(publicationStateReducer.reduce(events), log),
  }
  checkIncremental(observable, log)
}

function generated(seed: number): AbEvent[] {
  const rand = seededRandom(seed)
  const n = 5 + Math.floor(rand() * 20)
  const refs = ['g0', 'g1', 'g2']
  const log: AbEvent[] = []
  for (let seq = 1; seq <= n; seq++) {
    const sha = pick(rand, [A, B, C])
    const make = pick<() => AbEvent>(rand, [
      () => implementRequest(seq, sha),
      () => reconcileRequest(seq, sha),
      () => finalizeRequest(seq, sha),
      () => stepRequest(seq, pick(rand, ['fmt', 'docs']), sha),
      () => implementDone(seq, sha),
      () => reconcileDone(seq, sha),
      () => finalizeDone(seq, sha),
      () =>
        stepDone(seq, pick(rand, ['fmt', 'docs']), rand() < 0.3, rand() < 0.5 ? sha : undefined),
      () => provisioned(seq, pick(rand, refs)),
      () => released(seq, rand() < 0.7 ? pick(rand, refs) : undefined),
      () => lost(seq, 1 + Math.floor(rand() * n)),
      () => noise(seq),
      () => noise(seq),
      () => noise(seq),
    ])
    log.push(make())
  }
  return rand() < 0.6 ? shuffled(rand, log) : log
}

describe('publicationStateReducer', () => {
  test('version starts at 1', () => {
    expect(PUBLICATION_STATE_REDUCER_VERSION).toBe(1)
  })

  test('counterexample: an irrelevant event between workspace facts is a scan barrier', () => {
    const request = implementRequest(5, A) as PublicationRequest
    const log = [
      provisioned(1, 'first'),
      noise(10),
      provisioned(2, 'second'),
      request,
      released(6, 'second'),
    ]
    expect(publicationRequestSettled(log, request)).toBe(false)
    // A ledger filtered to relevant types alone would report true.
    expect(
      publicationRequestSettled(
        log.filter((e) => e.type !== 'observation.recorded'),
        request,
      ),
    ).toBe(true)
    check(log)
  })

  test('collapses runs of irrelevant events into one barrier', () => {
    const acc = publicationStateReducer.advance(publicationStateReducer.initial(), [
      noise(3),
      noise(9),
      noise(4),
      implementRequest(5),
      noise(2),
    ])
    expect(acc.ledger.map((i) => i.t)).toEqual(['barrier', 'request', 'barrier'])
    expect(acc.ledger[0]?.seq).toBe(9)
    const more = publicationStateReducer.advance(acc, [noise(11)])
    expect(more.ledger.map((i) => i.t)).toEqual(['barrier', 'request', 'barrier'])
    expect(more.ledger[2]?.seq).toBe(11)
  })

  const fixtures: Record<string, AbEvent[]> = {
    empty: [],
    parksThenCompletes: [implementRequest(4), implementDone(5)],
    unsettled: [implementRequest(4)],
    abandonedByRelease: [
      provisioned(3, 'sandbox-g0'),
      implementRequest(4),
      released(5, 'sandbox-g0'),
      provisioned(6, 'sandbox-g1'),
    ],
    unrelatedRelease: [provisioned(3, 'g1'), implementRequest(4), released(5, 'g0')],
    refless: [provisioned(3, 'g1'), implementRequest(4), released(5)],
    reconcile: [reconcileRequest(2), noise(3), reconcileDone(4)],
    finalize: [finalizeRequest(2), finalizeDone(3, B), finalizeRequest(4, C)],
    steps: [
      stepDone(2, 'format', true),
      stepRequest(3, 'format'),
      stepDone(4, 'docs', true),
      stepDone(5, 'format', true, A),
      stepRequest(6, 'x'),
      stepDone(7, 'x', false),
    ],
    lost: [implementRequest(4), lost(5, 4), lost(6, 99)],
    shuffledMixed: [released(6, 'g'), implementRequest(4), noise(1), provisioned(3, 'g'), noise(9)],
  }
  for (const [name, log] of Object.entries(fixtures)) {
    test(`fixture: ${name}`, () => check(log))
  }

  for (let seed = 1; seed <= 40; seed++) {
    test(`generated, mixed with irrelevant events and shuffled: seed ${seed}`, () => {
      check(generated(seed))
    })
  }
})
