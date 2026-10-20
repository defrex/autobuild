/** Frozen released v1.0.0-beta.0 parser. Keep the body closed to additive keys. */
import { z } from 'zod'
export const reducerValueSchema = z
  .object({
    version: z.number().int().positive(),
    cursor: z.number().int().nonnegative(),
    value: z.json(),
  })
  .strict()
