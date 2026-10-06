/**
 * The engine's raw-log index (see `LogIndex`): the projections `reduceBuild`
 * does not carry. Extracted from `engine.ts` as an incremental reducer.
 *
 * The restart boundary (`restartSeq`, the seq of the LAST `spec.revised` in
 * array order) is only known once the whole log has been read, and a later
 * `spec.revised` retroactively demotes events already folded as post-restart.
 * The accumulator therefore has two parts: running state that never depends on
 * the boundary (folded as the loop always did), and an in-array-order candidate
 * list of compact records for every event the post-restart projections read.
 * `finish` replays the candidates against the final `restartSeq`, so any array
 * order — including shuffled — reproduces the whole-array result exactly.
 */
import type { AbEvent } from '../events/catalog'
import { normalizeVerifyCompletion, type EventPayload } from '../events/payloads'
import {
  verifyPhase,
  type ArtifactRef,
  type Feedback,
  type Finding,
  type ReviewVerdictKind,
  type VerifyOutcome,
} from '../ontology'
import { defineReducer } from './incremental'

// ── Raw-log index ────────────────────────────────────────────────────────────
//
// Every field here is a projection the reducer does not carry (or carries
// without the seq the engine routes on). Loop and verify progress counts only
// events with seq > restartSeq (§6.3 immutability: every reviewer approves
// conformance to ONE spec revision — a drifting spec silently converts
// approvals into approvals-of-something-else, so approvals of an old spec do
// not carry across `spec.revised`).

export interface VerdictRecord {
  seq: number
  round: number
  verdict: ReviewVerdictKind
  findings: Finding[]
  reason?: string
}

export interface PlanCompletionRecord {
  seq: number
  artifact: ArtifactRef
  verifySteps?: string[]
}

export interface RoundRecord {
  startedSeq?: number
  completedSeq?: number
  /** Plan only. Kept separately so approval snapshots this exact completion. */
  planCompletion?: PlanCompletionRecord
  verdict?: VerdictRecord
}

export interface LoopIndex {
  /**
   * Max round in any of this loop's events over the FULL log. Round numbers
   * continue monotonically across spec restarts (next round = max round ever
   * seen + 1) so the log stays unambiguous: "plan round 1" must name exactly
   * one producer run, not one per spec revision.
   */
  maxRoundEver: number
  /** Max round with post-restart events; 0 when the loop is untouched. */
  maxRound: number
  /** Post-restart per-round event records (latest occurrence wins). */
  rounds: Map<number, RoundRecord>
  /** Latest post-restart revise verdict — the findings-feedback source. */
  latestRevise?: VerdictRecord
  /** seq of the latest post-restart approve verdict (verify cycle boundary). */
  latestApproveSeq: number
  /** Plan only: the completion present when the latest approve verdict landed.
   * A later orphan or superseded completion cannot replace this snapshot. */
  approvedPlan?: PlanCompletionRecord
  /** Findings per round (index round-1), post-restart — stalledChains input.
   * The reducer's reviewFindings spans restarts; this one must not. */
  findingsByRound: Finding[][]
}

export interface VerifyRecord {
  seq: number
  step: string
  attempt: number
  outcome: VerifyOutcome
  report?: ArtifactRef
  reason?: string
}

export interface GuidanceDelivery {
  escalation: string
  /** seq of the matching `session.started` that made the carrier actionable. */
  seq: number
}

export interface ReconcileStartRecord {
  seq: number
  attempt: number
  baseSha: string
}

export interface ReconcileCompletionRecord extends ReconcileStartRecord {
  completedSeq: number
}

export interface ReconcileProgressRecord {
  seq: number
  conflictSeq: number
  attempt: number
  baseSha: string
}

