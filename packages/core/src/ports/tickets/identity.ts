import type { TicketRef } from '../../ontology'
import type { TicketSource } from '../types'

/** A per-operation comparison view. Durable references and proposal keys stay exact. */
export function ticketIdentity(source: TicketSource): (ref: TicketRef) => Promise<string> {
  const cache = new Map<string, Promise<string>>()
  return async (ref) => {
    if (ref.source !== source.name) return `${ref.source}:${ref.id}`
    let pending = cache.get(ref.id)
    if (!pending) {
      pending = source
        .get(ref.id)
        .then(
          (ticket) => `${ref.source}:${ticket?.ref.source === ref.source ? ticket.ref.id : ref.id}`,
        )
      cache.set(ref.id, pending)
    }
    return pending
  }
}
