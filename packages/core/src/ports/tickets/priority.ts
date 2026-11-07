import { z } from 'zod'
import type { Ticket, TicketPriority, TicketSource } from '../types'

export type { TicketPriority } from '../types'

export const ticketPrioritySchema = z.enum(['urgent', 'normal'])

/** A write naming `urgent` reached a source that cannot store priority. */
export class TicketPriorityUnsupported extends Error {
  constructor(readonly source: string) {
    super(`${source} ticket source cannot store ticket priority; nothing was written`)
    this.name = 'TicketPriorityUnsupported'
  }
}

/** Refuse before any write: only `urgent` needs the capability; `normal` is the
 * value every source already holds. */
export function refuseUnsupportedPriority(
  source: Pick<TicketSource, 'name' | 'priority'>,
  patch: { priority?: unknown },
): void {
  if (patch.priority === 'urgent' && !source.priority)
    throw new TicketPriorityUnsupported(source.name)
}

/** Refuse `urgent`, then drop a `normal` no-op for a source without the
 * capability so its write (and wire) never names priority. */
export function withoutUnsupportedPriority<T extends { priority?: unknown }>(
  source: Pick<TicketSource, 'name' | 'priority'>,
  patch: T,
): T {
  refuseUnsupportedPriority(source, patch)
  if (source.priority || !('priority' in patch)) return patch
  const { priority: _priority, ...rest } = patch
  return rest as T
}

/** Absent and anything but `urgent` read as normal. */
export function ticketPriority(ticket: Pick<Ticket, 'priority'>): TicketPriority {
  return ticket.priority === 'urgent' ? 'urgent' : 'normal'
}

/** Stable partition: urgent candidates first, then the rest, each in input order. */
export function urgentFirst<T extends Pick<Ticket, 'priority'>>(tickets: readonly T[]): T[] {
  const urgent: T[] = []
  const normal: T[] = []
  for (const ticket of tickets) (ticket.priority === 'urgent' ? urgent : normal).push(ticket)
  return [...urgent, ...normal]
}

export function parsePriorityFlag(value: string, flag = '--priority'): TicketPriority {
  const result = ticketPrioritySchema.safeParse(value.trim())
  if (!result.success) throw new Error(`${flag}: expected urgent or normal, got "${value}"`)
  return result.data
}