export interface LogIndex {
  /** seq of the latest `spec.revised`, else 0 — the restart boundary (§6.3). */
  restartSeq: number
  plan: LoopIndex
  code: LoopIndex
  /** Post-restart `verify.completed` facts with seq, for the same sequence-based
   * cycle boundary query exposed by the reducer (§15.6-A). */
  verifyCompleted: VerifyRecord[]
  /** Post-restart `verify.started` facts — a crashed step re-runs at the SAME
   * attempt (§15.6-C), so the current cycle's attempt must be readable from
   * its start events even before any completion lands. */
  verifyStarted: { seq: number; attempt: number }[]
  /**
   * Max verify attempt in any `verify.started`/`verify.completed` over the
   * FULL log. Attempt numbers continue monotonically across spec restarts and
   * reconcile cycles — the same rationale as LoopIndex.maxRoundEver: the log
   * stays unambiguous ("verify attempt 2" names exactly one cycle) and D5
   * failure keys (verify:<step>, round = attempt) never collide across cycles.
   * This high-water allocates attempt numbers; current-cycle membership is
   * independently sequence-based.
   */
  maxVerifyAttemptEver: number
  /** seq of the latest post-restart `reconcile.completed` — cycle boundary
   * input: reconciliation changed code, verify re-runs in full (§15.7). */
  lastReconcileCompletedSeq: number
  /** seq of the latest post-restart `implement.completed` — a verify failure
   * with an implement round after it was already routed (§15.6-A). */
  lastImplementCompletedSeq: number
  /** Post-restart `finalize.completed` seen (the reducer only projects pr). */
  finalizeCompleted: boolean
  /** Post-restart `finalize.step-completed` steps, ok true OR false —
   * post-steps are failure-tolerant (§5), so any completion counts. */
  finalizeStepsDone: Set<string>
  /** Latest `pr.conflicted` (full log — the epilogue is restart-orthogonal);
   * only its seq is needed for policy/dedupe. Its baseSha is detection-time
   * evidence, not the reconcile merge target (§15.7). */
  lastConflict?: { seq: number }
  /** A `reconcile.started` after lastConflict without its completion — a
   * crashed reconcile re-runs the SAME attempt from its start (§15.6-C). */
  conflictReconcileStarted?: { attempt: number }
  /** Most recent completed reconcile, paired with the latest same-occurrence
   * start so crash retries use the base that actually completed. */
  lastReconcileCompleted?: ReconcileCompletionRecord
  /** Explicit authoritative observation for the current repeat conflict. */
  lastConflictProgressCheck?: ReconcileProgressRecord
  /** Distinct completed attempts observed still conflicted at the same base.
   * A later attempt start supplies the observation for pre-event logs. */
  reconcileNoProgressCount: number
  /** Guidance carriers that reached a matching durable session launch.
   * Plan, implement, and agent-verify starts may cite feedback (§15.3), but a
   * citation alone remains recoverable across the pre-launch crash boundary.
   * Only a later `session.started` for the same phase and round/attempt marks
   * that answer delivered (§15.6-B). */
  guidanceDeliveries: GuidanceDelivery[]
}

export const LOG_INDEX_REDUCER_VERSION = 1

type ReviewVerdictPayload = EventPayload<'plan-review.verdict'>

type LoopName = 'plan' | 'code'

/** A post-restart candidate: the fields the replay reads, in array order. */
export type LogIndexCandidate =
  | { kind: 'round-start'; loop: LoopName; seq: number; round: number }
  | {
      kind: 'plan-completed'
      seq: number
      round: number
      artifact: ArtifactRef
      verifySteps?: string[]
    }
  | { kind: 'round-touch'; loop: LoopName; seq: number; round: number }
  | { kind: 'round-completed'; loop: LoopName; seq: number; round: number }
  | {
      kind: 'verdict'
      loop: LoopName
      seq: number
      round: number
      verdict: ReviewVerdictKind
      findings: Finding[]
      reason?: string
    }
  | { kind: 'implement-completed'; seq: number }
  | { kind: 'verify-started'; seq: number; attempt: number }
  | { kind: 'verify-completed'; record: VerifyRecord }
  | { kind: 'finalize-completed'; seq: number }
  | { kind: 'finalize-step'; seq: number; step: string }
  | { kind: 'reconcile-completed'; seq: number }

