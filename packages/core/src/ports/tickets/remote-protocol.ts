import { z } from 'zod'
import { ticketRefSchema } from '../../ontology'

/** Repository-owned policy sent with every hosted ticket operation. */
export const hostedTicketContextSchema = z.strictObject({
  teamKey: z.string().min(1),
  claimedState: z.string().min(1).optional(),
  createState: z.string().min(1).optional(),
})
export type HostedTicketContext = z.infer<typeof hostedTicketContextSchema>

export const ticketWireSchema = z.strictObject({
  ref: ticketRefSchema,
  creationKey: z.string().optional(),
  title: z.string(),
  body: z.string(),
  state: z.string().optional(),
  labels: z.array(z.string()),
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

export const hostedTicketRequestSchemas = {
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
