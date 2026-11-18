/**
 * Pure optimization admission and proposer selectors over a reduced
 * `OptimizationState` (SPEC §13.1.1, RFC 0005 §5, §9.1). Type-only imports:
 * dispatch capacity, which the browser dashboards bundle, imports these, so
 * this module must not reach the reducer definitions or `Bun` APIs.
 */
import type { Objective } from '../objective'
import type { OptimizationState } from './optimization'
import type { BuildState } from './reducer'

export function direction(objective: Objective): 'minimize' | 'maximize' {
  return objective.metric.kind === 'command' ? objective.metric.direction : 'maximize'
}

export const HOUR_MS = 3_600_000

export function optimizationElapsedHours(state: OptimizationState, now: Date): number {
  return Math.max(0, (now.getTime() - Date.parse(state.openedAt)) / HOUR_MS)
}

export interface OptimizationStopEligibility {
  threshold: boolean
  plateau: boolean
  budget: boolean
  budgetCause?: 'attempts' | 'hours'
}

/** Which stop causes the digest makes eligible at `now` (RFC 0005 §9.1). */
export function optimizationStopEligibility(
  state: OptimizationState,
  now: Date,
): OptimizationStopEligibility {
  const { objective } = state
  const threshold = objective.target.threshold
  const reached =
    threshold !== undefined &&
    state.current !== undefined &&
    (direction(objective) === 'minimize' ? state.current <= threshold : state.current >= threshold)
  const plateauLimit = objective.stop.plateau?.attempts
  const budgetCause =
    objective.budget.maxAttempts !== undefined &&
    state.attempts.filed >= objective.budget.maxAttempts
      ? ('attempts' as const)
      : objective.budget.maxHours !== undefined &&
          optimizationElapsedHours(state, now) >= objective.budget.maxHours
        ? ('hours' as const)
        : undefined
  return {
    threshold: reached,
    plateau: plateauLimit !== undefined && state.plateau >= plateauLimit,
    budget: budgetCause !== undefined,
    ...(budgetCause !== undefined ? { budgetCause } : {}),
  }
}

export interface OptimizationAdmission {
  stopped: boolean
  /** Attempts the budget still allows; null without an attempts budget. */
  attemptRoom: number | null
  /** Concurrency slots not held by an in-flight attempt. */
  slots: number
}

export function optimizationAdmission(state: OptimizationState, _now: Date): OptimizationAdmission {
  const max = state.objective.budget.maxAttempts
  return {
    stopped: state.stopped !== undefined,
    attemptRoom: max === undefined ? null : Math.max(0, max - state.attempts.filed),
    slots: Math.max(0, state.objective.proposer.concurrency - state.inFlight.length),
  }
}

// ── The proposer (SPEC §13.1.1, RFC 0005 §5) ──────────────────────────────

/** Attempts one proposal round may file now: the free concurrency slots,
 * capped by the attempts budget; 0 once a budget is spent. */
export function proposerRoom(state: OptimizationState, now: Date): number {
  if (optimizationStopEligibility(state, now).budget) return 0
  const { attemptRoom, slots } = optimizationAdmission(state, now)
  return Math.min(slots, attemptRoom ?? slots)
}

/** A non-optimization condition that keeps a node's proposer from being
 * requested. Each clears only through a fact in `PROPOSER_WAKE_EVENT_TYPES`
 * (compatibility clears by upgrading, which the digest observes directly). */
export type ProposerBlocker =
  | 'paused'
  | 'blocked'
  | 'command'
  | 'restack'
  | 'integration'
  | 'landing'
  | 'compatibility'

type ProposerBuild = Pick<
  BuildState,
  | 'kind'
  | 'nodeOpened'
  | 'optimization'
  | 'status'
  | 'pendingCommands'
  | 'compatibility'
  | 'nodeRestack'
  | 'integration'
  | 'prState'
>

