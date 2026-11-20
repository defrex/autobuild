import { resolveApprovedVerifySelection } from './plan-verify-selection'
import { activeVerifyStage, leafVerifyCycleInputs } from './verify-stages'
import { verifyBudgetExhaustedQuestion } from './verify-budget'
import { verifyMemberKey } from './verify-stage-state'
import { mixedVersionDeferred } from './mixed-version'
import { integrationCurrent, integrationConfig, integrationFailed } from './integration-state'
import { proposeRunDue, proposeStarted } from './optimization'
import { reopenSpecPending } from './reopen'
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
import { indexLog, type LogIndex, type LoopIndex } from './log-index'
import { reduceBuild, type AnsweredEscalation, type BuildState } from './reducer'
import { stalledChains, type FindingChain } from './stall'
import { pendingWaitRequest, waitGuidance, waitResumeRestackCycle } from './ticket-wait'
import { leafRestackedBase } from './leaf-restack-state'
import {
  baselineMeasurementDue,
  pendingMeasurementRequest,
  progressMeasurementDue,
} from './measurement'

// ── The decision contract ────────────────────────────────────────────────────

export type WaitReason =
  | 'target-rewritten'
  | 'publication-retry'
  | 'verify-stage'
  | 'mixed-version'
  | 'ticket-wait'
  | 'blocked'
  | 'paused'
  | 'awaiting-spec'
  | 'awaiting-pr'
  | 'done'
  | 'aborted'
  | 'declined'

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

export type VerifyMemberDecision =
  | VerifyAction
  | {
      kind: 'evaluate-verify'
      step: string
      attempt: number
      paths: string[]
      action: VerifyAction
    }
  | {
      kind: 'skip-verify'
      step: string
      attempt: number
      reason: string
      skipCause?: 'post-reconcile-policy'
    }
export type Decision =
  | { kind: 'record-verify-selection-drift'; summary: string }
  | { kind: 'restart-execution' }
  | { kind: 'run-verify-stage'; members: VerifyMemberDecision[] }
  | { kind: 'cancel-verify-stage'; steps: string[]; cause: string; attempt: number }
  | {
      kind: 'record-verify-stage-failure'
      failure: import('../events/payloads').EventPayload<'verify.stage-failed'>
    }
  | ({ kind: 'raise-read-deferral' } & import('./read-deferrals').ReadDeferral)
  | {
      kind: 'restack'
      trigger: 'verify-entry' | 'awaiting-landing' | 'wait-resume'
      cycle: number
    }
  | { kind: 'capture-reconcile-policy'; reconcileSeq: number }
  | { kind: 'wait'; reason: WaitReason }
  | { kind: 'acknowledge'; command: 'pause' | 'resume' | 'abort' }
  | {
      kind: 'run-phase'
      phase: CorePhase
      round: number
      feedback?: Feedback
      verifyStageFailure?: number
      /** Present iff phase === 'reconcile'; execution resolves its base (§15.7). */
      reconcile?: { attempt: number }
      /** Present iff phase === 'propose': the open request it answers. */
      propose?: { request: string; head: string }
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
      skipCause?: 'post-reconcile-policy'
    }
  | { kind: 'run-finalize-step'; step: string; action: FinalizeAction }
  | {
      /** An optimization node's starting measurement: its harness pin against
       * itself under the current ruler (SPEC §13.1.1). */
      kind: 'measure-baseline'
      revision: number
      harnessPin: string
    }
  | {
      /** A panel node's progress: its head after an accepted attempt
       * against the starting head (SPEC §13.1.1). */
      kind: 'measure-progress'
      revision: number
      head: string
      start: string
      harnessPin: string
    }
  | {
      /** A requested paired measurement of an optimization attempt. */
      kind: 'run-measurement'
      request: import('../events/payloads').EventPayload<'attempt.measurement-requested'>
    }
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
  return decideNextFromFacts(reduceBuild(events), indexLog(events), config)
}

