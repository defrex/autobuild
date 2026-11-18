/**
 * The optimization node's derived state (SPEC §15.5, RFC 0005 §11): a bounded
 * digest the dispatcher, status and `ab objective` read from BuildState, and
 * a ledger of settled attempts the proposer reads once per run.
 *
 * Both fold only the node's own log. `attempt.settled` carries the measured
 * delta, so neither ever reads an attempt's log.
 */
import type { AbEvent } from '../events/catalog'
import type { AttemptOutcome, EventPayload, OptimizationStopCause } from '../events/payloads'
import {
  applyObjectiveRevisions,
  objectiveRulerChanged,
  REVISABLE_FIELDS,
  type Objective,
  type ObjectiveEpsilon,
  type RevisableField,
} from '../objective'
import type { TicketRef } from '../ontology'
import { defineReducer } from './incremental'
export { optimizationCompletionBlocker } from './integration-state'
import type { BuildState } from './reducer'

/** One proposed attempt that has not settled. Admission caps these at the
 * objective's concurrency, so the list is bounded. */
export interface InFlightAttempt {
  proposal: string
  ticket: TicketRef
}

/** A settled, non-accepted attempt whose ticket the dispatcher has not yet
 * moved to the rejected role (SPEC §13). Settlement transfers an attempt from
 * `inFlight` to here, and admission counts both lists against concurrency, so
 * `inFlight.length + rejections.length` never exceeds `proposer.concurrency`
 * through new proposals. An entry exists only between settlement and the
 * move's `attempt.ticket-rejected`. */
export interface PendingRejection {
  proposal: string
  ticket: TicketRef
  /** The attempt's build, when it was ever claimed. */
  build?: string
  outcome: Exclude<AttemptOutcome, 'accepted'>
}

export interface OptimizationValue {
  value: number
  spread: number
  head: string
}

/** The bounded per-node digest. Plain JSON; its size never grows with the
 * number of settled attempts. */
export interface OptimizationState {
  /** The latest `optimization.objective-accepted`. */
  accepted: EventPayload<'optimization.objective-accepted'> & { acceptedAt: string }
  /** When the objective was first accepted: the start of the hours budget. */
  openedAt: string
  /** The accepted objective with every later quick revision applied. */
  objective: Objective
  /** The latest objective revision, across acceptances and quick revisions. */
  revision: number
  /** Fields quick-revised since the latest acceptance. */
  revisedFields: RevisableField[]
  /** The acceptance that started the current ruler. Measurements under an
   * older revision are history and feed no value below. */
  rulerRevision: number
  /** The head measured against itself under the current ruler. A panel's
   * starting value is 0.5 by definition. */
  starting?: OptimizationValue
  /** The node head's value: a command's latest accepted candidate median, a
   * panel's latest head-against-start win rate. Falls back to the starting
   * value. */
  current?: number
  /** The best value in the objective's direction under the current ruler. */
  best?: number
  attempts: {
    /** Tickets proposed, which the attempts budget counts. */
    filed: number
    accepted: number
    /** Settled as no-improvement, declined, stopped or aborted. */
    rejected: number
  }
  /** Proposed attempts that have not settled; `inFlight.length` are running. */
  inFlight: InFlightAttempt[]
  /** Settled, non-accepted attempts whose ticket move is still pending. */
  rejections: PendingRejection[]
  /** Consecutive `no-improvement` or `declined` settlements since the last
   * `accepted`. `stopped` and `aborted` leave it unchanged. */
  plateau: number
  /** Consecutive proposals that returned no attempts. */
  emptyProposals: number
  stopped?: { cause: OptimizationStopCause; mode: 'abort' | 'drain'; at: string }
  /** Tickets of attempts settled `stopped`, which the claim gate refuses.
   * Bounded: only attempts in flight at the stop settle `stopped`, and
   * admission caps those at the objective's concurrency. */
  stoppedTickets?: TicketRef[]
}

/** The digest accumulator, embedded in BuildAcc. Undefined until the first
 * acceptance. */
export type OptimizationAcc = OptimizationState | undefined

function direction(objective: Objective): 'minimize' | 'maximize' {
  return objective.metric.kind === 'command' ? objective.metric.direction : 'maximize'
}

function better(objective: Objective, a: number | undefined, b: number): number {
  if (a === undefined) return b
  return direction(objective) === 'minimize' ? Math.min(a, b) : Math.max(a, b)
}

