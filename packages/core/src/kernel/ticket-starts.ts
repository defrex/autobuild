import type { RepositoryEvent, TicketStartOutcome, TicketStartPriority } from '../events/repository'
import type { TicketRef } from '../ontology'
import { defineReducer } from './incremental'

/** An operator's single-ticket start request the dispatcher has not settled. */
export interface PendingTicketStart {
  /** Seq of the `ticket.start-requested` event; settlement names it. */
  seq: number
  ts: string
  ticket: TicketRef
  /** The request's slot-admission tier; a re-request may change it. */
  priority: TicketStartPriority
  /** When a re-request last changed `priority`; omitted while unchanged. */
  prioritySetAt?: string
  by?: string
}

/** A settled or cancelled request, newest last. */
export interface SettledTicketStart {
  request: number
  ticket: TicketRef
  priority: TicketStartPriority
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
 * durable canonical identities of hosted active builds. A repeated request
 * for a pending key keeps the first request's seq and only updates its
 * priority when that differs, and a settle or cancel
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
        const existing = acc.pending[key]
        if (existing !== undefined) {
          if (existing.priority !== event.payload.priority) {
            existing.priority = event.payload.priority
            existing.prioritySetAt = event.ts
          }
          continue
        }
        acc.pending[key] = {
          seq: event.seq,
          ts: event.ts,
          ticket: event.payload.ticket,
          priority: event.payload.priority,
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
                priority: pending.priority,
                outcome: 'cancelled',
                at: event.ts,
                ...(event.actor.kind === 'human' ? { by: event.actor.user } : {}),
              }
            : {
                request: pending.seq,
                ticket: pending.ticket,
                priority: pending.priority,
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
