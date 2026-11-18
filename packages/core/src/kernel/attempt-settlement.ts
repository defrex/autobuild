/**
 * Settle an optimization attempt exactly once (SPEC §15.7, RFC 0005 §7.2).
 * Whichever dispatcher path ends the attempt calls this: the merged path
 * (`accepted`), the landing gate (`no-improvement`), abort cleanup and a
 * human-closed PR (`aborted`). The node's digest is the guard: only an
 * attempt still in `optimization.inFlight` settles, and the write is
 * conditional on the node log not having moved since that read.
 */
import { DISPATCHER } from '../events/envelope'
import type { AttemptOutcome, EventPayload } from '../events/payloads'
import type { TicketRef } from '../ontology'
import { readBuildFacts } from '../store/reduced-reads'
import type { BuildStore } from '../store/types'

export interface SettledAttempt {
  proposal: string
  ticket: TicketRef
  build?: string
}

/** Append `attempt.settled` to `node` unless the attempt already settled.
 * Returns whether this call wrote it. */
export async function settleAttempt(
  store: Pick<BuildStore, 'getReducerValue' | 'appendIfCurrent'>,
  node: string,
  attempt: SettledAttempt,
  outcome: AttemptOutcome,
  measurement?: EventPayload<'attempt.settled'>['measurement'],
  note?: string,
): Promise<boolean> {
  while (true) {
    const state = (await readBuildFacts(store, node)).value.state
    if (!state.optimization?.inFlight.some((entry) => entry.proposal === attempt.proposal))
      return false
    const written = await store.appendIfCurrent(node, state.lastSeq, {
      actor: DISPATCHER,
      type: 'attempt.settled',
      payload: {
        attempt: {
          proposal: attempt.proposal,
          ticket: attempt.ticket,
          ...(attempt.build !== undefined ? { build: attempt.build } : {}),
        },
        outcome,
        ...(measurement !== undefined ? { measurement } : {}),
        ...(note !== undefined ? { note: note.slice(0, 4000) } : {}),
      },
    })
    if (written) return true
  }
}
