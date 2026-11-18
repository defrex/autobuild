/**
 * The dispatcher's merged-attempt reconciliation (SPEC §15.7): an in-flight
 * attempt whose newest build already completed merged, but whose node log
 * records neither its settlement nor `attempt.merged-unmeasured`. The merged
 * path writes one of the two before the child completes, so only a child
 * merged before that path existed, or one whose write was lost, is ever a
 * candidate.
 *
 * Choosing candidates is a pure scan of the node's in-flight entries over the
 * build listing the tick already holds. Each candidate costs one reduced
 * `buildFacts` of its child and ends in a guarded write that removes it from
 * the candidate set, so a node with nothing to reconcile costs no read.
 */
import { markUnmeasuredMerge, settleAttempt } from '../kernel/attempt-settlement'
import { mergedAttemptMeasurement, settlementMeasurement } from '../kernel/landing-measurement'
import type { BuildState } from '../kernel/reducer'
import type { BuildDigest, BuildRecord } from '../store/types'
import {
  attemptTicketKey,
  newestAttemptBuild,
  type OptimizationStopDeps,
} from './optimization-stop'

/**
 * One tick of reconciliation for a node. A merged child whose head was
 * measured settles `accepted`, exactly as the merged path would have; any
 * other merged child is marked unmeasured, with `unresolvable` when it
 * recorded no merged head. Returns whether the node's log was written.
 */
export async function reconcileMergedAttempts(
  deps: Pick<OptimizationStopDeps, 'store' | 'migrations' | 'ticketSource'>,
  record: BuildRecord,
  state: BuildState,
  builds: readonly { record: BuildRecord; digest: BuildDigest }[],
): Promise<boolean> {
  const optimization = state.optimization
  if (
    state.kind !== 'node' ||
    optimization === undefined ||
    state.status === 'done' ||
    state.status === 'aborted' ||
    state.prState === 'merged' ||
    state.prState === 'closed'
  )
    return false
  const unmarked = optimization.inFlight.filter((attempt) => attempt.unmeasuredMerge === undefined)
  if (unmarked.length === 0) return false
  // A cheap pass first: only a done, merged build of an unmarked attempt's
  // ticket can make one a candidate.
  const key = attemptTicketKey(deps)
  const wanted = new Set(
    unmarked.flatMap((attempt) => {
      const wantedKey = key(attempt.ticket)
      return wantedKey === undefined ? [] : [wantedKey]
    }),
  )
  const any = builds.some(
    ({ record: build, digest }) =>
      digest.terminal === 'done' &&
      digest.merged !== undefined &&
      build.ticket !== undefined &&
      wanted.has(key(build.ticket, build.slug) ?? ''),
  )
  if (!any) return false
  let wrote = false
  for (const attempt of unmarked) {
    const entry = newestAttemptBuild(deps, record.slug, attempt, builds)
    // Before completion the merged path owns the child.
    if (entry?.digest.terminal !== 'done' || entry.digest.merged === undefined) continue
    const build = entry.record.slug
    const child = (await deps.store.buildFacts(build)).state
    const identity = { proposal: attempt.proposal, ticket: attempt.ticket }
    const sha = child.mergedSha
    if (sha === undefined) {
      if (
        await markUnmeasuredMerge(deps.store, record.slug, identity, {
          build,
          reason: 'unresolvable',
        })
      )
        wrote = true
      continue
    }
    const measured = mergedAttemptMeasurement(child.landingMeasurement, record.slug, sha)
    const written =
      measured.kind === 'measured'
        ? await settleAttempt(deps.store, record.slug, { ...identity, build }, 'accepted', {
            measurement: settlementMeasurement(measured.result),
          })
        : await markUnmeasuredMerge(deps.store, record.slug, identity, {
            build,
            sha,
            reason: measured.reason,
            ...(measured.measuredCandidate !== undefined
              ? { measuredCandidate: measured.measuredCandidate }
              : {}),
          })
    if (written) wrote = true
  }
  return wrote
}
