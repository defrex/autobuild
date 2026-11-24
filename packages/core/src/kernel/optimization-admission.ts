/**
 * Pure optimization admission and proposer selectors over a reduced
 * `OptimizationState` (SPEC §13.1.1, RFC 0005 §5, §9.1). Type-only imports:
 * dispatch capacity, which the browser dashboards bundle, imports these, so
 * this module must not reach the reducer definitions or `Bun` APIs.
 */
import type { EventPayload, OptimizationStopCause } from '../events/payloads'
import type { Objective } from '../objective'
import type { ExecutionIntervalsValue } from './execution-intervals'
import type { OptimizationClock, OptimizationState } from './optimization'
import type { BuildState } from './reducer'

export function direction(objective: Objective): 'minimize' | 'maximize' {
  return objective.metric.kind === 'command' ? objective.metric.direction : 'maximize'
}

export const HOUR_MS = 3_600_000

// ── The active-hours clock (SPEC §13.1.1) ─────────────────────────────────

/** A closed interval of ISO timestamps, `[start, end]`. */
export type ClockSpan = [string, string]

/** Merge spans into a sorted, disjoint list. Adjacent and overlapping spans
 * join; empty spans vanish. ISO timestamps of one format order as strings. */
export function unionSpans(spans: readonly ClockSpan[]): ClockSpan[] {
  const sorted = spans
    .filter(([start, end]) => start < end)
    .map(([start, end]) => [start, end] as ClockSpan)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const merged: ClockSpan[] = []
  for (const span of sorted) {
    const last = merged.at(-1)
    if (last !== undefined && span[0] <= last[1]) {
      if (span[1] > last[1]) last[1] = span[1]
    } else merged.push(span)
  }
  return merged
}

/** The length in milliseconds of the union of `spans`. */
export function unionLength(spans: readonly ClockSpan[]): number {
  return unionSpans(spans).reduce(
    (total, [start, end]) => total + (Date.parse(end) - Date.parse(start)),
    0,
  )
}

/** `spans` clipped to `[from, to]`; parts outside vanish. */
export function clipSpans(spans: readonly ClockSpan[], from?: string, to?: string): ClockSpan[] {
  return spans.flatMap(([start, end]) => {
    const clipped: ClockSpan = [
      from !== undefined && start < from ? from : start,
      to !== undefined && end > to ? to : end,
    ]
    return clipped[0] < clipped[1] ? [clipped] : []
  })
}

/** What active hours need from a clock: open intervals as start times. */
export interface OptimizationClockView {
  activeMs: number
  spans: ClockSpan[]
  open: string[]
  stoppedAt?: string
  /** A stopped clock whose pre-stop attempt facts are all accounted. */
  settled?: true
}

export function clockView(clock: OptimizationClock): OptimizationClockView {
  return {
    activeMs: clock.activeMs,
    spans: clock.spans.map(([start, end]) => [start, end] as ClockSpan),
    open: Object.values(clock.open)
      .map(({ start }) => start)
      .sort(),
    ...(clock.stoppedAt !== undefined ? { stoppedAt: clock.stoppedAt } : {}),
    ...(clock.settled ? { settled: true as const } : {}),
  }
}

/** Active hours at `now`: the union of every execution interval the node
 * counts, each open one running to `now`, all ending at the stop. A stopped
 * view is constant in `now`. */
export function activeHours(view: OptimizationClockView, now: Date): number {
  const iso = now.toISOString()
  const end = view.stoppedAt !== undefined && view.stoppedAt < iso ? view.stoppedAt : iso
  const live = unionLength(
    clipSpans(
      [...view.spans, ...view.open.map((start) => [start, end] as ClockSpan)],
      undefined,
      end,
    ),
  )
  return Math.max(0, (view.activeMs + live) / HOUR_MS)
}

/** Whether a stopped node's active hours may still change once, when the
 * dispatcher's settlement accounts attempt runs from before the stop: it has
 * attempts in flight, tracked builds or an open attempt run. A node with none
 * (a completed legacy node) is final already. */
