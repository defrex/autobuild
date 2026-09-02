import { z } from 'zod'

export const buildListScopeSchema = z.enum(['active', 'queued', 'all'])

export const buildControlRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('pause') }),
  z.strictObject({ action: z.literal('cancel-pause') }),
  z.strictObject({ action: z.literal('resume') }),
  z.strictObject({ action: z.literal('abort') }),
  z.strictObject({ action: z.literal('discard') }),
  z.strictObject({ action: z.literal('auto-merge-on') }),
  z.strictObject({ action: z.literal('auto-merge-off') }),
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
  title: z.string(),
  body: z.string(),
  labels: z.array(z.string()).optional(),
  state: z.string().min(1).optional(),
  blockedBy: z.array(z.string().min(1)).optional(),
})
export const ticketUpdateRequestSchema = z
  .strictObject({
    title: z.string().optional(),
    body: z.string().optional(),
    labels: z.array(z.string()).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'update must name at least one field')
export const ticketMoveRequestSchema = z.strictObject({ state: z.string().min(1) })
export const ticketBlockerRequestSchema = z.strictObject({
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
