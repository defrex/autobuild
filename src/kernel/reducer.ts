/**
 * The state reducer (SPEC §15.5, §3.4): state is a reduction of events — any
 * snapshot is a cache, never the source of truth, and resumability falls out.
 * `reduceBuild` is pure, total (any prefix of a valid log reduces), and O(n).
 *
 * This projection is the single read model: the engine picks the next phase
 * from it, the operator UI's build list is exactly this reduction over every
 * build (§15.5), and the dispatcher's janitor reads `pr`/`prState` (§15.7).
 */
import type { Actor } from '../events/envelope'
import type { AbEvent } from '../events/catalog'
import type { EventPayload } from '../events/payloads'
import type {
  ArtifactRef,
  BuildOutcome,
  BuildStatus,
  CommitRange,
  EscalationResolution,
  EscalationSource,
  Finding,
  Phase,
} from '../ontology'
import { verifyPhase } from '../ontology'

/** An `escalation.raised` without a matching `escalation.answered` — the
 * definition of `blocked` (§15.5). Matched by id, so answers may arrive in
 * any order. */
export interface OpenEscalation {
  id: string
  phase: Phase
  round?: number
  source: EscalationSource
  question: string
  refs?: string[]
  /** seq of the `escalation.raised` event — what `spec.revised` cites (§15.3). */
  seq: number
}

/** Answered escalations keep their resolution because the engine routes on it
 * (§15.6-B, §6.3): `guidance` feeds the next producer round as authoritative
 * feedback, `dismiss-finding` marks the chain human-resolved for the next
 * reviewer, `revise-spec` restarts the build from plan, `abort` ends it. */
export interface AnsweredEscalation extends OpenEscalation {
  answer: string
  resolution: EscalationResolution
  /** seq of the `escalation.answered` event. */
  answeredSeq: number
}

/** One phase occurrence. Loop phases carry `round` (§15.3); verify and
 * reconcile carry `attempt`; finalize carries neither. */
export interface PhaseContext {
  phase: Phase
  round?: number
  attempt?: number
  /** seq of the `*.started` event (currentPhase) or the terminal event
   * (lastCompletedPhase) — the resume anchor (§15.6-C). */
  seq: number
}

/** An operator `*-requested` event the kernel has not yet acknowledged with
 * its fact event (D2, §15.2.7). A dead runner receives these on resume.
 * Commands are ordered events (§15.2.7): a request supersedes any earlier
 * pending request of the OPPOSING kind (pause vs resume) — the operator's
 * latest command wins, and a countermanded request is never delivered. */
export interface PendingCommand {
  command: 'pause' | 'resume' | 'abort'
  /** seq of the `*-requested` event. */
  seq: number
  reason?: string
  actor: Actor
}

/** A `session.started` without its `session.ended`. On resume after sandbox
 * death (§15.6-C) the dead session stays listed — its `session.ended` never
 * arrives — so the engine can see what was in flight. */
export interface OpenSession {
  session: string
  role: string
  runner: string
  model?: string
  phase: Phase
  round?: number
  /** seq of the `session.started` event. */
  seq: number
}

/** One `verify.completed` fact. Results accumulate across attempts; the
 * current cycle is the entries with `attempt === verify.attempt` (§15.6-A:
 * a re-run after a failed verify restarts FROM THE FIRST STEP at attempt+1,
 * so earlier attempts' passes never count toward the current cycle). */
export interface VerifyResult {
  step: string
  attempt: number
  pass: boolean
  report?: ArtifactRef
}

/** PR lifecycle (§15.7): 'open' once `finalize.completed` records the PR;
 * then per `pr.*` janitor events. 'conflicted' holds until a
 * `reconcile.completed` appears after the `pr.conflicted`, which returns the
 * PR to 'open' while verify re-runs in full. */
export type PrLifecycle = 'open' | 'merged' | 'closed' | 'conflicted'

export type ObservationRecord = EventPayload<'observation.recorded'>