/** Whether `event` is a node-log fact the digest folds. */
export function isOptimizationEvent(event: Pick<AbEvent, 'type'>): boolean {
  return (
    event.type.startsWith('optimization.') ||
    event.type === 'attempt.settled' ||
    event.type === 'attempt.ticket-rejected'
  )
}

function startRuler(state: OptimizationState, revision: number) {
  state.rulerRevision = revision
  delete state.starting
  delete state.current
  delete state.best
  if (state.objective.metric.kind === 'panel') {
    state.current = 0.5
    state.best = 0.5
  }
}

/** Fold node-log events into the digest. Returns the advanced value; the
 * previous one is mutated in place when it exists. */
export function advanceOptimization(acc: OptimizationAcc, events: readonly AbEvent[]) {
  let state = acc
  for (const event of events) {
    if (event.type === 'optimization.objective-accepted') {
      const accepted = { ...structuredClone(event.payload), acceptedAt: event.ts }
      if (state === undefined) {
        state = {
          accepted,
          openedAt: event.ts,
          objective: structuredClone(event.payload.objective),
          revision: event.payload.revision,
          revisedFields: [],
          rulerRevision: event.payload.revision,
          attempts: { filed: 0, accepted: 0, rejected: 0 },
          inFlight: [],
          rejections: [],
          plateau: 0,
          emptyProposals: 0,
        }
        startRuler(state, event.payload.revision)
        continue
      }
      const changed = objectiveRulerChanged(state.accepted.objective, event.payload.objective)
      state.accepted = accepted
      state.objective = structuredClone(event.payload.objective)
      state.revision = event.payload.revision
      state.revisedFields = []
      if (changed) startRuler(state, event.payload.revision)
      continue
    }
    if (state === undefined) continue
    switch (event.type) {
      case 'optimization.objective-revised': {
        state.objective = applyObjectiveRevisions(state.objective, [event.payload.changes])
        state.revision = event.payload.revision
        const revised = new Set([...state.revisedFields, ...Object.keys(event.payload.changes)])
        state.revisedFields = REVISABLE_FIELDS.filter((field) => revised.has(field))
        break
      }
      case 'optimization.baseline-measured': {
        if (event.payload.revision < state.rulerRevision) break
        const panel = state.objective.metric.kind === 'panel'
        const value = panel ? 0.5 : event.payload.median
        state.starting = { value, spread: event.payload.spread, head: event.payload.head }
        if (!panel) {
          state.current ??= value
          state.best = better(state.objective, state.best, value)
        }
        break
      }
      case 'optimization.noise-exceeded':
        // Advisory attention only: the starting value arrives with the
        // `baseline-measured` fact written after it.
        break
      case 'optimization.progress-measured':
        if (event.payload.revision < state.rulerRevision) break
        state.current = event.payload.winRate
        state.best = better(state.objective, state.best, event.payload.winRate)
        break
      case 'optimization.attempts-proposed':
        state.attempts.filed += event.payload.proposals.length
        state.emptyProposals = event.payload.proposals.length === 0 ? state.emptyProposals + 1 : 0
        for (const proposal of event.payload.proposals)
          if (!state.inFlight.some((attempt) => attempt.proposal === proposal.id))
            state.inFlight.push({ proposal: proposal.id, ticket: proposal.ticket })
        break
      case 'attempt.settled': {
        const { attempt, outcome, measurement } = event.payload
        const wasInFlight = state.inFlight.some((entry) => entry.proposal === attempt.proposal)
        state.inFlight = state.inFlight.filter((entry) => entry.proposal !== attempt.proposal)
        // Only a transfer out of `inFlight` adds a pending rejection, so
        // settlement never grows the two lists' combined length.
        if (
          outcome !== 'accepted' &&
          wasInFlight &&
          !state.rejections.some((entry) => entry.proposal === attempt.proposal)
        )
          state.rejections.push({
            proposal: attempt.proposal,
            ticket: structuredClone(attempt.ticket),
            ...(attempt.build !== undefined ? { build: attempt.build } : {}),
            outcome,
          })
        if (outcome === 'accepted') {
          state.attempts.accepted += 1
          state.plateau = 0
          if (
            state.objective.metric.kind === 'command' &&
            measurement !== undefined &&
            measurement.revision >= state.rulerRevision
          ) {
            state.current = measurement.candidate
            state.best = better(state.objective, state.best, measurement.candidate)
          }
          break
        }
        state.attempts.rejected += 1
        if (outcome === 'no-improvement' || outcome === 'declined') state.plateau += 1
        if (outcome === 'stopped') {
          state.stoppedTickets ??= []
          if (
            !state.stoppedTickets.some((ticket) => ticketKey(ticket) === ticketKey(attempt.ticket))
          )
            state.stoppedTickets.push(attempt.ticket)
        }
        break
      }
      case 'optimization.stopped':
        state.stopped ??= { ...event.payload, at: event.ts }
        break
      case 'attempt.ticket-rejected':
        state.rejections = state.rejections.filter(
          (entry) => entry.proposal !== event.payload.proposal,
        )
        break
    }
  }
  return state
}

