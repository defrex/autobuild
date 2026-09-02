import type { OperatorTicketDetail, OperatorTicketUpdateRequest } from 'autobuild/operator-api'
import type { Ticket } from 'autobuild/plugin-sdk'

export interface TicketDraft {
  title: string
  body: string
  labels: string[]
}

export function draftFromTicket(ticket: Ticket): TicketDraft {
  return { title: ticket.title, body: ticket.body, labels: [...ticket.labels] }
}

export function ticketUpdatePatch(
  ticket: Ticket,
  draft: TicketDraft,
): OperatorTicketUpdateRequest | null {
  const patch: OperatorTicketUpdateRequest = {
    ...(draft.title !== ticket.title ? { title: draft.title } : {}),
    ...(draft.body !== ticket.body ? { body: draft.body } : {}),
    ...(draft.labels.length !== ticket.labels.length ||
    draft.labels.some((label, index) => label !== ticket.labels[index])
      ? { labels: [...draft.labels] }
      : {}),
  }
  return Object.keys(patch).length > 0 ? patch : null
}

export function parseLabels(value: string): string[] {
  return value
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean)
}

export function ticketFilterQuery(filters: { state?: string; labels?: string[] }): string {
  const query = new URLSearchParams()
  if (filters.state !== undefined) query.set('state', filters.state)
  for (const label of filters.labels ?? []) query.append('label', label)
  return query.toString()
}

export function groupTickets(tickets: Ticket[]): Array<{ state: string; tickets: Ticket[] }> {
  const groups = new Map<string, Ticket[]>()
  for (const ticket of tickets) {
    const state = ticket.state ?? '(unknown)'
    const group = groups.get(state) ?? []
    group.push(ticket)
    groups.set(state, group)
  }
  return [...groups].map(([state, grouped]) => ({ state, tickets: grouped }))
}

/** Polled details replace clean drafts only; an operator's bytes always win while dirty. */
export function reconcileTicketDetail(
  current: OperatorTicketDetail | undefined,
  incoming: OperatorTicketDetail,
  dirty: boolean,
): OperatorTicketDetail {
  return dirty && current?.ticket.ref.id === incoming.ticket.ref.id ? current : incoming
}
