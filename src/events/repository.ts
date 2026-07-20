/**
 * Repository-scoped event catalog. These events deliberately do not enter the
 * build event union: repository controls and harvest runs are not synthetic
 * builds or new phases in the fixed build grammar.
 */
import { z } from 'zod'
import {
  artifactRefSchema,
  findingSchema,
  reviewVerdictKindSchema,
  ticketRefSchema,
} from '../ontology'
import {
  harvestDispositionSchema,
  harvestPendingProposalSchema,
  harvestStepSchema,
  occurrenceKeySchema,
} from '../harvest/schema'
import { actorSchema, type Actor, type ActorKind } from './envelope'
import { EventValidationError } from './catalog'

const round = z.number().int().positive()
const attempt = z.number().int().positive()
const empty = z.strictObject({})
const setting = z.strictObject({ enabled: z.boolean() })

export const harvestEventPayloadSchemas = {
  // Repository-wide operator control. Requests are human commands; paused /
  // resumed are kernel acknowledgements made only at workflow boundaries.
  'harvest.pause-requested': empty,
  'harvest.resume-requested': empty,
  'harvest.paused': empty,
  'harvest.resumed': empty,
  /** Durable selection of one outer automatic recovery. The acknowledgement
   * is the same harvest.resumed fact used by a human request. */
  'harvest.recovery-requested': z.strictObject({
    run: z.string().min(1),
    attempt,
    limit: z.number().int().positive(),
  }),
  /** Atomic give-up boundary: commit the safe partial ledger, release only
   * pending observations, and raise a durable human-attention barrier. */
  'harvest.recovery-exhausted': z.strictObject({
    run: z.string().min(1),
    step: harvestStepSchema,
    round: round.optional(),
    error: z.string().min(1),
    attempts: z.number().int().positive(),
    limit: z.number().int().positive(),
    releasedObservations: z.array(occurrenceKeySchema),
    committedDispositions: z.array(harvestDispositionSchema),
    pendingProposals: z.array(harvestPendingProposalSchema),
  }),
  'harvest.started': z.strictObject({
    run: z.string().min(1),
    observations: z.array(occurrenceKeySchema).min(1),
    scan: artifactRefSchema,
  }),
  'harvest.step.started': z.strictObject({
    run: z.string().min(1),
    step: harvestStepSchema,
    round: round.optional(),
  }),
  'harvest.step.completed': z.strictObject({
    run: z.string().min(1),
    step: harvestStepSchema,
    outcome: z.enum(['completed', 'approve', 'revise', 'escalate', 'failed']),
    round: round.optional(),
    artifact: artifactRefSchema.optional(),
    detail: z.string().optional(),
  }),
  'harvest.session.started': z.strictObject({
    run: z.string().min(1),
    session: z.string().min(1),
    role: z.enum(['harvest', 'harvest-review']),
    runner: z.string().min(1),
    model: z.string().optional(),
    step: z.enum(['synthesize', 'review']),
    round,
  }),
  'harvest.session.ended': z.strictObject({
    run: z.string().min(1),
    session: z.string().min(1),
    transcript: artifactRefSchema,
    usage: z.strictObject({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      turns: z.number().int().nonnegative(),
    }),
  }),
  'harvest.proposals.submitted': z.strictObject({
    run: z.string().min(1),
    round,
    artifact: artifactRefSchema,
  }),
  'harvest.review.verdict': z.strictObject({
    run: z.string().min(1),
    round,
    verdict: reviewVerdictKindSchema,
    findings: z.array(findingSchema),
    artifact: artifactRefSchema,
    reason: z.string().optional(),
  }),
  'harvest.proposal.id-reserved': z.strictObject({
    run: z.string().min(1),
    proposalKey: z.string().min(1),
    id: z.uuidv4(),
  }),
  'harvest.proposal.filed': z.strictObject({
    run: z.string().min(1),
    proposalKey: z.string().min(1),
    ticket: ticketRefSchema,
  }),
  /** The authoritative committed ledger facts for a successful run. */
  'harvest.completed': z.strictObject({
    run: z.string().min(1),
    dispositions: z.array(harvestDispositionSchema).min(1),
    report: artifactRefSchema,
  }),
  /** Terminal and deliberately consumes the claimed snapshot, preventing an
   * agent/stall/policy escalation from becoming a watch-tick hot loop. */
  'harvest.escalated': z.strictObject({
    run: z.string().min(1),
    source: z.enum(['agent', 'stall', 'policy']),
    reason: z.string().min(1),
    round: round.optional(),
    observations: z.array(occurrenceKeySchema).min(1),
  }),
  /** Infrastructure failure. A non-retrying failure stops the run at a
   * durable boundary for bounded automatic or explicit recovery. */
  'harvest.failed': z.strictObject({
    run: z.string().min(1),
    step: harvestStepSchema,
    round: round.optional(),
    attempt,
    error: z.string().min(1),
    willRetry: z.boolean(),
  }),
} as const

