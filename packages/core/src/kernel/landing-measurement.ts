/**
 * The measurement landing gate (SPEC §15.7, RFC 0005 §6.3, §6.4, §7.5): the
 * pure rules that decide whether a child of an optimization node may land.
 * The dispatcher only does the IO around these functions.
 *
 * A measurement applies only to the exact pair it measured: the child's
 * candidate head and the node head it would land on, under the node's
 * accepted harness pin and current ruler. A restack changes the candidate and
 * a sibling landing changes the node head, so either one makes a measurement
 * stale by construction. Verification is a separate fact and survives both.
 */
import type { AbEvent } from '../events/catalog'
import type { EventPayload, UnmeasuredMergeReason } from '../events/payloads'
import type { Objective } from '../objective'
import type { TicketRef } from '../ontology'
import type { OptimizationState } from './optimization'
import type { BuildState } from './reducer'
import { escalationsBeyondJanitor } from './janitor-failure'

export type MeasurementRequest = EventPayload<'attempt.measurement-requested'> & { seq: number }
export type MeasurementResult = EventPayload<'attempt.measured'> & { seq: number }

/** A child's landing measurement state, folded from its own log. Bounded: it
 * keeps only the latest request and the result answering it. */
export interface LandingMeasurementState {
  request?: MeasurementRequest
  /** The `attempt.measured` answering `request`; results for older requests
   * are history. */
  result?: MeasurementResult
  /** Requests whose baseline differed from the previous request's: how many
   * times the node head moved under this child before it landed. */
  overtakes: number
}

/** An attempt overtaken this many consecutive times holds the next turn. */
export const OVERTAKE_TURN_LIMIT = 3

/** Fold one child-log event into its landing measurement state. */
export function advanceLandingMeasurement(
  acc: LandingMeasurementState | undefined,
  event: AbEvent,
): LandingMeasurementState | undefined {
  if (event.type === 'attempt.measurement-requested') {
    const previous = acc?.request
    const overtaken = previous !== undefined && previous.baseline !== event.payload.baseline
    return {
      request: { ...structuredClone(event.payload), seq: event.seq },
      overtakes: (acc?.overtakes ?? 0) + (overtaken ? 1 : 0),
    }
  }
  if (event.type === 'attempt.measured') {
    if (acc?.request === undefined || acc.request.id !== event.payload.request) return acc
    return { ...acc, result: { ...structuredClone(event.payload), seq: event.seq } }
  }
  return acc
}

/** The ε in effect for one measurement: absolute, or relative to the
 * baseline median's magnitude. A panel accepts only an absolute ε. */
export function measurementThreshold(
  objective: Pick<Objective, 'target'>,
  measured: Pick<EventPayload<'attempt.measured'>, 'medians'>,
): number {
  const { epsilon } = objective.target
  return epsilon.relative !== undefined
    ? epsilon.relative * Math.abs(measured.medians?.baseline ?? 0)
    : (epsilon.absolute ?? 0)
}

export type LandingRule = 'improve' | 'non-regress'
export type LandingClass = 'land' | 'no-improvement' | 'regressed'

/**
 * Classify a measurement from its recorded delta and the effective ε. An
 * attempt must improve by at least ε; any other child must not make the
 * metric worse by more than ε. The recorded `decision` is informational.
 */
export function classifyLanding(
  objective: Pick<Objective, 'target'>,
  rule: LandingRule,
  measured: Pick<EventPayload<'attempt.measured'>, 'medians' | 'delta'>,
): LandingClass {
  const epsilon = measurementThreshold(objective, measured)
  if (rule === 'improve') return measured.delta >= epsilon ? 'land' : 'no-improvement'
  return measured.delta >= -epsilon ? 'land' : 'regressed'
}

/** Whether a measurement (requested or recorded) is for exactly this pair
 * under the node's current pin and ruler. */
function forPair(
  digest: Pick<OptimizationState, 'accepted' | 'rulerRevision'>,
  measured: Pick<MeasurementRequest, 'candidate' | 'baseline' | 'harnessPin' | 'revision'>,
  candidate: string,
  nodeHead: string,
): boolean {
  return (
    measured.candidate === candidate &&
    measured.baseline === nodeHead &&
    measured.harnessPin === digest.accepted.harnessPin &&
    measured.revision >= digest.rulerRevision
  )
}

/** Whether the child's recorded result applies to landing `candidate` on
 * `nodeHead` now. Freshness compares SHAs exactly. */
export function measurementApplies(
  digest: Pick<OptimizationState, 'accepted' | 'rulerRevision'>,
  lm: LandingMeasurementState | undefined,
  candidate: string | undefined,
  nodeHead: string | undefined,
): boolean {
  return (
    lm?.result !== undefined &&
    candidate !== undefined &&
    nodeHead !== undefined &&
    forPair(digest, lm.result, candidate, nodeHead)
  )
}

/** One open child of the node the turn rule considers. */
export interface TurnCandidate {
  slug: string
  ticket: TicketRef
  state: Pick<
    BuildState,
    'status' | 'prState' | 'openEscalations' | 'landingMeasurement' | 'pendingCommands'
  >
}

