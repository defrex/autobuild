import { z } from 'zod'
import { issueLinksInputSchema } from '../ports/tickets/issue-links'
import { TICKET_MOVE_ROLES } from '../ports/tickets/lifecycle'
import { ticketPrioritySchema } from '../ports/tickets/priority'

const issueLinksField = issueLinksInputSchema
  .optional()
  .describe(
    'Forge issues this ticket addresses: {issue, intent?}; intent "closes" (default) or "refs" for partial work. On update, a complete replacement; [] clears.',
  )

const priorityField = ticketPrioritySchema
  .optional()
  .describe(
    'Dispatch class: "urgent" is claimed before normal ready work (never preempting a running build); "normal" (the default) removes urgency. Sources that cannot store priority refuse urgent.',
  )

export const buildListScopeSchema = z.enum(['active', 'queued', 'all'])

export const buildControlRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('pause') }),
  z.strictObject({ action: z.literal('cancel-pause') }),
  z.strictObject({ action: z.literal('resume') }),
  z.strictObject({ action: z.literal('abort') }),
  z.strictObject({ action: z.literal('discard') }),
  z.strictObject({ action: z.literal('land') }),
  z.strictObject({ action: z.literal('hold') }),
])
export type OperatorBuildControlRequest = z.infer<typeof buildControlRequestSchema>

const optionalText = z.string().optional()
export const answerRequestSchema = z.union([
  z.strictObject({ resolution: z.literal('guidance'), text: z.string().trim().min(1) }),
  z.strictObject({ resolution: z.literal('retry') }),
  z.strictObject({ resolution: z.literal('dismiss'), text: optionalText }),
  z.strictObject({
    resolution: z.literal('review-round-ceiling'),
    ceiling: z.number().int().positive(),
    text: optionalText,
  }),
  z.strictObject({
    resolution: z.literal('revise-spec'),
    origin: z.literal('body'),
    body: z.string(),
    text: optionalText,
    /** Accepted only so the shared core can return its exact incompatible-options refusal. */
    ceiling: z.number().int().positive().optional(),
  }),
  z.strictObject({
    resolution: z.literal('revise-spec'),
    origin: z.literal('ticket'),
    body: z.string(),
    text: optionalText,
    ceiling: z.number().int().positive().optional(),
  }),
])
export type OperatorAnswerRequest = z.infer<typeof answerRequestSchema>

export const settingRequestSchema = z.strictObject({ enabled: z.boolean() })
export const bulkControlRequestSchema = z.strictObject({ action: z.enum(['pause', 'resume']) })
export const harvestControlRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('toggle-gate') }),
  z.strictObject({ action: z.literal('run'), run: z.string().min(1) }),
])

export const ticketCreateRequestSchema = z.strictObject({
  kind: z.enum(['work', 'node']).optional(),
  target: z.string().trim().min(1).nullable().optional(),
  title: z.string(),
  body: z.string(),
  labels: z.array(z.string()).optional(),
  state: z.string().min(1).optional(),
  blockedBy: z.array(z.string().min(1)).optional(),
  issueLinks: issueLinksField,
  priority: priorityField,
})
const expectedRevisionSchema = z
  .string()
  .refine((v) => v.trim().length > 0, 'expectedRevision must be nonblank')
  .optional()
export const ticketUpdateRequestSchema = z
  .strictObject({
    kind: z.enum(['work', 'node']).optional(),
    target: z.string().trim().min(1).nullable().optional(),
    expectedRevision: expectedRevisionSchema,
    title: z.string().optional(),
    body: z.string().optional(),
    labels: z.array(z.string()).optional(),
    issueLinks: issueLinksField,
    priority: priorityField,
  })
  .refine(
    (value) =>
      value.title !== undefined ||
      value.body !== undefined ||
      value.labels !== undefined ||
      value.issueLinks !== undefined ||
      value.priority !== undefined ||
      value.kind !== undefined ||
      value.target !== undefined,
    'update must name at least one field',
  )
/** A window over a ticket listing; see `OperatorTicketPage`. */
export const ticketPageSchema = z.strictObject({
  limit: z.number().int().min(0).max(200),
  offset: z.number().int().min(0).optional(),
  order: z.enum(['oldest', 'newest']).optional(),
})
/** The unrefined move shape, so tool inputs can extend it; validate requests
 * with `ticketMoveRequestSchema`, which requires exactly one target. */
export const ticketMoveRequestShape = z.strictObject({
  expectedRevision: expectedRevisionSchema,
  state: z.string().min(1).optional(),
  role: z
    .enum(TICKET_MOVE_ROLES)
    .optional()
    .describe(
      "Lifecycle role to move the ticket into, resolved through this repository's [tickets] configuration. Destructive for `ready`.",
    ),
})
export const exactlyOneMoveTarget = (value: { state?: string; role?: string }): boolean =>
  (value.state === undefined) !== (value.role === undefined)
export const MOVE_TARGET_MESSAGE = 'move must name exactly one of state or role'
export const ticketMoveRequestSchema = ticketMoveRequestShape.refine(
  exactlyOneMoveTarget,
  MOVE_TARGET_MESSAGE,
)
export const ticketBlockerRequestSchema = z.strictObject({
  expectedRevision: expectedRevisionSchema,
  blockerIds: z.array(z.string().min(1)).min(1),
})
export type OperatorTicketCreateRequest = z.infer<typeof ticketCreateRequestSchema>
export type OperatorTicketUpdateRequest = z.infer<typeof ticketUpdateRequestSchema>
export type OperatorTicketMoveRequest = z.infer<typeof ticketMoveRequestSchema>
export type OperatorTicketBlockerRequest = z.infer<typeof ticketBlockerRequestSchema>

export const operatorErrorSchema = z.strictObject({
  kind: z.enum(['validation', 'auth', 'not-found', 'conflict', 'refusal', 'internal']),
  error: z.string(),
  code: z.string().optional(),
  progress: z.unknown().optional(),
})
export type OperatorErrorBody = z.infer<typeof operatorErrorSchema>

export const sessionCreateRequestSchema = z.strictObject({ title: z.string().min(1).optional() })
export type OperatorSessionCreateRequest = z.infer<typeof sessionCreateRequestSchema>

export const sessionMessageRequestSchema = z.strictObject({ text: z.string().trim().min(1) })
export type OperatorSessionMessageRequest = z.infer<typeof sessionMessageRequestSchema>

export const sessionWakeRequestSchema = z.strictObject({
  globs: z.array(z.string().min(1)).max(100),
})
export type OperatorSessionWakeRequest = z.infer<typeof sessionWakeRequestSchema>

export const sessionApprovalRequestSchema = z.strictObject({
  turn: z.string().min(1),
  toolCallId: z.string().min(1),
  decision: z.enum(['approve', 'deny']),
})
export type OperatorSessionApprovalRequest = z.infer<typeof sessionApprovalRequestSchema>

export const ticketStateCreateRequestSchema = z.strictObject({
  name: z.string(),
  about: z.string().optional(),
})
