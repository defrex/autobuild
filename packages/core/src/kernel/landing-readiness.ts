import type { BuildState } from './reducer'
import { discardInFlight } from './reducer'
import type { LeafRestackState } from './leaf-restack-state'
import { integrationCurrent, integrationCycleVerified } from './integration-state'

/** The deterministic part of land's guard. Live completeness and CAS remain at the write boundary. */
export function landPreconditions(state: BuildState, restack: LeafRestackState): boolean {
  const decision = state.landing?.decision
  return (
    !!decision &&
    state.status !== 'paused' &&
    !state.currentPhase &&
    !state.openEscalations.length &&
    !state.pendingCommands.length &&
    state.prState === 'open' &&
    (state.kind === 'node' ? state.integration?.cycle?.head : state.pr?.headSha) ===
      decision.candidate.head &&
    !(
      state.kind !== 'node' &&
      restack.target &&
      restack.target.sha !== decision.candidate.parent
    ) &&
    !restack.active &&
    !state.nodeRestack?.active
  )
}

/** Read eligibility is deliberately stricter than a command's historical acceptance guard. */
export function landingReady(state: BuildState, restack: LeafRestackState): boolean {
  if (
    !landPreconditions(state, restack) ||
    state.status === 'queued' ||
    state.status === 'done' ||
    state.status === 'aborted' ||
    discardInFlight(state) ||
    state.nodeRestack?.parentRequest ||
    state.nodeRestack?.parentChange ||
    state.sessions.open.length > 0
  )
    return false
  const candidate = state.landing!.decision!.candidate
  if (state.kind === 'node')
    return (
      integrationCurrent(state) &&
      integrationCycleVerified(state) &&
      candidate.parent === state.integration!.cycle!.parent &&
      candidate.cycle === state.integration!.cycle!.id
    )
  if (
    state.finalizeCompletedSeq <= state.restartSince ||
    state.landing!.decision!.seq < state.verify.cycleSince ||
    state.verify.results.some(
      (result) => result.seq > state.verify.cycleSince && result.outcome === 'fail',
    )
  )
    return false
  return (
    candidate.cycle === String(state.finalizeCompletedSeq) &&
    candidate.parent === (restack.completed?.targetBase ?? restack.initialBase ?? '')
  )
}

export function awaitsConsent(state: BuildState, restack: LeafRestackState): boolean {
  if (!landingReady(state, restack)) return false
  if (state.landing?.command?.kind === 'hold') return true
  return state.landing?.decision?.mode === 'consent' && state.landing.command?.kind !== 'land'
}
