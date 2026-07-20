/**
 * The kernel pipeline engine (SPEC §8): "read the event log, decide the next
 * phase per the transition table, invoke the AgentRunner with `/{skill}
 * {build}`, wait for the terminal event, repeat." `decideNext` IS that
 * transition table — the determinism half of the constitution (§2.1): agents
 * never decide phase transitions; this pure, total function does. Same events
 * + config → same decision, and any prefix of a valid log decides — which is
 * why resumability is not a feature (§2.2): re-deciding over the log IS the
 * resume path (§15.6-C), and a fresh sandbox resumes a dead sandbox's build
 * by pulling events and asking the same question (§7.4).
 *
 * The engine performs no I/O and appends nothing. It returns a Decision; the
 * build-runner executes it (starts sessions, runs check commands, appends the
 * events execution produces) and asks again. Escalation raising is itself a
 * decision (`raise-escalation`), so the stall/policy thresholds live here —
 * §15.4's split made code: judgment marks `persists`, determinism applies the
 * threshold.
 *
 * Projection policy: `reduceBuild` is used for everything it already projects
 * (status, pending commands, escalations, spec rev, prState, reconcile
 * attempts). The engine drops to raw events only where the reducer lacks a
 * projection; each such spot is a documented field of `LogIndex` below.
 */
import type { Config } from '../config/schema'
import type { AbEvent } from '../events/catalog'
import { normalizeVerifyCompletion, type EventPayload } from '../events/payloads'
import {
  isVerifyPhase,
  verifyPhase,
  type ArtifactRef,
  type CorePhase,
  type EscalationSource,
  type Feedback,
  type Finding,
  type Phase,
  type ReviewVerdictKind,
  type VerifyOutcome,
} from '../ontology'
import { reduceBuild, type AnsweredEscalation } from './reducer'
import { stalledChains, type FindingChain } from './stall'

// ── The decision contract ────────────────────────────────────────────────────

export type WaitReason = 'blocked' | 'paused' | 'awaiting-spec' | 'awaiting-pr' | 'done' | 'aborted'

export type Decision =
  | { kind: 'wait'; reason: WaitReason }
  | { kind: 'acknowledge'; command: 'pause' | 'resume' | 'abort' }
  | {
      kind: 'run-phase'
      phase: CorePhase
      round: number
      feedback?: Feedback
      /** Present iff phase === 'reconcile'; execution resolves its base (§15.7). */
      reconcile?: { attempt: number }
    }
  | { kind: 'run-check'; step: string; command: string; attempt: number }
  | { kind: 'run-agent-verify'; step: string; skill: string; needsServer: boolean; attempt: number }
  | { kind: 'run-finalize-step'; step: string }
  | {
      kind: 'raise-escalation'
      source: 'agent' | 'stall' | 'policy'
      phase: Phase
      round?: number
      question: string
      refs?: string[]
    }

// ── Raw-log index ────────────────────────────────────────────────────────────
//
// Every field here is a projection the reducer does not carry (or carries
// without the seq the engine routes on). Loop and verify progress counts only
// events with seq > restartSeq (§6.3 immutability: every reviewer approves
// conformance to ONE spec revision — a drifting spec silently converts
// approvals into approvals-of-something-else, so approvals of an old spec do
// not carry across `spec.revised`).

interface VerdictRecord {
  seq: number
  round: number
  verdict: ReviewVerdictKind
  findings: Finding[]
  reason?: string
}

interface RoundRecord {
  startedSeq?: number
  completedSeq?: number
  verdict?: VerdictRecord
}

interface LoopIndex {
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
  /** Findings per round (index round-1), post-restart — stalledChains input.
   * The reducer's reviewFindings spans restarts; this one must not. */
  findingsByRound: Finding[][]
}

interface VerifyRecord {
  seq: number
  step: string
  attempt: number
  outcome: VerifyOutcome
  report?: ArtifactRef
  reason?: string
}

interface GuidanceStart {
  escalation: string
  seq: number
}

