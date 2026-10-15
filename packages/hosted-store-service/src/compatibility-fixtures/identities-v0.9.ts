// Frozen v0.9.0 identity decoders.
/**
 * The event envelope (SPEC §15.1). Every event in a build's append-only log
 * shares this shape; the store assigns `seq` and `ts` so producers can't fake
 * ordering.
 */
import { z } from 'zod'

/** Delegated-write attribution (SPEC §15.1): when an agent acts for a person,
 * the event still names the person as the human actor and may name the
 * delegate, so an audit trail can distinguish "the operator did this" from
 * "the operator's orchestrator session did this" or "an MCP client did this"
 * forever. Only human actors may carry `via`, and only on build and
 * repository events; session events are the delegate's own log. */
export const viaSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session'), id: z.string().min(1) }),
  z.strictObject({ kind: z.literal('mcp'), client: z.string().min(1) }),
])
export type Via = z.infer<typeof viaSchema>

export const actorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('kernel') }),
  z.strictObject({
    kind: z.literal('agent'),
    role: z.string().min(1),
    session: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal('human'),
    user: z.string().min(1),
    via: viaSchema.optional(),
  }),
  z.strictObject({ kind: z.literal('dispatcher') }),
  z.strictObject({ kind: z.literal('ingester'), source: z.string().min(1) }),
])

export const ticketRefSchema = z.strictObject({
  source: z.string().min(1),
  id: z.string().min(1),
  url: z.string().optional(),
  title: z.string().optional(),
})
