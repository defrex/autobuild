/**
 * Incremental contract for the engine's raw-log index over seeded generated
 * logs, checked against the original whole-array `indexLog` (kept verbatim
 * below as the oracle) — including shuffled arrays, where a later-in-array
 * `spec.revised` can carry a lower seq than events already folded.
 */
import { describe, expect, test } from 'bun:test'
import type { AbEvent, EventWrite } from '../events/catalog'
import { allowedActorKinds, validateEventWrite } from '../events/catalog'
import { KERNEL, DISPATCHER, humanActor, type Actor } from '../events/envelope'
import { normalizeVerifyCompletion, type EventPayload, type EventType } from '../events/payloads'
import { verifyPhase, type Feedback } from '../ontology'
import { steppingClock } from '../testing/fixed'
import { checkIncremental, pick, seededRandom, shuffled } from './incremental-contract'
import {
  indexLog,
  logIndexReducer,
  type GuidanceDelivery,
  type LogIndex,
  type LoopIndex,
  type ReconcileCompletionRecord,
  type ReconcileProgressRecord,
  type ReconcileStartRecord,
  type RoundRecord,
  type VerdictRecord,
  type VerifyRecord,
} from './log-index'

// ── Oracle: the pre-extraction implementation, verbatim ──────────────────────

type ReviewVerdictPayload = EventPayload<'plan-review.verdict'>

function emptyLoop(): LoopIndex {
  return {
    maxRoundEver: 0,
    maxRound: 0,
    rounds: new Map(),
    latestApproveSeq: 0,
    findingsByRound: [],
  }
}

