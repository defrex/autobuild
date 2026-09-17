/**
 * The repository auto-merge default as a bulk action over in-flight builds.
 *
 * The durable `dispatcher.auto-merge-default-set` fact has always been the
 * claim-time seed; it now also fans out onto every current non-terminal build
 * of the repository, attributed to the operator who toggled it. The fan-out is
 * a dispatcher-tick reconciliation driven by the durable fact — never a
 * write-time walk — so a build claimed concurrently with the toggle and a
 * build observed by a second dispatcher polling the same repository converge
 * on the same state.
 *
 * Idempotency vs. per-build overrides: each answering command records the
 * repository `seq` of the default fact that caused it (`defaultSeq`). A tick
 * applies the default to a build only when the newest fact's seq is strictly
 * newer than the build's recorded `defaultSeq`. When the build's requested
 * state already matches the fact, the tick records a provenance-only
 * `build.auto-merge-default-observed` marker instead of appending a duplicate
 * command, so a later per-build toggle is not mistaken for staleness and
 * reverted. A global toggle therefore re-applies over a per-build choice, a
 * per-build toggle in between is stable, and pressing the toggle twice appends
 * no duplicate request.
 *
 * Eligibility is expressed against `BuildState`, not `effectiveStatus`
 * (dashboard/model.ts), whose contract is "DISPLAY-ONLY — nothing consults
 * this"; a durable write path must not become its first consumer — the same
 * precedent `bulk-control.ts` set for the pause/resume walk.
 */
import type { RepositoryEvent } from '../events/repository'
import { discardInFlight, type BuildState } from './reducer'

/** One `dispatcher.auto-merge-default-set` fact, resolved. `actor` is the
 * event's actor — the human who toggled, `via` marker included — and is the
 * attribution every fan-out command carries. */
export interface AutoMergeDefaultFact {
  enabled: boolean
  /** The repository event's seq — the fan-out's comparison marker. */
  seq: number
  actor: RepositoryEvent['actor']
}

/** The newest `dispatcher.auto-merge-default-set` fact in the repository
 * journal, or undefined when no default was ever set (the scan runs from the
 * tail because seqs are monotonic, so the first hit is the newest). With
 * `enabled`, the newest fact *matching that value* — the fact a claim-time
 * seed built on a stale pre-tick sample must cite, so a newer opposite fact
 * stays strictly newer than the seed's provenance and the next tick's
 * fan-out can reconcile it (f_b851c0e8). */
export function latestAutoMergeDefault(
  events: RepositoryEvent[],
  enabled?: boolean,
): AutoMergeDefaultFact | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (
      event?.type === 'dispatcher.auto-merge-default-set' &&
      (enabled === undefined || event.payload.enabled === enabled)
    ) {
      return { enabled: event.payload.enabled, seq: event.seq, actor: event.actor }
    }
  }
  return undefined
}

/**
 * A build the default may still act on: not terminal, and not on its way out.
 * A pending abort (an explicit request or an accepted escalation answer) must
 * never receive consent — a merge landing mid-abort is exactly the race this
 * clause exists to close. The same holds for an outstanding discard request:
 * `discardRequest` is present exactly while the build is non-terminal and its
 * discard is unsettled, and the reducer settles it only by terminal completion
 * — consent recorded inside that window can merge a build the operator already
 * asked to discard (in the raced-runner-attachment case the discard is inert
 * for a running build, and the recorded consent later drives the merge in
 * `checkPr`). Direction-blind like the abort clause: the build terminalizes
 * imminently either way. If discard ever grows a mid-flight settlement event,
 * this predicate must be revisited.
 */
export function autoMergeDefaultEligible(state: BuildState): boolean {
  if (state.status === 'done' || state.status === 'aborted') return false
  // An empty log is a record whose `build.created` has not landed yet (the
  // crash or one-await window between `createBuild` and the first append):
  // writing an auto-merge command ahead of the immutable facts would leave the
  // log unrecoverable — dispatch recovery rejects a log that does not start
  // with `build.created` (f_647d40be). `lastSeq === 0` is exactly that log.
  if (state.lastSeq === 0) return false
  // An outstanding discard request is the same "on its way out" shape as a
  // pending abort: it settles only by terminal completion (reducer.ts), so
  // consent recorded inside that window can merge a build the operator
  // already asked to discard. Direction-blind, like the abort clause — an
  // OFF fan-out skipping it withdraws nothing that survives the settlement.
  // Shared predicate: the per-build consent guard (build-control.ts) applies
  // the same exclusion to consent-recording writes. A per-build OFF withdrawal
  // stays available there — revocation only shrinks the merge set — which is a
  // stated, directional divergence, not a silent one.
  if (discardInFlight(state)) return false
  return !state.pendingCommands.some((command) => command.command === 'abort')
}

/** What one default fact asks of one build: a real command, a pure provenance
 * advance, or `undefined` for "nothing". */
export type AutoMergeDefaultTarget = 'request' | 'cancel' | 'observed'

/** What one default fact asks of one build, or undefined for "nothing".
 *
 * Seq-first: a build whose recorded provenance is already this fact (or newer)
 * has had its day in court — a per-build toggle made after the fan-out stands
 * until the default moves again. A build that sampled the default at claim time
 * carries the fact's seq too, so a fresh claim is not re-fanned on the next
 * tick.
 *
 * When the requested state already matches the fact, the fact still has to be
 * *recorded* as observed (`'observed'`) so the next tick does not mistake a
 * later per-build command for staleness: the marker advances `defaultSeq`
 * without a duplicate request/cancel (f_28b3fba1). */
export function autoMergeDefaultTarget(
  state: BuildState,
  fact: AutoMergeDefaultFact,
): AutoMergeDefaultTarget | undefined {
  if (!autoMergeDefaultEligible(state)) return undefined
  if ((state.autoMerge.defaultSeq ?? 0) >= fact.seq) return undefined
  if (state.autoMerge.requested === fact.enabled) return 'observed'
  return fact.enabled ? 'request' : 'cancel'
}
