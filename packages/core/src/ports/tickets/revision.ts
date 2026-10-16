import { createHash } from 'node:crypto'
import type { Ticket, TicketMutation, TicketSource } from '../types'

/** Content versions intentionally return to the same value after an exact revert. */
export function ticketRevision(
  ticket: Pick<Ticket, 'title' | 'body' | 'labels' | 'state' | 'blockedBy'>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        ticket.title,
        ticket.body,
        [...new Set(ticket.labels)].sort(),
        ticket.state ?? null,
        [...new Set(ticket.blockedBy ?? [])].sort(),
      ]),
    )
    .digest('hex')
}

export class TicketRevisionConflict extends Error {
  constructor(
    readonly id: string,
    readonly expectedRevision: string,
    readonly currentRevision: string,
  ) {
    super(
      `ticket "${id}" changed: expected revision ${expectedRevision}, current revision ${currentRevision}`,
    )
    this.name = 'TicketRevisionConflict'
  }
}

export class TicketRevisionUnsupported extends Error {
  constructor(source: string) {
    super(`${source} ticket source does not support revision-checked writes`)
    this.name = 'TicketRevisionUnsupported'
  }
}

export function checkTicketRevision(ticket: Ticket, expected: string): void {
  if (!expected.trim()) throw new Error('expected revision must be nonblank')
  if (ticket.revision !== expected)
    throw new TicketRevisionConflict(ticket.ref.id, expected, ticket.revision)
}

export async function mutateTicketIfRevision(
  source: TicketSource,
  id: string,
  expected: string,
  mutation: TicketMutation,
): Promise<void> {
  if (!expected.trim()) throw new Error('expected revision must be nonblank')
  if (!source.mutateIfRevision) throw new TicketRevisionUnsupported(source.name)
  await source.mutateIfRevision(id, expected, mutation)
}