function referenceIndexLog(events: AbEvent[]): LogIndex {
  // Pass 1: the restart boundary — seq of the latest spec.revised (§6.3).
  let restartSeq = 0
  for (const event of events) {
    if (event.type === 'spec.revised') restartSeq = event.seq
  }

  const plan = emptyLoop()
  const code = emptyLoop()
  const verifyCompleted: VerifyRecord[] = []
  const verifyStarted: { seq: number; attempt: number }[] = []
  let maxVerifyAttemptEver = 0
  const finalizeStepsDone = new Set<string>()
  const guidanceDeliveries: GuidanceDelivery[] = []
  const pendingGuidanceStarts = new Map<string, { escalation: string; seq: number }>()
  let lastReconcileCompletedSeq = 0
  let lastImplementCompletedSeq = 0
  let finalizeCompleted = false
  let lastConflict: { seq: number } | undefined
  let conflictReconcileStarted: { attempt: number } | undefined
  const conflictSeqs = new Set<number>()
  const reconcileStarts: ReconcileStartRecord[] = []
  const reconcileCompletions: ReconcileCompletionRecord[] = []
  const reconcileProgressChecks: ReconcileProgressRecord[] = []
  let activeReconcileStart: ReconcileStartRecord | undefined

  /** Track a loop round: maxRoundEver over the full log; the per-round record
   * only for post-restart events (returns undefined pre-restart). */
  const roundRecord = (loop: LoopIndex, r: number, post: boolean): RoundRecord | undefined => {
    if (r > loop.maxRoundEver) loop.maxRoundEver = r
    if (!post) return undefined
    if (r > loop.maxRound) loop.maxRound = r
    let record = loop.rounds.get(r)
    if (record === undefined) {
      record = {}
      loop.rounds.set(r, record)
    }
    return record
  }

  const noteGuidanceStart = (key: string, feedback: Feedback | undefined, seq: number): void => {
    // A newer start is the authoritative carrier for this exact occurrence.
    // In particular, a guidance-free retry must not let its later session
    // consume an older citation that never launched.
    if (feedback !== undefined && 'guidance' in feedback) {
      pendingGuidanceStarts.set(key, {
        escalation: feedback.guidance.escalation,
        seq,
      })
    } else {
      pendingGuidanceStarts.delete(key)
    }
  }

  const noteVerdict = (
    loop: LoopIndex,
    payload: ReviewVerdictPayload,
    seq: number,
    post: boolean,
  ): void => {
    const record = roundRecord(loop, payload.round, post)
    if (record === undefined) return
    const verdict: VerdictRecord = {
      seq,
      round: payload.round,
      verdict: payload.verdict,
      findings: payload.findings,
      reason: payload.reason,
    }
    record.verdict = verdict
    if (payload.verdict === 'revise') loop.latestRevise = verdict
    if (payload.verdict === 'approve') {
      loop.latestApproveSeq = seq
      // Snapshot at verdict time. A plan.completed appended later — even for
      // this round — was never reviewed and therefore has no authority.
      if (loop === plan) loop.approvedPlan = record.planCompletion
    }
    // Findings per round, reducer-style padding (rounds without verdicts stay
    // empty — including every pre-restart round, which is the point).
    while (loop.findingsByRound.length < payload.round) loop.findingsByRound.push([])
    loop.findingsByRound[payload.round - 1] = payload.findings
  }

  for (const event of events) {
    const post = event.seq > restartSeq
    switch (event.type) {
      case 'plan.started': {
        noteGuidanceStart(`plan@${event.payload.round}`, event.payload.feedback, event.seq)
        const record = roundRecord(plan, event.payload.round, post)
        if (record !== undefined) record.startedSeq = event.seq
        break
      }
      case 'plan.completed': {
        const record = roundRecord(plan, event.payload.round, post)
        if (record !== undefined) {
          record.completedSeq = event.seq
          record.planCompletion = {
            seq: event.seq,
            artifact: event.payload.artifact,
            ...(event.payload.verifySteps !== undefined
              ? { verifySteps: [...event.payload.verifySteps] }
              : {}),
          }
        }
        break
      }
      case 'plan-review.started':
        roundRecord(plan, event.payload.round, post)
        break
      case 'plan-review.verdict':
        noteVerdict(plan, event.payload, event.seq, post)
        break

      case 'implement.started': {
        noteGuidanceStart(`implement@${event.payload.round}`, event.payload.feedback, event.seq)
        const record = roundRecord(code, event.payload.round, post)
        if (record !== undefined) record.startedSeq = event.seq
        break
      }
      case 'implement.completed': {
        const record = roundRecord(code, event.payload.round, post)
        if (record !== undefined) record.completedSeq = event.seq
        if (post) lastImplementCompletedSeq = event.seq
        break
      }
      case 'code-review.started':
        roundRecord(code, event.payload.round, post)
        break
      case 'code-review.verdict':
        noteVerdict(code, event.payload, event.seq, post)
        break

      case 'verify.started': {
        noteGuidanceStart(
          `${verifyPhase(event.payload.step)}@${event.payload.attempt}`,
          event.payload.feedback,
          event.seq,
        )
        maxVerifyAttemptEver = Math.max(maxVerifyAttemptEver, event.payload.attempt)
        if (post)
          verifyStarted.push({
            seq: event.seq,
            attempt: event.payload.attempt,
          })
        break
      }
      case 'session.started': {
        if (event.payload.round === undefined) break
        const key = `${event.payload.phase}@${event.payload.round}`
        const carrier = pendingGuidanceStarts.get(key)
        if (carrier !== undefined && carrier.seq < event.seq) {
          guidanceDeliveries.push({
            escalation: carrier.escalation,
            seq: event.seq,
          })
          pendingGuidanceStarts.delete(key)
        }
        break
      }
      case 'verify.completed': {
        const result = normalizeVerifyCompletion(event.payload)
        maxVerifyAttemptEver = Math.max(maxVerifyAttemptEver, result.attempt)
        if (post) {
          verifyCompleted.push({
            seq: event.seq,
            step: result.step,
            attempt: result.attempt,
            outcome: result.outcome,
            ...(result.report !== undefined ? { report: result.report } : {}),
            ...(result.reason !== undefined ? { reason: result.reason } : {}),
          })
        }
        break
      }

      case 'finalize.completed':
        if (post) finalizeCompleted = true
        break
      case 'finalize.step-completed':
        if (post) finalizeStepsDone.add(event.payload.step)
        break

      case 'pr.conflicted':
        lastConflict = { seq: event.seq }
        conflictSeqs.add(event.seq)
        conflictReconcileStarted = undefined
        break
      case 'reconcile.progress-checked':
        reconcileProgressChecks.push({ seq: event.seq, ...event.payload })
        break
      case 'reconcile.started': {
        const start = { seq: event.seq, ...event.payload }
        reconcileStarts.push(start)
        activeReconcileStart = start
        if (lastConflict !== undefined && event.seq > lastConflict.seq) {
          conflictReconcileStarted = { attempt: event.payload.attempt }
        }
        break
      }
      case 'reconcile.completed':
        if (post) lastReconcileCompletedSeq = event.seq
        if (activeReconcileStart !== undefined) {
          reconcileCompletions.push({
            ...activeReconcileStart,
            completedSeq: event.seq,
          })
          activeReconcileStart = undefined
        }
        conflictReconcileStarted = undefined
        break

      default:
        break
    }
  }

  // One completed occurrence per monotonic attempt. A later duplicate
  // completion is safer to pair with its own latest start than with an older
  // aggregate high-water, and malformed unmatched completions classify nothing.
  const completedByAttempt = new Map<number, ReconcileCompletionRecord>()
  for (const completion of reconcileCompletions) {
    completedByAttempt.set(completion.attempt, completion)
  }
  const completed = [...completedByAttempt.values()].sort(
    (left, right) => left.completedSeq - right.completedSeq,
  )

  let reconcileNoProgressCount = 0
  for (const completion of completed) {
    const nextStart = reconcileStarts.find(
      (start) => start.seq > completion.completedSeq && start.attempt > completion.attempt,
    )
    const observationLimit = nextStart?.seq ?? Number.POSITIVE_INFINITY
    // Explicit checks win over the historical fallback. Use the latest one
    // that could have routed this next occurrence; duplicate conflict facts do
    // not count one completed reconcile more than once.
    const explicit = reconcileProgressChecks
      .filter(
        (check) =>
          check.attempt === completion.attempt &&
          check.seq > completion.completedSeq &&
          check.seq < observationLimit &&
          check.conflictSeq > completion.completedSeq &&
          check.seq > check.conflictSeq &&
          conflictSeqs.has(check.conflictSeq),
      )
      .at(-1)
    const observedBase = explicit?.baseSha ?? nextStart?.baseSha
    if (observedBase === completion.baseSha) reconcileNoProgressCount += 1
  }

  const lastReconcileCompleted = completed.at(-1)
  const lastConflictProgressCheck =
    lastConflict === undefined || lastReconcileCompleted === undefined
      ? undefined
      : reconcileProgressChecks
          .filter(
            (check) =>
              check.conflictSeq === lastConflict.seq &&
              check.attempt === lastReconcileCompleted.attempt &&
              check.seq > lastConflict.seq,
          )
          .at(-1)

  return {
    restartSeq,
    plan,
    code,
    verifyCompleted,
    verifyStarted,
    maxVerifyAttemptEver,
    lastReconcileCompletedSeq,
    lastImplementCompletedSeq,
    finalizeCompleted,
    finalizeStepsDone,
    lastConflict,
    conflictReconcileStarted,
    lastReconcileCompleted,
    lastConflictProgressCheck,
    reconcileNoProgressCount,
    guidanceDeliveries,
  }
}