export function clockSettling(state: Pick<OptimizationState, 'clock' | 'inFlight'>): boolean {
  const { clock } = state
  return (
    clock.stoppedAt !== undefined &&
    !clock.settled &&
    (state.inFlight.length > 0 ||
      Object.keys(clock.builds).length > 0 ||
      Object.keys(clock.open).some((key) => key !== ''))
  )
}

/** The budget's hours: active hours, never wall-clock time since opening. */
export function optimizationElapsedHours(state: OptimizationState, now: Date): number {
  return activeHours(clockView(state.clock), now)
}

/** Most attempt execution facts one `optimization.activity-recorded` carries. */
export const ACTIVITY_FACTS_PER_EVENT = 200

/** One relevant attempt build, as the dispatcher's activity pass sees it. */
export interface ActivityBuildInput {
  build: string
  /** The build is an in-flight attempt's newest build. */
  inFlightNewest: boolean
  /** The listing has no such build: nothing can ever be read for it. */
  missing?: true
  /** The build digest's `executionFacts`. */
  digestCount?: number
  /** The build digest shows an open execution. */
  digestOpen?: boolean
  /** The build's `executionIntervals` value, when the pass read it. */
  value?: ExecutionIntervalsValue
}

export type ActivityBatch = EventPayload<'optimization.activity-recorded'>

/** A value lacks a fact the node needs: an invariant violation the
 * dispatcher reports, never repairs from events. */
export class ExecutionFactsMissingError extends Error {
  constructor(
    readonly build: string,
    readonly n: number,
  ) {
    super(
      `execution fact ${n} of build ${build} is missing from its executionIntervals value: it was acknowledged before the node accounted it`,
    )
    this.name = 'ExecutionFactsMissingError'
  }
}

/**
 * The attempt execution facts a node's clock has not yet accounted, as one
 * batch payload, or undefined when there is nothing to record. A running
 * clock takes each build's facts above its accounted count up to the digest's
 * count; a stopped, unsettled clock takes every unaccounted fact up to the
 * stop and settles. A clock with no batch yet gets one that starts it, so
 * every later settlement is tracked. Releases fully accounted builds that no
 * in-flight attempt runs on any more.
 *
 * The watermark, through which the clock compacts, is not the latest fact:
 * each build's digest is read on its own, so a fact this pass missed on one
 * build can be stamped before a fact it saw on another. It is the store time
 * the node recorded its previous batch, which the previous pass wrote before
 * this one read any digest, so every fact stamped before it is visible now.
 */
export function optimizationActivityBatch(
  clock: OptimizationClock,
  inputs: readonly ActivityBuildInput[],
  fallbackWatermark: string,
): ActivityBatch | undefined {
  if (clock.settled) return undefined
  const settling = clock.stoppedAt !== undefined
  // The first batch starts the clock: settlements after it are tracked.
  const starting = !settling && clock.watermark === undefined
  const facts: ActivityBatch['facts'] = []
  const accounted: Record<string, number> = {}
  const released: string[] = []
  for (const input of inputs) {
    const tracked = clock.builds[input.build] !== undefined
    const seen = clock.builds[input.build] ?? 0
    // The instance the clock holds open for this build after this batch.
    let open: string | undefined = clock.open[input.build]?.instance
    let through = seen
    if (!input.missing && input.value !== undefined) {
      const value = input.value
      // Facts at or below the acknowledgment were accounted by this node
      // before it released the build; the acknowledgment follows the record.
      const from = Math.max(seen, value.acknowledged)
      const last = settling ? value.count : Math.min(input.digestCount ?? 0, value.count)
      for (let n = from + 1; n <= last; n++) {
        const fact = value.facts.find((candidate) => candidate.n === n)
        if (fact === undefined) throw new ExecutionFactsMissingError(input.build, n)
        if (settling && fact.at > clock.stoppedAt!) continue
        facts.push({ build: input.build, n, instance: fact.instance, kind: fact.kind, at: fact.at })
        if (fact.kind === 'started') open = fact.instance
        else if (fact.instance === open) open = undefined
      }
      through = Math.max(seen, last)
    }
    if (through > seen) accounted[input.build] = through
    if (settling || input.inFlightNewest || open !== undefined) continue
    if (!tracked && through === seen) continue
    if (
      input.missing ||
      (!input.digestOpen && input.digestCount !== undefined && through >= input.digestCount)
    )
      released.push(input.build)
  }
  facts.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.n - b.n))
  if (
    !settling &&
    !starting &&
    facts.length === 0 &&
    Object.keys(accounted).length === 0 &&
    released.length === 0
  )
    return undefined
  const complete = settling ? clock.stoppedAt! : (clock.recordedAt ?? fallbackWatermark)
  const watermark =
    clock.watermark !== undefined && clock.watermark > complete ? clock.watermark : complete
  return {
    facts,
    accounted,
    ...(released.length > 0 ? { released: released.sort() } : {}),
    watermark,
    ...(starting ? { starts: true as const } : {}),
    ...(settling ? { settles: true as const } : {}),
  }
}

