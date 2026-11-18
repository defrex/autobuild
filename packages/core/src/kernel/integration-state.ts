import type { AbEvent } from '../events/catalog'
import type { EventPayload } from '../events/payloads'
import type { BuildState } from './reducer'

/** Exact immutable inputs, retained independently of disposable execution. */
export interface IntegrationState {
  cycles?: (EventPayload<'integration.prepared'> & { seq: number })[]
  failures?: (EventPayload<'integration.verification-failed'> & { seq: number })[]
  observation?: EventPayload<'integration.observed'>
  cycle?: EventPayload<'integration.prepared'> & { seq: number }
  intent?: EventPayload<'integration.landing-intended'>
  landing?: EventPayload<'integration.landed'>
  audit?: EventPayload<'integration.audited'>
}
export function advanceIntegration(state: IntegrationState, event: AbEvent): void {
  switch (event.type) {
    case 'integration.verification-failed':
      state.failures ??= []
      state.failures.push({ ...event.payload, seq: event.seq })
      break
    case 'integration.observed':
      state.observation = event.payload
      break
    case 'integration.prepared':
      state.cycle = { ...event.payload, seq: event.seq }
      state.cycles ??= []
      state.cycles.push(state.cycle)
      break
    case 'integration.abandoned':
      if (state.intent?.id === event.payload.id) delete state.intent
      break
    case 'integration.landing-intended':
      state.intent = event.payload
      break
    case 'integration.landed':
      state.landing = event.payload
      break
    case 'integration.audited':
      state.audit = event.payload
      break
  }
}
/** Why an optimization node is not yet complete; undefined for a plain node
 * and for an optimization node that has stopped with nothing in flight. The
 * existing child-enumeration rule applies on top. It lives here, free of the
 * reducer machinery, because browser dashboard bundles import this module. */
export function optimizationCompletionBlocker(
  state: Pick<BuildState, 'optimization'>,
): string | undefined {
  const optimization = state.optimization
  if (optimization === undefined) return undefined
  if (optimization.stopped === undefined) return 'the optimization node has not stopped'
  const unmeasured = optimization.inFlight.filter((attempt) => attempt.unmeasuredMerge)
  const running = optimization.inFlight.filter((attempt) => !attempt.unmeasuredMerge)
  const reasons = [
    ...(running.length > 0
      ? [`attempts still in flight: ${running.map((attempt) => attempt.ticket.id).join(', ')}`]
      : []),
    ...(unmeasured.length > 0
      ? [
          `merged without a landing measurement, awaiting operator settlement: ${unmeasured.map((attempt) => attempt.ticket.id).join(', ')}`,
        ]
      : []),
  ]
  return reasons.length > 0 ? reasons.join('; ') : undefined
}

/** The node's children are all resolved and contributed, and an
 * optimization node has also stopped with no attempt in flight. */
export function integrationComplete(
  state: Pick<BuildState, 'integration' | 'optimization'>,
): boolean {
  const observation = state.integration?.observation
  return (
    optimizationCompletionBlocker(state) === undefined &&
    !!observation &&
    observation.openChildren.length === 0 &&
    observation.diagnostics.length === 0 &&
    observation.contributions.length > 0
  )
}
type CycleState = Pick<
  BuildState,
  'integration' | 'restartSince' | 'nodeComparison' | 'verify' | 'verifyStage'
>

/** A spec revision invalidates execution eligibility, never historical receipts. */
export function integrationCycleCurrent(
  state: Pick<CycleState, 'integration' | 'restartSince'>,
): boolean {
  return !!state.integration?.cycle && state.integration.cycle.seq > state.restartSince
}

export function integrationCurrent(state: BuildState): boolean {
  const cycle = state.integration?.cycle
  return (
    integrationCycleCurrent(state) &&
    integrationComplete(state) &&
    !state.nodeRestack?.parentRequest &&
    !state.nodeRestack?.parentChange &&
    !state.nodeRestack?.active &&
    state.nodeComparison?.headSha === cycle!.head &&
    state.nodeComparison?.parentSha === cycle!.parent &&
    (!state.nodeRestack?.observedParent ||
      state.nodeRestack.observedParent.sha === cycle!.parent) &&
    state.nodeRestack?.contributionBase === cycle!.parent
  )
}