/** The digest as a registered build-scoped value. BuildState embeds the same
 * fold; this registration lets the shape contract and incremental tests hold
 * it independently. */
export const optimizationReducer = defineReducer<
  { state?: OptimizationState },
  AbEvent,
  OptimizationState | null
>({
  version: 3,
  initial: () => ({}),
  fold(acc, events) {
    const state = advanceOptimization(acc.state, events)
    if (state !== undefined) acc.state = state
  },
  finish: (acc) => (acc.state === undefined ? null : structuredClone(acc.state)),
})

const HOUR_MS = 3_600_000

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

/** What the stop enforcer knows about one in-flight attempt's newest build. */
export interface OptimizationAttemptBuild {
  slug: string
  terminal?: 'done' | 'aborted'
  merged?: boolean
  /** The build's reduced state; read only for an unmerged build that is not
   * mid-abort, since abort cleanup ends in `build.completed {abandoned}`. */
  state?: Pick<
    BuildState,
    'status' | 'outcome' | 'currentPhase' | 'lastCompletedPhase' | 'pendingCommands'
  >
}

export interface OptimizationStopActions {
  /** Attempts to settle `stopped`, with the build that ran, if any. */
  settle: { attempt: InFlightAttempt; build?: string }[]
  /** Attempt builds to request an abort of. */
  abort: { slug: string; reason: string }[]
}

/**
 * What a stopped node does to its in-flight attempts (RFC 0005 §9.2). Both
 * modes cancel an attempt that never got a build or never started work; an
 * aborted build is left to abort cleanup for settlement. Abort mode aborts every running attempt;
 * drain mode lets a running one finish and face the landing gate. A done or
 * merged attempt is the landing gate's to settle.
 */
export function optimizationStopActions(
  node: { slug: string; stopped: NonNullable<OptimizationState['stopped']> },
  attempts: readonly { attempt: InFlightAttempt; build?: OptimizationAttemptBuild }[],
): OptimizationStopActions {
  const reason = `optimization node ${node.slug} stopped (${node.stopped.cause}, ${node.stopped.mode})`
  const actions: OptimizationStopActions = { settle: [], abort: [] }
  for (const { attempt, build } of attempts) {
    if (build === undefined) {
      actions.settle.push({ attempt })
      continue
    }
    // Abort cleanup alone settles builds, from the first request's origin.
    if (build.terminal === 'aborted' || build.state?.outcome === 'abandoned') continue
    if (build.terminal === 'done' || build.merged || build.state === undefined) continue
    const state = build.state
    if (state.status === 'done' || state.status === 'aborted') continue
    if (state.pendingCommands.some((command) => command.command === 'abort')) continue
    const started =
      state.status === 'running' ||
      state.currentPhase !== undefined ||
      state.lastCompletedPhase !== undefined
    if (node.stopped.mode === 'abort' || !started) actions.abort.push({ slug: build.slug, reason })
  }
  return actions
}

