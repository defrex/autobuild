import { z } from 'zod'

/** Ordered dispatcher-owned policy; omitted predicates are wildcards. */
export const landingRuleSchema = z.strictObject({
  into: z
    .string()
    .refine(
      (value) => value.trim().length > 0,
      'into must be root, node, or a nonblank node ticket id',
    )
    .optional(),
  from: z.enum(['leaf', 'node']).optional(),
  label: z
    .string()
    .refine(
      (value) => value.trim().length > 0,
      'label must be nonblank (labels match exactly, including case)',
    )
    .optional(),
  mode: z.enum(['auto', 'consent']),
})
export type LandingRule = z.infer<typeof landingRuleSchema>
