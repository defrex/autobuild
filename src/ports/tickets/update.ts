import { z } from 'zod'
import { expandIssues } from '../../zod-issues'
import type { TicketUpdate } from '../types'

const ticketUpdateSchema = z
  .strictObject({
    title: z
      .string()
      .refine((value) => value.trim().length > 0, 'title must not be blank')
      .optional(),
    body: z
      .string()
      .refine((value) => value.trim().length > 0, 'body must not be blank')
      .optional(),
    labels: z.array(z.string()).optional(),
  })
  .refine(
    (patch) => patch.title !== undefined || patch.body !== undefined || patch.labels !== undefined,
    'update must name at least one of title, body, or labels',
  )

/** Render ticket-update issues while retaining nested union branch detail. */
export function renderTicketUpdateIssues(issues: readonly z.core.$ZodIssue[]): string {
  return expandIssues(issues)
    .map((issue) => {
      const path = issue.path.join('.')
      return path === '' ? issue.message : `${path}: ${issue.message}`
    })
    .join('; ')
}

/**
 * Validate the common partial-update contract before an adapter performs any
 * write. Keeping this at the port boundary (rather than only in the CLI)
 * gives direct callers and every provider identical required-field and strict
 * key semantics.
 */
export function validateTicketUpdate(patch: TicketUpdate): TicketUpdate {
  const result = ticketUpdateSchema.safeParse(patch)
  if (!result.success) {
    throw new Error(`invalid ticket update — ${renderTicketUpdateIssues(result.error.issues)}`)
  }

  // Reconstruct the patch so arrays cannot be mutated behind an adapter's
  // back and explicit `undefined` never masquerades as a named field.
  return {
    ...(result.data.title !== undefined ? { title: result.data.title } : {}),
    ...(result.data.body !== undefined ? { body: result.data.body } : {}),
    ...(result.data.labels !== undefined ? { labels: [...result.data.labels] } : {}),
  }
}