// ── Generated logs ───────────────────────────────────────────────────────────

function actorFor(type: string): Actor {
  switch (allowedActorKinds[type as EventType][0]) {
    case 'kernel':
      return KERNEL
    case 'dispatcher':
      return DISPATCHER
    case 'human':
      return humanActor('aron')
    case 'agent':
      return { kind: 'agent', role: 'test-role', session: 's_test' }
    default:
      return { kind: 'ingester', source: 'test' }
  }
}

const w = (type: string, payload: Record<string, unknown>, _actor?: unknown): EventWrite =>
  validateEventWrite({ actor: actorFor(type), type, payload } as EventWrite)

const guidance = (n: number): Feedback => ({
  guidance: { escalation: `e_${n}`, answer: 'a' },
})

function randomWrite(rand: () => number): EventWrite {
  const round = 1 + Math.floor(rand() * 3)
  const attempt = 1 + Math.floor(rand() * 3)
  const step = pick(rand, ['types', 'e2e'])
  const feedback = (): Feedback | undefined =>
    rand() < 0.5 ? guidance(1 + Math.floor(rand() * 2)) : undefined
  const agent = { kind: 'agent', role: 'r', session: 's' } as const
  const templates: Array<() => EventWrite> = [
    () =>
      w('spec.revised', { artifact: { kind: 'spec', rev: round }, escalation: 1 }, humanActor('a')),
    () => w('plan.started', { round, feedback: feedback() }),
    () =>
      w('plan.completed', {
        round,
        artifact: { kind: 'plan', rev: round },
        ...(rand() < 0.5 ? { verifySteps: ['types'] } : {}),
      }),
    () => w('plan-review.started', { round }),
    () =>
      w('plan-review.verdict', {
        round,
        verdict: pick(rand, ['approve', 'revise'] as const),
        findings:
          rand() < 0.5 ? [] : [{ id: 'f1', severity: 'blocking', summary: 's', persists: [] }],
        artifact: { kind: 'plan-review', rev: round },
        reason: rand() < 0.3 ? 'why' : undefined,
      }),
    () => w('implement.started', { round, feedback: feedback() }),
    () =>
      w('implement.completed', {
        round,
        commits: { base: 'b', head: `h${round}` },
        artifact: { kind: 'implement-notes', rev: round },
      }),
    () => w('code-review.started', { round }),
    () =>
      w('code-review.verdict', {
        round,
        verdict: pick(rand, ['approve', 'revise'] as const),
        findings: [],
        artifact: { kind: 'code-review', rev: round },
      }),
    () =>
      w('verify.started', {
        step,
        attempt,
        ...(step === 'e2e' ? { feedback: feedback() } : {}),
      }),
    () => w('verify.completed', { step, attempt, pass: rand() < 0.5 }),
    () =>
      w('finalize.completed', {
        pr: { number: 7, url: 'https://github.com/o/r/pull/7', headSha: 'h' },
      }),
    () =>
      w('finalize.step-completed', {
        step: pick(rand, ['n1', 'n2']),
        ok: rand() < 0.5,
      }),
    () => w('pr.conflicted', { baseSha: 'm' }),
    () => w('reconcile.started', { attempt, baseSha: pick(rand, ['m1', 'm2']) }),
    () =>
      w('reconcile.completed', {
        mergeCommit: 'mc',
        artifact: { kind: 'reconcile-notes', rev: attempt },
      }),
    () =>
      w('reconcile.progress-checked', {
        conflictSeq: 1 + Math.floor(rand() * 20),
        attempt,
        baseSha: pick(rand, ['m1', 'm2']),
      }),
    () =>
      w(
        'session.started',
        {
          session: 's_x',
          role: 'r',
          runner: 'claude',
          ...pick(rand, [
            { phase: 'plan', round },
            { phase: 'implement', round },
            { phase: verifyPhase('e2e'), round: attempt },
            { phase: 'plan' },
          ]),
        },
        agent,
      ),
    () => w('observation.recorded', { id: 'o', kind: 'refactor', summary: 's', files: [] }, agent),
  ]
  return pick(rand, templates)()
}