interface LogIndex {
  /** seq of the latest `spec.revised`, else 0 — the restart boundary (§6.3). */
  restartSeq: number
  /** seq of the latest `build.aborted`, else 0 — an escalation answered with
   * resolution 'abort' after this seq is an unacknowledged abort. */
  lastAbortedSeq: number
  plan: LoopIndex
  code: LoopIndex
  /** Post-restart `verify.completed` facts WITH seq (the reducer's
   * verify.results lack it, and the cycle boundary is seq-based §15.6-A). */
  verifyCompleted: VerifyRecord[]
  /** Post-restart `verify.started` facts — a crashed step re-runs at the SAME
   * attempt (§15.6-C), so the current cycle's attempt must be readable from
   * its start events even before any completion lands. */
  verifyStarted: { seq: number; attempt: number }[]
  /**
   * Max verify attempt in any `verify.started`/`verify.completed` over the
   * FULL log. Attempt numbers continue monotonically across spec restarts and
   * reconcile cycles — the same rationale as LoopIndex.maxRoundEver: the log
   * stays unambiguous ("verify attempt 2" names exactly one cycle), the
   * reducer's documented current-cycle projection (attempt === max attempt)
   * never returns stale pre-restart results, and D5 failure keys
   * (verify:<step>, round = attempt) never collide across cycles.
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
  /** Every `*.started` carrying feedback.guidance — consumption markers: a
   * guidance answer is consumed once a started event after it cites it.
   * `plan.started` and `implement.started` both carry feedback (§15.3,
   * symmetric by design), so both loops' consumption is observed the same
   * way: only a started event that actually CITES the answer consumes it —
   * a start that failed to carry it leaves the answer deliverable (§15.6-B:
   * a human answer is authoritative and must never be silently dropped). */
  guidanceStarts: GuidanceStart[]
}

