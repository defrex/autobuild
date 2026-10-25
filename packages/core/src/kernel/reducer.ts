import {
  advanceVerifyStage,
  initialVerifyStageState,
  verifyMemberKey,
  runningVerifyMembers,
  type VerifyStageState,
} from './verify-stage-state'
import { advancePollingActivity } from './node-polling'
import { integrationFailed } from './integration-state'
import {
  advanceCompatibility,
  initialCompatibility,
  projectEvents,
  type CompatibilityState,
} from '../events/compatibility'
import type { NativeSessionHandle } from '../ports/types'
import { advanceLanding, type LandingState } from './landing-state'
import { advanceIntegration, type IntegrationState } from './integration-state'
import { advanceNodeRestack, type NodeRestackState } from './node-restack-state'
import { reconcileRewriteHead } from './reconcile-head'
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
import { normalizeVerifyCompletion, type EventPayload, type PinnedAsset } from '../events/payloads'
import type {
  ArtifactRef,
  BuildOutcome,
  BuildStatus,
  CommitRange,
  EscalationResolution,
  EscalationSource,
  EscalationTarget,
  Finding,
  Phase,
  PolicyEscalationCause,
  VerifyOutcome,
} from '../ontology'
import { verifyPhase } from '../ontology'
import { defineReducer, type IncrementalReducer } from './incremental'

/** An `escalation.raised` without a matching `escalation.answered` — the
 * definition of `blocked` (§15.5). Matched by id, so answers may arrive in
 * any order. */
export interface OpenEscalation {
  id: string
  phase: EscalationTarget
  round?: number
  source: EscalationSource
  /** Raising agent identity, for occurrence-scoped cancellation. */
  session?: string
  /** Policy guard identity. Absent only on historical policy raises. */
  policyCause?: PolicyEscalationCause
  deferral?: 'own-build-read'
  question: string
  refs?: string[]
  /** seq of the `escalation.raised` event — what `spec.revised` cites (§15.3). */
  seq: number
}

/** Answered escalations keep their resolution because the engine routes on it
 * (§15.6-B, §6.3): `guidance` feeds the next producer round as authoritative
 * feedback, `dismiss-finding` marks the chain human-resolved for the next
 * reviewer, `revise-spec` restarts the build from plan, `abort` ends it, and
 * bare `retry` re-arms the applicable policy-exhausted budget without
 * inventing guidance. */
