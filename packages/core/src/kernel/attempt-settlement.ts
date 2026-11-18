/**
 * Settle an optimization attempt exactly once (SPEC §15.7, RFC 0005 §7.2).
 * Whichever path ends the attempt calls this: the merged path (`accepted`),
 * the landing gate (`no-improvement`), decline settlement (`declined`),
 * abort cleanup and a human-closed PR (`aborted`), and an operator releasing
 * a merge no landing measurement covers (`merged-unmeasured`). The node's
 * digest is the guard: only an attempt still in `optimization.inFlight`
 * settles, and the write is conditional on the node log not having moved
 * since that read.
 */
import type { Actor } from '../events/envelope'
import { DISPATCHER } from '../events/envelope'
import type {
  AttemptOutcome,
  EventPayload,
  UnmeasuredMergeReason,
  UnmeasuredSettlementPolicy,
} from '../events/payloads'
import type { TicketRef } from '../ontology'
import { readBuildFacts } from '../store/reduced-reads'
import type { BuildStore } from '../store/types'
import type { BuildState } from './reducer'

export interface SettledAttempt {
  proposal: string
  ticket: TicketRef
  build?: string
  /** A declined or no-improvement attempt's published build branch, which
   * the node's rejection sweep deletes from the forge. */
  branch?: string
}

export interface SettlementOptions {
  measurement?: EventPayload<'attempt.settled'>['measurement']
  note?: string
  /** `merged-unmeasured` only. */
  policy?: UnmeasuredSettlementPolicy
  /** `merged-unmeasured` only: the merged head, when recorded. */
  mergedSha?: string
  /** Defaults to the dispatcher; an operator settlement names the human. */
  actor?: Actor
}

/** Append `attempt.settled` to `node` unless the attempt already settled.
 * Returns whether this call wrote it. */
export async function settleAttempt(
  store: Pick<BuildStore, 'getReducerValue' | 'appendIfCurrent'>,
  node: string,
  attempt: SettledAttempt,
  outcome: AttemptOutcome,
  options: SettlementOptions = {},
): Promise<boolean> {
  const { measurement, note, policy, mergedSha } = options
  while (true) {
    const state = (await readBuildFacts(store, node)).value.state
    if (!state.optimization?.inFlight.some((entry) => entry.proposal === attempt.proposal))
      return false
    const written = await store.appendIfCurrent(node, state.lastSeq, {
      actor: options.actor ?? DISPATCHER,
      type: 'attempt.settled',
      payload: {
        attempt: {
          proposal: attempt.proposal,
          ticket: attempt.ticket,
          ...(attempt.build !== undefined ? { build: attempt.build } : {}),
          ...(attempt.branch !== undefined ? { branch: attempt.branch } : {}),
        },
        outcome,
        ...(measurement !== undefined ? { measurement } : {}),
        ...(policy !== undefined ? { policy } : {}),
        ...(mergedSha !== undefined ? { mergedSha } : {}),
        ...(note !== undefined ? { note: note.slice(0, 4000) } : {}),
      },
    })
    if (written) return true
  }
}

export interface UnmeasuredMergeFact {
  build: string
  sha?: string
  reason: UnmeasuredMergeReason
  measuredCandidate?: string
}

/** Record on `node` that an in-flight attempt merged without a valid landing
 * measurement of its merged head, unless the attempt already settled or was
 * already marked. Returns whether this call wrote it. */
export async function markUnmeasuredMerge(
  store: Pick<BuildStore, 'getReducerValue' | 'appendIfCurrent'>,
  node: string,
  attempt: Pick<SettledAttempt, 'proposal' | 'ticket'>,
  merge: UnmeasuredMergeFact,
): Promise<boolean> {
  while (true) {
    const state = (await readBuildFacts(store, node)).value.state
    const entry = state.optimization?.inFlight.find((e) => e.proposal === attempt.proposal)
    if (entry === undefined || entry.unmeasuredMerge !== undefined) return false
    const written = await store.appendIfCurrent(node, state.lastSeq, {
      actor: DISPATCHER,
      type: 'attempt.merged-unmeasured',
      payload: {
        proposal: attempt.proposal,
        ticket: attempt.ticket,
        build: merge.build,
        ...(merge.sha !== undefined ? { sha: merge.sha } : {}),
        reason: merge.reason,
        ...(merge.measuredCandidate !== undefined
          ? { measuredCandidate: merge.measuredCandidate }
          : {}),
      },
    })
    if (written) return true
  }
}

/** Whether an attempt build ever put its branch on the forge: it completed an
 * implement round (whose `ab done` pushes) or opened a PR. A build that did
 * neither has no remote branch to delete. */
export function attemptBranchPublished(state: Pick<BuildState, 'implement' | 'pr'>): boolean {
  return state.implement?.commits !== undefined || state.pr !== undefined
}