export interface OptimizationAdmission {
  stopped: boolean
  /** Attempts the budget still allows; null without an attempts budget. */
  attemptRoom: number | null
  /** Concurrency slots held neither by an in-flight attempt nor by a settled
   * attempt whose rejected-role move is pending. A tracker that keeps
   * refusing the move therefore stalls proposals instead of accumulating
   * pending rejections. */
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

function ticketKey(ref: TicketRef): string {
  const source = ref.source === 'database' ? 'hosted' : ref.source
  return `${source}\u0000${ref.id}`
}

/**
 * The in-flight attempt `ticket` is, when it is one. A build is an attempt of
 * a node exactly when its ticket was created from a recorded proposal of that
 * node; children filed any other way are not attempts. Settled attempts are
 * in the ledger. `key` lets a caller apply its ticket-migration identity.
 */
export function optimizationAttempt(
  state: OptimizationState | undefined,
  ticket: TicketRef,
  key: (ref: TicketRef) => string = ticketKey,
): InFlightAttempt | undefined {
  if (state === undefined) return undefined
  const wanted = key(ticket)
  return state.inFlight.find((attempt) => key(attempt.ticket) === wanted)
}

/** The pending rejection for `ticket`: a settled attempt whose ticket has not
 * yet moved to the rejected role. */
export function optimizationRejection(
  state: OptimizationState | undefined,
  ticket: TicketRef,
  key: (ref: TicketRef) => string = ticketKey,
): PendingRejection | undefined {
  if (state === undefined) return undefined
  const wanted = key(ticket)
  return state.rejections.find((entry) => key(entry.ticket) === wanted)
}

export interface LedgerEntry {
  seq: number
  proposal: string
  ticket: TicketRef
  build?: string
  title: string
  strategy: string
  outcome: AttemptOutcome
  delta?: number
  baseline?: number
  candidate?: number
  note?: string
  /** Improved by less than ε: a strategy worth knowing about. */
  nearMiss?: true
}

/** Improved, but by less than the ε then in effect. A relative ε is scaled by
 * the baseline's magnitude. */
export function isNearMiss(
  entry: Pick<LedgerEntry, 'outcome' | 'delta' | 'baseline'>,
  epsilon: ObjectiveEpsilon,
): boolean {
  if (entry.outcome !== 'no-improvement' || entry.delta === undefined || entry.delta <= 0)
    return false
  const threshold =
    epsilon.relative !== undefined
      ? epsilon.relative * Math.abs(entry.baseline ?? 0)
      : (epsilon.absolute ?? 0)
  return entry.delta < threshold
}

export interface OptimizationLedger {
  /** The ε in effect, for near-miss flags. */
  epsilon?: ObjectiveEpsilon
  /** Proposed attempts by proposal id, until they settle. */
  pending: Record<string, { title: string; strategy: string }>
  entries: LedgerEntry[]
}

/** The attempt ledger: one entry per `attempt.settled`, advanced from the
 * node's log alone. Its size grows with settled attempts, which `maxAttempts`
 * bounds; only an explicit history request (the proposer) reads it. */
export const optimizationLedgerReducer = defineReducer<
  OptimizationLedger,
  AbEvent,
  OptimizationLedger
>({
  version: 1,
  initial: () => ({ pending: {}, entries: [] }),
  fold(acc, events) {
    for (const event of events) {
      switch (event.type) {
        case 'optimization.objective-accepted':
          acc.epsilon = { ...event.payload.objective.target.epsilon }
          break
        case 'optimization.objective-revised':
          if (event.payload.changes.epsilon !== undefined)
            acc.epsilon = { ...event.payload.changes.epsilon }
          break
        case 'optimization.attempts-proposed':
          for (const proposal of event.payload.proposals)
            acc.pending[proposal.id] = { title: proposal.title, strategy: proposal.strategy }
          break
        case 'attempt.settled': {
          const { attempt, outcome, measurement, note } = event.payload
          const pending = acc.pending[attempt.proposal]
          delete acc.pending[attempt.proposal]
          const entry: LedgerEntry = {
            seq: event.seq,
            proposal: attempt.proposal,
            ticket: attempt.ticket,
            ...(attempt.build !== undefined ? { build: attempt.build } : {}),
            title: pending?.title ?? attempt.ticket.title ?? attempt.ticket.id,
            strategy: pending?.strategy ?? '',
            outcome,
            ...(measurement !== undefined
              ? {
                  delta: measurement.delta,
                  baseline: measurement.baseline,
                  candidate: measurement.candidate,
                }
              : {}),
            ...(note !== undefined ? { note } : {}),
          }
          if (acc.epsilon !== undefined && isNearMiss(entry, acc.epsilon)) entry.nearMiss = true
          acc.entries.push(entry)
          break
        }
      }
    }
  },
  finish: (acc) => structuredClone(acc),
})
