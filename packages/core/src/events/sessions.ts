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

/** The trigger that started a turn: a human message or a wake event. A wake
 * trigger names exactly one source — a build (the build-log attention scan)
 * or the repository journal — enforced by the schema's `.check()` below even
 * though the static type (one object with optional fields) cannot express it:
 * a two-member union or a nested discriminated union is not a valid
 * discriminated-union option on zod 4 (both constructions throw at first
 * parse), so the wake variant stays a single object and call sites branch on
 * `journal === true`. */
const turnWakeTriggerSchema = z
  .strictObject({
    kind: z.literal('wake'),
    build: z.string().min(1).optional(),
    journal: z.literal(true).optional(),
    seq: positiveInt,
    type: z.string().min(1),
  })
  .check((ctx) => {
    const hasBuild = ctx.value.build !== undefined
    const hasJournal = ctx.value.journal === true
    if (hasBuild === hasJournal) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'a wake trigger names exactly one of build or journal',
      })
    }
  })

const turnTriggerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('message'), messageSeq: positiveInt }),
  turnWakeTriggerSchema,
])

/** Matches the transcript usage shape (harvest.session.ended, §15.3). The
 * turn runner records the AI SDK's totalUsage token counts plus the step
 * count. Old `turn.completed` events without `steps` still reduce. */
const usageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  steps: z.number().int().nonnegative(),
  turns: z.number().int().nonnegative().optional(),
})

/** The typed model-failure vocabulary (AUT-342): provider availability,
 * exhaustion, credentials, and configuration are distinguished so a failed
 * turn's class is visible in the session's reduced state and nothing is ever
 * retried unboundedly. `internal` covers non-model failures — the dispatcher
 * tick's crash reaper among them. */
const turnFailureKindSchema = z.enum([
  'provider-unavailable',
  'exhausted',
  'credentials',
  'configuration',
  'internal',
])

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
  /** The (later turn runner's) start of one turn on its stream. A wake
   * turn additionally carries the delivered input — the attention event
   * record and, for a build wake, the build's reduced state, frozen at wake
   * time — so a later invocation reconstructs the identical user message
   * from durable state alone (live build state keeps moving; the frozen
   * snapshot does not). A journal wake delivers the event record only. */
  'turn.started': z.strictObject({
    turn: z.string().min(1),
    stream: z.string().min(1),
    trigger: turnTriggerSchema,
    wake: z
      .strictObject({
        event: z.strictObject({
          seq: positiveInt,
          ts: z.string().min(1),
          type: z.string().min(1),
          payload: z.record(z.string(), z.unknown()),
        }),
        buildState: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
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
  /** One turn failed: `kind` is the typed failure class, `error` the
   * human-readable message surfaced in the session's reduced state. */
  'turn.failed': z.strictObject({
    turn: z.string().min(1),
    kind: turnFailureKindSchema,
    error: z.string().min(1),
  }),
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
