import type { AbEvent } from '../events/catalog'
import type { EventPayload } from '../events/payloads'
import type { BuildState } from './reducer'

/** Exact immutable inputs, retained independently of disposable execution. */
export interface IntegrationState {
  cycles?: (EventPayload<'integration.prepared'> & { seq: number })[]
  observation?: EventPayload<'integration.observed'>
  cycle?: EventPayload<'integration.prepared'> & { seq: number }
  intent?: EventPayload<'integration.landing-intended'>
  landing?: EventPayload<'integration.landed'>
  audit?: EventPayload<'integration.audited'>
}
export function advanceIntegration(state: IntegrationState, event: AbEvent): void {
  switch (event.type) {
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
export function integrationComplete(state: Pick<BuildState, 'integration'>): boolean {
  const observation = state.integration?.observation
  return (
    !!observation &&
    observation.openChildren.length === 0 &&
    observation.diagnostics.length === 0 &&
    observation.contributions.length > 0
  )
}
export function integrationCurrent(state: BuildState): boolean {
  const cycle = state.integration?.cycle
  return (
    !!cycle &&
    integrationComplete(state) &&
    !state.nodeRestack?.active &&
    state.nodeComparison?.headSha === cycle.head &&
    state.nodeComparison?.parentSha === cycle.parent &&
    (!state.nodeRestack?.observedParent || state.nodeRestack.observedParent.sha === cycle.parent) &&
    state.nodeRestack?.contributionBase === cycle.parent
  )
}

export function integrationConfig(config: import('../config/schema').Config): string {
  return JSON.stringify({ verify: config.verify, commands: config.commands })
}
export function integrationFailed(state: BuildState): boolean {
  const cycle = state.integration?.cycle
  return (
    !!cycle &&
    state.nodeComparison?.headSha === cycle.head &&
    state.nodeComparison?.parentSha === cycle.parent &&
    state.verify.results.some(
      (result) =>
        result.seq > cycle!.seq && result.restackId === cycle!.id && result.outcome === 'fail',
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
          result.seq > cycle!.seq &&
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

export function integrationNeedsRunner(state: BuildState): boolean {
  return (
    integrationCurrent(state) &&
    !integrationFailed(state) &&
    !integrationHeadVerified(state, state.integration!.cycle!.head)
  )
}
