// Selected standalone decoders frozen verbatim from npm @defrex/autobuild@1.2.0.
// Publication and integrity provenance: remote/released-clients.json in core.
import { z } from 'zod'
export const errorKindSchema = z.enum(['validation', 'not-found', 'auth', 'conflict', 'internal'])

export const errorBodySchema = z.object({
  error: z.string(),
  kind: errorKindSchema,
})

export const repoChangePositionSchema = z.object({
  position: z.string().regex(/^(0|[1-9][0-9]*)$/),
})

export const repoHighWaterSchema = z.object({ seq: z.number().int().nonnegative() })

export const leaseClaimBodySchema = z.object({
  holder: z.string().min(1),
  ttlMs: z.number().int().nonnegative(),
})

export const leaseHolderBodySchema = z.object({ holder: z.string().min(1) })

export const okResponseSchema = z.object({ ok: z.boolean() })

export const beginRepoTickResponseSchema = z.iso.datetime().nullable()

export const reducerValueRequestSchema = z
  .object({
    reducer: z.string().min(1).max(64),
    args: z.record(z.string(), z.json()).optional(),
  })
  .strict()

export const reducerValueSchema = z
  .object({
    version: z.number().int().positive(),
    cursor: z.number().int().nonnegative(),
    value: z.json(),
  })
  .strict()
