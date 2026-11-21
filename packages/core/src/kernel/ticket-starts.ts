import type { RepositoryEvent, TicketStartOutcome } from '../events/repository'
import type { TicketRef } from '../ontology'
import { defineReducer } from './incremental'

/** An operator's single-ticket start request the dispatcher has not settled. */
export interface PendingTicketStart {
  /** Seq of the `ticket.start-requested` event; settlement names it. */
  seq: number
  ts: string
  ticket: TicketRef
  by?: string
}

/** A settled or cancelled request, newest last. */
export interface SettledTicketStart {
  request: number
  ticket: TicketRef
  outcome: TicketStartOutcome | 'cancelled'
  slug?: string
  detail?: string
  at: string
  by?: string
}

/** Canonical identity of one hosted build's recorded ticket ref. */
export interface RecordedTicketIdentity {
  recorded: string
  canonical: string
}

export interface TicketStarts {
  /** Keyed by `ticketStartKey` of the canonical ref. */
  pending: Record<string, PendingTicketStart>
  recent: SettledTicketStart[]
  /** Keyed by build slug; removed only when a writer releases the build. */
  identities: Record<string, RecordedTicketIdentity>
}

export const TICKET_START_RECENT_LIMIT = 8

export function ticketStartKey(ref: TicketRef): string {
  return `${ref.source}:${ref.id}`
}

/** Pending operator start requests, the most recent settlements, and the
 * durable canonical identities of hosted active builds. A duplicate request
 * for a pending key is ignored (the first wins), and a settle or cancel
 * applies only to the pending request it names, so a stale one never closes
 * a newer request. Bounded by pending requests, the recent cap, and builds
 * not yet released. */
export const ticketStartsReducer = defineReducer<TicketStarts, RepositoryEvent, TicketStarts>({
  identity: 'ticketStarts',
  initial: () => ({ pending: {}, recent: [], identities: {} }),
  fold(acc, events) {
    const settle = (entry: SettledTicketStart) => {
      acc.recent.push(entry)
      if (acc.recent.length > TICKET_START_RECENT_LIMIT)
        acc.recent.splice(0, acc.recent.length - TICKET_START_RECENT_LIMIT)
    }
    for (const event of events) {
      if (event.type === 'ticket.start-requested') {
        const key = ticketStartKey(event.payload.ticket)
        if (acc.pending[key] !== undefined) continue
        acc.pending[key] = {
          seq: event.seq,
          ts: event.ts,
          ticket: event.payload.ticket,
          ...(event.actor.kind === 'human' ? { by: event.actor.user } : {}),
        }
      } else if (event.type === 'ticket.start-cancelled' || event.type === 'ticket.start-settled') {
        const key = ticketStartKey(event.payload.ticket)
        const pending = acc.pending[key]
        if (pending?.seq !== event.payload.request) continue
        delete acc.pending[key]
        settle(
          event.type === 'ticket.start-cancelled'
            ? {
                request: pending.seq,
                ticket: pending.ticket,
                outcome: 'cancelled',
                at: event.ts,
                ...(event.actor.kind === 'human' ? { by: event.actor.user } : {}),
              }
            : {
                request: pending.seq,
                ticket: pending.ticket,
                outcome: event.payload.outcome,
                ...(event.payload.slug !== undefined ? { slug: event.payload.slug } : {}),
                ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
                at: event.ts,
                ...(pending.by !== undefined ? { by: pending.by } : {}),
              },
        )
      } else if (event.type === 'ticket.identity-recorded') {
        for (const slug of event.payload.released ?? []) delete acc.identities[slug]
        for (const { build, recorded, canonical } of event.payload.identities)
          acc.identities[build] = { recorded, canonical }
      }
    }
  },
  finish: (acc) => structuredClone(acc),
})
