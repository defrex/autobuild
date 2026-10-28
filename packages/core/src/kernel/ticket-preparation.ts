import type { RepositoryEvent } from '../events/repository'
import type { TicketRef } from '../ontology'
import { defineReducer } from './incremental'

export interface TicketPreparation {
  attempt: string
  ticket: TicketRef
  readyState: string
  claimedState: string
  claimed: boolean
  slug?: string
  handback?: string
  stage?: string
  error?: string
  recoveryError?: string
  retryAt?: string
}
/** Completed attempts leave no historical entries in the canonical value. */
export const ticketPreparationReducer = defineReducer<
  Record<string, TicketPreparation>,
  RepositoryEvent,
  Record<string, TicketPreparation>
>({
  version: 1,
  initial: () => ({}),
  fold(acc, events) {
    for (const event of events) {
      if (event.type === 'ticket-preparation.intended') {
        acc[event.payload.attempt] = { ...event.payload, claimed: false }
        continue
      }
      if (!event.type.startsWith('ticket-preparation.')) continue
      if (!('attempt' in event.payload)) continue
      const held = acc[event.payload.attempt]
      if (!held) continue
      switch (event.type) {
        case 'ticket-preparation.claimed':
          held.claimed = true
          break
        case 'ticket-preparation.creation-selected':
          held.slug = event.payload.slug
          break
        case 'ticket-preparation.handback-selected':
          held.handback = event.payload.state
          break
        case 'ticket-preparation.failed':
          held.claimed = event.payload.claimed
          held.error ??= event.payload.error
          held.stage = event.payload.stage
          held.handback = event.payload.handback
          break
        case 'ticket-preparation.recovery-failed':
          held.claimed ||= event.payload.claimed ?? false
          if (event.payload.handback) held.handback = event.payload.handback
          if (event.payload.preparationError) held.error ??= event.payload.preparationError
          held.recoveryError = event.payload.error
          held.retryAt = event.payload.retryAt
          break
        case 'ticket-preparation.resolved':
          delete acc[event.payload.attempt]
          break
      }
    }
  },
  finish: (acc) => structuredClone(acc),
})