export interface AnsweredEscalation extends OpenEscalation {
  answer: string
  resolution: EscalationResolution
  /** Exact replacement spec revision authorized by a `revise-spec` answer. */
  artifact?: ArtifactRef
  /** Ticket assets sampled with a revise-from-ticket authorization. */
  assets?: PinnedAsset[]
  /** Absolute review budget accepted with a review-round-limit answer. */
  reviewRoundCeiling?: number
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

/** An accepted operator command the kernel has not yet acknowledged with its
 * fact event (D2, §15.2.7). Most come from `*-requested`; an escalation answer
 * with the abort resolution is the equivalent accepted abort intent. A dead
 * runner receives these on resume. Commands are ordered events (§15.2.7): a
 * request supersedes any earlier pending request of the OPPOSING kind (pause
 * vs resume) — the operator's latest command wins, and a countermanded request
 * is never delivered. */
export interface PendingCommand {
  command: 'pause' | 'resume' | 'abort'
  /** seq of the event that accepted the command. */
  seq: number
  reason?: string
  actor: Actor
}

/** A `session.started` without its `session.ended`. Historical orphan-only
 * logs remain open and readable; a recovering runner explicitly ends every
 * session open at its resume boundary before announcing attachment (§15.6-C). */
export interface OpenSession {
  /** Absent means the harness has not reported an identity. */
  nativeHandle?: NativeSessionHandle
  continuation?: EventPayload<'session.started'>['continuation']
  budgetMs?: number
  args?: string[]
  startedAt: string
  nativeResumeFallback?: boolean
  resumed?: boolean
  suspensionCause?: EventPayload<'session.suspended'>['cause']
  suspendedActiveMs?: number
  session: string
  role: string
  runner: string
  model?: string
  phase: Phase
  round?: number
  /** Live-view stream id (SPEC §9); absent on historical events. */
  stream?: string
  /** seq of the `session.started` event. */
  seq: number
}

export interface LogicalSessionTotals {
  activeMs: number
  usage?: { inputTokens: number; outputTokens: number; turns: number }
  transcripts: ArtifactRef[]
}

/** One `verify.completed` fact. Results accumulate across attempts; membership
 * in the current cycle is solely
 * `results.filter(r => r.seq > verify.cycleSince)`. `maxAttemptSeen` is only
 * the aggregate attempt high-water and cannot identify the current cycle in
 * the window between a verify failure and the next `verify.started`. */
export interface VerifyResult {
  baseSha?: string
  headSha?: string
  restackId?: string
  step: string
  attempt: number
  outcome: VerifyOutcome
  report?: ArtifactRef
  /** Optional classification on kernel policy skips; historical skips omit it. */
  skipCause?: 'post-reconcile-policy'
  /** Present exactly when `outcome === "skipped"`. */
  reason?: string
  /** seq of the `verify.completed` event — what `cycleSince` is compared to. */
  seq: number
}

/** PR lifecycle (§15.7): 'open' once `finalize.completed` records the PR;
 * then per `pr.*` janitor events. 'conflicted' holds until a
 * `reconcile.completed` appears after the `pr.conflicted`, which returns the
 * PR to 'open' while verify re-runs in full. */
export type PrLifecycle = 'open' | 'merged' | 'closed' | 'conflicted'

/** Durable desired state for GitHub native auto-merge plus the latest forge
 * application fact. The command seq correlates the two sides of the
 * non-transactional forge/event boundary: consumers treat the command as
 * settled only when both `enabled` and `commandSeq` match. */
export interface AutoMergeProjection {
  explicitCommandSeq?: number
  /** Latest human command. False with no commandSeq means the default: off. */
  requested: boolean
  commandSeq?: number
  /** The repository seq of the `dispatcher.auto-merge-default-set` fact the
   * latest answering command (claim-time seed or fan-out) sampled, when one
   * did. A per-build command with no `defaultSeq` preserves the previous
   * value, so the default fan-out can tell an override from staleness. */
  defaultSeq?: number
  /** Latest recorded external application. It may acknowledge an older
   * command; such a stale fact never changes `requested`/`commandSeq`. */
  applied?: { enabled: boolean; commandSeq: number }
}

export type ObservationRecord = EventPayload<'observation.recorded'>

export interface DrainExecution {
  correlations?: string[]
  relaunch?: EventPayload<'execution.relaunch-requested'>
  authorization?: EventPayload<'execution.drain-authorized'>
  correlation: string
  ended?: true
  suspended?: true
}

export interface BuildState {
  drainingExecutions?: Record<string, DrainExecution>
  compatibility: CompatibilityState
  compatibilityDeferredBoundary?: number
  kind?: 'work' | 'node'
  target?: EventPayload<'build.created'>['target']
  baseBranch?: string
  mergedSha?: string
  nodeOpening?: EventPayload<'node.opening'>
  nodeOpened?: EventPayload<'node.opened'>
  nodeRestack?: NodeRestackState
  integration?: IntegrationState
  pollingActivity?: Record<string, string>
  nodePolling?: EventPayload<'node.poll-checked'> & { checkedAt: string }
  nodeComparison?: EventPayload<'node.compared'>

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
  /** Human-selected absolute caps for the current spec's independent loops. */
  reviewRoundCeilings: { plan?: number; code?: number }
  /** From `finalize.completed` (§15.3) — the kernel opened the PR (D7). */
  pr?: { number: number; url: string; headSha: string }
  prState?: PrLifecycle
  /** Readiness provenance, landing-bound consent and native application receipts. */
  janitor?: {
    firstFailureAt: string
    attempt: number
    message: string
    nextAttemptAt: string
    attention?: true
  }
  landing?: LandingState
  /** Historical auto-merge controls retained for replay compatibility. */
  autoMerge: AutoMergeProjection
  /** seq of the latest `finalize.completed`, else 0 — "has finalize run for
   * the CURRENT spec". `prState` cannot answer that: it is the full-log PR
   * fact and must stay so, because the janitor (dispatcher.ts:342,:367,:396)
   * and the deliberately restart-orthogonal epilogue (engine.ts:161-162,:402)
   * read it. Compare this against `restartSince`, exactly as engine.ts:707-708
   * post-filters its own `finalizeCompleted`. */
  finalizeCompletedSeq: number
  /** Full-log `finalize.step-completed` facts, in event order (§5).
   * Post-steps are failure-tolerant, so a completion counts whether `ok` is
   * true or false. Current-spec membership is determined by
   * `finalizeSteps.filter(f => f.seq > restartBoundary)`, matching
   * engine.ts's post-restart `finalizeStepsDone` scope (engine.ts:710-712). */
  finalizeSteps: { step: string; ok: boolean; seq: number }[]
  lastEvent?: AbEvent
  /** 0 for an empty log; `runner.attached {resumedFromSeq}` cites this. */
  lastSeq: number
  /** Ticket assets the build froze: set by `build.created`, replaced by a
   * `spec.revised` that carries `assets` (§6.3). Empty for historical logs. */
  pinnedAssets: PinnedAsset[]
  /** Latest spec artifact rev — `spec.imported`/`spec.authored` set it,
   * `spec.revised` bumps it (§6.3: rev N+1 restarts leaves from plan and nodes from collection). */
  specRev?: number
  /** seq of the latest `spec.revised`, else 0 — the restart boundary (§6.3).
   * Rev N+1 restarts leaves from plan and nodes from collection; earlier
   * approvals and results describe the previous spec revision. Mirrors
   * engine.ts's `restartSeq` (engine.ts:126). */
  restartSince: number
  /** `approved` ≡ the latest `plan-review.verdict` is 'approve' (§10);
   * `artifactRev` is the latest deposited plan rev.
   *
   * `approval` is the `plan-review.verdict` approve that currently STANDS —
   * its event seq and round. Set only on an approve; cleared by any other
   * verdict, so `approval !== undefined` ⇔ `approved`. A consumer asking "is
   * the plan loop settled?" must check this against `restartSince` and
   * `plan.round`, not `approved` alone — `approved` spans the full log and
   * survives a restart, which re-runs the whole loop (engine.ts:466). */
  plan: {
    round: number
    approved: boolean
    artifactRev?: number
    approval?: { seq: number; round: number }
  }
  /** Round tracks the latest implementation start/completion; artifact identifies
   * its latest completion. Commits tracks the current contribution, including
   * successful leaf replays. */
  implement: { round: number; commits?: CommitRange; artifactRev?: number }
  /** ≡ the latest `code-review.verdict` is 'approve'. */
  codeReviewApproved: boolean
  /** The `code-review.verdict` approve that currently stands — its event seq
   * and round. Same discipline as `plan.approval`: check it against
   * `restartSince` and `implement.round`, AND against the verify cycle, which
   * a failure reopens (§15.6-A) before any new implement round lands. */
  codeReviewApproval?: { seq: number; round: number }
  /** Findings per round, in round order (index round-1); rounds that never
   * produced a verdict are empty. Stall detection walks `persists` chains
   * across these (§15.4); reviewers get all prior rounds as context (§8.3). */
  reviewFindings: { planReview: Finding[][]; codeReview: Finding[][] }
  /** `maxAttemptSeen` is the highest verify attempt seen across the full log;
   * it is a high-water mark, not a current-cycle identifier. `results`
   * accumulate across attempts (filter by `cycleSince` for the current cycle
   * — see VerifyResult); `currentStep` is a `verify.started` without its
   * `verify.completed`.
   *
   * `cycleSince` is the seq after which results describe the CURRENT code
   * (§15.6-A): max(restartSince, latest code-review approve, latest
   * `reconcile.completed`, config capture/supersession). Results at or before it describe code that no
   * longer exists — implement or reconcile changed it, and a new cycle re-runs
   * from the FIRST step. 0 before any boundary lands. This is the same filter
   * engine.ts:275-276 applies over its post-restart index. */
  verifyStage: VerifyStageState
  verify: {
    maxAttemptSeen: number
    results: VerifyResult[]
    currentStep?: string
    running?: string[]
    configPin?: import('../events/payloads').EventPayload<'verify.config-captured'> & {
      seq: number
    }
    cycleSince: number
  }
  /** Highest `reconcile.started.attempt` — the kernel's own occurrence
   * counter, so a re-run of the same attempt after sandbox death does not
   * double-count. Progress-budget accounting is projected separately from
   * authoritative repeat-conflict evidence (§15.7). */
  reconcileAttempts: number
  /** `observation.recorded` payloads in order — harvest input (§12). */
  observations: ObservationRecord[]
  /** Every setup failure remains historical evidence. `setupFailure` is the
   * latest one not superseded by a later successful runner attachment. */
  setupFailures: Array<EventPayload<'runner.setup-failed'> & { seq: number }>
  setupFailure?: EventPayload<'runner.setup-failed'> & { seq: number }
  /** Pre-run dispatch attempts, retained as durable operator diagnostics. */
  dispatchFailures: Array<EventPayload<'dispatch.failed'> & { seq: number }>
  /** Provider identities and failures are durable even after recovery clears the current error. */
  executions: Array<EventPayload<'execution.started'> & { seq: number }>
  infrastructureFailures: Array<EventPayload<'infrastructure.failed'> & { seq: number }>
  infrastructureFailure?: EventPayload<'infrastructure.failed'> & { seq: number }
  cleanupAttempts: Array<EventPayload<'infrastructure.cleanup-attempted'> & { seq: number }>
  /** Outstanding human discard intent. It is settled only by terminal completion. */
  discardRequest?: { seq: number; actor: Actor }
  /** Unacknowledged runner-owned operator commands in request order (D2). */
  pendingCommands: PendingCommand[]
  sessions: {
    open: OpenSession[]
    nativeHandles: Record<string, NativeSessionHandle>
    suspended: OpenSession[]
    totals: Record<string, LogicalSessionTotals>
  }
  /** `phase.failed` tally per phase (verify steps key as `verify:<step>`) —
   * retry policy input (§8.4). */
  failures: Record<string, number>
}

/** Whether the build carries an outstanding `discardRequest`. Present exactly
 * while the build is non-terminal and its discard is unsettled; the reducer
 * settles it only by terminal completion. This is the single predicate shared
 * by the auto-merge default fan-out (`autoMergeDefaultEligible`, AUT-418) and
 * the per-build consent guard (`controlBuild`'s `discard-pending` refusal), so
 * the two controls' discard exclusions cannot diverge silently. */
export function discardInFlight(state: Pick<BuildState, 'discardRequest'>): boolean {
  return state.discardRequest !== undefined
}

/** The reducer's carried accumulator: everything `reduceBuild` folds, before
 * the final status derivation. Plain JSON-shaped data (the escalation and
 * session maps are insertion-ordered entry arrays) so it survives a round
 * trip through `JSON.stringify` — the foundation for incremental advancement
 * and cached state. */
export interface BuildAcc {
  endedExecutionInstances: Record<string, true>
  drainingExecutions: Record<string, DrainExecution>
  compatibility: CompatibilityState
  compatibilityDeferredBoundary: number
  kind?: 'work' | 'node'
  target?: EventPayload<'build.created'>['target']
  baseBranch?: string
  mergedSha?: string
  nodeOpening?: EventPayload<'node.opening'>
  nodeOpened?: EventPayload<'node.opened'>
  nodeRestack?: NodeRestackState
  integration?: IntegrationState
  pollingActivity?: Record<string, string>
  nodePolling?: EventPayload<'node.poll-checked'> & { checkedAt: string }
  nodeComparison?: EventPayload<'node.compared'>

