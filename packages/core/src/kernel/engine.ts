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
import {
  isVerifyPhase,
  verifyPhase,
  type CorePhase,
  type EscalationSource,
  type EscalationTarget,
  type Feedback,
  type Finding,
  type Phase,
  type PolicyEscalationCause,
} from '../ontology'
import { indexLog, type LoopIndex } from './log-index'
import { reduceBuild, type AnsweredEscalation } from './reducer'
import { stalledChains, type FindingChain } from './stall'

// ── The decision contract ────────────────────────────────────────────────────

export type WaitReason = 'blocked' | 'paused' | 'awaiting-spec' | 'awaiting-pr' | 'done' | 'aborted'

export type VerifyAction =
  | { kind: 'run-check'; step: string; command: string; attempt: number }
  | {
      kind: 'run-agent-verify'
      step: string
      skill: string
      attempt: number
      feedback?: Feedback
    }

export type FinalizeAction = { kind: 'check'; command: string } | { kind: 'agent'; skill: string }

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
  | VerifyAction
  | {
      /** Kernel-side path gating to resolve against the live Git diff. */
      kind: 'evaluate-verify'
      step: string
      attempt: number
      paths: string[]
      action: VerifyAction
    }
  | {
      /** Kernel-authored exclusion that launches no verifier work. */
      kind: 'skip-verify'
      step: string
      attempt: number
      reason: string
    }
  | { kind: 'run-finalize-step'; step: string; action: FinalizeAction }
  | {
      /** Authoritative repeat-conflict observation before policy routing. */
      kind: 'check-reconcile-progress'
      conflictSeq: number
      completedAttempt: number
      nextAttempt: number
    }
  | {
      kind: 'raise-escalation'
      source: 'agent' | 'stall'
      phase: Phase
      round?: number
      question: string
      refs?: string[]
    }
  | {
      kind: 'raise-escalation'
      source: 'policy'
      policyCause: PolicyEscalationCause
      phase: Phase
      round?: number
      question: string
      refs?: string[]
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

  // "Has this exact escalation class already landed after seq X?" — open and
  // answered escalations both carry their raise seq, source, and target, so
  // the union is the complete durable deduplication history. Both dimensions
  // must match: a later raise for another source or target cannot repair this
  // condition's crash gap or acknowledge its exhausted budget.
  const allRaised = [...state.openEscalations, ...state.answeredEscalations]
  const raisedAfter = (seq: number, source: EscalationSource, phase: EscalationTarget): boolean =>
    allRaised.some((e) => e.seq > seq && e.source === source && e.phase === phase)
  const reconcileNoProgressRaisedAfter = (seq: number): boolean =>
    allRaised.some(
      (e) =>
        e.seq > seq &&
        e.source === 'policy' &&
        e.phase === 'reconcile' &&
        (e.policyCause === 'reconcile-no-progress' ||
          // Compatibility for durable logs written before policyCause existed.
          // An explicit different cause must never inherit this old meaning.
          (e.policyCause === undefined && e.round === undefined)),
    )

  // Latest-only guidance for an explicit destination (§15.6-B). Plan/code
  // escalations feed their producer; an agent verifier's own escalation feeds
  // that exact verifier occurrence; policy verify guidance keeps its existing
  // implement destination. A cited *.started payload carries the answer; its
  // matching durable session launch consumes it. Select the destination winner
  // before checking delivery: a newer answer durably supersedes older
  // same-destination answers, so consuming the winner cannot reveal one of them
  // later. An answer appended after that delivery becomes the new winner and
  // remains eligible.
  const guidanceFeedback = (destination: GuidanceDestination): Feedback | undefined => {
    let latest: AnsweredEscalation | undefined
    for (const e of state.answeredEscalations) {
      if (e.resolution !== 'guidance' || guidanceDestination(e) !== destination) continue
      if (latest === undefined || e.answeredSeq > latest.answeredSeq) latest = e
    }
    if (
      latest === undefined ||
      log.guidanceDeliveries.some(
        (delivery) => delivery.escalation === latest.id && delivery.seq > latest.answeredSeq,
      )
    ) {
      return undefined
    }
    return { guidance: { escalation: latest.id, answer: latest.answer } }
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
    reviewRoundCeiling: state.reviewRoundCeilings.plan,
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
    reviewRoundCeiling: state.reviewRoundCeilings.code,
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
    !raisedAfter(lastFail.seq, 'policy', verifyPhase(lastFail.step))
  ) {
    // Exhaustion escalates once per failure: an exact policy raise for this
    // verify target after the last failure (answered or not) suppresses replay;
    // a NEW failure re-arms it.
    return {
      kind: 'raise-escalation',
      source: 'policy',
      policyCause: 'verify-failure-limit',
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
  const approvedPlan = log.plan.approvedPlan
  const approvedSelection =
    approvedPlan?.verifySteps === undefined
      ? undefined
      : {
          steps: new Set(approvedPlan.verifySteps),
          planRev: approvedPlan.artifact.rev,
        }
  for (const step of config.verify.steps) {
    // First unsatisfied step in the current cycle runs next — only an explicit
    // pass or skip satisfies that step. A failure anywhere was handled above
    // and therefore can never be hidden by another step's skip.
    if (
      cycleResults.some((v) => v.step === step && (v.outcome === 'pass' || v.outcome === 'skipped'))
    ) {
      continue
    }
    const stepConfig = config.verify.stepConfigs[step]
    if (stepConfig === undefined) continue // unreachable: configSchema cross-validates (§16.1)

    // Missing selection data is the historical default-all behavior. For a
    // current explicit selection, exclusion precedes path evaluation and any
    // verifier construction. Mandatory gates remain selected defensively even
    // if a directly-authored event bypassed the CLI's deposit validation.
    if (
      approvedSelection !== undefined &&
      !approvedSelection.steps.has(step) &&
      stepConfig.always !== true
    ) {
      return {
        kind: 'skip-verify',
        step,
        attempt,
        reason:
          `excluded by approved plan selection (plan@${approvedSelection.planRev}): ` +
          `verify step ${JSON.stringify(step)} was not selected`,
      }
    }

    const verifierFeedback = guidanceFeedback(verifyPhase(step))
    const action: VerifyAction =
      stepConfig.kind === 'check'
        ? {
            // Resolve the [commands] ref (§16.1) — config validation guarantees
            // it exists; the raw-ref fallback only keeps decideNext total.
            kind: 'run-check',
            step,
            command: config.commands[stepConfig.command] ?? stepConfig.command,
            attempt,
          }
        : {
            kind: 'run-agent-verify',
            step,
            skill: stepConfig.skill,
            attempt,
            ...(verifierFeedback !== undefined ? { feedback: verifierFeedback } : {}),
          }

    // Omitted paths preserve the historical unconditional behavior. Explicit
    // `always = true` wins even when selectors are present, making the
    // mandatory-gate guard structural rather than dependent on truthiness.
    if (stepConfig.paths === undefined || stepConfig.always === true) return action
    return {
      kind: 'evaluate-verify',
      step,
      attempt,
      paths: stepConfig.paths,
      action,
    }
  }

  // ── 8. Finalize (§5): all verify steps satisfied in the current cycle ─────
  if (!log.finalizeCompleted) return { kind: 'run-phase', phase: 'finalize', round: 1 }
  for (const step of config.finalize.steps) {
    // Post-steps are independent and failure-tolerant (§5): a completion with
    // ok false still counts — it filed its observation and never re-runs.
    if (log.finalizeStepsDone.has(step)) continue
    const stepConfig = config.finalize.stepConfigs[step]
    if (stepConfig === undefined) continue // unreachable: configSchema cross-validates
    const action: FinalizeAction =
      stepConfig.kind === 'check'
        ? {
            kind: 'check',
            // Resolve the [commands] ref; fallback keeps decideNext total for
            // directly-constructed Config values that bypass validation.
            command: config.commands[stepConfig.command] ?? stepConfig.command,
          }
        : { kind: 'agent', skill: stepConfig.skill }
    return { kind: 'run-finalize-step', step, action }
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
    const completed = log.lastReconcileCompleted
    if (completed !== undefined && completed.completedSeq < log.lastConflict.seq) {
      const progress = log.lastConflictProgressCheck
      if (progress === undefined || progress.attempt !== completed.attempt) {
        // A repeat conflict cannot spend policy budget using the janitor's
        // detection-time base. Ask execution for a fresh authoritative fact;
        // replay after that append consumes the same durable decision.
        return {
          kind: 'check-reconcile-progress',
          conflictSeq: log.lastConflict.seq,
          completedAttempt: completed.attempt,
          nextAttempt,
        }
      }

      const baseUnchanged = progress.baseSha === completed.baseSha
      if (
        baseUnchanged &&
        log.reconcileNoProgressCount >= config.policy.maxReconcileAttempts &&
        !reconcileNoProgressRaisedAfter(log.lastConflict.seq)
      ) {
        // Only reconciles that leave the PR conflicted against the same
        // authoritative base consume this budget. policyCause is this
        // conflict-scoped condition's durable identity; round remains only
        // occurrence scope. A moving-base race always gets another monotonic
        // attempt, even after prior no-progress outcomes.
        return {
          kind: 'raise-escalation',
          source: 'policy',
          policyCause: 'reconcile-no-progress',
          phase: 'reconcile',
          question:
            `maxReconcileAttempts (${config.policy.maxReconcileAttempts}) exhausted: ` +
            'reconciliation made no progress against an unchanged base',
        }
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
  reviewRoundCeiling?: number
  dismissedIds: ReadonlySet<string>
  raisedAfter: (seq: number, source: EscalationSource, phase: EscalationTarget) => boolean
  producerFeedback: () => Feedback | undefined
}

function decideLoop(args: LoopArgs): Decision | 'approved' {
  const {
    loop,
    producer,
    reviewer,
    policy,
    reviewRoundCeiling,
    dismissedIds,
    raisedAfter,
    producerFeedback,
  } = args
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
    if (!raisedAfter(verdict.seq, 'agent', reviewer)) {
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
  if (stalled.length > 0 && !raisedAfter(verdict.seq, 'stall', reviewer)) {
    // Deepest chain reported; first in root order on ties (converge does the
    // same). Dedupe: raise once per verdict — a stall raise for this reviewer
    // already recorded after this verdict (answered or not) suppresses replay.
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
  const effectiveCeiling = reviewRoundCeiling ?? policy.maxReviewRounds
  const reviewedRounds = [...loop.rounds.values()].filter(
    (record) => record.verdict !== undefined,
  ).length
  if (reviewedRounds >= effectiveCeiling && !raisedAfter(verdict.seq, 'policy', reviewer)) {
    return {
      kind: 'raise-escalation',
      source: 'policy',
      policyCause: 'review-round-limit',
      phase: reviewer,
      round: verdict.round,
      question: `maxReviewRounds (${effectiveCeiling}) exhausted without approval`,
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

type GuidanceDestination = 'plan' | 'code' | `verify:${string}` | 'other'

/**
 * Where an escalation answer is delivered (§15.6-B). Producer/reviewer and
 * policy/stall routes retain their loop producer. The deliberate exception is
 * an agent verifier's own `ab escalate`: its answer returns to the exact
 * verifier that asked, while a policy escalation after verify failures still
 * feeds implement. Finalize/reconcile guidance travels through `ab context`.
 */
function guidanceDestination(
  escalation: Pick<AnsweredEscalation, 'phase' | 'source'>,
): GuidanceDestination {
  const { phase, source } = escalation
  if (phase === 'plan' || phase === 'plan-review') return 'plan'
  if (phase === 'implement' || phase === 'code-review') return 'code'
  if (isVerifyPhase(phase)) return source === 'agent' ? phase : 'code'
  return 'other'
}
