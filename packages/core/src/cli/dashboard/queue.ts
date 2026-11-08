import { ticketPriority, urgentFirst } from '../../ports/tickets/priority'
import type { Ticket } from '../../ports/types'

/** The word every frontend shows on an urgent queued ticket. */
export const URGENT_MARK = 'URGENT'

export interface QueuedTicket<T> {
  ticket: T
  urgent: boolean
}

/** Queued tickets in dispatch order — urgent first, then normal, each in the
 * source's order — each saying whether it is urgent. */
export function queuedTickets<T extends Pick<Ticket, 'priority'>>(
  tickets: readonly T[],
): QueuedTicket<T>[] {
  return urgentFirst(tickets).map((ticket) => ({
    ticket,
    urgent: ticketPriority(ticket) === 'urgent',
  }))
}