export function proposerBlocker(build: ProposerBuild): ProposerBlocker | undefined {
  if (build.status === 'paused') return 'paused'
  if (build.status === 'blocked') return 'blocked'
  if (build.pendingCommands.length > 0) return 'command'
  if ((build.compatibility?.decisiveFacts ?? 0) > 0) return 'compatibility'
  if (build.nodeRestack?.conflict !== undefined || build.nodeRestack?.active !== undefined)
    return 'restack'
  if (build.integration?.intent !== undefined) return 'integration'
  if (build.prState === 'merged' || build.prState === 'closed') return 'landing'
  return undefined
}

/** The optimization half of request admission, which the digest signal
 * mirrors: not stopped, measured, no open request, fewer than two empty
 * proposals in a row, and room to file. */
export function proposerRequestable(state: OptimizationState, now: Date): boolean {
  return (
    state.stopped === undefined &&
    state.starting !== undefined &&
    state.proposal === undefined &&
    state.emptyProposals < 2 &&
    proposerRoom(state, now) > 0
  )
}

/** Whether the dispatcher may record a new proposal request for `build`. */
export function proposerAdmissible(build: ProposerBuild, now: Date): boolean {
  return (
    build.kind === 'node' &&
    build.nodeOpened !== undefined &&
    build.optimization !== undefined &&
    build.status !== 'done' &&
    build.status !== 'aborted' &&
    proposerRequestable(build.optimization, now) &&
    proposerBlocker(build) === undefined
  )
}

/** A request is open and not yet deposited: the proposer has work. Clock
 * free; the engine and runner gates use it once the dispatcher admitted. */
export function proposeRunDue(state: OptimizationState | undefined): boolean {
  return state?.proposal !== undefined && state.proposal.deposited === undefined
}

/** The proposer session for the open request has started: it was admitted
 * and keeps its allowance, whatever later revisions or stops say. */
export function proposeStarted(build: Pick<BuildState, 'optimization' | 'currentPhase'>): boolean {
  const proposal = build.optimization?.proposal
  return (
    proposal !== undefined &&
    proposal.deposited === undefined &&
    build.currentPhase?.phase === 'propose' &&
    build.currentPhase.round === proposal.round
  )
}

export type ProposalWithdrawalReason = 'stopped' | 'budget' | 'concurrency'

function proposalIneligibility(
  state: OptimizationState,
  now: Date,
): ProposalWithdrawalReason | undefined {
  if (state.stopped !== undefined) return 'stopped'
  if (optimizationStopEligibility(state, now).budget) return 'budget'
  const { attemptRoom, slots } = optimizationAdmission(state, now)
  if (attemptRoom === 0) return 'budget'
  if (slots === 0) return 'concurrency'
  const room = state.proposal?.room ?? 0
  if (room > Math.min(slots, attemptRoom ?? slots))
    return attemptRoom !== null && attemptRoom < slots ? 'budget' : 'concurrency'
  return undefined
}

/** The open request still fits current state: re-evaluated at every point
 * a proposer session can be admitted, so a request that waited for a slot
 * never starts after a stop, a spent budget or a shrink below its room. */
export function proposalEligible(state: OptimizationState, now: Date): boolean {
  return proposalIneligibility(state, now) === undefined
}

/** A proposer session may be admitted for the open request now. */
export function proposeAdmissible(state: OptimizationState | undefined, now: Date): boolean {
  return state !== undefined && proposeRunDue(state) && proposalEligible(state, now)
}

/** Why an undeposited request must be withdrawn, when it must. */
export function proposalWithdrawalDue(
  state: OptimizationState | undefined,
  now: Date,
): ProposalWithdrawalReason | undefined {
  if (state === undefined || !proposeRunDue(state)) return undefined
  return proposalIneligibility(state, now)
}

/** The proposer deposited and the dispatcher has not filed yet. */
export function proposalFilingDue(state: OptimizationState | undefined): boolean {
  return state?.proposal?.deposited !== undefined
}

/** Two consecutive empty proposals and no stop recorded yet. */
export function exhaustedStopDue(state: OptimizationState | undefined): boolean {
  return state !== undefined && state.emptyProposals >= 2 && state.stopped === undefined
}
