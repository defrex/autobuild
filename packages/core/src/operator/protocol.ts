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

export const operatorErrorSchema = z.strictObject({
  kind: z.enum(['validation', 'auth', 'not-found', 'conflict', 'refusal', 'internal']),
  error: z.string(),
  code: z.string().optional(),
  progress: z.unknown().optional(),
})
export type OperatorErrorBody = z.infer<typeof operatorErrorSchema>