export interface BuildState {
  /**
   * §15.5: 'queued' until `runner.attached`, 'running' after;
   * 'blocked' ≡ open escalation; 'paused' ≡ `build.paused` without a later
   * `build.resumed`; 'done' after `build.completed`; 'aborted' after
   * `build.aborted`. Precedence: aborted/done (terminal, latest wins) >
   * paused > blocked > running > queued.
   *
   * Paused + blocked overlap: both can hold at once (an escalation is open
   * when the operator pauses). Paused wins — it is the operator's explicit
   * instruction — but the escalation stays in `openEscalations`, so resuming
   * a still-blocked build reports 'blocked' again. No information is lost.
   */
  status: BuildStatus
  /** From `build.completed` — present only once status is 'done'. */
  outcome?: BuildOutcome
  /** currentPhase if one is started-but-not-completed, else the latest
   * completed phase. A started-without-terminal phase is exactly what
   * §15.6-C re-runs from its start. */
  phase?: Phase
  /** The current loop round: the round carried by the most recent
   * plan/plan-review/implement/code-review event. Verify, finalize, and
   * reconcile events do not reset it (verify attempt 2 still belongs to the
   * loop round that produced the code — §15.6-A). 0 before `plan.started`. */
  round: number
  /** Started, not completed — set by `*.started`, cleared by the phase's
   * terminal event (§8.4). `escalation.raised` and `phase.failed` do NOT
   * clear it: the phase still needs re-running (§15.6-B/C). */
  currentPhase?: PhaseContext
  lastCompletedPhase?: PhaseContext
  /** In raise order. Non-empty ≡ blocked (§15.5). */
  openEscalations: OpenEscalation[]
  /** In answer order, with resolutions for engine routing (§15.6-B). */
  answeredEscalations: AnsweredEscalation[]
  /** From `finalize.completed` (§15.3) — the kernel opened the PR (D7). */
  pr?: { number: number; url: string; headSha: string }
  prState?: PrLifecycle
  lastEvent?: AbEvent
  /** 0 for an empty log; `runner.attached {resumedFromSeq}` cites this. */
  lastSeq: number
  /** Latest spec artifact rev — `spec.imported`/`spec.authored` set it,
   * `spec.revised` bumps it (§6.3: rev N+1 restarts the build from plan). */
  specRev?: number
  /** `approved` ≡ the latest `plan-review.verdict` is 'approve' (§10);
   * `artifactRev` is the latest deposited plan rev. */
  plan: { round: number; approved: boolean; artifactRev?: number }
  /** `round` tracks the latest `implement.started`/`.completed`; `commits`
   * and `artifactRev` come from the latest `implement.completed` only — so
   * mid-round they still point at the last pushed head, the cross-sandbox
   * resume anchor (D3, §15.6-C). */
  implement: { round: number; commits?: CommitRange; artifactRev?: number }
  /** ≡ the latest `code-review.verdict` is 'approve'. */
  codeReviewApproved: boolean
  /** Findings per round, in round order (index round-1); rounds that never
   * produced a verdict are empty. Stall detection walks `persists` chains
   * across these (§15.4); reviewers get all prior rounds as context (§8.3). */
  reviewFindings: { planReview: Finding[][]; codeReview: Finding[][] }
  /** `attempt` is the highest attempt seen; `results` accumulate across
   * attempts (filter by `attempt` for the current cycle — see VerifyResult);
   * `currentStep` is a `verify.started` without its `verify.completed`. */
  verify: { attempt: number; results: VerifyResult[]; currentStep?: string }
  /** Highest `reconcile.started.attempt` — the kernel's own counter, so a
   * re-run of the same attempt after sandbox death does not double-count.
   * `policy.maxReconcileAttempts` gates on this (§15.7). */
  reconcileAttempts: number
  /** `observation.recorded` payloads in order — harvest input (§12). */
  observations: ObservationRecord[]
  /** Unacknowledged operator commands in request order (D2). */
  pendingCommands: PendingCommand[]
  sessions: { open: OpenSession[] }
  /** `phase.failed` tally per phase (verify steps key as `verify:<step>`) —
   * retry policy input (§8.4). */
  failures: Record<string, number>
}

