import { readDispatcherRunFacts, readDispatchUpgrade } from '../store/reduced-reads'
import type { BuildStore } from '../store/types'

/** Pause between the successor's post-yield observations during the fast
 * window. Each observation is the two canonical reduced reads of
 * `observeSuccessorRelease`, which read zero event rows while nothing changed,
 * so a step costs the same at any journal length. */
export const RELEASE_OBSERVATION_FAST_MS = 25

/** Observations of one preflight that use the fast pause: at least six seconds
 * of sleep, which covers a drain-mode release with wide margin. Later
 * observations back off, so the fast observations per handoff are finite. */
export const RELEASE_OBSERVATION_FAST_LIMIT = 240

/** Steady pause after the backoff, for slow drains and for cutovers waiting on
 * the predecessor's stop: two observations per second until takeover, stop,
 * failure, abort or preflight's deadline. */
export const RELEASE_OBSERVATION_IDLE_MS = 500

/** Pause schedule of one preflight's release observation. Each call takes how
 * long the last observation took and returns the next pause: the fast pause
 * for the first `RELEASE_OBSERVATION_FAST_LIMIT` calls, then doubling to the
 * idle pause and staying there. A pause is never shorter than the last
 * observation, so a slow or struggling store is never queried back-to-back. */
export function releaseObservationCadence(): (lastObservationMs: number) => number {
  let calls = 0
  return (lastObservationMs) => {
    calls++
    const floor =
      Number.isFinite(lastObservationMs) && lastObservationMs > 0 ? lastObservationMs : 0
    const over = calls - RELEASE_OBSERVATION_FAST_LIMIT
    const scheduled =
      over <= 0
        ? RELEASE_OBSERVATION_FAST_MS
        : RELEASE_OBSERVATION_FAST_MS * 2 ** over >= RELEASE_OBSERVATION_IDLE_MS
          ? RELEASE_OBSERVATION_IDLE_MS
          : RELEASE_OBSERVATION_FAST_MS * 2 ** over
    return Math.max(scheduled, floor)
  }
}

/** One observation step: the predecessor run's durable upgrade state, then its
 * run facts, in that order. Exactly these reduced reads, no event rows while
 * nothing changed. The caller validates every fact itself. */
export async function observeSuccessorRelease(
  store: Pick<BuildStore, 'getReducerValue'>,
  repo: string,
  run: string,
) {
  const current = (await readDispatchUpgrade(store, repo)).value.runs[run]
  const facts = (await readDispatcherRunFacts(store, repo, run)).value
  return { current, facts }
}
