import type { HandbackCause } from '../events/payloads'
import type { RepositoryEvent } from '../events/repository'
import type { TicketRef } from '../ontology'
import { defineReducer } from './incremental'

export interface OpenHandback {
  seq: number
  ticket: TicketRef
  cause: HandbackCause
}

/** Build hand-backs that have been reported and not yet settled, keyed
 * `build:<slug>`. The dispatcher consults it before reporting, so a report
 * whose acknowledgement was lost is never appended twice; settlement prunes
 * the entry, which bounds the value by in-flight hand-backs. */
export const ticketHandbacksReducer = defineReducer<
  Record<string, OpenHandback>,
  RepositoryEvent,
  Record<string, OpenHandback>
>({
  identity: 'ticketHandbacks',
  initial: () => ({}),
  fold(acc, events) {
    for (const event of events) {
      if (event.type === 'ticket.handed-back' && event.payload.build !== undefined)
        acc[handbackIdentity(event.payload.build)] = {
          seq: event.seq,
          ticket: event.payload.ticket,
          cause: event.payload.cause,
        }
      else if (event.type === 'ticket.handback-settled')
        delete acc[handbackIdentity(event.payload.build)]
    }
  },
  finish: (acc) => structuredClone(acc),
})

export function handbackIdentity(build: string): string {
  return `build:${build}`
}
