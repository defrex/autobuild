/**
 * The pure reopen predicates (SPEC §15.7) over already-reduced `BuildState`.
 * They import types only, so client bundles (both dashboards' shared
 * projection) can use them without pulling Bun-only reducer modules in.
 */
import type { BuildState } from './reducer'

/** A recorded reopen whose spec the kernel has not published yet. */
export function reopenSpecPending(state: Pick<BuildState, 'reopen'>): boolean {
  return state.reopen?.spec !== undefined && state.reopen.specPublishedSeq === undefined
}

/** The restart the latest reopen opened by publishing its spec is the
 * current restart: no later spec revision superseded it. */
export function reopenRestart(state: Pick<BuildState, 'reopen' | 'restartSince'>): boolean {
  return (
    state.reopen?.specPublishedSeq !== undefined &&
    state.reopen.specPublishedSeq === state.restartSince
  )
}

/** Whether the latest reopen still governs the current spec: a feedback-only
 * reopen after the latest spec revision, or the reopen whose spec is the
 * current revision. A later escalation spec revision supersedes it. */
export function reopenCurrent(state: Pick<BuildState, 'reopen' | 'restartSince'>): boolean {
  const reopen = state.reopen
  if (reopen === undefined) return false
  return reopen.spec !== undefined ? reopenRestart(state) : reopen.seq > state.restartSince
}

/** A nonterminal leaf reopened since it last settled: it is re-running its
 * pipeline and is not awaiting merge. */
export function reopenUnsettled(
  state: Pick<BuildState, 'kind' | 'status' | 'reopen' | 'pipelineSettled'>,
): boolean {
  return (
    state.kind !== 'node' &&
    state.status !== 'done' &&
    state.status !== 'aborted' &&
    state.reopen !== undefined &&
    state.reopen.seq > (state.pipelineSettled ?? 0)
  )
}

/** An answered `revise-spec` escalation still waits for its revision: no
 * `spec.revised` has landed since the answer (§6.3). */
export function reviseSpecPending(
  state: Pick<BuildState, 'answeredEscalations' | 'restartSince'>,
): boolean {
  return state.answeredEscalations.some(
    (e) => e.resolution === 'revise-spec' && e.answeredSeq > state.restartSince,
  )
}

/** Where a reopen sends the leaf. */
export function reopenRoute(reopen: NonNullable<BuildState['reopen']>): 'implement' | 'plan' {
  return reopen.spec !== undefined ? 'plan' : 'implement'
}
