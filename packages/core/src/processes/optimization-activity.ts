/**
 * The dispatcher's optimization activity pass (SPEC §13.1.1): copy attempt
 * execution facts into the node's active-hours clock, and settle a stopped
 * node's clock once.
 *
 * An unchanged tick reads nothing: which builds have new facts is decided
 * from the node's reduced state and the build digests the tick already
 * holds. A build whose digest `executionFacts` grew costs one served
 * `executionIntervals` value, which holds only unacknowledged execution
 * facts. A stop costs one such value per relevant build, once. No path ever
 * reads events.
 */
import { DISPATCHER } from '../events/envelope'
import type { EventWrite } from '../events/catalog'
import {
  chunkActivityBatch,
  optimizationActivityBatch,
  type ActivityBuildInput,
} from '../kernel/optimization'
import type { BuildState } from '../kernel/reducer'
import { BuildDigestCapabilityError } from '../store/digest'
import { readExecutionIntervals } from '../store/reduced-reads'
import type { BuildDigest, BuildRecord } from '../store/types'
import { newestAttemptBuild, type OptimizationStopDeps } from './optimization-stop'

/** Whether the node keeps an active-hours clock the pass still advances. */
function activityApplies(state: BuildState): boolean {
  const optimization = state.optimization
  return (
    state.kind === 'node' &&
    state.nodeOpened !== undefined &&
    optimization !== undefined &&
    optimization.clock.settled !== true &&
    state.status !== 'done' &&
    state.status !== 'aborted' &&
    state.prState !== 'merged' &&
    state.prState !== 'closed'
  )
}

/**
 * One tick of the activity pass for a node. `builds` is the repository's
 * unfiltered build listing. Returns whether the node's log was written; the
 * caller rereads its facts. Throws `BuildDigestCapabilityError` when an older
 * store's digest lacks `executionFacts`.
 */
export async function recordOptimizationActivity(
  deps: Pick<OptimizationStopDeps, 'store' | 'migrations' | 'ticketSource'>,
  record: BuildRecord,
  state: BuildState,
  builds: readonly { record: BuildRecord; digest: BuildDigest }[],
): Promise<boolean> {
  if (!activityApplies(state)) return false
  const optimization = state.optimization!
  const clock = optimization.clock
  // A stopped node settles; reading after the state that holds the stop, so
  // every fact at or before the stop is in what the reads return.
  const settling = clock.stoppedAt !== undefined
  const newest = new Set<string>()
  for (const attempt of optimization.inFlight) {
    const entry = newestAttemptBuild(deps, record.slug, attempt, builds)
    if (entry !== undefined) newest.add(entry.record.slug)
  }
  const relevant = [...new Set([...Object.keys(clock.builds), ...newest])].sort()
  if (relevant.length === 0 && !settling) return false
  const listing = new Map(builds.map((entry) => [entry.record.slug, entry.digest]))
  const inputs: ActivityBuildInput[] = []
  for (const build of relevant) {
    const digest = listing.get(build)
    const inFlightNewest = newest.has(build)
    if (digest === undefined) {
      inputs.push({ build, inFlightNewest, missing: true })
      continue
    }
    if (digest.executionFacts === undefined)
      throw new BuildDigestCapabilityError(build, 'execution')
    const input: ActivityBuildInput = {
      build,
      inFlightNewest,
      digestCount: digest.executionFacts,
      digestOpen: digest.executionOpen === true,
    }
    if (settling || digest.executionFacts > (clock.builds[build] ?? 0))
      input.value = (await readExecutionIntervals(deps.store, build)).value
    inputs.push(input)
  }
  const batch = optimizationActivityBatch(clock, inputs, optimization.openedAt)
  if (batch === undefined) return false
  let expected = state.lastSeq
  for (const payload of chunkActivityBatch(batch)) {
    const written = await deps.store.appendIfCurrent(record.slug, expected, {
      actor: DISPATCHER,
      type: 'optimization.activity-recorded',
      payload,
    } satisfies EventWrite<'optimization.activity-recorded'>)
    // A concurrent writer moved the node: the next tick starts over from
    // what the node then holds, and skips what it already accounted by `n`.
    if (written === null) return expected !== state.lastSeq
    expected = written.seq
  }
  // Advisory and after the node record only: a build's value drops facts
  // the node has durably accounted. A refusal leaves them for a later read.
  const values = new Map(inputs.map((input) => [input.build, input.value]))
  for (const [build, count] of Object.entries(batch.accounted)) {
    if (count < 1 || count <= (values.get(build)?.acknowledged ?? 0)) continue
    try {
      await deps.store.append(build, {
        actor: DISPATCHER,
        type: 'execution.accounted',
        payload: { count },
      } satisfies EventWrite<'execution.accounted'>)
    } catch {
      // A terminal or refused build keeps its facts; nobody reads them once
      // the node releases it.
    }
  }
  return true
}