/**
 * The child holding the node's landing turn, or undefined. An in-flight
 * attempt overtaken `OVERTAKE_TURN_LIMIT` times holds it while it is open,
 * not paused or aborted, and has no open non-janitor escalation, so an
 * escalated holder never wedges the node. The first such attempt in
 * `inFlight` order wins.
 */
export function selectTurnHolder(
  digest: Pick<OptimizationState, 'inFlight'>,
  candidates: readonly TurnCandidate[],
  key: (ref: TicketRef) => string,
): string | undefined {
  for (const attempt of digest.inFlight) {
    const wanted = key(attempt.ticket)
    const holder = candidates.find(
      ({ ticket, state }) =>
        key(ticket) === wanted &&
        (state.landingMeasurement?.overtakes ?? 0) >= OVERTAKE_TURN_LIMIT &&
        state.status !== 'done' &&
        state.status !== 'aborted' &&
        state.status !== 'paused' &&
        state.prState !== 'merged' &&
        state.prState !== 'closed' &&
        !state.pendingCommands.some((command) => command.command === 'abort') &&
        escalationsBeyondJanitor(state).length === 0,
    )
    if (holder !== undefined) return holder.slug
  }
  return undefined
}

/** Whether the child is an attempt of the node, and whether it settled. */
export type AttemptStatus = 'in-flight' | 'settled' | 'none'

export interface LandingGateInput {
  digest: Pick<OptimizationState, 'accepted' | 'rulerRevision' | 'objective'>
  attempt: AttemptStatus
  lm: LandingMeasurementState | undefined
  candidate: string | undefined
  nodeHead: string | undefined
  /** The turn holder's slug, when one holds the turn. */
  turn?: string
  self: string
  /** The regression escalation raised for the current request was answered:
   * the operator asked for another measurement. */
  regressionAnswered?: boolean
}

export type LandingGateVerdict =
  /** Already settled: close without settling again. */
  | 'settled'
  /** Another child holds the turn. */
  | 'wait-turn'
  /** The candidate or node head is unknown. */
  | 'stale'
  /** Request a measurement of this pair. */
  | 'request'
  /** A request for this pair awaits its result. */
  | 'pending'
  | LandingClass

/** The gate's one verdict for a ready child of an optimization node. */
export function landingMeasurementGate(input: LandingGateInput): LandingGateVerdict {
  const { digest, lm, candidate, nodeHead } = input
  if (input.attempt === 'settled') return 'settled'
  if (input.turn !== undefined && input.turn !== input.self) return 'wait-turn'
  if (candidate === undefined || nodeHead === undefined) return 'stale'
  if (measurementApplies(digest, lm, candidate, nodeHead)) {
    const verdict = classifyLanding(
      digest.objective,
      input.attempt === 'in-flight' ? 'improve' : 'non-regress',
      lm!.result!,
    )
    return verdict === 'regressed' && input.regressionAnswered ? 'request' : verdict
  }
  if (lm?.request !== undefined && forPair(digest, lm.request, candidate, nodeHead))
    return 'pending'
  return 'request'
}

/** Whether a merged attempt's head was measured for landing on its node. */
export type MergedAttemptMeasurement =
  | { kind: 'measured'; result: MeasurementResult }
  | {
      kind: 'unmeasured'
      reason: Exclude<UnmeasuredMergeReason, 'unresolvable'>
      /** `stale-head`: the candidate the recorded result measured. */
      measuredCandidate?: string
    }

/**
 * Classify the landing measurement of an attempt that merged as `sha` into
 * `node` (SPEC §15.7). Only a result for exactly that head, answering a
 * request of that node, is a measurement the attempt may settle `accepted`
 * with; anything else is unmeasured, never inferred.
 */
export function mergedAttemptMeasurement(
  lm: LandingMeasurementState | undefined,
  node: string,
  sha: string,
): MergedAttemptMeasurement {
  const result = lm?.result
  if (lm?.request !== undefined && lm.request.node !== node)
    return { kind: 'unmeasured', reason: 'unrelated' }
  if (result === undefined) return { kind: 'unmeasured', reason: 'absent' }
  if (result.candidate !== sha)
    return { kind: 'unmeasured', reason: 'stale-head', measuredCandidate: result.candidate }
  return { kind: 'measured', result }
}

/** The numbers `attempt.settled` records for a measured settlement. A panel's
 * baseline is 0.5 by definition and its candidate is the win rate. */
export function settlementMeasurement(
  measured: Pick<EventPayload<'attempt.measured'>, 'revision' | 'medians' | 'winRate' | 'delta'>,
): NonNullable<EventPayload<'attempt.settled'>['measurement']> {
  return measured.medians !== undefined
    ? {
        revision: measured.revision,
        baseline: measured.medians.baseline,
        candidate: measured.medians.candidate,
        delta: measured.delta,
      }
    : {
        revision: measured.revision,
        baseline: 0.5,
        candidate: measured.winRate ?? 0.5,
        delta: measured.delta,
      }
}

/** The deterministic id of a regression escalation for one request. */
export function regressionEscalationId(request: string): string {
  return `landing-regressed-${request}`
}

/** The deterministic id of a harness-edit escalation for one candidate head. */
export function harnessEscalationId(candidate: string): string {
  return `landing-harness-${candidate}`
}