  attached: boolean
  pausedFlag: boolean
  terminal?: 'done' | 'aborted'
  outcome?: BuildOutcome
  round: number
  currentPhase?: PhaseContext
  lastCompletedPhase?: PhaseContext
  openEscalations: OpenEscalation[]
  answeredEscalations: AnsweredEscalation[]
  reviewRoundCeilings: BuildState['reviewRoundCeilings']
  pr: BuildState['pr']
  prState?: PrLifecycle
  janitor?: {
    firstFailureAt: string
    attempt: number
    message: string
    nextAttemptAt: string
    attention?: true
  }
  landing?: LandingState
  autoMerge: AutoMergeProjection
  specRev?: number
  restartSince: number
  pinnedAssets: PinnedAsset[]
  finalizeCompletedSeq: number
  finalizeSteps: BuildState['finalizeSteps']
  plan: BuildState['plan']
  implement: BuildState['implement']
  codeReviewApproved: boolean
  codeReviewApproval: BuildState['codeReviewApproval']
  planReviewFindings: Finding[][]
  codeReviewFindings: Finding[][]
  verifyStage: VerifyStageState
  verify: BuildState['verify']
  reconcileAttempts: number
  observations: ObservationRecord[]
  setupFailures: BuildState['setupFailures']
  setupFailure: BuildState['setupFailure']
  dispatchFailures: BuildState['dispatchFailures']
  executions: BuildState['executions']
  infrastructureFailures: BuildState['infrastructureFailures']
  infrastructureFailure: BuildState['infrastructureFailure']
  cleanupAttempts: BuildState['cleanupAttempts']
  discardRequest: BuildState['discardRequest']
  pending: Record<PendingCommand['command'], PendingCommand[]>
  nativeHandles: Record<string, NativeSessionHandle>
  sessionTotals: Record<string, LogicalSessionTotals>
  suspendedSessions: OpenSession[]
  openSessions: OpenSession[]
  failures: Record<string, number>
  lastEvent?: AbEvent
}

/** Bump when `BuildAcc`'s shape or the fold's semantics change. */
export const BUILD_REDUCER_VERSION = 24

function initialBuildAcc(): BuildAcc {
  return {
    endedExecutionInstances: {},
    drainingExecutions: {},
    compatibility: initialCompatibility(),
    compatibilityDeferredBoundary: 0,
    attached: false,
    pausedFlag: false,
    round: 0,
    openEscalations: [],
    answeredEscalations: [],
    reviewRoundCeilings: {},
    pr: undefined,
    landing: {},
    autoMerge: { requested: false },
    restartSince: 0,
    pinnedAssets: [],
    finalizeCompletedSeq: 0,
    finalizeSteps: [],
    plan: { round: 0, approved: false },
    implement: { round: 0 },
    codeReviewApproved: false,
    codeReviewApproval: undefined,
    planReviewFindings: [],
    codeReviewFindings: [],
    verifyStage: initialVerifyStageState(),
    verify: { maxAttemptSeen: 0, results: [], cycleSince: 0 },
    reconcileAttempts: 0,
    observations: [],
    setupFailures: [],
    setupFailure: undefined,
    dispatchFailures: [],
    executions: [],
    infrastructureFailures: [],
    infrastructureFailure: undefined,
    cleanupAttempts: [],
    discardRequest: undefined,
    pending: { pause: [], resume: [], abort: [] },
    nativeHandles: {},
    sessionTotals: {},
    suspendedSessions: [],
    openSessions: [],
    failures: {},
  }
}

/** Fold `events` into `acc` in place. */
function foldBuild(acc: BuildAcc, events: readonly AbEvent[]): void {
  advanceCompatibility(acc.compatibility, events)
  events = projectEvents(events)
  for (const event of events) {
    if (event.type === 'build.compatibility-deferred')
      acc.compatibilityDeferredBoundary = event.payload.boundary
    if (event.type === 'execution.drain-authorized') {
      const previous = acc.drainingExecutions[event.payload.instance]
      if (
        previous?.correlation === event.payload.correlation ||
        previous?.correlations?.includes(event.payload.correlation)
      )
        continue
      acc.drainingExecutions[event.payload.instance] = {
        ...previous,
        correlations: [
          ...(previous?.correlations ?? []),
          ...(previous ? [previous.correlation] : []),
        ],
        correlation: event.payload.correlation,
        ...(acc.endedExecutionInstances[event.payload.instance]
          ? { ended: true as const }
          : { authorization: event.payload }),
      }
    }
    if (event.type === 'execution.relaunch-requested') {
      const entry = acc.drainingExecutions[event.payload.instance]
      if (entry?.authorization?.correlation === event.payload.correlation && !entry.ended)
        entry.relaunch = event.payload
    }
    if (event.type === 'session.suspended' && event.payload.cause === 'shutdown')
      for (const entry of Object.values(acc.drainingExecutions))
        if (entry.authorization && !entry.ended) entry.suspended = true
    if (event.type === 'execution.ended') acc.endedExecutionInstances[event.payload.instance] = true
    if (event.type === 'execution.ended' && acc.drainingExecutions[event.payload.instance]) {
      const entry = acc.drainingExecutions[event.payload.instance]!
      entry.ended = true
      delete entry.authorization
    }
    if (event.type === 'execution.drain-settled') {
      const entry = acc.drainingExecutions[event.payload.instance]
      if (entry?.correlation === event.payload.correlation) delete entry.authorization
    }
  }
  let attached = acc.attached
  let pausedFlag = acc.pausedFlag
  let terminal = acc.terminal
  let outcome = acc.outcome
  let round = acc.round
  let currentPhase = acc.currentPhase
  let lastCompletedPhase = acc.lastCompletedPhase
  const openEscalations = new Map(acc.openEscalations.map((e) => [e.id, e]))
  const answeredEscalations = acc.answeredEscalations
  const reviewRoundCeilings = acc.reviewRoundCeilings
  let pr = acc.pr
  let prState = acc.prState
  const autoMerge = acc.autoMerge
  let specRev = acc.specRev
  let restartSince = acc.restartSince
  let pinnedAssets = acc.pinnedAssets
  let finalizeCompletedSeq = acc.finalizeCompletedSeq
  const finalizeSteps = acc.finalizeSteps
  const plan = acc.plan
  const implement = acc.implement
  let codeReviewApproved = acc.codeReviewApproved
  let codeReviewApproval = acc.codeReviewApproval
  const planReviewFindings = acc.planReviewFindings
  const codeReviewFindings = acc.codeReviewFindings
  const verify = acc.verify
  let reconcileAttempts = acc.reconcileAttempts
  const observations = acc.observations
  const setupFailures = acc.setupFailures
  let setupFailure = acc.setupFailure
  const dispatchFailures = acc.dispatchFailures
  const executions = acc.executions
  const infrastructureFailures = acc.infrastructureFailures
  let infrastructureFailure = acc.infrastructureFailure
  const cleanupAttempts = acc.cleanupAttempts
  let discardRequest = acc.discardRequest
  const pending = acc.pending
  const suspended = new Map(acc.suspendedSessions.map((s) => [s.session, s]))
  const openSessions = new Map(acc.openSessions.map((s) => [s.session, s]))
  const failures = acc.failures

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

  let lastEvent = acc.lastEvent
  for (const event of events) {
    acc.pollingActivity ??= {}
    advancePollingActivity(acc.pollingActivity, event)
    acc.landing ??= {}
    if (event.type === 'build.janitor-attempt-failed')
      acc.janitor = {
        ...event.payload,
        ...(acc.janitor?.attention ? { attention: true as const } : {}),
      }
    if (event.type === 'build.janitor-failing' && acc.janitor) acc.janitor.attention = true
    if (event.type === 'build.janitor-recovered') delete acc.janitor
    advanceLanding(acc.landing, event)
    if (event.type.startsWith('integration.')) {
      acc.integration ??= {}
      advanceIntegration(acc.integration, event)
    }
    if (event.type.startsWith('node.') || (acc.kind === 'node' && event.type === 'target.moved')) {
      acc.nodeRestack ??= { items: [] }
      advanceNodeRestack(acc.nodeRestack, [event])
    }
    advanceVerifyStage(acc.verifyStage, event)
    if (event.type === 'verify.cancelled') {
      for (const escalation of [...openEscalations.values(), ...answeredEscalations]) {
        const session = escalation.session
        const key = session === undefined ? undefined : acc.verifyStage.owners[session]
        const cancellation = key === undefined ? undefined : acc.verifyStage.cancellations[key]
        if (!cancellation) continue
        if (
          'answeredSeq' in escalation &&
          'resolution' in escalation &&
          escalation.resolution === 'abort'
        )
          pending.abort = pending.abort.filter((command) => command.seq !== escalation.answeredSeq)
        openEscalations.delete(escalation.id)
        const index = answeredEscalations.findIndex((e) => e.id === escalation.id)
        if (index >= 0) answeredEscalations.splice(index, 1)
        if (!acc.verifyStage.superseded.some((e) => e.escalation.id === escalation.id))
          acc.verifyStage.superseded.push({ escalation, cancellation })
      }
    }
    switch (event.type) {
      // Facts the projection does not need (workspace liveness is the
      // dispatcher's concern; finalize post-steps are failure-tolerant §5).
      case 'node.parent-accepted':
        if (acc.kind === 'node') {
          acc.target = event.payload.next.target ?? undefined
          acc.baseBranch = event.payload.next.branch
          delete acc.nodeComparison
          if (acc.integration) {
            delete acc.integration.cycle
            delete acc.integration.observation
          }
        }
        break
      case 'node.opening':
        acc.nodeOpening = event.payload
        break
      case 'node.opened':
        acc.nodeOpened = event.payload
        break
      case 'node.poll-checked':
        acc.nodePolling = { ...event.payload, checkedAt: event.ts }
        break
      case 'node.compared':
        acc.nodeComparison = event.payload
        break
      case 'node.rewritten':
        if (acc.nodeComparison)
          acc.nodeComparison = { ...acc.nodeComparison, headSha: event.payload.head }
        if (pr) pr = { ...pr, headSha: event.payload.head }
        break
      case 'pr.opened':
        pr = event.payload.pr
        prState = 'open'
        break
      case 'build.created':
        acc.kind = event.payload.kind
        acc.target = event.payload.target
        acc.baseBranch = event.payload.baseBranch
        pinnedAssets = event.payload.assets ?? []
        break
      case 'workspace.provisioned':
      case 'workspace.released':
      case 'pr-summary.requested':
      case 'pr-summary.attempted':
      case 'pr-summary.result':
      case 'pr-summary.settled':
      case 'finalize.step-started':
      case 'publication.requested':
      // Inert loss fact (AUT-328): the dispatcher released a workspace with a
      // pending publication. Recovery runs through the existing
      // abandoned-publication flow (abandonedPublicationPending), which re-runs
      // the phase — the reducer needs no state from it.
      case 'publication.retry-scheduled':
      case 'publication.retry-exhausted':
      case 'publication.lost':
      case 'dispatch.comment-posted':
      case 'pr-attachment.designated':
      case 'pr-attachment.hosted':
      case 'pr-attachment.reclaimed':
      case 'pr-attachment.reclaim-failed':
        break

      case 'build.completed':
        terminal = 'done' // terminal, latest wins (§15.5) — in-order overwrite
        outcome = event.payload.outcome
        break
      case 'runner.attached':
        attached = true
        // On a recovery attempt attachment is delayed until setup succeeds,
        // so this fact is also the durable proof that the condition cleared.
        setupFailure = undefined
        break
      case 'runner.setup-failed': {
        const failure = { ...event.payload, seq: event.seq }
        setupFailures.push(failure)
        setupFailure = failure
        break
      }
      case 'dispatch.failed':
        dispatchFailures.push({ ...event.payload, seq: event.seq })
        break
      case 'execution.started':
        executions.push({ ...event.payload, seq: event.seq })
        infrastructureFailure = undefined
        break
      case 'execution.ended':
        infrastructureFailure = undefined
        break
      case 'infrastructure.failed': {
        const failure = { ...event.payload, seq: event.seq }
        infrastructureFailures.push(failure)
        infrastructureFailure = failure
        break
      }
      case 'infrastructure.cleanup-attempted':
        cleanupAttempts.push({ ...event.payload, seq: event.seq })
        if (
          event.payload.outcome !== 'unknown' &&
          infrastructureFailure?.workspaceRef === event.payload.workspaceRef
        ) {
          infrastructureFailure = undefined
        }
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
      case 'build.discard-requested':
        discardRequest = { seq: event.seq, actor: event.actor }
        break
      case 'build.auto-merge-requested':
        if (event.payload.integrationConsent === true) autoMerge.explicitCommandSeq = event.seq
        autoMerge.requested = true
        autoMerge.commandSeq = event.seq
        // A fan-out (or seeded) command carries the default fact it answers; a
        // bare per-build command must preserve the previous provenance.
        if (event.payload.defaultSeq !== undefined) autoMerge.defaultSeq = event.payload.defaultSeq
        break
      case 'build.auto-merge-cancelled':
        autoMerge.requested = false
        autoMerge.commandSeq = event.seq
        if (event.payload.defaultSeq !== undefined) autoMerge.defaultSeq = event.payload.defaultSeq
        break
      case 'build.auto-merge-default-observed':
        // A no-op fan-out still advances the build's provenance. Without it, a
        // matching default fact would stay strictly ahead of a bare per-build
        // command and be re-applied on the next tick, reverting the operator's
        // explicit choice (f_28b3fba1).
        if (event.payload.defaultSeq > (autoMerge.defaultSeq ?? 0)) {
          autoMerge.defaultSeq = event.payload.defaultSeq
        }
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
        specRev = event.payload.artifact.rev
        break
      case 'spec.revised':
        specRev = event.payload.artifact.rev
        if (event.payload.assets !== undefined) pinnedAssets = event.payload.assets
        // §6.3: rev N+1 restarts leaves from plan and nodes from collection. The restart boundary
        // invalidates every approval and result at or before it, so it is also
        // a verify cycle boundary. Finalize post-steps remain in full-log
        // history; consumers use this boundary to select the current spec,
        // matching engine.ts:710-712.
        restartSince = event.seq
        verify.cycleSince = Math.max(verify.cycleSince, event.seq)
        delete reviewRoundCeilings.plan
        delete reviewRoundCeilings.code
        break

      case 'session.started': {
        const root = event.payload.continuation?.root ?? event.payload.session
        acc.sessionTotals[root] ??= { activeMs: 0, transcripts: [] }
        const totals = acc.sessionTotals[root]
        totals.activeMs = Math.max(totals.activeMs, event.payload.continuation?.activeMs ?? 0)
        if (event.payload.continuation)
          acc.nativeHandles[event.payload.session] = event.payload.continuation.handle
        if (event.payload.continuation) {
          suspended.delete(event.payload.continuation.predecessor)
          openSessions.delete(event.payload.continuation.predecessor)
        }
        openSessions.set(event.payload.session, {
          continuation: event.payload.continuation,
          budgetMs: event.payload.budgetMs,
          args: event.payload.args,
          startedAt: event.ts,
          nativeHandle: event.payload.continuation?.handle,
          session: event.payload.session,
          role: event.payload.role,
          runner: event.payload.runner,
          model: event.payload.model,
          phase: event.payload.phase,
          round: event.payload.round,
          stream: event.payload.stream,
          seq: event.seq,
        })
        break
      }
      case 'session.native-handle-recorded': {
        const { session, phase, round, handle } = event.payload
        const open = openSessions.get(session)
        if (
          open !== undefined &&
          open.phase === phase &&
          open.round === round &&
          open.nativeHandle === undefined
        ) {
          openSessions.set(session, { ...open, nativeHandle: handle })
          acc.nativeHandles[session] = handle
        }
        break
      }
      case 'session.suspended': {
        const open = openSessions.get(event.payload.session)
        if (
          open &&
          open.phase === event.payload.phase &&
          open.round === event.payload.round &&
          !(lastCompletedPhase?.phase === open.phase && lastCompletedPhase.seq > open.seq)
        ) {
          const totals = acc.sessionTotals[open.continuation?.root ?? open.session]!
          totals.activeMs += event.payload.activeMs
          totals.transcripts.push(event.payload.transcript)
          if (event.payload.usage) {
            totals.usage ??= { inputTokens: 0, outputTokens: 0, turns: 0 }
            totals.usage.inputTokens += event.payload.usage.inputTokens
            totals.usage.outputTokens += event.payload.usage.outputTokens
            totals.usage.turns += event.payload.usage.turns
          }
          suspended.set(open.session, {
            ...open,
            nativeHandle: event.payload.handle ?? open.nativeHandle,
            suspensionCause: event.payload.cause,
            suspendedActiveMs: event.payload.activeMs,
          })
          openSessions.delete(open.session)
        }
        break
      }
      case 'session.resume-fallback': {
        if (event.payload.stale) break
        suspended.delete(event.payload.session)
        const open = openSessions.get(event.payload.session)
        if (open) {
          const { nativeHandle: _handle, resumed: _resumed, ...fresh } = open
          openSessions.set(open.session, { ...fresh, nativeResumeFallback: true })
        }
        break
      }
      case 'session.resumed': {
        const open = openSessions.get(event.payload.session)
        if (
          !event.payload.stale &&
          !open?.nativeResumeFallback &&
          open?.continuation &&
          open.continuation.predecessor === event.payload.predecessor &&
          open.continuation.root === event.payload.root &&
          JSON.stringify(open.nativeHandle) === JSON.stringify(event.payload.handle)
        )
          openSessions.set(open.session, { ...open, resumed: true })
        break
      }
      case 'session.ended': {
        const open = openSessions.get(event.payload.session)
        if (open && 'transcript' in event.payload) {
          const totals = acc.sessionTotals[open.continuation?.root ?? open.session]!
          totals.activeMs +=
            event.payload.activeMs ?? Math.max(0, Date.parse(event.ts) - Date.parse(open.startedAt))
          totals.transcripts.push(event.payload.transcript)
          totals.usage ??= { inputTokens: 0, outputTokens: 0, turns: 0 }
          totals.usage.inputTokens += event.payload.usage.inputTokens
          totals.usage.outputTokens += event.payload.usage.outputTokens
          totals.usage.turns += event.payload.usage.turns
        }
        suspended.delete(event.payload.session)
        openSessions.delete(event.payload.session)
        break
      }

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
        // Only an approve stands; any other verdict clears it, so
        // `approval !== undefined` ⇔ `approved`.
        if (plan.approved) plan.approval = { seq: event.seq, round }
        else delete plan.approval
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
        codeReviewApproval = codeReviewApproved ? { seq: event.seq, round } : undefined
        // §15.6-A: an approve means the code is settled and verifiable, so it
        // opens a new verify cycle. This tracker is deliberately SEPARATE from
        // `codeReviewApproval` — a later revise clears the approval but must
        // NOT move the cycle boundary backwards (mirrors engine.ts:637, which
        // never resets `latestApproveSeq`).
        if (codeReviewApproved) verify.cycleSince = Math.max(verify.cycleSince, event.seq)
        setFindings(codeReviewFindings, round, event.payload.findings)
        complete('code-review', event.seq, { round })
        break

      case 'verify.config-captured':
        verify.configPin = { ...event.payload, seq: event.seq }
        verify.cycleSince = Math.max(verify.cycleSince, event.seq)
        break
      case 'verify.config-superseded':
      case 'integration.prepared':
        verify.cycleSince = Math.max(verify.cycleSince, event.seq)
        break
      case 'verify.cancelled':
        if (
          acc.verifyStage.cancellations[verifyMemberKey(event.payload.step, event.payload.attempt)]
            ?.seq === event.seq
        )
          complete(verifyPhase(event.payload.step), event.seq, { attempt: event.payload.attempt })
        break
      case 'verify.stage-failed':
        break
      case 'verify.started':
        verify.maxAttemptSeen = Math.max(verify.maxAttemptSeen, event.payload.attempt)
        verify.currentStep = event.payload.step
        start({
          phase: verifyPhase(event.payload.step),
          attempt: event.payload.attempt,
          seq: event.seq,
        })
        break
      case 'verify.completed': {
        const result = normalizeVerifyCompletion(event.payload)
        if (acc.verifyStage.cancellations[verifyMemberKey(result.step, result.attempt)]) break
        verify.maxAttemptSeen = Math.max(verify.maxAttemptSeen, result.attempt)
        verify.results.push({
          ...(result.baseSha === undefined ? {} : { baseSha: result.baseSha }),
          ...(result.headSha === undefined ? {} : { headSha: result.headSha }),
          ...(result.restackId === undefined ? {} : { restackId: result.restackId }),
          step: result.step,
          attempt: result.attempt,
          outcome: result.outcome,
          report: result.report,
          ...(result.reason !== undefined ? { reason: result.reason } : {}),
          ...(result.skipCause !== undefined ? { skipCause: result.skipCause } : {}),
          seq: event.seq,
        })
        if (verify.currentStep === result.step) {
          verify.currentStep = undefined
        }
        complete(verifyPhase(result.step), event.seq, {
          attempt: result.attempt,
        })
        break
      }

      case 'finalize.started':
        start({ phase: 'finalize', seq: event.seq })
        break
      case 'finalize.completed':
        pr = event.payload.pr
        prState = 'open'
        finalizeCompletedSeq = event.seq
        complete('finalize', event.seq)
        break
      case 'finalize.step-completed':
        // §5: post-steps are independent and failure-tolerant — a completion
        // counts whether `ok` is true or false. Retain full-log history with
        // occurrence identity; readers scope it with `seq > restartBoundary`.
        finalizeSteps.push({ step: event.payload.step, ok: event.payload.ok, seq: event.seq })
        break

      case 'pr.auto-merge-enabled':
        autoMerge.applied = { enabled: true, commandSeq: event.payload.commandSeq }
        break
      case 'pr.auto-merge-disabled':
        autoMerge.applied = { enabled: false, commandSeq: event.payload.commandSeq }
        break
      case 'pr.merged':
        acc.mergedSha = event.payload.sha
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
      case 'restack.rewritten':
      case 'restack.completed':
        if (acc.kind !== 'node' && implement.commits)
          implement.commits = { base: event.payload.targetBase, head: event.payload.headSha }
        if (event.type === 'restack.completed' && prState === 'conflicted') prState = 'open'
        if (pr !== undefined)
          pr = {
            ...pr,
            headSha:
              event.type === 'restack.rewritten'
                ? (event.payload.observedHead ?? event.payload.headSha)
                : event.payload.headSha,
          }
        break
      case 'reconcile.rewritten':
        if (acc.kind !== 'node' && implement.commits)
          implement.commits = { base: event.payload.targetBase, head: event.payload.headSha }
        if (pr !== undefined) pr = { ...pr, headSha: reconcileRewriteHead(event.payload) }
        break
      case 'reconcile.completed': {
        if (acc.kind !== 'node' && 'headSha' in event.payload && pr !== undefined)
          pr = { ...pr, headSha: event.payload.headSha }
        // The terminal payload has no attempt, so preserve it from the
        // matching in-flight occurrence before complete() clears that context.
        // An unmatched completion remains a bare context rather than borrowing
        // the aggregate reconcileAttempts high-water.
        const attempt = currentPhase?.phase === 'reconcile' ? currentPhase.attempt : undefined
        // §15.7: conflicted until a reconcile.completed appears after the
        // pr.conflicted — the PR is open again while verify:* re-runs.
        if (prState === 'conflicted') prState = 'open'
        // Reconciliation changed the code, so verify re-runs in full — a new
        // cycle (§15.7, engine.ts:275).
        verify.cycleSince = Math.max(verify.cycleSince, event.seq)
        complete('reconcile', event.seq, attempt !== undefined ? { attempt } : undefined)
        break
      }

      case 'observation.recorded':
        observations.push(event.payload)
        break
      case 'phase.deferral-escalated':
        openEscalations.set(event.payload.id, {
          id: event.payload.id,
          phase: event.payload.phase,
          round: event.payload.round,
          source: 'policy',
          deferral: 'own-build-read',
          question: event.payload.question,
          refs: event.payload.refs,
          seq: event.seq,
        })
        break
      case 'escalation.raised': {
        const escalation: OpenEscalation = {
          id: event.payload.id,
          phase: event.payload.phase,
          round: event.payload.round,
          source: event.payload.source,
          ...(event.actor.kind === 'agent' ? { session: event.actor.session } : {}),
          ...(event.payload.policyCause !== undefined
            ? { policyCause: event.payload.policyCause }
            : {}),
          question: event.payload.question,
          refs: event.payload.refs,
          seq: event.seq,
        }
        const key =
          escalation.session === undefined ? undefined : acc.verifyStage.owners[escalation.session]
        const cancellation = key === undefined ? undefined : acc.verifyStage.cancellations[key]
        if (cancellation) acc.verifyStage.superseded.push({ escalation, cancellation })
        else openEscalations.set(escalation.id, escalation)
        break
      }
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
            ...(event.payload.artifact !== undefined ? { artifact: event.payload.artifact } : {}),
            ...(event.payload.assets !== undefined ? { assets: event.payload.assets } : {}),
            ...(event.payload.reviewRoundCeiling !== undefined
              ? { reviewRoundCeiling: event.payload.reviewRoundCeiling }
              : {}),
            answeredSeq: event.seq,
          })
          if (
            event.payload.reviewRoundCeiling !== undefined &&
            open.source === 'policy' &&
            open.policyCause === 'review-round-limit'
          ) {
            if (open.phase === 'plan-review') {
              reviewRoundCeilings.plan = event.payload.reviewRoundCeiling
            } else if (open.phase === 'code-review') {
              reviewRoundCeilings.code = event.payload.reviewRoundCeiling
            }
          }
          // Abort is accepted through either supported operator surface. Keep
          // the answer as the audit reason and project its event identity as
          // the same pending command an explicit abort request creates; the
          // kernel's one build.aborted fact acknowledges both pathways.
          if (event.payload.resolution === 'abort') {
            pending.abort.push({
              command: 'abort',
              seq: event.seq,
              reason: event.payload.answer,
              actor: event.actor,
            })
          }
        }
        break
      }
      case 'phase.failed':
        failures[event.payload.phase] = (failures[event.payload.phase] ?? 0) + 1
        break
    }
    lastEvent = event
  }

  acc.attached = attached
  acc.pausedFlag = pausedFlag
  acc.terminal = terminal
  acc.outcome = outcome
  acc.round = round
  acc.currentPhase = currentPhase
  acc.lastCompletedPhase = lastCompletedPhase
  const running = runningVerifyMembers(acc.verifyStage, verify.cycleSince)
  if (Object.keys(acc.verifyStage.members).length)
    verify.running = running.map((member) => member.step)
  if (acc.verifyStage.concurrent && running.length) {
    verify.currentStep = running.at(-1)!.step
    if (!currentPhase || currentPhase.phase.startsWith('verify:'))
      currentPhase = {
        phase: verifyPhase(running.at(-1)!.step),
        attempt: running.at(-1)!.attempt,
        seq: running.at(-1)!.seq,
      }
  } else if (acc.verifyStage.concurrent) verify.currentStep = undefined
  acc.currentPhase = currentPhase
  acc.openEscalations = [...openEscalations.values()]
  acc.pr = pr
  acc.prState = prState
  acc.specRev = specRev
  acc.restartSince = restartSince
  acc.pinnedAssets = pinnedAssets
  acc.finalizeCompletedSeq = finalizeCompletedSeq
  acc.codeReviewApproved = codeReviewApproved
  acc.codeReviewApproval = codeReviewApproval
  acc.reconcileAttempts = reconcileAttempts
  acc.setupFailure = setupFailure
  acc.infrastructureFailure = infrastructureFailure
  acc.discardRequest = discardRequest
  acc.suspendedSessions = [...suspended.values()]
  acc.openSessions = [...openSessions.values()]
  acc.lastEvent = lastEvent
}