export function decideNext(events: AbEvent[], config: Config): Decision {
  const state = reduceBuild(events)
  const log = indexLog(events)

  // ── 1. Terminal (§15.5: terminal wins, latest wins) ────────────────────────
  if (state.status === 'aborted') return { kind: 'wait', reason: 'aborted' }
  if (state.status === 'done') return { kind: 'wait', reason: 'done' }

  // ── 2. Operator commands (D2, §15.2.7) ─────────────────────────────────────
  // Requests queue in the log; the kernel acknowledges with fact events, and a
  // dead runner receives its commands on resume. Abort wins over everything
  // below; paused parks every phase decision until resumed (§15.5 precedence:
  // paused wins over blocked, and the escalation is not lost).
  if (state.pendingCommands.some((c) => c.command === 'abort')) {
    return { kind: 'acknowledge', command: 'abort' }
  }
  if (state.status === 'paused') {
    if (state.pendingCommands.some((c) => c.command === 'resume')) {
      return { kind: 'acknowledge', command: 'resume' }
    }
    return { kind: 'wait', reason: 'paused' }
  }
  if (state.pendingCommands.some((c) => c.command === 'pause')) {
    return { kind: 'acknowledge', command: 'pause' }
  }

  // ── 3. Escalations (§11, §15.6-B) ──────────────────────────────────────────
  // An answered abort-resolution without a subsequent build.aborted: the
  // instruction arrived through the escalation channel rather than
  // build.abort-requested, but it ends the build the same way (§15.3).
  if (
    state.answeredEscalations.some(
      (e) => e.resolution === 'abort' && e.answeredSeq > log.lastAbortedSeq,
    )
  ) {
    return { kind: 'acknowledge', command: 'abort' }
  }
  // blocked ≡ any open (unanswered) escalation (§15.5).
  if (state.openEscalations.length > 0) return { kind: 'wait', reason: 'blocked' }
  // revise-spec: park until the human lands spec rev N+1 (§6.3); the
  // spec.revised event's seq becomes the restart boundary used everywhere
  // below. guidance and dismiss-finding resolutions do not decide anything
  // here — they route inside the loop rules (feedback priority and stall
  // suppression respectively).
  if (
    state.answeredEscalations.some(
      (e) => e.resolution === 'revise-spec' && e.answeredSeq > log.restartSeq,
    )
  ) {
    return { kind: 'wait', reason: 'awaiting-spec' }
  }

  // ── 4. Spec (§6.3: dispatch owns the import; `spec` is not a phase §5) ─────
  if (state.specRev === undefined) return { kind: 'wait', reason: 'awaiting-spec' }

  // ── Shared routing inputs ──────────────────────────────────────────────────

  // dismiss-finding contributes the raised escalation's refs to the dismissed
  // set (§15.6-B). The reducer already joins escalation.raised (refs) to
  // escalation.answered (resolution) by id, so no raw-event join is needed.
  const dismissedIds = new Set<string>()
  for (const e of state.answeredEscalations) {
    if (e.resolution !== 'dismiss-finding') continue
    for (const ref of e.refs ?? []) dismissedIds.add(ref)
  }

  // "Has an escalation.raised already landed after seq X?" — open and
  // answered escalations both carry their raise seq, so the union is the
  // complete raise history.
  const allRaised = [...state.openEscalations, ...state.answeredEscalations]
  const raisedAfter = (seq: number, source?: EscalationSource): boolean =>
    allRaised.some((e) => e.seq > seq && (source === undefined || e.source === source))

  // Unconsumed guidance for a loop (§15.6-B): guidance feeds the producer of
  // the loop the escalation came from (plan loop → plan; code loop, including
  // verify:* escalations → implement). Consumed once a *.started after the
  // answer carries feedback.guidance.escalation === the id — both producers'
  // started payloads carry feedback (§15.3, symmetric by design). Latest
  // answer wins when several are unconsumed.
  const guidanceFeedback = (loop: 'plan' | 'code'): Feedback | undefined => {
    let latest: AnsweredEscalation | undefined
    for (const e of state.answeredEscalations) {
      if (e.resolution !== 'guidance' || loopOfPhase(e.phase) !== loop) continue
      const consumed = log.guidanceStarts.some(
        (g) => g.escalation === e.id && g.seq > e.answeredSeq,
      )
      if (consumed) continue
      if (latest === undefined || e.answeredSeq > latest.answeredSeq) latest = e
    }
    return latest === undefined
      ? undefined
      : { guidance: { escalation: latest.id, answer: latest.answer } }
  }

  // Verify cycle (§15.6-A): results only count after the latest of (last
  // code-review approve, last reconcile.completed) — implement or reconcile
  // changed the code, so earlier results describe code that no longer exists
  // and the cycle re-runs from the FIRST step, cheap checks first.
  const cycleBoundary = Math.max(log.code.latestApproveSeq, log.lastReconcileCompletedSeq)
  const cycleResults = log.verifyCompleted.filter((v) => v.seq > cycleBoundary)
  const cycleFails = cycleResults.filter((v) => v.outcome === 'fail')
  const lastCycleFail = cycleFails.at(-1)
  // "Without a subsequent implement round": an implement.completed after the
  // failure means the code loop already picked it up. implement.*started* is
  // deliberately not enough — a crashed fail-routed round must recompute the
  // same verify feedback on re-run (§15.6-C).
  const pendingFail =
    lastCycleFail !== undefined && lastCycleFail.seq > log.lastImplementCompletedSeq
      ? lastCycleFail
      : undefined

  const findingsFeedback = (loop: LoopIndex): Feedback | undefined =>
    loop.latestRevise === undefined
      ? undefined
      : { findings: loop.latestRevise.findings.map((f) => f.id) }
  // A failure without a report has nothing to materialize (§8.3 routes the
  // report into .ab/verify/); the run-phase decision still fires without it.
  const verifyFeedback = (): Feedback | undefined =>
    pendingFail?.report === undefined
      ? undefined
      : { verify: { step: pendingFail.step, report: pendingFail.report } }

  // ── 5. Plan loop (§5, §10): rounds pair plan ⇄ plan-review ─────────────────
  const planDecision = decideLoop({
    loop: log.plan,
    producer: 'plan',
    reviewer: 'plan-review',
    policy: config.policy,
    dismissedIds,
    raisedAfter,
    // Feedback: unconsumed guidance, else the latest revise verdict's ids.
    producerFeedback: () => guidanceFeedback('plan') ?? findingsFeedback(log.plan),
  })
  if (planDecision !== 'approved') return planDecision

  // ── 6. Code loop: identical structure, plus verify routing ─────────────────
  const codeDecision = decideLoop({
    loop: log.code,
    producer: 'implement',
    reviewer: 'code-review',
    policy: config.policy,
    dismissedIds,
    raisedAfter,
    // Feedback priority: guidance > verify failure > findings (§15.6-A/B).
    producerFeedback: () =>
      guidanceFeedback('code') ?? verifyFeedback() ?? findingsFeedback(log.code),
  })
  if (codeDecision !== 'approved') return codeDecision

  // ── 7. Verify (§5, §15.6-A) — gated on code-review approved ────────────────
  // Exhaustion counts post-restart failures only; pre-restart results
  // (including failures) do not carry across a spec revision (§6.3). Attempt
  // NUMBERS, by contrast, continue monotonically over the full log — see the
  // attempt computation below and LogIndex.maxVerifyAttemptEver.
  const fails = log.verifyCompleted.filter((v) => v.outcome === 'fail')
  const lastFail = fails.at(-1)
  if (
    lastFail !== undefined &&
    fails.length >= config.policy.maxVerifyAttempts &&
    !raisedAfter(lastFail.seq, 'policy')
  ) {
    // Exhaustion escalates once per failure: any raise after the last failure
    // (answered or not) suppresses a re-raise; a NEW failure re-arms it.
    return {
      kind: 'raise-escalation',
      source: 'policy',
      phase: verifyPhase(lastFail.step),
      question: `maxVerifyAttempts (${config.policy.maxVerifyAttempts}) exhausted: verify:${lastFail.step} is still failing`,
    }
  }
  if (pendingFail !== undefined) {
    // A pending fail in the current cycle routes back into the code loop
    // (§15.6-A) — it never re-runs the step directly. Guidance outranks the
    // verify report (§15.6-B: a human answer is authoritative feedback).
    const feedback = guidanceFeedback('code') ?? verifyFeedback()
    const round = log.code.maxRound + 1
    return feedback === undefined
      ? { kind: 'run-phase', phase: 'implement', round }
      : { kind: 'run-phase', phase: 'implement', round, feedback }
  }
  // Attempt numbering (§15.6-A): every step in one cycle shares one attempt.
  // A cycle already underway (started or completed events after the boundary)
  // keeps its number — a crashed step re-runs at the SAME attempt (§15.6-C);
  // a fresh cycle takes max attempt ever + 1, monotonic across spec restarts
  // and reconcile cycles exactly like loop rounds (see maxVerifyAttemptEver).
  const cycleStarted = log.verifyStarted.filter((v) => v.seq > cycleBoundary)
  const cycleAttempts = [...cycleResults, ...cycleStarted].map((v) => v.attempt)
  const attempt =
    cycleAttempts.length > 0 ? Math.max(...cycleAttempts) : log.maxVerifyAttemptEver + 1
  for (const step of config.verify.steps) {
    // First unsatisfied step in the current cycle runs next — only an explicit
    // pass or skip satisfies that step. A failure anywhere was handled above
    // and therefore can never be hidden by another step's skip.
    if (
      cycleResults.some(
        (v) => v.step === step && (v.outcome === 'pass' || v.outcome === 'skipped'),
      )
    ) {
      continue
    }
    const stepConfig = config.verify.stepConfigs[step]
    if (stepConfig === undefined) continue // unreachable: configSchema cross-validates (§16.1)
    if (stepConfig.kind === 'check') {
      // Resolve the [commands] ref (§16.1) — config validation guarantees it
      // exists; the raw-ref fallback only keeps decideNext total.
      return {
        kind: 'run-check',
        step,
        command: config.commands[stepConfig.command] ?? stepConfig.command,
        attempt,
      }
    }
    return {
      kind: 'run-agent-verify',
      step,
      skill: stepConfig.skill,
      needsServer: stepConfig.needsServer,
      attempt,
    }
  }

  // ── 8. Finalize (§5): all verify steps satisfied in the current cycle ─────
  if (!log.finalizeCompleted) return { kind: 'run-phase', phase: 'finalize', round: 1 }
  for (const step of config.finalize.steps) {
    // Post-steps are independent and failure-tolerant (§5): a completion with
    // ok false still counts — it filed its observation and never re-runs.
    if (!log.finalizeStepsDone.has(step)) return { kind: 'run-finalize-step', step }
  }

  // ── 9. Post-PR epilogue (§15.7): finalize → (conflicted → reconcile →
  // verify:*)* → merged | closed. The dispatcher's janitor emits pr.* and
  // completes the build; the engine only ever runs reconcile here.
  if (state.prState === 'conflicted' && log.lastConflict !== undefined) {
    if (log.conflictReconcileStarted !== undefined) {
      // Crashed reconcile: re-run the SAME attempt from its start (§15.6-C) —
      // the reducer's reconcileAttempts is the kernel's own counter precisely
      // so a re-run does not double-count.
      const crashAttempt = log.conflictReconcileStarted.attempt
      return {
        kind: 'run-phase',
        phase: 'reconcile',
        round: crashAttempt,
        reconcile: { attempt: crashAttempt },
      }
    }
    const nextAttempt = state.reconcileAttempts + 1
    if (
      nextAttempt > config.policy.maxReconcileAttempts &&
      !raisedAfter(log.lastConflict.seq, 'policy')
    ) {
      // Bounds thrash against a busy base (§15.7). One raise per conflict:
      // an answered raise lets the build proceed (the human unblocked it),
      // and the NEXT conflict past the cap re-escalates.
      return {
        kind: 'raise-escalation',
        source: 'policy',
        phase: 'reconcile',
        question: `maxReconcileAttempts (${config.policy.maxReconcileAttempts}) exhausted`,
      }
    }
    return {
      kind: 'run-phase',
      phase: 'reconcile',
      round: nextAttempt,
      reconcile: { attempt: nextAttempt },
    }
  }
  // open → the janitor is watching the PR; merged/closed → the janitor
  // releases the workspace and emits build.completed (§15.7).
  return { kind: 'wait', reason: 'awaiting-pr' }
}

