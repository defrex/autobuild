/**
 * Repository-scoped harvest event catalog. These events deliberately do not
 * enter the build event union: a harvest run is an outer-loop workflow, not a
 * synthetic build or a new phase in the fixed build grammar.
 */
import { z } from 'zod'
import { artifactRefSchema, findingSchema, reviewVerdictKindSchema, ticketRefSchema } from '../ontology'
import {
  harvestDispositionSchema,
  harvestStepSchema,
  occurrenceKeySchema,
} from '../harvest/schema'
import { actorSchema, type Actor, type ActorKind } from './envelope'
import { EventValidationError } from './catalog'

const round = z.number().int().positive()
const attempt = z.number().int().positive()
const empty = z.strictObject({})

export const harvestEventPayloadSchemas = {
  // Repository-wide operator control. Requests are human commands; paused /
  // resumed are kernel acknowledgements made only at workflow boundaries.
  'harvest.pause-requested': empty,
  'harvest.resume-requested': empty,
  'harvest.paused': empty,
  'harvest.resumed': empty,
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
  /** Infrastructure failure. A non-retrying failure remains queryable and is
   * terminal for the run; retrying failures resume the same claimed snapshot. */
  'harvest.failed': z.strictObject({
    run: z.string().min(1),
    step: harvestStepSchema,
    round: round.optional(),
    attempt,
    error: z.string().min(1),
    willRetry: z.boolean(),
  }),
} as const

export type HarvestEventType = keyof typeof harvestEventPayloadSchemas
export const HARVEST_EVENT_TYPES = Object.keys(
  harvestEventPayloadSchemas,
) as HarvestEventType[]
export type HarvestEventPayload<T extends HarvestEventType> = z.infer<
  (typeof harvestEventPayloadSchemas)[T]
>

export interface HarvestEventEnvelope<T extends HarvestEventType = HarvestEventType> {
  repo: string
  seq: number
  ts: string
  actor: Actor
  type: T
  payload: HarvestEventPayload<T>
}

export type HarvestEvent = {
  [T in HarvestEventType]: HarvestEventEnvelope<T>
}[HarvestEventType]

export interface HarvestEventWrite<T extends HarvestEventType = HarvestEventType> {
  actor: Actor
  type: T
  payload: HarvestEventPayload<T>
}

const allowedActorKinds: Record<HarvestEventType, readonly ActorKind[]> = {
  'harvest.pause-requested': ['human'],
  'harvest.resume-requested': ['human'],
  'harvest.paused': ['kernel'],
  'harvest.resumed': ['kernel'],
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
}

export function isHarvestEventType(value: string): value is HarvestEventType {
  return Object.hasOwn(harvestEventPayloadSchemas, value)
}

export function validateHarvestEventWrite(input: {
  actor: unknown
  type: string
  payload: unknown
}): HarvestEventWrite {
  if (!isHarvestEventType(input.type)) {
    throw new EventValidationError(
      `unknown harvest event type "${input.type}" — known types: ${HARVEST_EVENT_TYPES.join(', ')}`,
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
  const result = harvestEventPayloadSchemas[input.type].safeParse(input.payload)
  if (!result.success) {
    throw new EventValidationError(
      `invalid payload for "${input.type}": ${result.error.message}`,
      result.error.issues,
    )
  }
  return { actor, type: input.type, payload: result.data } as HarvestEventWrite
}
