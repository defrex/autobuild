/**
 * The event envelope (SPEC §15.1). Every event in a build's append-only log
 * shares this shape; the store assigns `seq` and `ts` so producers can't fake
 * ordering.
 */
import { z } from 'zod'

export const actorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('kernel') }),
  z.strictObject({
    kind: z.literal('agent'),
    role: z.string().min(1),
    session: z.string().min(1),
  }),
  z.strictObject({ kind: z.literal('human'), user: z.string().min(1) }),
  z.strictObject({ kind: z.literal('dispatcher') }),
  z.strictObject({ kind: z.literal('ingester'), source: z.string().min(1) }),
])
export type Actor = z.infer<typeof actorSchema>
export type ActorKind = Actor['kind']

export const KERNEL: Actor = { kind: 'kernel' }
export const DISPATCHER: Actor = { kind: 'dispatcher' }

export function agentActor(role: string, session: string): Actor {
  return { kind: 'agent', role, session }
}

export function humanActor(user: string): Actor {
  return { kind: 'human', user }
}