/** Split a batch into events of at most `ACTIVITY_FACTS_PER_EVENT` facts, in
 * `at` order. Each chunk accounts only the facts it and earlier chunks carry
 * and watermarks no later than its last fact, since a later chunk's facts
 * follow it; the last chunk carries the batch's accounted counts, releases,
 * watermark and settlement. */
export function chunkActivityBatch(batch: ActivityBatch): ActivityBatch[] {
  if (batch.facts.length <= ACTIVITY_FACTS_PER_EVENT) return [batch]
  const chunks: ActivityBatch[] = []
  const through: Record<string, number> = {}
  for (let index = 0; index < batch.facts.length; index += ACTIVITY_FACTS_PER_EVENT) {
    const facts = batch.facts.slice(index, index + ACTIVITY_FACTS_PER_EVENT)
    const last = index + ACTIVITY_FACTS_PER_EVENT >= batch.facts.length
    if (last) {
      chunks.push({ ...batch, facts })
      break
    }
    const accounted: Record<string, number> = {}
    for (const fact of facts) {
      through[fact.build] = Math.max(through[fact.build] ?? 0, fact.n)
      accounted[fact.build] = through[fact.build]!
    }
    const lastAt = facts.at(-1)!.at
    chunks.push({
      facts,
      accounted,
      watermark: lastAt < batch.watermark ? lastAt : batch.watermark,
    })
  }
  return chunks
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
  /** Concurrency slots not held by an in-flight attempt or a pending rejection. */
  slots: number
}

export function optimizationAdmission(state: OptimizationState, _now: Date): OptimizationAdmission {
  const max = state.objective.budget.maxAttempts
  return {
    stopped: state.stopped !== undefined,
    attemptRoom: max === undefined ? null : Math.max(0, max - state.attempts.filed),
    slots: Math.max(
      0,
      state.objective.proposer.concurrency - state.inFlight.length - state.rejections.length,
    ),
  }
}

export type OptimizationAutomaticStopCause = Exclude<
  OptimizationStopCause,
  'exhausted' | 'operator'
>

/** The cause the dispatcher records as `optimization.stopped` at `now`, in
 * precedence threshold, plateau, budget; undefined once the node has
 * stopped. The effective objective is folded into the digest, so a revised
 * threshold, budget or plateau applies on the next evaluation. */
export function optimizationStopCause(
  state: OptimizationState,
  now: Date,
): OptimizationAutomaticStopCause | undefined {
  if (state.stopped !== undefined) return undefined
  const eligibility = optimizationStopEligibility(state, now)
  return eligibility.threshold
    ? 'threshold'
    : eligibility.plateau
      ? 'plateau'
      : eligibility.budget
        ? 'budget'
        : undefined
}

/** Whether a proposer session may be admitted at `now`. The proposer phase
 * (RFC 0005 §5.1) must admit through this predicate: it is false once the
 * node has stopped or any stop cause is eligible, and otherwise requires
 * attempts-budget room and a free concurrency slot. */
export function optimizationProposerAdmissible(state: OptimizationState, now: Date): boolean {
  if (state.stopped !== undefined || optimizationStopCause(state, now) !== undefined) return false
  const admission = optimizationAdmission(state, now)
  return admission.attemptRoom !== 0 && admission.slots > 0
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
    optimizationProposerAdmissible(state, now) &&
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
  if (optimizationStopCause(state, now) !== undefined) return 'stopped'
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
