/**
 * The event catalog: envelope + payload schemas + per-type actor rules, and
 * the single validation entry point every store adapter calls at append.
 * This is where the ontology is *enforced*, not just described (SPEC §8).
 */
import { actorSchema, type Actor, type ActorKind } from './envelope'
import {
  eventPayloadSchemas,
  isEventType,
  type EventPayload,
  type EventType,
} from './payloads'

/**
 * A stored event: envelope (SPEC §15.1) with a known type. `seq` is per-build
 * and monotonic, `ts` is ISO-8601; both are store-assigned on append.
 */
export interface EventEnvelope<T extends EventType = EventType> {
  build: string
  seq: number
  ts: string
  actor: Actor
  type: T
  payload: EventPayload<T>
}

/** The discriminated union over every event type — what reducers consume. */
export type AbEvent = { [T in EventType]: EventEnvelope<T> }[EventType]

/** What a producer submits; the store assigns `seq`/`ts` (§15.1). */
export interface EventWrite<T extends EventType = EventType> {
  actor: Actor
  type: T
  payload: EventPayload<T>
}

/**
 * Which actor kinds may emit each event type — the Actor column of the
 * catalog tables in SPEC §15.3.
 */
export const allowedActorKinds: Record<EventType, readonly ActorKind[]> = {
  'build.created': ['dispatcher', 'human'],
  'build.completed': ['dispatcher'],
  'runner.attached': ['kernel'],
  'workspace.provisioned': ['dispatcher', 'kernel'],
  'workspace.released': ['dispatcher', 'kernel'],

  'build.pause-requested': ['human'],
  'build.resume-requested': ['human'],
  'build.abort-requested': ['human'],
  'build.auto-merge-requested': ['human'],
  'build.auto-merge-cancelled': ['human'],
  'build.paused': ['kernel'],
  'build.resumed': ['kernel'],
  'build.aborted': ['kernel'],

  'spec.imported': ['dispatcher'],
  'spec.authored': ['agent'],
  'spec.revised': ['kernel'],

  'session.started': ['kernel'],
  'session.ended': ['kernel'],

  'plan.started': ['kernel'],
  'plan.completed': ['agent'],
  'plan-review.started': ['kernel'],
  'plan-review.verdict': ['agent'],
  'implement.started': ['kernel'],
  'implement.completed': ['agent'],
  'code-review.started': ['kernel'],
  'code-review.verdict': ['agent'],

  'verify.started': ['kernel'],
  'verify.completed': ['kernel', 'agent'],
  'finalize.started': ['kernel'],
  'finalize.completed': ['kernel'],
  'finalize.step-completed': ['agent'],

  'pr.auto-merge-enabled': ['kernel', 'dispatcher'],
  'pr.auto-merge-disabled': ['kernel', 'dispatcher'],
  'pr.merged': ['dispatcher'],
  'pr.closed': ['dispatcher'],
  'pr.conflicted': ['dispatcher'],
  'reconcile.started': ['kernel'],
  'reconcile.completed': ['agent'],

  'observation.recorded': ['agent'],
  'escalation.raised': ['agent', 'kernel'],
  // Humans may use every resolution, including a bare `retry`. Dispatcher-
  // authored answers are restricted to `retry` below; matching those to an
  // all-policy open set requires log context and lives in Dispatcher.
  'escalation.answered': ['human', 'dispatcher'],
  'phase.failed': ['kernel'],
}

/**
 * Validation failures are agent feedback (D6): the message carries what was
 * wrong and what would be accepted, so the in-session correction loop is
 * immediate and cheap.
 */
export class EventValidationError extends Error {
  constructor(
    message: string,
    readonly issues?: unknown,
  ) {
    super(message)
    this.name = 'EventValidationError'
  }
}

/**
 * The single validation gate. Every store adapter MUST pass writes through
 * here before appending — the contract tests enforce that they do.
 */
export function validateEventWrite(input: {
  actor: unknown
  type: string
  payload: unknown
}): EventWrite {
  if (!isEventType(input.type)) {
    throw new EventValidationError(
      `unknown event type "${input.type}" — known types: ${Object.keys(eventPayloadSchemas).join(', ')}`,
    )
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

  const schema = eventPayloadSchemas[input.type]
  const payloadResult = schema.safeParse(input.payload)
  if (!payloadResult.success) {
    throw new EventValidationError(
      `invalid payload for "${input.type}": ${payloadResult.error.message}`,
      payloadResult.error.issues,
    )
  }
  if (
    input.type === 'escalation.answered' &&
    actor.kind === 'dispatcher' &&
    (payloadResult.data as EventPayload<'escalation.answered'>).resolution !== 'retry'
  ) {
    throw new EventValidationError(
      'dispatcher may only emit "escalation.answered" with resolution "retry"',
    )
  }

  return {
    actor,
    type: input.type,
    payload: payloadResult.data,
  } as EventWrite
}