export const dispatcherSettingEventPayloadSchemas = {
  /** Current repository-wide intake gate sampled by every dispatcher tick. */
  'dispatcher.intake-set': setting,
  /** Claim-time auto-merge default sampled by every dispatcher tick. */
  'dispatcher.auto-merge-default-set': setting,
} as const

export const repositoryEventPayloadSchemas = {
  ...harvestEventPayloadSchemas,
  ...dispatcherSettingEventPayloadSchemas,
} as const

export type RepositoryEventType = keyof typeof repositoryEventPayloadSchemas
export const REPOSITORY_EVENT_TYPES = Object.keys(
  repositoryEventPayloadSchemas,
) as RepositoryEventType[]
export type RepositoryEventPayload<T extends RepositoryEventType> = z.infer<
  (typeof repositoryEventPayloadSchemas)[T]
>

export interface RepositoryEventEnvelope<
  T extends RepositoryEventType = RepositoryEventType,
> {
  repo: string
  seq: number
  ts: string
  actor: Actor
  type: T
  payload: RepositoryEventPayload<T>
}

export type RepositoryEvent = {
  [T in RepositoryEventType]: RepositoryEventEnvelope<T>
}[RepositoryEventType]

export interface RepositoryEventWrite<
  T extends RepositoryEventType = RepositoryEventType,
> {
  actor: Actor
  type: T
  payload: RepositoryEventPayload<T>
}

export type HarvestEventType = keyof typeof harvestEventPayloadSchemas
export type HarvestEventPayload<T extends HarvestEventType> =
  RepositoryEventPayload<T>
export type HarvestEventEnvelope<
  T extends HarvestEventType = HarvestEventType,
> = RepositoryEventEnvelope<T>
export type HarvestEvent = {
  [T in HarvestEventType]: RepositoryEventEnvelope<T>
}[HarvestEventType]
export type HarvestEventWrite<T extends HarvestEventType = HarvestEventType> =
  RepositoryEventWrite<T>

export const HARVEST_EVENT_TYPES = Object.keys(
  harvestEventPayloadSchemas,
) as HarvestEventType[]

const allowedActorKinds: Record<RepositoryEventType, readonly ActorKind[]> = {
  'harvest.pause-requested': ['human'],
  'harvest.resume-requested': ['human'],
  'harvest.paused': ['kernel'],
  'harvest.resumed': ['kernel'],
  'harvest.recovery-requested': ['kernel'],
  'harvest.recovery-exhausted': ['kernel'],
  'harvest.started': ['dispatcher', 'kernel'],
  'harvest.step.started': ['kernel'],
  'harvest.step.completed': ['kernel'],
  'harvest.session.started': ['kernel'],
  'harvest.session.ended': ['kernel'],
  'harvest.proposals.submitted': ['agent'],
  'harvest.review.verdict': ['agent'],
  'harvest.proposal.id-reserved': ['kernel'],
  'harvest.proposal.filed': ['kernel'],
  'harvest.completed': ['kernel'],
  'harvest.escalated': ['kernel', 'agent'],
  'harvest.failed': ['kernel'],
  'dispatcher.intake-set': ['human'],
  'dispatcher.auto-merge-default-set': ['human'],
}

export function isHarvestEventType(value: string): value is HarvestEventType {
  return Object.hasOwn(harvestEventPayloadSchemas, value)
}

export function isHarvestEvent(event: RepositoryEvent): event is HarvestEvent {
  return isHarvestEventType(event.type)
}

export function isRepositoryEventType(
  value: string,
): value is RepositoryEventType {
  return Object.hasOwn(repositoryEventPayloadSchemas, value)
}

export function validateRepositoryEventWrite(input: {
  actor: unknown
  type: string
  payload: unknown
}): RepositoryEventWrite {
  if (!isRepositoryEventType(input.type)) {
    throw new EventValidationError(
      `unknown repository event type "${input.type}" — known types: ${REPOSITORY_EVENT_TYPES.join(', ')}`,
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
  const result = repositoryEventPayloadSchemas[input.type].safeParse(
    input.payload,
  )
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
  } as RepositoryEventWrite
}