// ── Review-loop transition (rules 5 and 6 share one structure — §10) ─────────

interface LoopArgs {
  loop: LoopIndex
  producer: 'plan' | 'implement'
  reviewer: 'plan-review' | 'code-review'
  policy: Config['policy']
  dismissedIds: ReadonlySet<string>
  raisedAfter: (seq: number, source?: EscalationSource) => boolean
  producerFeedback: () => Feedback | undefined
}

function decideLoop(args: LoopArgs): Decision | 'approved' {
  const { loop, producer, reviewer, policy, dismissedIds, raisedAfter, producerFeedback } = args
  const runProducer = (round: number): Decision => {
    const feedback = producerFeedback()
    return feedback === undefined
      ? { kind: 'run-phase', phase: producer, round }
      : { kind: 'run-phase', phase: producer, round, feedback }
  }

  // No rounds since the restart boundary: the loop is due. Round numbers
  // continue monotonically across restarts (§6.3): next = max ever seen + 1.
  if (loop.maxRound === 0) return runProducer(loop.maxRoundEver + 1)

  const round = loop.rounds.get(loop.maxRound)
  const verdict = round?.verdict

  if (verdict === undefined) {
    if (round?.completedSeq !== undefined) {
      // Producer completed, no verdict yet: the reviewer is due (or crashed
      // mid-round and re-runs from its start — §15.6-C).
      return { kind: 'run-phase', phase: reviewer, round: loop.maxRound }
    }
    // Started-or-due without a completion is a crashed producer: re-run the
    // same round from its start (§15.6-C); the runner owns retry counting,
    // not the engine (§8.4). Feedback is recomputed, never replayed.
    return runProducer(loop.maxRound)
  }

  if (verdict.verdict === 'approve') return 'approved'

  if (verdict.verdict === 'escalate') {
    // CLI crash gap: the verdict landed but its escalation.raised did not
    // (§8.5 makes the pair near-atomic; the repair keeps decideNext total).
    if (!raisedAfter(verdict.seq)) {
      return {
        kind: 'raise-escalation',
        source: 'agent',
        phase: reviewer,
        round: verdict.round,
        question: verdict.reason ?? 'reviewer escalated',
      }
    }
    // The escalation exists and was answered (an open one already returned
    // wait/blocked in rule 3): the loop proceeds to the next producer round;
    // a guidance answer rides producerFeedback (§15.6-B).
    return runProducer(loop.maxRound + 1)
  }

  // revise — stall check FIRST (§15.4), then the policy round cap (§10), then
  // the next producer round with findings feedback.
  const stalled = liveChains(
    stalledChains(loop.findingsByRound, policy.stallRounds, dismissedIds),
    loop.findingsByRound,
    verdict.round,
  )
  if (stalled.length > 0 && !raisedAfter(verdict.seq, 'stall')) {
    // Deepest chain reported; first in root order on ties (converge does the
    // same). Dedupe: raise once per verdict — a stall raise already recorded
    // after this verdict (answered or not) suppresses a re-raise.
    const chain = stalled.reduce((deepest, candidate) =>
      candidate.rounds > deepest.rounds ? candidate : deepest,
    )
    return {
      kind: 'raise-escalation',
      source: 'stall',
      phase: reviewer,
      round: verdict.round,
      question: `finding chain persisted ${chain.rounds} rounds: ${chain.ids.join(' -> ')}`,
      refs: chain.ids,
    }
  }
  if (loop.maxRound >= policy.maxReviewRounds && !raisedAfter(verdict.seq, 'policy')) {
    return {
      kind: 'raise-escalation',
      source: 'policy',
      phase: reviewer,
      round: verdict.round,
      question: `maxReviewRounds (${policy.maxReviewRounds}) exhausted without approval`,
    }
  }
  return runProducer(loop.maxRound + 1)
}