export interface LogIndexAcc {
  /** Full-log running state. */
  restartSeq: number
  maxRoundEver: { plan: number; code: number }
  maxVerifyAttemptEver: number
  pendingGuidanceStarts: Record<string, { escalation: string; seq: number }>
  guidanceDeliveries: GuidanceDelivery[]
  lastConflict?: { seq: number }
  conflictSeqs: number[]
  conflictReconcileStarted?: { attempt: number }
  activeReconcileStart?: ReconcileStartRecord
  reconcileStarts: ReconcileStartRecord[]
  reconcileCompletions: ReconcileCompletionRecord[]
  reconcileProgressChecks: ReconcileProgressRecord[]
  /** Post-restart candidates, replayed in `finish` against the final restart. */
  candidates: LogIndexCandidate[]
}

function initialLogIndexAcc(): LogIndexAcc {
  return {
    restartSeq: 0,
    maxRoundEver: { plan: 0, code: 0 },
    maxVerifyAttemptEver: 0,
    pendingGuidanceStarts: {},
    guidanceDeliveries: [],
    conflictSeqs: [],
    reconcileStarts: [],
    reconcileCompletions: [],
    reconcileProgressChecks: [],
    candidates: [],
  }
}

function emptyLoop(): LoopIndex {
  return {
    maxRoundEver: 0,
    maxRound: 0,
    rounds: new Map(),
    latestApproveSeq: 0,
    findingsByRound: [],
  }
}

