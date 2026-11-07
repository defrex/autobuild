import type { BuildState } from './reducer'
import { discardInFlight } from './reducer'
import type { LeafRestackState } from './leaf-restack-state'
import {
  integrationCurrent,
  integrationCycleVerified,
  integrationCycleCurrent,
} from './integration-state'

/** The deterministic part of land's guard. Live completeness and CAS remain at the write boundary. */
export function landPreconditions(state: BuildState, restack: LeafRestackState): boolean {
  return landRefusalReason(state, restack) === undefined
}

/** Why land's deterministic guard refuses, naming the first unmet clause, or
 * undefined when it passes. */
export function landRefusalReason(
  state: BuildState,
  restack: LeafRestackState,
): string | undefined {
  const decision = state.landing?.decision
  if (!decision) return 'no merge candidate has been decided yet'
  if (state.kind === 'node' && !integrationCycleCurrent(state))
    return "the node's integration cycle is not current"
  if (state.status === 'paused') return 'the build is paused'
  if (state.currentPhase) return `phase ${state.currentPhase} is still running`
  if (state.openEscalations.length) return 'the build has open escalations to answer'
  if (state.pendingCommands.length) return 'earlier controls are awaiting acknowledgement'
  if (state.prState !== 'open') return `the pull request is ${state.prState ?? 'not open'}`
  if (
    (state.kind === 'node' ? state.integration?.cycle?.head : state.pr?.headSha) !==
    decision.candidate.head
  )
    return "the merge candidate's head is stale"
  if (state.kind !== 'node' && restack.target && restack.target.sha !== decision.candidate.parent)
    return "the merge candidate's base is stale"
  if (restack.active || state.nodeRestack?.active) return 'a restack is in progress'
  return undefined
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
