/**
 * The consecutive setup-failure streak. Pure so the reducer registry can
 * register it without importing process code.
 */
import type { AbEvent } from '../events/catalog'
import { defineReducer } from './incremental'

/** Consecutive durable setup failures since the latest successful attachment
 * or explicit human answer. The accumulator keeps the boundary seq and the
 * failure seqs, so it is exact for any array order. */
export const setupStreakReducer = defineReducer<
  { escalations: string[]; boundary: number; failures: number[] },
  AbEvent,
  number
>({
  identity: 'setupStreak',
  initial: () => ({ escalations: [], boundary: 0, failures: [] }),
  fold(acc, events) {
    for (const event of events) {
      if (event.type === 'runner.attached') acc.boundary = event.seq
      else if (
        event.type === 'escalation.raised' &&
        event.payload.phase === 'setup' &&
        event.payload.source === 'policy'
      ) {
        if (!acc.escalations.includes(event.payload.id)) acc.escalations.push(event.payload.id)
      } else if (
        event.type === 'escalation.answered' &&
        acc.escalations.includes(event.payload.id)
      ) {
        acc.boundary = event.seq
      } else if (event.type === 'runner.setup-failed') {
        acc.failures.push(event.seq)
      }
    }
  },
  finish: (acc) => acc.failures.filter((seq) => seq > acc.boundary).length,
})