function foldLogIndex(acc: LogIndexAcc, events: readonly AbEvent[]): void {
  const noteRound = (loop: LoopName, round: number): void => {
    if (round > acc.maxRoundEver[loop]) acc.maxRoundEver[loop] = round
  }
  const noteGuidanceStart = (key: string, feedback: Feedback | undefined, seq: number): void => {
    // A newer start is the authoritative carrier for this exact occurrence.
    // In particular, a guidance-free retry must not let its later session
    // consume an older citation that never launched.
    if (feedback !== undefined && 'guidance' in feedback) {
      acc.pendingGuidanceStarts[key] = {
        escalation: feedback.guidance.escalation,
        seq,
      }
    } else {
      delete acc.pendingGuidanceStarts[key]
    }
  }

  for (const event of events) {
    switch (event.type) {
      case 'spec.revised':
        acc.restartSeq = event.seq
        break
      case 'plan.started':
        noteGuidanceStart(`plan@${event.payload.round}`, event.payload.feedback, event.seq)
        noteRound('plan', event.payload.round)
        acc.candidates.push({
          kind: 'round-start',
          loop: 'plan',
          seq: event.seq,
          round: event.payload.round,
        })
        break
      case 'plan.completed':
        noteRound('plan', event.payload.round)
        acc.candidates.push({
          kind: 'plan-completed',
          seq: event.seq,
          round: event.payload.round,
          artifact: event.payload.artifact,
          ...(event.payload.verifySteps !== undefined
            ? { verifySteps: [...event.payload.verifySteps] }
            : {}),
        })
        break
      case 'plan-review.started':
        noteRound('plan', event.payload.round)
        acc.candidates.push({
          kind: 'round-touch',
          loop: 'plan',
          seq: event.seq,
          round: event.payload.round,
        })
        break
      case 'plan-review.verdict':
        noteRound('plan', event.payload.round)
        acc.candidates.push(verdictCandidate('plan', event.payload, event.seq))
        break

      case 'implement.started':
        noteGuidanceStart(`implement@${event.payload.round}`, event.payload.feedback, event.seq)
        noteRound('code', event.payload.round)
        acc.candidates.push({
          kind: 'round-start',
          loop: 'code',
          seq: event.seq,
          round: event.payload.round,
        })
        break
      case 'implement.completed':
        noteRound('code', event.payload.round)
        acc.candidates.push({
          kind: 'round-completed',
          loop: 'code',
          seq: event.seq,
          round: event.payload.round,
        })
        acc.candidates.push({ kind: 'implement-completed', seq: event.seq })
        break
      case 'code-review.started':
        noteRound('code', event.payload.round)
        acc.candidates.push({
          kind: 'round-touch',
          loop: 'code',
          seq: event.seq,
          round: event.payload.round,
        })
        break
      case 'code-review.verdict':
        noteRound('code', event.payload.round)
        acc.candidates.push(verdictCandidate('code', event.payload, event.seq))
        break

      case 'verify.started':
        noteGuidanceStart(
          `${verifyPhase(event.payload.step)}@${event.payload.attempt}`,
          event.payload.feedback,
          event.seq,
        )
        acc.maxVerifyAttemptEver = Math.max(acc.maxVerifyAttemptEver, event.payload.attempt)
        acc.candidates.push({
          kind: 'verify-started',
          seq: event.seq,
          attempt: event.payload.attempt,
        })
        break
      case 'session.started': {
        if (event.payload.round === undefined) break
        const key = `${event.payload.phase}@${event.payload.round}`
        const carrier = acc.pendingGuidanceStarts[key]
        if (carrier !== undefined && carrier.seq < event.seq) {
          acc.guidanceDeliveries.push({
            escalation: carrier.escalation,
            seq: event.seq,
          })
          delete acc.pendingGuidanceStarts[key]
        }
        break
      }
      case 'verify.completed': {
        const result = normalizeVerifyCompletion(event.payload)
        acc.maxVerifyAttemptEver = Math.max(acc.maxVerifyAttemptEver, result.attempt)
        acc.candidates.push({
          kind: 'verify-completed',
          record: {
            seq: event.seq,
            step: result.step,
            attempt: result.attempt,
            outcome: result.outcome,
            ...(result.report !== undefined ? { report: result.report } : {}),
            ...(result.reason !== undefined ? { reason: result.reason } : {}),
          },
        })
        break
      }

      case 'finalize.completed':
        acc.candidates.push({ kind: 'finalize-completed', seq: event.seq })
        break
      case 'finalize.step-completed':
        acc.candidates.push({
          kind: 'finalize-step',
          seq: event.seq,
          step: event.payload.step,
        })
        break

      case 'pr.conflicted':
        acc.lastConflict = { seq: event.seq }
        acc.conflictSeqs.push(event.seq)
        delete acc.conflictReconcileStarted
        break
      case 'reconcile.progress-checked':
        acc.reconcileProgressChecks.push({ seq: event.seq, ...event.payload })
        break
      case 'reconcile.started': {
        const start = { seq: event.seq, ...event.payload }
        acc.reconcileStarts.push(start)
        acc.activeReconcileStart = start
        if (acc.lastConflict !== undefined && event.seq > acc.lastConflict.seq) {
          acc.conflictReconcileStarted = { attempt: event.payload.attempt }
        }
        break
      }
      case 'reconcile.completed':
        acc.candidates.push({ kind: 'reconcile-completed', seq: event.seq })
        if (acc.activeReconcileStart !== undefined) {
          acc.reconcileCompletions.push({
            ...acc.activeReconcileStart,
            completedSeq: event.seq,
          })
          delete acc.activeReconcileStart
        }
        delete acc.conflictReconcileStarted
        break

      default:
        break
    }
  }
}

function verdictCandidate(
  loop: LoopName,
  payload: ReviewVerdictPayload,
  seq: number,
): LogIndexCandidate {
  return {
    kind: 'verdict',
    loop,
    seq,
    round: payload.round,
    verdict: payload.verdict,
    findings: payload.findings,
    ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
  }
}

