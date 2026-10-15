import type { RepositoryEvent, RepositoryEventPayload } from '../events/repository'
import { defineReducer } from './incremental'

export type TicketSourceDegradation = RepositoryEventPayload<'dispatcher.ticket-source-degraded'>
export const ticketSourceHealthReducer = defineReducer<
  { active?: TicketSourceDegradation },
  RepositoryEvent,
  TicketSourceDegradation | undefined
>({
  version: 1,
  initial: () => ({}),
  fold(acc, events) {
    for (const event of events) {
      if (event.type === 'dispatcher.ticket-source-degraded') acc.active = event.payload
      if (event.type === 'dispatcher.ticket-source-recovered') delete acc.active
    }
  },
  finish: (acc) => acc.active,
})
export function reduceTicketSourceHealth(
  events: readonly RepositoryEvent[],
): TicketSourceDegradation | undefined {
  return ticketSourceHealthReducer.reduce(events)
}
