/**
 * One build's execution facts that an optimization node has not yet
 * acknowledged (SPEC §13.1.1): the input the dispatcher copies into a node's
 * active-hours clock. A served reduced value, advanced incrementally and
 * holding only execution facts, so reading it never costs a read of the
 * build's log, however long it grows.
 *
 * Complete by construction: every fact numbered above `acknowledged` is in
 * `facts`, and the dispatcher acknowledges a count only after the node has
 * recorded it. There is no window and no truncation.
 */
import type { AbEvent } from '../events/catalog'
import { defineReducer } from './incremental'

/** One `execution.started` or `execution.ended`, numbered from 1 in log order. */
export interface ExecutionFact {
  n: number
  kind: 'started' | 'ended'
  instance: string
  /** The fact's envelope timestamp. */
  at: string
}

export interface ExecutionIntervalsValue {
  /** Every execution fact on the build. */
  count: number
  /** The highest count a node has acknowledged with `execution.accounted`. */
  acknowledged: number
  /** The facts numbered above `acknowledged`, in log order. */
  facts: ExecutionFact[]
}

export const executionIntervalsReducer = defineReducer<
  ExecutionIntervalsValue,
  AbEvent,
  ExecutionIntervalsValue
>({
  identity: 'executionIntervals',
  initial: () => ({ count: 0, acknowledged: 0, facts: [] }),
  fold(acc, events) {
    for (const event of events) {
      if (event.type === 'execution.started' || event.type === 'execution.ended') {
        acc.count += 1
        acc.facts.push({
          n: acc.count,
          kind: event.type === 'execution.started' ? 'started' : 'ended',
          instance: event.payload.instance,
          at: event.ts,
        })
      } else if (event.type === 'execution.accounted') {
        // Folded as a maximum, so a repeated acknowledgment is a no-op; never
        // above the facts this build has, so a later fact is always kept.
        const acknowledged = Math.min(acc.count, Math.max(acc.acknowledged, event.payload.count))
        if (acknowledged === acc.acknowledged) continue
        acc.acknowledged = acknowledged
        acc.facts = acc.facts.filter((fact) => fact.n > acknowledged)
      }
    }
  },
  finish: (acc) => structuredClone(acc),
})