/**
 * §15.4 reads "a chain survives N rounds" as a LIVE streak. `stalledChains`
 * reports the longest historical streak, but a chain the current round's
 * reviewer did not continue was judged resolved by that round's fresh skeptic
 * (see src/kernel/stall.ts's streak-break rationale) — re-raising it would
 * park the build on a disagreement nobody is still having, e.g. on the first
 * revise after a guidance answer settled the chain. Only chains with a member
 * in the round whose verdict is being routed can raise.
 */
function liveChains(
  chains: FindingChain[],
  findingsByRound: Finding[][],
  round: number,
): FindingChain[] {
  const current = new Set((findingsByRound[round - 1] ?? []).map((f) => f.id))
  return chains.filter((chain) => chain.ids.some((id) => current.has(id)))
}

/**
 * Which loop an escalation feeds guidance into (§15.6-B): producer-phase,
 * reviewer-phase, and stall/policy escalations all feed the loop's producer.
 * verify:* escalations belong to the code loop (§15.6-A routes verify
 * failures to implement). finalize/reconcile escalations have no producer
 * round to feed — their guidance travels via `ab context`, not engine
 * feedback (PHASE_SPECS.inputs.answeredGuidance materializes the latest
 * answer as .ab/guidance.json for those phases).
 */
function loopOfPhase(phase: Phase): 'plan' | 'code' | 'other' {
  if (phase === 'plan' || phase === 'plan-review') return 'plan'
  if (phase === 'implement' || phase === 'code-review' || isVerifyPhase(phase)) return 'code'
  return 'other'
}

