import { stampCompatibility, type CompatibilityMetadata, buildEventPolicy } from './policy'
/**
 * The event catalog: envelope + payload schemas + per-type actor rules, and
 * the single validation entry point every store adapter calls at append.
 * This is where the ontology is *enforced*, not just described (SPEC §8).
 */
import {
  actorSchema,
  VIA_ACTOR_RULE,
  viaOnNonHumanActor,
  type Actor,
  type ActorKind,
} from './envelope'
import { eventPayloadSchemas, isEventType, type EventPayload, type EventType } from './payloads'

/**
 * A stored event: envelope (SPEC §15.1) with a known type. `seq` is per-build
 * and monotonic, `ts` is ISO-8601; both are store-assigned on append.
 */
export interface EventEnvelope<T extends EventType = EventType> {
  compatibility?: CompatibilityMetadata
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
  compatibility?: CompatibilityMetadata
  actor: Actor
  type: T
  payload: EventPayload<T>
}

/**
 * Which actor kinds may emit each event type — the Actor column of the
 * catalog tables in SPEC §15.3.
 */
export const allowedActorKinds: Record<EventType, readonly ActorKind[]> = {
  'build.compatibility-deferred': ['kernel', 'dispatcher'],
  'build.janitor-attempt-failed': ['dispatcher'],
  'build.janitor-recovered': ['dispatcher'],
  'build.janitor-failing': ['dispatcher'],
  'landing.application-failed': ['dispatcher', 'kernel'],
  'landing.decided': ['dispatcher', 'kernel'],
  'build.hold-requested': ['human'],
  'build.land-requested': ['human'],
  'landing.command-acknowledged': ['dispatcher', 'kernel'],
  'landing.native-enable-started': ['dispatcher'],
  'landing.forge-merged': ['kernel'],
  'landing.native-applied': ['dispatcher', 'kernel'],
  'target.distance': ['dispatcher'],
  'target.moved': ['dispatcher', 'kernel'],
  'restack.prepared': ['kernel', 'dispatcher'],
  'restack.replayed': ['kernel', 'dispatcher'],
  'restack.publish-intended': ['kernel', 'dispatcher'],
  'restack.rewritten': ['kernel', 'dispatcher'],
  'restack.contended': ['kernel', 'dispatcher'],
  'restack.completed': ['kernel', 'dispatcher'],
  'integration.abandoned': ['kernel', 'dispatcher'],
  'integration.observed': ['kernel', 'dispatcher'],
  'integration.prepared': ['kernel', 'dispatcher'],
  'integration.landing-intended': ['kernel', 'dispatcher'],
  'integration.landed': ['kernel', 'dispatcher'],
  'integration.verification-failed': ['kernel', 'dispatcher'],
  'integration.audited': ['kernel', 'dispatcher'],
  'node.restack-requested': ['dispatcher', 'human'],
  'node.restack-satisfied': ['kernel', 'dispatcher'],
  'node.restack-availability-observed': ['kernel', 'dispatcher'],
  'node.parent-distance': ['kernel', 'dispatcher'],
  'node.parent-requested': ['dispatcher', 'human'],
  'node.parent-accepted': ['dispatcher', 'human'],
  'node.parent-pr-retargeted': ['dispatcher', 'human'],
  'node.parent-completed': ['dispatcher', 'human'],
  'node.parent-cancelled': ['dispatcher', 'human'],
  'node.parent-rejection-cleared': ['dispatcher', 'human'],
  'node.parent-rejected': ['dispatcher', 'human'],
  'node.opening': ['dispatcher'],
  'node.writer-reserved': ['kernel', 'dispatcher'],
  'node.item-prepared': ['kernel', 'dispatcher'],
  'node.item-replayed': ['kernel', 'dispatcher'],
  'node.item-conflicted': ['kernel', 'dispatcher'],
  'node.publish-intended': ['kernel', 'dispatcher'],
  'node.rewritten': ['kernel', 'dispatcher'],
  'node.writer-settled': ['kernel', 'dispatcher'],
  'node.contribution-recorded': ['kernel', 'dispatcher'],
  'node.inventory': ['kernel', 'dispatcher'],
  'node.opened': ['dispatcher'],
  'node.poll-checked': ['dispatcher'],
  'node.compared': ['dispatcher'],
  'pr.opened': ['dispatcher'],
  'build.created': ['dispatcher', 'human'],
  'build.completed': ['dispatcher'],
  'runner.runtime-recorded': ['kernel'],
  'runner.attached': ['kernel'],
  'runner.setup-failed': ['kernel'],
  'workspace.provisioned': ['dispatcher', 'kernel'],
  'workspace.provision-started': ['dispatcher'],
  'workspace.cleanup-required': ['dispatcher'],
  'workspace.fenced': ['dispatcher'],
  'workspace.commits-preserved': ['dispatcher'],
  'workspace.commits-lost': ['dispatcher'],
  'workspace.released': ['dispatcher', 'kernel'],
  'execution.relaunch-requested': ['kernel'],
  'execution.drain-authorized': ['dispatcher'],
  'execution.drain-settled': ['dispatcher'],
  'execution.started': ['dispatcher'],
  'execution.ended': ['dispatcher'],
  'infrastructure.failed': ['dispatcher'],
  'infrastructure.cleanup-attempted': ['dispatcher'],
  'pr-summary.requested': ['kernel'],
  'pr-summary.attempted': ['kernel'],
  'pr-summary.result': ['kernel'],
  'pr-summary.settled': ['kernel'],
  'finalize.step-started': ['kernel'],
  'publication.requested': ['agent', 'kernel'],
  // Only the dispatcher releases workspaces and settles publications (§15.7);
  // the kernel never destroys one, so it never records a loss.
  'publication.candidate-retired': ['dispatcher', 'kernel'],
  'publication.lost': ['dispatcher'],
  'publication.retry-scheduled': ['kernel', 'dispatcher'],
  'publication.retry-exhausted': ['kernel', 'dispatcher'],
  'abort.remote-branch-deleted': ['dispatcher'],
  'abort.local-branch-deleted': ['dispatcher'],
  'abort.ticket-returned': ['dispatcher'],
  'dispatch.failed': ['dispatcher'],
  'dispatch.comment-posted': ['dispatcher'],

  'build.pause-requested': ['human'],
  'build.resume-requested': ['human'],
  'build.abort-requested': ['human'],
  'build.discard-requested': ['human'],
  'build.auto-merge-requested': ['human'],
  'build.auto-merge-cancelled': ['human'],
  'build.auto-merge-default-observed': ['dispatcher'],
  'build.paused': ['kernel', 'dispatcher'],
  'build.resumed': ['kernel', 'dispatcher'],
  'build.aborted': ['kernel', 'dispatcher'],

  'spec.imported': ['dispatcher'],
  'spec.authored': ['agent'],
  'spec.revised': ['kernel'],

  'session.suspended': ['kernel'],
  'session.resumed': ['kernel'],
  'session.resume-fallback': ['kernel'],
  'session.started': ['kernel'],
  'session.native-handle-recorded': ['kernel'],
  'session.ended': ['kernel'],

  'plan.started': ['kernel'],
  'plan.completed': ['agent'],
  'plan-review.started': ['kernel'],
  'plan-review.verdict': ['agent'],
  'implement.started': ['kernel'],
  'implement.completed': ['agent', 'dispatcher'],
  'code-review.started': ['kernel'],
  'code-review.verdict': ['agent'],

  'verify.reconcile-policy-captured': ['kernel'],
  'verify.config-captured': ['kernel'],
  'verify.config-superseded': ['kernel'],
  'verify.started': ['kernel'],
  'verify.cancelled': ['kernel'],
  'verify.stage-failed': ['kernel'],
  'verify.completed': ['kernel', 'agent'],
  'finalize.started': ['kernel'],
  'finalize.completed': ['kernel'],
  'finalize.step-completed': ['kernel', 'agent'],
  'pr-attachment.designated': ['agent'],
  'pr-attachment.hosted': ['kernel'],
  'pr-attachment.reclaimed': ['dispatcher'],
  'pr-attachment.reclaim-failed': ['dispatcher'],

  'pr.auto-merge-enabled': ['kernel', 'dispatcher'],
  'pr.auto-merge-disabled': ['kernel', 'dispatcher'],
  'pr.merged': ['dispatcher'],
  'pr.closed': ['dispatcher'],
  'pr.conflicted': ['dispatcher'],
  'reconcile.progress-checked': ['kernel'],
  'reconcile.started': ['kernel'],
  'reconcile.prepared': ['kernel'],
  'reconcile.contended': ['kernel', 'dispatcher'],
  'reconcile.replayed': ['kernel'],
  'reconcile.publish-intended': ['kernel'],
  'reconcile.rewritten': ['kernel', 'dispatcher'],
  'reconcile.completed': ['agent', 'dispatcher', 'kernel'],

  'observation.recorded': ['kernel', 'agent'],
  'escalation.raised': ['agent', 'kernel', 'dispatcher'],
  // Answering an escalation is always a deliberate human act. Historical
  // dispatcher-authored retries remain reducible because replay does not
  // revalidate already-persisted envelopes.
  'escalation.answered': ['human'],
  'phase.failed': ['kernel'],
  'session.build-read-failed': ['kernel'],
  'phase.deferred': ['kernel'],
  'phase.deferral-escalated': ['kernel'],
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
  compatibility?: unknown
}): EventWrite {
  if (!isEventType(input.type)) {
    throw new EventValidationError(
      `unknown event type "${input.type}" — known types: ${Object.keys(eventPayloadSchemas).join(', ')}`,
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

  const schema = eventPayloadSchemas[input.type]
  const payloadResult = schema.safeParse(input.payload)
  if (!payloadResult.success) {
    throw new EventValidationError(
      `invalid payload for "${input.type}": ${payloadResult.error.message}`,
      payloadResult.error.issues,
    )
  }
  if (input.type === 'escalation.raised') {
    const escalation = payloadResult.data as EventPayload<'escalation.raised'>
    if (
      actor.kind === 'dispatcher' &&
      (escalation.source !== 'policy' ||
        (escalation.policyCause !== 'infrastructure-failure-limit' &&
          escalation.policyCause !== 'dispatch-failure-limit' &&
          escalation.policyCause !== 'execution-no-progress' &&
          escalation.policyCause !== 'publication-retry-limit'))
    ) {
      throw new EventValidationError(
        'invalid dispatcher escalation: only policy/infrastructure-failure-limit or policy/dispatch-failure-limit or policy/execution-no-progress or policy/publication-retry-limit may be raised outside the kernel',
      )
    }
    if (escalation.source === 'policy' && escalation.policyCause === undefined) {
      throw new EventValidationError(
        'invalid payload for "escalation.raised": source "policy" requires a recognized policyCause',
      )
    }
    if (escalation.source !== 'policy' && escalation.policyCause !== undefined) {
      throw new EventValidationError(
        `invalid payload for "escalation.raised": policyCause is only allowed when source is "policy", not ${JSON.stringify(escalation.source)}`,
      )
    }
  }
  return {
    ...(input.compatibility === undefined
      ? {}
      : { compatibility: stampCompatibility(buildEventPolicy[input.type], input.compatibility) }),
    actor,
    type: input.type,
    payload: payloadResult.data,
  } as EventWrite
}

/** Producer boundary: validate strictly, then identify the actual writer. */
export function prepareEventWrite(input: Parameters<typeof validateEventWrite>[0]): EventWrite {
  try {
    const validated = validateEventWrite(input)
    return {
      ...validated,
      compatibility: stampCompatibility(buildEventPolicy[validated.type], validated.compatibility),
    }
  } catch (error) {
    if (error instanceof EventValidationError) throw error
    throw new EventValidationError(
      `invalid compatibility metadata: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