function makeLog(writes: EventWrite[]): AbEvent[] {
  const clock = steppingClock()
  return writes.map(
    (write, index) =>
      ({
        build: 'b',
        seq: index + 1,
        ts: clock().toISOString(),
        actor: write.actor,
        type: write.type,
        payload: write.payload,
      }) as AbEvent,
  )
}

const normalize = (index: LogIndex): unknown => structuredClone(index)

describe('indexLog incremental reducer', () => {
  test('matches the original implementation on generated logs, ordered and shuffled', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const rand = seededRandom(seed)
      const length = 6 + Math.floor(rand() * 14)
      const ordered = makeLog(Array.from({ length }, () => randomWrite(rand)))
      for (const log of [ordered, shuffled(rand, ordered), shuffled(rand, ordered)]) {
        expect(normalize(indexLog(log))).toEqual(normalize(referenceIndexLog(log)))
        checkIncremental(logIndexReducer, log, {
          compare: (actual, expected) => {
            expect(normalize(actual)).toEqual(normalize(expected))
            expect(normalize(actual)).toEqual(normalize(referenceIndexLog(log)))
          },
        })
      }
    }
  })

  test('a later-in-array spec.revised with a lower seq demotes already-folded events', () => {
    const log = makeLog([
      w('plan.started', { round: 1 }),
      w('plan.completed', { round: 1, artifact: { kind: 'plan', rev: 0 } }),
      w('spec.revised', { artifact: { kind: 'spec', rev: 1 }, escalation: 1 }, humanActor('a')),
      w('plan.started', { round: 2 }),
    ])
    const arrays = [
      log,
      [log[0], log[1], log[3], log[2]] as AbEvent[],
      [log[2], log[3], log[0], log[1]] as AbEvent[],
    ]
    for (const events of arrays) {
      expect(normalize(indexLog(events))).toEqual(normalize(referenceIndexLog(events)))
      checkIncremental(logIndexReducer, events, {
        compare: (a, e) => expect(normalize(a)).toEqual(normalize(e)),
      })
    }
  })

  test('repeat-conflict reconcile sequences and guidance deliveries', () => {
    const log = makeLog([
      w('pr.conflicted', { baseSha: 'm0' }),
      w('reconcile.started', { attempt: 1, baseSha: 'm1' }),
      w('reconcile.completed', {
        mergeCommit: 'c1',
        artifact: { kind: 'reconcile-notes', rev: 0 },
      }),
      w('pr.conflicted', { baseSha: 'm1' }),
      w('reconcile.progress-checked', {
        conflictSeq: 4,
        attempt: 1,
        baseSha: 'm1',
      }),
      w('reconcile.started', { attempt: 2, baseSha: 'm1' }),
      w('reconcile.completed', {
        mergeCommit: 'c2',
        artifact: { kind: 'reconcile-notes', rev: 1 },
      }),
      w('pr.conflicted', { baseSha: 'm1' }),
      w('implement.started', { round: 1, feedback: guidance(1) }),
      w(
        'session.started',
        { session: 's', role: 'i', runner: 'c', phase: 'implement', round: 1 },
        { kind: 'agent', role: 'r', session: 's' },
      ),
      w('verify.started', { step: 'e2e', attempt: 1, feedback: guidance(2) }),
      w(
        'session.started',
        {
          session: 's2',
          role: 'v',
          runner: 'c',
          phase: verifyPhase('e2e'),
          round: 1,
        },
        { kind: 'agent', role: 'r', session: 's' },
      ),
    ])
    expect(normalize(indexLog(log))).toEqual(normalize(referenceIndexLog(log)))
    expect(indexLog(log).guidanceDeliveries).toHaveLength(2)
    checkIncremental(logIndexReducer, log, {
      compare: (a, e) => expect(normalize(a)).toEqual(normalize(e)),
    })
  })
})
