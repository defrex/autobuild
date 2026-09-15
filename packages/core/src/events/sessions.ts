/**
 * Operator-session event catalog (SPEC §7.1.1). Operator sessions are a third
 * BuildStore resource kind alongside builds and the repository journal: an
 * orchestrator conversation is durable state, but it is neither a build nor a
 * repository fact. The catalog is closed and validated separately from the
 * build and repository catalogs, so no build reducer can interpret session
 * events — the same separation the repository journal has.
 *
 * Sessions are hosted-only: local installs interact through the CLI and
 * dashboard and never create one. Nothing in this module encodes this
 * repository's specifics.
 */
import { z } from 'zod'
import { EventValidationError } from './catalog'
import {
  actorSchema,
  VIA_ACTOR_RULE,
  viaOnNonHumanActor,
  type Actor,
  type ActorKind,
} from './envelope'

const positiveInt = z.number().int().positive()

const empty = z.strictObject({})

/** The trigger that started a turn: a human message or a wake event. */
const turnTriggerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('message'), messageSeq: positiveInt }),
  z.strictObject({
    kind: z.literal('wake'),
    build: z.string().min(1),
    seq: positiveInt,
    type: z.string().min(1),
  }),
])

/** Matches the transcript usage shape (harvest.session.ended, §15.3). */
const usageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  turns: z.number().int().nonnegative().optional(),
})

export const sessionEventPayloadSchemas = {
  /** The fact of creation; the session record carries the same title. */
  'session.created': z.strictObject({ title: z.string().min(1).optional() }),
  /** A human operator's message. */
  'message.posted': z.strictObject({ text: z.string().min(1) }),
  /** Which attention events may start a turn. Possibly empty: empty means
   * no wake sources (message-only). */
  'session.wake-set': z.strictObject({
    globs: z.array(z.string().min(1)).max(100),
  }),
  /** The (later) turn runner's start of one turn on its stream. */
  'turn.started': z.strictObject({
    turn: z.string().min(1),
    stream: z.string().min(1),
    trigger: turnTriggerSchema,
  }),
  /** A turn was suspended for budget or for an approval. */
  'turn.suspended': z.strictObject({
    turn: z.string().min(1),
    cause: z.enum(['budget', 'approval']),
  }),
  /** The runner's acknowledgement that a suspended turn continues. */
  'turn.resumed': z.strictObject({ turn: z.string().min(1) }),
  /** The turn asks its human to approve one tool call. */
  'approval.requested': z.strictObject({
    turn: z.string().min(1),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    input: z.record(z.string(), z.unknown()),
  }),
  /** The human's decision on one requested approval. */
  'approval.answered': z.strictObject({
    turn: z.string().min(1),
    toolCallId: z.string().min(1),
    decision: z.enum(['approve', 'deny']),
  }),
  /** One turn finished. */
  'turn.completed': z.strictObject({ turn: z.string().min(1), usage: usageSchema }),
  /** One turn failed. */
  'turn.failed': z.strictObject({ turn: z.string().min(1), error: z.string().min(1) }),
  /** Terminal. The session is read-only afterwards. */
  'session.archived': empty,
} as const

export type SessionEventType = keyof typeof sessionEventPayloadSchemas
export const SESSION_EVENT_TYPES = Object.keys(sessionEventPayloadSchemas) as SessionEventType[]
export type SessionEventPayload<T extends SessionEventType> = z.infer<
  (typeof sessionEventPayloadSchemas)[T]
>

export interface SessionEventEnvelope<T extends SessionEventType = SessionEventType> {
  session: string
  seq: number
  ts: string
  actor: Actor
  type: T
  payload: SessionEventPayload<T>
}

export type SessionEvent = {
  [T in SessionEventType]: SessionEventEnvelope<T>
}[SessionEventType]

export interface SessionEventWrite<T extends SessionEventType = SessionEventType> {
  actor: Actor
  type: T
  payload: SessionEventPayload<T>
}

/** Which actor kinds may emit each event type — the session catalog's Actor
 * column, enforced at validation exactly as for builds (§15.3). Humans create,
 * message, configure wakes, answer approvals, and archive; the agent (the
 * embedded orchestrator's turn runner) owns the turn lifecycle. */
const allowedActorKinds: Record<SessionEventType, readonly ActorKind[]> = {
  'session.created': ['human'],
  'message.posted': ['human'],
  'session.wake-set': ['human'],
  'approval.answered': ['human'],
  'session.archived': ['human'],
  'turn.started': ['agent'],
  'turn.suspended': ['agent'],
  'turn.resumed': ['agent'],
  'approval.requested': ['agent'],
  'turn.completed': ['agent'],
  'turn.failed': ['agent'],
}

export function isSessionEventType(value: string): value is SessionEventType {
  return Object.hasOwn(sessionEventPayloadSchemas, value)
}

/**
 * The session catalog's single validation gate. Every store adapter MUST pass
 * session writes through here before appending, with the same exact strictness
 * as the build and repository gates (D6).
 */
export function validateSessionEventWrite(input: {
  actor: unknown
  type: string
  payload: unknown
}): SessionEventWrite {
  if (!isSessionEventType(input.type)) {
    throw new EventValidationError(
      `unknown session event type "${input.type}" — known types: ${SESSION_EVENT_TYPES.join(', ')}`,
    )
  }
  if (viaOnNonHumanActor(input.actor)) {
    throw new EventValidationError(VIA_ACTOR_RULE)
  }
  const actorResult = actorSchema.safeParse(input.actor)
  if (!actorResult.success) {
    throw new EventValidationError(
      `invalid actor for "${input.type}": ${actorResult.error.message}`,
      actorResult.error.issues,
    )
  }
  const actor = actorResult.data
  const allowed = allowedActorKinds[input.type]
  if (!allowed.includes(actor.kind)) {
    throw new EventValidationError(
      `actor kind "${actor.kind}" may not emit "${input.type}" (allowed: ${allowed.join(', ')})`,
    )
  }
  const result = sessionEventPayloadSchemas[input.type].safeParse(input.payload)
  if (!result.success) {
    throw new EventValidationError(
      `invalid payload for "${input.type}": ${result.error.message}`,
      result.error.issues,
    )
  }
  return {
    actor,
    type: input.type,
    payload: result.data,
  } as SessionEventWrite
}