/** `decideNext` over already-reduced facts: a caller holding the build state
 * and log index (a reducer snapshot advanced to the log tail) decides without
 * the event array. `decideNext(events, config)` is exactly this over
 * `reduceBuild(events)` and `indexLog(events)`. */
export function decideNextFromFacts(state: BuildState, log: LogIndex, config: Config): Decision {
  const decision = decideNextInternal(
    state,
    {
      ...log,
      verifyCompleted: log.verifyCompleted.filter((r) => {
        const cancellation = state.verifyStage.cancellations[verifyMemberKey(r.step, r.attempt)]
        return cancellation === undefined || r.seq < cancellation.seq
      }),
    },
    config,
  )
  // A requested measurement runs only once the pipeline has nothing else to
  // do, so restack, re-verify and reconcile keep their precedence over it. A
  // request whose baseline a later `target.moved` superseded runs nothing.
  if (decision.kind === 'wait' && decision.reason === 'awaiting-pr' && state.kind !== 'node') {
    const request = pendingMeasurementRequest(state)
    if (request !== undefined) return { kind: 'run-measurement', request }
  }
  if (
    decision.kind !== 'run-phase' ||
    decision.phase !== 'implement' ||
    config.verify.stages === undefined
  )
    return decision
  const receipt =
    state.verifyStage.failures.findLast(
      (f) =>
        f.cycle >=
          Math.max(
            log.restartSeq,
            log.codeRestartSeq,
            log.code.latestApproveSeq,
            log.lastReconcileCompletedSeq,
            log.verifyConfigBoundary,
          ) && f.seq > log.lastImplementCompletedSeq,
    ) ??
    state.verifyStage.failures.find(
      (f) => f.seq === state.verifyStage.implementations[String(decision.round)],
    )
  if (!receipt) return decision
  const first = receipt.failed.find((f) => f.report !== undefined)
  return {
    ...decision,
    verifyStageFailure: receipt.seq,
    ...(decision.feedback && 'guidance' in decision.feedback
      ? {}
      : {
          feedback: first?.report
            ? { verify: { step: first.step, report: first.report } }
            : undefined,
        }),
  }
}
function decideNextInternal(state: BuildState, log: LogIndex, config: Config): Decision {
  if (mixedVersionDeferred(state)) return { kind: 'wait', reason: 'mixed-version' }
  // ── 1. Terminal (§15.5: terminal wins, latest wins) ────────────────────────
  if (state.status === 'aborted') return { kind: 'wait', reason: 'aborted' }
  if (state.status === 'done') return { kind: 'wait', reason: 'done' }
  // An optimization attempt's implementer declined (RFC 0005 §6.2): the
  // decision is already made, so nothing below runs — no review, verify,
  // finalize or measurement. The dispatcher settles it and completes the build.
  if (state.declined !== undefined) return { kind: 'wait', reason: 'declined' }

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

  // A declared ticket wait parks the build until the dispatcher validates it
  // (SPEC §11 "Ticket waits"): accepted, it becomes an open escalation below;
  // refused, the declaring phase re-runs with the refusal as guidance.
  if (pendingWaitRequest(state)) return { kind: 'wait', reason: 'ticket-wait' }

  // A reopen with a replacement spec parks until the kernel publishes it as
  // the next `spec.revised` (§15.7), exactly like an answered revise-spec.
  if (state.kind !== 'node' && reopenSpecPending(state))
    return { kind: 'wait', reason: 'awaiting-spec' }

  // Frozen transactions retain their original destination and may recover.
  if (state.targetRewrite && !log.restack.active && !state.nodeRestack?.active)
    return { kind: 'wait', reason: 'target-rewritten' }

  // ── 3. Escalations (§11, §15.6-B) ──────────────────────────────────────────
  // blocked ≡ any open (unanswered) escalation (§15.5).
  // The active stage's cycle: a leaf's shares `leafVerifyCycleInputs` with
  // `cycleBoundary` below, so both drop the same prior-base evidence.
  const stageCycle =
    state.kind === 'node'
      ? Math.max(state.integration?.cycle?.seq ?? 0, log.verifyConfigBoundary)
      : Math.max(leafVerifyCycleInputs(log), log.restartSeq, log.codeRestartSeq)
  const stage =
    config.verify.stages === undefined
      ? undefined
      : activeVerifyStage(
          config.verify,
          state.kind === 'node'
            ? log.verifyCompleted.filter(
                (r) =>
                  r.restackId === state.integration?.cycle?.id &&
                  r.headSha === state.integration?.cycle?.head &&
                  r.baseSha === state.integration?.cycle?.parent,
              )
            : log.verifyCompleted,
          state.verifyStage,
          stageCycle,
        )
  const heldVerifier = (step: string): boolean =>
    state.openEscalations.some(
      (e) =>
        e.source === 'agent' &&
        e.session !== undefined &&
        state.verifyStage.owners[e.session] === verifyMemberKey(step, state.verify.maxAttemptSeen),
    )
  if (
    state.openEscalations.some(
      (e) =>
        !(
          stage &&
          e.wait === undefined &&
          e.source === 'agent' &&
          e.session !== undefined &&
          stage.stage.some(
            (step) =>
              state.verifyStage.owners[e.session!] ===
              verifyMemberKey(step, state.verify.maxAttemptSeen),
          )
        ),
    )
  )
    return { kind: 'wait', reason: 'blocked' }
  if (
    state.verifyStage.cleanupExecutionSeq !== undefined &&
    state.verifyStage.executionSeq <= state.verifyStage.cleanupExecutionSeq &&
    !(stage?.cause && stage.unfinished.length)
  )
    return { kind: 'restart-execution' }
  const deferred = log.readDeferrals.find((item) => item.ended)
  if (deferred) return { kind: 'raise-read-deferral', ...deferred }
  if (state.kind === 'node') {
    // A recorded landing ends the node's work: open verification is moot and
    // the janitor settles the node once the execution ends.
    if (state.integration?.landing) return { kind: 'wait', reason: 'awaiting-pr' }
    if (state.nodeRestack?.conflict) {
      const attempt =
        state.currentPhase?.phase === 'reconcile'
          ? (state.currentPhase.attempt ?? state.reconcileAttempts)
          : state.reconcileAttempts + 1
      return {
        kind: 'run-phase',
        phase: 'reconcile',
        round: attempt,
        reconcile: { attempt },
      }
    }
    if (proposeStarted(state) && proposeRunDue(state.optimization)) {
      const proposal = state.optimization!.proposal!
      return {
        kind: 'run-phase',
        phase: 'propose',
        round: proposal.round,
        propose: { request: proposal.id, head: proposal.head },
      }
    }
    if (baselineMeasurementDue(state))
      return {
        kind: 'measure-baseline',
        revision: state.optimization!.revision,
        harnessPin: state.optimization!.accepted.harnessPin,
      }
    const progress = progressMeasurementDue(state)
    if (progress) return { kind: 'measure-progress', ...progress }
    // The proposer (SPEC §13.1.1): the dispatcher admitted a session for
    // the open request; a deposited or withdrawn one falls through.
    const proposal = state.optimization?.proposal
    if (proposal !== undefined && proposeRunDue(state.optimization))
      return {
        kind: 'run-phase',
        phase: 'propose',
        round: proposal.round,
        propose: { request: proposal.id, head: proposal.head },
      }
    const cycle = state.integration?.cycle
    if (!integrationCurrent(state) || cycle?.config !== integrationConfig(config))
      return { kind: 'wait', reason: 'awaiting-pr' }
    if (integrationFailed(state)) return { kind: 'wait', reason: 'blocked' }
    const results = log.verifyCompleted.filter(
      (result) =>
        result.seq > Math.max(cycle.seq, log.verifyConfigBoundary) &&
        result.restackId === cycle.id &&
        result.headSha === cycle.head &&
        result.baseSha === cycle.parent,
    )
    const starts = log.verifyStarted.filter(
      (result) =>
        result.seq > Math.max(cycle.seq, log.verifyConfigBoundary) && result.restackId === cycle.id,
    )
    const attempts = [...results, ...starts].map((result) => result.attempt)
    const attempt = attempts.length ? Math.max(...attempts) : log.maxVerifyAttemptEver + 1
    if (stage?.cause && stage.unfinished.length)
      return {
        kind: 'cancel-verify-stage',
        steps: stage.unfinished,
        cause: stage.cause.step,
        attempt,
      }
    if (
      stage?.settled &&
      stage.failures.length &&
      !state.verifyStage.failures.some((f) => f.cycle === cycle.seq && f.attempt === attempt)
    )
      return {
        kind: 'record-verify-stage-failure',
        failure: {
          cycle: cycle.seq,
          stage: stage.stage,
          attempt,
          restackId: cycle.id,
          headSha: cycle.head,
          baseSha: cycle.parent,
          failed: stage.failures.map((f) => ({
            step: f.step,
            ...(f.report ? { report: f.report } : {}),
          })),
          cancelled: stage.cancellations.map((c) => ({ step: c.step, cause: c.cause })),
        },
      }
    if (stage?.settled && stage.failures.length) return { kind: 'wait', reason: 'blocked' }
    const members: VerifyMemberDecision[] = []
    for (const step of stage?.unfinished ?? config.verify.steps) {
      if (stage && heldVerifier(step)) continue
      if (
        results.some(
          (result) =>
            result.step === step && (result.outcome === 'pass' || result.outcome === 'skipped'),
        )
      )
        continue
      const selected = config.verify.stepConfigs[step]!
      const action: VerifyAction =
        selected.kind === 'check'
          ? {
              kind: 'run-check',
              step,
              command: config.commands[selected.command] ?? selected.command,
              attempt,
            }
          : { kind: 'run-agent-verify', step, skill: selected.skill, attempt }
      const member: VerifyMemberDecision =
        selected.paths === undefined || selected.always === true
          ? action
          : { kind: 'evaluate-verify', step, attempt, paths: selected.paths, action }
      if (!stage) return member
      members.push(member)
    }
    if (stage)
      return members.length
        ? { kind: 'run-verify-stage', members }
        : { kind: 'wait', reason: 'verify-stage' }
    return { kind: 'wait', reason: 'awaiting-pr' }
  }
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

  // A revised contract invalidates approvals, but an unfinished replay still
  // belongs to its reconcile occurrence. Publish it before opening the new
  // plan loop so no other phase inherits its detached/conflicted workspace.
  if (state.currentPhase?.phase === 'reconcile' && state.currentPhase.seq < log.restartSeq) {
    const attempt = state.currentPhase.attempt ?? state.reconcileAttempts
    return { kind: 'run-phase', phase: 'reconcile', round: attempt, reconcile: { attempt } }
  }

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
    allRaised.some(
      (e) => e.seq > seq && e.source === source && e.phase === phase && e.deferral === undefined,
    )
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
  // A refused ticket wait is guidance for the phase that declared it, keyed by
  // the wait request id and delivered by the same rule.
  const guidanceFeedback = (destination: GuidanceDestination): Feedback | undefined => {
    let latest: Pick<AnsweredEscalation, 'id' | 'answer' | 'answeredSeq'> | undefined
    for (const e of [...state.answeredEscalations, ...waitGuidance(state)]) {
      if ('resolution' in e && e.resolution !== 'guidance') continue
      if (guidanceDestination(e) !== destination) continue
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
  // code-review approval, reconcile completion, configuration boundary, or a
  // clean wait-resume restack after a verify:* or finalize wait). The stage
  // selection's `stageCycle` above shares these inputs. Replay identity
  // remains separate: refreshing config or resuming a wait neither restacks
  // the workspace again nor discards its post-reconcile policy.
  const replayBoundary = Math.max(log.code.latestApproveSeq, log.lastReconcileCompletedSeq)
  const cycleBoundary = leafVerifyCycleInputs(log)
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
  // report into $AB_CONTEXT_DIR/verify/); the run-phase decision still fires without it.
  const verifyFeedback = (): Feedback | undefined =>
    pendingFail?.report === undefined
      ? undefined
      : { verify: { step: pendingFail.step, report: pendingFail.report } }

  // ── Wait resume (SPEC §11 "Ticket waits"): a build leaving a ticket wait
  // first restacks onto its target's current head, so the declaring phase
  // sees the merged blockers. Supersession of a reconcile-declared wait or a
  // fresh wait-resume restack outranks every open transaction, including an
  // earlier wait-resume conflict. Never-waited builds have no `state.wait`.
  const waitCycle = waitResumeRestackCycle(state, log)
  if (waitCycle !== undefined) return { kind: 'restack', trigger: 'wait-resume', cycle: waitCycle }
  const waitRestack = log.restack.active?.trigger === 'wait-resume' ? log.restack.active : undefined
  if (waitRestack) {
    if (restackConflictNeedsReconcile(log, config)) {
      const round = log.restack.reconcileAttempt ?? state.reconcileAttempts + 1
      return { kind: 'run-phase', phase: 'reconcile', round, reconcile: { attempt: round } }
    }
    return { kind: 'restack', trigger: 'wait-resume', cycle: waitRestack.cycle }
  }

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
  // `log.code` counts only rounds after `codeRestartSeq`: a feedback-only
  // reopen (§15.7) empties it, so implement runs again at maxRoundEver + 1.
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
  if (stage?.cause && stage.unfinished.length)
    return {
      kind: 'cancel-verify-stage',
      steps: stage.unfinished,
      cause: stage.cause.step,
      attempt: stage.cause.attempt,
    }
  if (
    stage?.settled &&
    stage.failures.length &&
    !state.verifyStage.failures.some(
      (f) => f.cycle === cycleBoundary && f.attempt === stage.failures[0]!.attempt,
    )
  )
    return {
      kind: 'record-verify-stage-failure',
      failure: {
        cycle: cycleBoundary,
        ...(stage.failures[0]!.baseSha === undefined
          ? {}
          : { baseSha: stage.failures[0]!.baseSha }),
        ...(stage.failures[0]!.headSha === undefined
          ? {}
          : { headSha: stage.failures[0]!.headSha }),
        ...(stage.failures[0]!.restackId === undefined
          ? {}
          : { restackId: stage.failures[0]!.restackId }),
        stage: stage.stage,
        attempt: stage.failures[0]!.attempt,
        failed: stage.failures.map((f) => ({
          step: f.step,
          ...(f.report ? { report: f.report } : {}),
        })),
        cancelled: stage.cancellations.map((c) => ({ step: c.step, cause: c.cause })),
      },
    }
  const fails = log.verifyCompleted.filter((v) => v.outcome === 'fail')
  const lastFail = fails.at(-1)
  if (
    (stage === undefined || stage.settled) &&
    lastFail !== undefined &&
    new Set(fails.map((failure) => failure.attempt)).size >= config.policy.maxVerifyAttempts &&
    !raisedAfter(lastFail.seq, 'policy', verifyPhase(lastFail.step))
  ) {
    // Exhaustion escalates once per failure: an exact policy raise for this
    // verify target after the last failure (answered or not) suppresses replay;
    // a NEW failure re-arms it. The question lists the counted failed attempts
    // and their steps; the target stays the last failed step.
    return {
      kind: 'raise-escalation',
      source: 'policy',
      policyCause: 'verify-failure-limit',
      phase: verifyPhase(lastFail.step),
      question: verifyBudgetExhaustedQuestion(config.policy.maxVerifyAttempts, fails),
    }
  }
  if (pendingFail !== undefined && (stage === undefined || stage.settled)) {
    // A pending fail in the current cycle routes back into the code loop
    // (§15.6-A) — it never re-runs the step directly. Guidance outranks the
    // verify report (§15.6-B: a human answer is authoritative feedback).
    const feedback = guidanceFeedback('code') ?? verifyFeedback()
    const round = log.code.maxRound + 1
    return feedback === undefined
      ? { kind: 'run-phase', phase: 'implement', round }
      : { kind: 'run-phase', phase: 'implement', round, feedback }
  }
  // A frozen transaction always wins over a new observation. The runner owns
  // workspace mutation; the dispatcher only records target movement.
  if (log.restack.active !== undefined) {
    if (restackConflictNeedsReconcile(log, config)) {
      const round = log.restack.reconcileAttempt ?? state.reconcileAttempts + 1
      return { kind: 'run-phase', phase: 'reconcile', round, reconcile: { attempt: round } }
    }
    return { kind: 'restack', trigger: log.restack.active.trigger, cycle: log.restack.active.cycle }
  }
  if (
    log.restack.gates[String(replayBoundary)] === undefined &&
    (log.restack.finalizedAt ?? 0) < replayBoundary &&
    !log.verifyStarted.some((v) => v.seq > replayBoundary) &&
    !log.verifyCompleted.some((v) => v.seq > replayBoundary)
  ) {
    return { kind: 'restack', trigger: 'verify-entry', cycle: replayBoundary }
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
  // Freeze only a fresh reconcile cycle. A newer code-review approval restores
  // ordinary verification. Already-started historical cycles have no snapshot:
  // preserve their rerun-all policy, including after a crashed verify start.
  const reconcileCycle =
    log.lastReconcileCompletedSeq > Math.max(log.code.latestApproveSeq, log.restartSeq)
  const policy =
    reconcileCycle &&
    !log.restack.initialVerification &&
    log.reconcilePolicy?.reconcileSeq === log.lastReconcileCompletedSeq &&
    (log.reconcilePolicy.cycle === cycleBoundary ||
      (log.verifyConfigBoundary === 0 && log.reconcilePolicy.cycle === undefined))
      ? log.reconcilePolicy
      : undefined
  if (
    reconcileCycle &&
    !log.restack.initialVerification &&
    policy === undefined &&
    cycleAttempts.length === 0
  ) {
    return { kind: 'capture-reconcile-policy', reconcileSeq: log.lastReconcileCompletedSeq }
  }
  const approvedPlan = log.plan.approvedPlan
  const selection = resolveApprovedVerifySelection(approvedPlan?.verifySteps, config)
  if (selection.unknown.length) {
    const summary =
      `verify selection drift (cycle ${cycleBoundary}, plan@${approvedPlan!.artifact.rev}): ` +
      `unknown steps ${selection.unknown.map((name) => JSON.stringify(name)).join(', ')}; ` +
      'running all configured optional steps subject to paths and post-reconcile policy'
    if (!state.observations.some((observation) => observation.summary === summary))
      return { kind: 'record-verify-selection-drift', summary }
  }
  const approvedSelection =
    selection.selected === undefined
      ? undefined
      : {
          steps: selection.selected,
          planRev: approvedPlan!.artifact.rev,
        }
  const memberDecision = (step: string): VerifyMemberDecision | undefined => {
    // First unsatisfied step in the current cycle runs next — only an explicit
    // pass or skip satisfies that step. A failure anywhere was handled above
    // and therefore can never be hidden by another step's skip.
    if (
      cycleResults.some((v) => v.step === step && (v.outcome === 'pass' || v.outcome === 'skipped'))
    ) {
      return undefined
    }
    const stepConfig = config.verify.stepConfigs[step]
    if (stepConfig === undefined) return undefined // unreachable: configSchema cross-validates (§16.1)

    const exclusion = policy?.steps.find((s) => s.step === step && !s.enabled)
    if (exclusion !== undefined)
      return {
        kind: 'skip-verify',
        step,
        attempt,
        skipCause: 'post-reconcile-policy',
        reason: `skipped by post-reconcile policy: ${exclusion.source} = false`,
      }

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
  const members: VerifyMemberDecision[] = []
  for (const step of stage?.unfinished ?? config.verify.steps) {
    if (stage && heldVerifier(step)) continue
    const member = memberDecision(step)
    if (!member) continue
    if (!stage) return member
    members.push(member)
  }
  if (stage)
    return members.length
      ? { kind: 'run-verify-stage', members }
      : { kind: 'wait', reason: 'verify-stage' }

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
  // Resume a retained resolver occurrence before considering a newly observed
  // target. Candidate retirement removes its result, not its frozen intent.
  if (
    state.prState === 'conflicted' &&
    (log.conflictReconcileStarted !== undefined || state.currentPhase?.phase === 'reconcile')
  ) {
    // A later conflict observation clears the log marker, but cannot retire
    // an unfinished resolver or spend another occurrence during reconstruction.
    const attempt =
      log.conflictReconcileStarted?.attempt ??
      state.currentPhase?.attempt ??
      state.reconcileAttempts
    return { kind: 'run-phase', phase: 'reconcile', round: attempt, reconcile: { attempt } }
  }
  if (landingRestackDue(state, log)) {
    return { kind: 'restack', trigger: 'awaiting-landing', cycle: cycleBoundary }
  }
  if (state.prState === 'conflicted' && log.lastConflict !== undefined) {
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

/** The §9 awaiting-landing restack condition: the target moved since the
 * build's last restack base, or a target post-step landed after it. Shared
 * with dispatch capacity, which admits a parked build that must restack. */
export function landingRestackDue(state: BuildState, log: Pick<LogIndex, 'restack'>): boolean {
  return (
    log.restack.target !== undefined &&
    (log.restack.target.sha !== leafRestackedBase(log.restack) ||
      (state.target !== undefined &&
        (log.restack.postStepAt ?? 0) > (log.restack.completedAt ?? 0)))
  )
}

/** Whether a conflicted leaf replay needs an agent reconcile. The runner
 * regenerates a replay whose conflicts are all `[[generated]]` files and
 * records the outcome; the engine reads only that fact, never globs. With
 * declarations and no fact yet (and no reconcile started), the runner still
 * has to decide, so the transaction stays a restack. */
export function restackConflictNeedsReconcile(
  log: Pick<LogIndex, 'restack'>,
  config: Pick<Config, 'generated'>,
): boolean {
  if (!log.restack.replay?.conflicted) return false
  if (log.restack.reconcileAttempt !== undefined) return true
  const regeneration = log.restack.regeneration
  if (regeneration?.outcome === 'resolved') return false
  if (regeneration === undefined && (config.generated?.length ?? 0) > 0) return false
  return true
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
  escalation: Pick<AnsweredEscalation, 'phase' | 'source' | 'deferral' | 'wait'>,
): GuidanceDestination {
  const { phase, source } = escalation
  // A reviewer's own-build-read deferral or ticket wait re-runs that same
  // review round, which reads its guidance through `ab context`.
  if (
    (escalation.deferral === 'own-build-read' || escalation.wait !== undefined) &&
    (phase === 'plan-review' || phase === 'code-review')
  )
    return 'other'
  if (phase === 'plan' || phase === 'plan-review') return 'plan'
  if (phase === 'implement' || phase === 'code-review') return 'code'
  // A ticket wait's escalations, including the dispatcher's unresolvable
  // raise that ended one, resume the verify step that declared it.
  if (isVerifyPhase(phase))
    return source === 'agent' ||
      escalation.deferral === 'own-build-read' ||
      escalation.wait !== undefined
      ? phase
      : 'code'
  return 'other'
}
