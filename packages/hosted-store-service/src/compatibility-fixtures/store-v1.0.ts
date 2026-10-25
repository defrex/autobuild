// Selected standalone wire decoders frozen verbatim from v1.0.1
// f934de5144992084884909a5faeb6826a6b61fb5 (protocol 4).
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
