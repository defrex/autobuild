import { z } from 'zod'

/** Advisory liveness, independent of workflow authority and event streams. */
export const OPERATOR_PRESENCE_TTL_MS = 300_000
export const OPERATOR_HEARTBEAT_MS = 30_000
export const operatorIdentitySchema = z
  .object({
    id: z.string().trim().min(1).max(256),
    host: z.string().trim().min(1).max(256),
    pid: z.number().int().positive().safe(),
    startedAt: z.string().datetime({ offset: true }),
  })
  .strict()
export const operatorPresenceSchema = operatorIdentitySchema
  .extend({
    repo: z.string().min(1),
    heartbeatAt: z.string().datetime({ offset: true }),
  })
  .strict()
export type OperatorIdentity = z.infer<typeof operatorIdentitySchema>
export type OperatorPresence = z.infer<typeof operatorPresenceSchema>
