import { z } from 'zod'
import { documentFields } from './reference-metadata'
import { pathSelectorSchema } from './path-selectors'

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
  paths: z
    .array(pathSelectorSchema)
    .min(1, 'paths must contain at least one repository-relative glob')
    .optional(),
  within: z
    .array(pathSelectorSchema)
    .min(1, 'within must contain at least one repository-relative glob')
    .optional(),
  mode: z.enum(['auto', 'consent']),
})
export type LandingRule = z.infer<typeof landingRuleSchema>

documentFields(landingRuleSchema, {
  into: 'Optional destination: `root`, any `node`, or an exact frozen destination node ticket id.',
  from: 'Restrict this rule to one source build kind; omission matches all kinds.',
  label: 'Optional exact, case-sensitive label on the source ticket. Blank labels are invalid.',
  paths:
    'Match when at least one changed path matches a selector. Same glob grammar and case sensitivity as `[verify.<step>].paths`.',
  within: 'Match when every changed path matches a selector and at least one path changed.',
  mode: 'Choose automatic merge or require recorded consent.',
})
