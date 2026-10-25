import { z } from 'zod'
import { documentFields } from './reference-metadata'

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

documentFields(landingRuleSchema, {
  into: 'Optional destination: `root`, any `node`, or an exact frozen destination node ticket id.',
  from: 'Restrict this rule to one source build kind; omission matches all kinds.',
  label: 'Optional exact, case-sensitive label on the source ticket. Blank labels are invalid.',
  mode: 'Choose automatic merge or require recorded consent.',
})