function finishBuild(acc: BuildAcc): BuildState {
  const {
    terminal,
    pausedFlag,
    attached,
    currentPhase,
    lastCompletedPhase,
    lastEvent,
    discardRequest,
    pending,
  } = acc

  // §15.5 precedence: aborted/done (terminal, latest wins) > paused >
  // blocked > running > queued. See BuildState.status for the paused+blocked
  // overlap rule.
  const status: BuildStatus =
    terminal ??
    (pausedFlag
      ? 'paused'
      : acc.openEscalations.length > 0 || integrationFailed(acc)
        ? 'blocked'
        : acc.kind === 'node' && acc.nodeOpened !== undefined
          ? 'collecting'
          : attached
            ? 'running'
            : 'queued')

  const active = currentPhase ?? lastCompletedPhase

  return {
    kind: acc.kind,
    target: acc.target,
    baseBranch: acc.baseBranch,
    nodeOpening: acc.nodeOpening,
    mergedSha: acc.mergedSha,
    nodeOpened: acc.nodeOpened,
    integration: acc.integration,
    pollingActivity: acc.pollingActivity,
    nodePolling: acc.nodePolling,
    nodeComparison: acc.nodeComparison,
    nodeRestack: acc.nodeRestack,
    status,
    outcome: acc.outcome,
    phase: active?.phase,
    round: acc.round,
    currentPhase,
    lastCompletedPhase,
    openEscalations: [...acc.openEscalations],
    answeredEscalations: acc.answeredEscalations,
    reviewRoundCeilings: acc.reviewRoundCeilings,
    pr: acc.pr,
    prState: acc.prState,
    janitor: acc.janitor,
    landing: acc.landing,
    autoMerge: acc.autoMerge,
    finalizeCompletedSeq: acc.finalizeCompletedSeq,
    finalizeSteps: acc.finalizeSteps,
    lastEvent,
    lastSeq: Math.max(lastEvent?.seq ?? 0, acc.compatibility.lastSeq),
    compatibility: structuredClone(acc.compatibility),
    compatibilityDeferredBoundary: acc.compatibilityDeferredBoundary,
    ...(Object.keys(acc.drainingExecutions).length
      ? { drainingExecutions: structuredClone(acc.drainingExecutions) }
      : {}),
    pinnedAssets: acc.pinnedAssets,
    specRev: acc.specRev,
    restartSince: acc.restartSince,
    plan: acc.plan,
    implement: acc.implement,
    codeReviewApproved: acc.codeReviewApproved,
    codeReviewApproval: acc.codeReviewApproval,
    reviewFindings: { planReview: acc.planReviewFindings, codeReview: acc.codeReviewFindings },
    verifyStage: acc.verifyStage,
    verify: acc.verify,
    reconcileAttempts: acc.reconcileAttempts,
    observations: acc.observations,
    setupFailures: acc.setupFailures,
    setupFailure: acc.setupFailure,
    dispatchFailures: acc.dispatchFailures,
    executions: acc.executions,
    infrastructureFailures: acc.infrastructureFailures,
    infrastructureFailure: acc.infrastructureFailure,
    cleanupAttempts: acc.cleanupAttempts,
    ...(terminal === undefined && discardRequest !== undefined ? { discardRequest } : {}),
    pendingCommands: [...pending.pause, ...pending.resume, ...pending.abort].sort(
      (a, b) => a.seq - b.seq,
    ),
    sessions: {
      totals: structuredClone(acc.sessionTotals),
      suspended: [...acc.suspendedSessions],
      open: [...acc.openSessions],
      nativeHandles: { ...acc.nativeHandles },
    },
    failures: acc.failures,
  }
}

/** The incremental form of `reduceBuild`: advance a carried accumulator with
 * only the events newer than it, then derive the state. */
export const buildReducer: IncrementalReducer<BuildAcc, AbEvent, BuildState> = defineReducer({
  version: BUILD_REDUCER_VERSION,
  rawEvents: true,
  initial: initialBuildAcc,
  fold: foldBuild,
  finish: finishBuild,
})

export function reduceBuild(events: AbEvent[]): BuildState {
  const acc = initialBuildAcc()
  foldBuild(acc, events)
  return finishBuild(acc)
}
