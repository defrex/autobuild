import { z } from 'zod'
import { ticketRefSchema } from '../../ontology'

/** Explicit opt-in: released clients through 0.12 use strict decoders without revisions.
 * Source checkouts can share their release version, so version alone is insufficient. */
export const TICKET_REVISIONS_HEADER = 'x-autobuild-ticket-revisions'
export const TICKET_REVISIONS_CAPABILITY = '1'

/** Repository-owned policy sent with every hosted ticket operation. */
export const hostedTicketContextSchema = z.strictObject({
  teamKey: z.string().min(1),
  repo: z.string().min(1).optional(),
  claimedState: z.string().min(1).optional(),
  createState: z.string().min(1).optional(),
})
export type HostedTicketContext = z.infer<typeof hostedTicketContextSchema>

export const TICKET_COMMENTS_HEADER = 'x-autobuild-ticket-comments'
export const TICKET_COMMENTS_CAPABILITY = '1'

export const ticketCommentWireSchema = z.strictObject({
  body: z.string(),
  createdAt: z.string(),
  author: z.string().optional(),
})

export const ticketWireSchema = z.strictObject({
  revision: z.string().min(1),
  ref: ticketRefSchema,
  comments: z.array(ticketCommentWireSchema).optional(),
  creationKey: z.string().optional(),
  title: z.string(),
  body: z.string(),
  state: z.string().optional(),
  resolved: z.boolean(),
  labels: z.array(z.string()),
  blockersResolved: z.boolean().optional(),
  blockedBy: z.array(z.string()).optional(),
})
export const ticketListingWireSchema = z.strictObject({
  tickets: z.array(ticketWireSchema),
  diagnostics: z.array(z.string()),
})
export const dependencyStateWireSchema = z.strictObject({
  id: z.string(),
  exists: z.boolean(),
  resolved: z.boolean(),
  blockedBy: z.array(z.string()),
})
export const dependencyStatesWireSchema = z.array(dependencyStateWireSchema)
export const successWireSchema = z.strictObject({ ok: z.literal(true) })
export const claimWireSchema = z.strictObject({ claimed: z.boolean() })

const criteriaSchema = z.strictObject({
  labels: z.array(z.string()).optional(),
  state: z.string().optional(),
})
const idSchema = z.strictObject({ id: z.string().min(1) })
const draftSchema = z.strictObject({
  title: z.string(),
  body: z.string(),
  labels: z.array(z.string()).optional(),
  blockedBy: z.array(z.string()).optional(),
})
const createOptionsSchema = z.strictObject({
  state: z.string().optional(),
  idempotencyKey: z.string().optional(),
})
const updateSchema = z
  .strictObject({
    title: z.string().optional(),
    body: z.string().optional(),
    labels: z.array(z.string()).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'update must name at least one field')

function envelope<T extends z.ZodType>(input: T) {
  return z.strictObject({ context: hostedTicketContextSchema, input })
}

const mutationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('update'), patch: updateSchema }),
  z.strictObject({ kind: z.literal('transition'), state: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('blockers'),
    operation: z.enum(['block', 'unblock']),
    ids: z.array(z.string().min(1)),
  }),
])

export const hostedTicketRequestSchemas = {
  'mutate-if-revision': envelope(
    z.strictObject({
      id: z.string().min(1),
      expectedRevision: z.string().refine((v) => v.trim().length > 0),
      mutation: mutationSchema,
    }),
  ),
  'list-ready': envelope(criteriaSchema),
  get: envelope(idSchema),
  claim: envelope(idSchema),
  comment: envelope(z.strictObject({ id: z.string().min(1), body: z.string() })),
  transition: envelope(z.strictObject({ id: z.string().min(1), state: z.string().min(1) })),
  create: envelope(z.strictObject({ draft: draftSchema, options: createOptionsSchema.optional() })),
  update: envelope(z.strictObject({ id: z.string().min(1), patch: updateSchema })),
  'add-blocker': envelope(z.strictObject({ id: z.string().min(1), blockerId: z.string().min(1) })),
  'remove-blocker': envelope(
    z.strictObject({ id: z.string().min(1), blockerId: z.string().min(1) }),
  ),
  'dependency-states': envelope(z.strictObject({ ids: z.array(z.string().min(1)) })),
} as const

export type HostedTicketOperation = keyof typeof hostedTicketRequestSchemas
export const HOSTED_TICKET_OPERATIONS = Object.keys(
  hostedTicketRequestSchemas,
) as HostedTicketOperation[]
