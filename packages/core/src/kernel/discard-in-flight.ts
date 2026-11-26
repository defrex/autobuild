import type { BuildState } from './reducer'

/** Whether the build carries an outstanding `discardRequest`. Present exactly
 * while the build is non-terminal and its discard is unsettled; the reducer
 * settles it only by terminal completion. This is the single predicate shared
 * by the auto-merge default fan-out (`autoMergeDefaultEligible`, AUT-418) and
 * the per-build consent guard (`controlBuild`'s `discard-pending` refusal), so
 * the two controls' discard exclusions cannot diverge silently. Kept apart from
 * the build reducer so repository reducers can share it without loading that
 * reducer. */
export function discardInFlight(state: Pick<BuildState, 'discardRequest'>): boolean {
  return state.discardRequest !== undefined
}