function finishLogIndex(acc: LogIndexAcc): LogIndex {
  const { restartSeq } = acc
  const plan = emptyLoop()
  const code = emptyLoop()
  plan.maxRoundEver = acc.maxRoundEver.plan
  code.maxRoundEver = acc.maxRoundEver.code
  const loops = { plan, code }
  const verifyCompleted: VerifyRecord[] = []
  const verifyStarted: { seq: number; attempt: number }[] = []
  const finalizeStepsDone = new Set<string>()
  let lastReconcileCompletedSeq = 0
  let lastImplementCompletedSeq = 0
  let finalizeCompleted = false

  const roundRecord = (loop: LoopIndex, r: number): RoundRecord => {
    if (r > loop.maxRound) loop.maxRound = r
    let record = loop.rounds.get(r)
    if (record === undefined) {
      record = {}
      loop.rounds.set(r, record)
    }
    return record
  }

  // Replay only what is post-restart under the FINAL boundary, in array order.
  for (const candidate of acc.candidates) {
    const seq = candidate.kind === 'verify-completed' ? candidate.record.seq : candidate.seq
    if (seq <= restartSeq) continue
    switch (candidate.kind) {
      case 'round-start':
        roundRecord(loops[candidate.loop], candidate.round).startedSeq = candidate.seq
        break
      case 'plan-completed': {
        const record = roundRecord(plan, candidate.round)
        record.completedSeq = candidate.seq
        record.planCompletion = {
          seq: candidate.seq,
          artifact: candidate.artifact,
          ...(candidate.verifySteps !== undefined
            ? { verifySteps: [...candidate.verifySteps] }
            : {}),
        }
        break
      }
      case 'round-touch':
        roundRecord(loops[candidate.loop], candidate.round)
        break
      case 'round-completed':
        roundRecord(loops[candidate.loop], candidate.round).completedSeq = candidate.seq
        break
      case 'verdict': {
        const loop = loops[candidate.loop]
        const record = roundRecord(loop, candidate.round)
        const verdict: VerdictRecord = {
          seq: candidate.seq,
          round: candidate.round,
          verdict: candidate.verdict,
          findings: candidate.findings,
          reason: candidate.reason,
        }
        record.verdict = verdict
        if (candidate.verdict === 'revise') loop.latestRevise = verdict
        if (candidate.verdict === 'approve') {
          loop.latestApproveSeq = candidate.seq
          // Snapshot at verdict time. A plan.completed appended later — even
          // for this round — was never reviewed and therefore has no authority.
          if (loop === plan) loop.approvedPlan = record.planCompletion
        }
        // Findings per round, reducer-style padding (rounds without verdicts
        // stay empty — including every pre-restart round, which is the point).
        while (loop.findingsByRound.length < candidate.round) loop.findingsByRound.push([])
        loop.findingsByRound[candidate.round - 1] = candidate.findings
        break
      }
      case 'implement-completed':
        lastImplementCompletedSeq = candidate.seq
        break
      case 'verify-started':
        verifyStarted.push({ seq: candidate.seq, attempt: candidate.attempt })
        break
      case 'verify-completed':
        verifyCompleted.push({ ...candidate.record })
        break
      case 'finalize-completed':
        finalizeCompleted = true
        break
      case 'finalize-step':
        finalizeStepsDone.add(candidate.step)
        break
      case 'reconcile-completed':
        lastReconcileCompletedSeq = candidate.seq
        break
    }
  }

  const { lastConflict, reconcileStarts, reconcileProgressChecks } = acc
  const conflictSeqs = new Set(acc.conflictSeqs)

  // One completed occurrence per monotonic attempt. A later duplicate
  // completion is safer to pair with its own latest start than with an older
  // aggregate high-water, and malformed unmatched completions classify nothing.
  const completedByAttempt = new Map<number, ReconcileCompletionRecord>()
  for (const completion of acc.reconcileCompletions) {
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
    maxVerifyAttemptEver: acc.maxVerifyAttemptEver,
    lastReconcileCompletedSeq,
    lastImplementCompletedSeq,
    finalizeCompleted,
    finalizeStepsDone,
    lastConflict,
    conflictReconcileStarted: acc.conflictReconcileStarted,
    lastReconcileCompleted,
    lastConflictProgressCheck,
    reconcileNoProgressCount,
    guidanceDeliveries: [...acc.guidanceDeliveries],
  }
}

export const logIndexReducer = defineReducer<LogIndexAcc, AbEvent, LogIndex>({
  version: LOG_INDEX_REDUCER_VERSION,
  initial: initialLogIndexAcc,
  fold: foldLogIndex,
  finish: finishLogIndex,
})

/** The whole-array form: `finish(fold(initial(), events))`. */
export function indexLog(events: readonly AbEvent[]): LogIndex {
  return logIndexReducer.reduce(events)
}