export function integrationConfig(config: import('../config/schema').Config): string {
  return JSON.stringify({ verify: config.verify, commands: config.commands })
}
function usesVerifyStages(config: string): boolean {
  try {
    return Array.isArray(JSON.parse(config).verify?.stages)
  } catch {
    return false
  }
}
export function integrationFailed(state: CycleState): boolean {
  const cycle = state.integration?.cycle
  return (
    integrationCycleCurrent(state) &&
    state.nodeComparison?.headSha === cycle!.head &&
    state.nodeComparison?.parentSha === cycle!.parent &&
    (!usesVerifyStages(cycle!.config) ||
      state.verifyStage.failures.some(
        (f) => f.restackId === cycle!.id && f.cycle === cycle!.seq,
      )) &&
    state.verify.results.some(
      (result) =>
        result.seq > Math.max(cycle!.seq, state.verify.cycleSince) &&
        result.restackId === cycle!.id &&
        result.outcome === 'fail',
    )
  )
}
export function integrationVerified(
  state: BuildState,
  config: import('../config/schema').Config,
): boolean {
  const cycle = state.integration?.cycle
  return (
    integrationCurrent(state) &&
    cycle!.config === integrationConfig(config) &&
    !integrationFailed(state) &&
    config.verify.steps.every((step) =>
      state.verify.results.some(
        (result) =>
          result.seq > Math.max(cycle!.seq, state.verify.cycleSince) &&
          result.restackId === cycle!.id &&
          result.headSha === cycle!.head &&
          result.baseSha === cycle!.parent &&
          result.step === step &&
          (result.outcome === 'pass' || result.outcome === 'skipped'),
      ),
    )
  )
}

export function integrationHeadVerified(state: BuildState, head: string): boolean {
  const cycles =
    state.integration?.cycles ?? (state.integration?.cycle ? [state.integration.cycle] : [])
  return cycles.some((cycle) => {
    if (cycle.head !== head) return false
    const selected = JSON.parse(cycle.config) as { verify: { steps: string[] } }
    const receipts = state.verify.results.filter(
      (result) =>
        result.restackId === cycle.id && result.headSha === head && result.baseSha === cycle.parent,
    )
    return (
      !receipts.some((result) => result.outcome === 'fail') &&
      selected.verify.steps.every((step) =>
        receipts.some(
          (result) =>
            result.step === step && (result.outcome === 'pass' || result.outcome === 'skipped'),
        ),
      )
    )
  })
}

/** Eligibility belongs to the current cycle. Historical same-head evidence
 * remains available to landing audits, but cannot authorize a new parent. */
export function integrationCycleVerified(state: BuildState): boolean {
  const cycle = state.integration?.cycle
  if (!cycle || !integrationCycleCurrent(state)) return false
  return integrationHeadVerified(
    {
      ...state,
      verify: {
        ...state.verify,
        results: state.verify.results.filter(
          (result) => result.seq > Math.max(cycle.seq, state.verify.cycleSince),
        ),
      },
      integration: { ...state.integration, cycles: [cycle] },
    },
    cycle.head,
  )
}

/** Durable facts that rule out preparing or admitting integration verification. */
export function integrationAdmissible(state: BuildState): boolean {
  return !(
    state.targetRewrite ||
    state.status === 'paused' ||
    state.status === 'done' ||
    state.status === 'aborted' ||
    state.pendingCommands.length ||
    state.openEscalations.length ||
    state.prState === 'merged' ||
    state.prState === 'closed' ||
    state.integration?.intent ||
    state.nodeRestack?.parentRequest ||
    state.nodeRestack?.parentChange
  )
}

export function integrationNeedsRunner(state: BuildState): boolean {
  return integrationCurrent(state) && !integrationFailed(state) && !integrationCycleVerified(state)
}

/** Only the current failed cycle can still require a repair child. */
export function missingIntegrationFailures(
  state: BuildState,
  slug: string,
): EventPayload<'integration.verification-failed'>[] {
  if (
    state.kind !== 'node' ||
    state.status === 'done' ||
    state.status === 'aborted' ||
    !integrationCycleCurrent(state)
  )
    return []
  const cycle = state.integration?.cycle
  if (
    !cycle ||
    state.nodeComparison?.headSha !== cycle.head ||
    state.nodeComparison?.parentSha !== cycle.parent
  )
    return []
  if (state.integration?.failures?.some((failure) => failure.id === cycle.id)) return []
  if (
    usesVerifyStages(cycle.config) &&
    !state.verifyStage.failures.some((f) => f.cycle === cycle.seq && f.restackId === cycle.id)
  )
    return []
  const steps = [
    ...new Set(
      state.verify.results
        .filter(
          (result) =>
            result.seq > cycle.seq &&
            result.restackId === cycle.id &&
            result.headSha === cycle.head &&
            result.baseSha === cycle.parent &&
            result.outcome === 'fail',
        )
        .map((result) => result.step),
    ),
  ]
  return steps.length
    ? [
        {
          id: cycle.id,
          head: cycle.head,
          parent: cycle.parent,
          steps,
          guidance: `file a repair child targeting this node: ${slug}`,
        },
      ]
    : []
}