// ── Raw-log indexing ─────────────────────────────────────────────────────────

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

function indexLog(events: AbEvent[]): LogIndex {
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
  const guidanceStarts: GuidanceStart[] = []
  let lastReconcileCompletedSeq = 0
  let lastImplementCompletedSeq = 0
  let finalizeCompleted = false
  let lastConflict: { seq: number } | undefined
  let conflictReconcileStarted: { attempt: number } | undefined
  let lastAbortedSeq = 0

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
    if (payload.verdict === 'approve') loop.latestApproveSeq = seq
    // Findings per round, reducer-style padding (rounds without verdicts stay
    // empty — including every pre-restart round, which is the point).
    while (loop.findingsByRound.length < payload.round) loop.findingsByRound.push([])
    loop.findingsByRound[payload.round - 1] = payload.findings
  }

  for (const event of events) {
    const post = event.seq > restartSeq
    switch (event.type) {
      case 'plan.started': {
        const feedback = event.payload.feedback
        if (feedback !== undefined && 'guidance' in feedback) {
          guidanceStarts.push({ escalation: feedback.guidance.escalation, seq: event.seq })
        }
        const record = roundRecord(plan, event.payload.round, post)
        if (record !== undefined) record.startedSeq = event.seq
        break
      }
      case 'plan.completed': {
        const record = roundRecord(plan, event.payload.round, post)
        if (record !== undefined) record.completedSeq = event.seq
        break
      }
      case 'plan-review.started':
        roundRecord(plan, event.payload.round, post)
        break
      case 'plan-review.verdict':
        noteVerdict(plan, event.payload, event.seq, post)
        break

      case 'implement.started': {
        const feedback = event.payload.feedback
        if (feedback !== undefined && 'guidance' in feedback) {
          guidanceStarts.push({ escalation: feedback.guidance.escalation, seq: event.seq })
        }
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

      case 'verify.started':
        maxVerifyAttemptEver = Math.max(maxVerifyAttemptEver, event.payload.attempt)
        if (post) verifyStarted.push({ seq: event.seq, attempt: event.payload.attempt })
        break
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
        conflictReconcileStarted = undefined
        break
      case 'reconcile.started':
        if (lastConflict !== undefined && event.seq > lastConflict.seq) {
          conflictReconcileStarted = { attempt: event.payload.attempt }
        }
        break
      case 'reconcile.completed':
        if (post) lastReconcileCompletedSeq = event.seq
        conflictReconcileStarted = undefined
        break

      case 'build.aborted':
        lastAbortedSeq = event.seq
        break

      default:
        break
    }
  }

  return {
    restartSeq,
    lastAbortedSeq,
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
    guidanceStarts,
  }
}