export function reduceBuild(events: AbEvent[]): BuildState {
  let attached = false
  let pausedFlag = false
  let terminal: 'done' | 'aborted' | undefined
  let outcome: BuildOutcome | undefined
  let round = 0
  let currentPhase: PhaseContext | undefined
  let lastCompletedPhase: PhaseContext | undefined
  const openEscalations = new Map<string, OpenEscalation>()
  const answeredEscalations: AnsweredEscalation[] = []
  let pr: BuildState['pr']
  let prState: PrLifecycle | undefined
  let specRev: number | undefined
  const plan: BuildState['plan'] = { round: 0, approved: false }
  const implement: BuildState['implement'] = { round: 0 }
  let codeReviewApproved = false
  const planReviewFindings: Finding[][] = []
  const codeReviewFindings: Finding[][] = []
  const verify: BuildState['verify'] = { attempt: 0, results: [] }
  let reconcileAttempts = 0
  const observations: ObservationRecord[] = []
  const pending: Record<PendingCommand['command'], PendingCommand[]> = {
    pause: [],
    resume: [],
    abort: [],
  }
  const openSessions = new Map<string, OpenSession>()
  const failures: Record<string, number> = {}

  const start = (ctx: PhaseContext): void => {
    currentPhase = ctx
  }
  /** Terminal event for `phase` (§8.4): record completion, close the current
   * context if it is this phase. A terminal with no matching start still
   * records — the reducer is total over any log. */
  const complete = (
    phase: Phase,
    seq: number,
    ctx?: { round?: number; attempt?: number },
  ): void => {
    lastCompletedPhase = { phase, seq, ...ctx }
    if (currentPhase?.phase === phase) currentPhase = undefined
  }
  const setFindings = (per: Finding[][], r: number, findings: Finding[]): void => {
    while (per.length < r) per.push([])
    per[r - 1] = findings
  }

  let lastEvent: AbEvent | undefined
  for (const event of events) {
    switch (event.type) {
      // Facts the projection does not need (workspace liveness is the
      // dispatcher's concern; finalize post-steps are failure-tolerant §5).
      case 'build.created':
      case 'workspace.provisioned':
      case 'workspace.released':
      case 'finalize.step-completed':
        break

      case 'build.completed':
        terminal = 'done' // terminal, latest wins (§15.5) — in-order overwrite
        outcome = event.payload.outcome
        break
      case 'runner.attached':
        attached = true
        break

      // Operator commands (D2): requests queue until the kernel's fact event
      // acknowledges them; one ack clears every earlier request of its kind.
      // Commands are ORDERED events (§15.2.7), so a request also expires every
      // earlier pending request of the opposing kind: a pause countermands a
      // still-pending resume and vice versa. Otherwise a stale retained
      // request would later be acknowledged against the operator's newest
      // command — an old resume un-pausing a later pause.
      case 'build.pause-requested':
        pending.resume = []
        pending.pause.push({
          command: 'pause',
          seq: event.seq,
          reason: event.payload.reason,
          actor: event.actor,
        })
        break
      case 'build.resume-requested':
        pending.pause = []
        pending.resume.push({
          command: 'resume',
          seq: event.seq,
          reason: event.payload.reason,
          actor: event.actor,
        })
        break
      case 'build.abort-requested':
        pending.abort.push({
          command: 'abort',
          seq: event.seq,
          reason: event.payload.reason,
          actor: event.actor,
        })
        break
      case 'build.paused':
        pausedFlag = true
        pending.pause = []
        break
      case 'build.resumed':
        pausedFlag = false
        pending.resume = []
        break
      case 'build.aborted':
        terminal = 'aborted'
        pending.abort = []
        break

      case 'spec.imported':
      case 'spec.authored':
      case 'spec.revised':
        specRev = event.payload.artifact.rev
        break

      case 'session.started':
        openSessions.set(event.payload.session, {
          session: event.payload.session,
          role: event.payload.role,
          runner: event.payload.runner,
          model: event.payload.model,
          phase: event.payload.phase,
          round: event.payload.round,
          seq: event.seq,
        })
        break
      case 'session.ended':
        openSessions.delete(event.payload.session)
        break

      case 'plan.started':
        round = event.payload.round
        plan.round = round
        start({ phase: 'plan', round, seq: event.seq })
        break
      case 'plan.completed':
        round = event.payload.round
        plan.round = round
        plan.artifactRev = event.payload.artifact.rev
        complete('plan', event.seq, { round })
        break
      case 'plan-review.started':
        round = event.payload.round
        start({ phase: 'plan-review', round, seq: event.seq })
        break
      case 'plan-review.verdict':
        round = event.payload.round
        plan.approved = event.payload.verdict === 'approve'
        setFindings(planReviewFindings, round, event.payload.findings)
        complete('plan-review', event.seq, { round })
        break
      case 'implement.started':
        round = event.payload.round
        implement.round = round
        start({ phase: 'implement', round, seq: event.seq })
        break
      case 'implement.completed':
        round = event.payload.round
        implement.round = round
        implement.commits = event.payload.commits
        implement.artifactRev = event.payload.artifact.rev
        complete('implement', event.seq, { round })
        break
      case 'code-review.started':
        round = event.payload.round
        start({ phase: 'code-review', round, seq: event.seq })
        break
      case 'code-review.verdict':
        round = event.payload.round
        codeReviewApproved = event.payload.verdict === 'approve'
        setFindings(codeReviewFindings, round, event.payload.findings)
        complete('code-review', event.seq, { round })
        break

      case 'verify.started':
        verify.attempt = Math.max(verify.attempt, event.payload.attempt)
        verify.currentStep = event.payload.step
        start({
          phase: verifyPhase(event.payload.step),
          attempt: event.payload.attempt,
          seq: event.seq,
        })
        break
      case 'verify.completed':
        verify.attempt = Math.max(verify.attempt, event.payload.attempt)
        verify.results.push({
          step: event.payload.step,
          attempt: event.payload.attempt,
          pass: event.payload.pass,
          report: event.payload.report,
        })
        if (verify.currentStep === event.payload.step) {
          verify.currentStep = undefined
        }
        complete(verifyPhase(event.payload.step), event.seq, {
          attempt: event.payload.attempt,
        })
        break

      case 'finalize.started':
        start({ phase: 'finalize', seq: event.seq })
        break
      case 'finalize.completed':
        pr = event.payload.pr
        prState = 'open'
        complete('finalize', event.seq)
        break

      case 'pr.merged':
        prState = 'merged'
        break
      case 'pr.closed':
        prState = 'closed'
        break
      case 'pr.conflicted':
        prState = 'conflicted'
        break
      case 'reconcile.started':
        reconcileAttempts = Math.max(reconcileAttempts, event.payload.attempt)
        start({
          phase: 'reconcile',
          attempt: event.payload.attempt,
          seq: event.seq,
        })
        break
      case 'reconcile.completed':
        // §15.7: conflicted until a reconcile.completed appears after the
        // pr.conflicted — the PR is open again while verify:* re-runs.
        if (prState === 'conflicted') prState = 'open'
        complete('reconcile', event.seq)
        break

      case 'observation.recorded':
        observations.push(event.payload)
        break
      case 'escalation.raised':
        openEscalations.set(event.payload.id, {
          id: event.payload.id,
          phase: event.payload.phase,
          round: event.payload.round,
          source: event.payload.source,
          question: event.payload.question,
          refs: event.payload.refs,
          seq: event.seq,
        })
        break
      case 'escalation.answered': {
        // Matched by id — answers may arrive out of raise order. An answer
        // with no open raise is ignored (total over any prefix).
        const open = openEscalations.get(event.payload.id)
        if (open) {
          openEscalations.delete(event.payload.id)
          answeredEscalations.push({
            ...open,
            answer: event.payload.answer,
            resolution: event.payload.resolution,
            answeredSeq: event.seq,
          })
        }
        break
      }
      case 'phase.failed':
        failures[event.payload.phase] = (failures[event.payload.phase] ?? 0) + 1
        break
    }
    lastEvent = event
  }

  // §15.5 precedence: aborted/done (terminal, latest wins) > paused >
  // blocked > running > queued. See BuildState.status for the paused+blocked
  // overlap rule.
  const status: BuildStatus =
    terminal ??
    (pausedFlag
      ? 'paused'
      : openEscalations.size > 0
        ? 'blocked'
        : attached
          ? 'running'
          : 'queued')

  const active = currentPhase ?? lastCompletedPhase

  return {
    status,
    outcome,
    phase: active?.phase,
    round,
    currentPhase,
    lastCompletedPhase,
    openEscalations: [...openEscalations.values()],
    answeredEscalations,
    pr,
    prState,
    lastEvent,
    lastSeq: lastEvent?.seq ?? 0,
    specRev,
    plan,
    implement,
    codeReviewApproved,
    reviewFindings: { planReview: planReviewFindings, codeReview: codeReviewFindings },
    verify,
    reconcileAttempts,
    observations,
    pendingCommands: [...pending.pause, ...pending.resume, ...pending.abort].sort(
      (a, b) => a.seq - b.seq,
    ),
    sessions: { open: [...openSessions.values()] },
    failures,
  }
}
