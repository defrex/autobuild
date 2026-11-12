import { z } from 'zod'
import type { TicketsConfig } from '../../config/schema'
import type { TicketSource } from '../types'

/** GitHub's documented maximum assignees per issue. */
export const MAX_TICKET_ASSIGNEES = 10

export const ticketAssigneesSchema = z
  .array(
    z
      .string()
      .refine((value) => value.trim().length > 0, 'assignee must not be blank')
      .refine((value) => value === value.trim(), 'assignee must not have surrounding whitespace'),
  )
  .max(MAX_TICKET_ASSIGNEES, `at most ${MAX_TICKET_ASSIGNEES} assignees`)

/** A write naming assignees reached a source that cannot store them. */
export class TicketAssigneesUnsupported extends Error {
  constructor(readonly source: string) {
    super(`${source} ticket source cannot store assignees; nothing was written`)
    this.name = 'TicketAssigneesUnsupported'
  }
}

/** Refuse before any write: a present `assignees` (including `[]`) needs the capability. */
export function refuseUnsupportedAssignees(
  source: Pick<TicketSource, 'name' | 'assignees'>,
  patch: { assignees?: unknown },
): void {
  if (patch.assignees !== undefined && !source.assignees)
    throw new TicketAssigneesUnsupported(source.name)
}

/** Parse a CLI comma list such as `alice,me`; an empty value yields `[]`. */
export function parseAssigneesFlag(value: string, flag = '--assignees'): string[] {
  const entries = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  const result = ticketAssigneesSchema.safeParse(entries)
  if (!result.success)
    throw new Error(`${flag}: ${result.error.issues.map((issue) => issue.message).join('; ')}`)
  return result.data
}

/** The assignees a create sends: explicit ones replace the configured
 * `[tickets].createAssignee` default; undefined sends none. */
export function creationAssignees(
  tickets: Pick<TicketsConfig, 'createAssignee'>,
  explicit?: string[],
): string[] | undefined {
  if (explicit !== undefined) return explicit
  return tickets.createAssignee !== undefined ? [tickets.createAssignee] : undefined
}
