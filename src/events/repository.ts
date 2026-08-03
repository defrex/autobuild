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
  harvestBlockerProvenanceSchema,
  harvestDispositionSchema,
  harvestPendingProposalSchema,
  harvestStepSchema,
  harvestTriggerSchema,
  occurrenceKeySchema,
} from '../harvest/schema'
import { actorSchema, type Actor, type ActorKind } from './envelope'
import { EventValidationError } from './catalog'
import { providerAttemptsSchema, providerSubstitutionSchema } from './payloads'

const round = z.number().int().positive()
const attempt = z.number().int().positive()
const empty = z.strictObject({})
const setting = z.strictObject({ enabled: z.boolean() })
const dispatchRun = z.string().min(1)
const boundedDiagnostics = z.array(z.string().min(1)).max(1_000)
const tickCountersSchema = z.strictObject({
  merged: z.number().int().nonnegative(),
  closed: z.number().int().nonnegative(),
  conflicted: z.number().int().nonnegative(),
  abandoned: z.number().int().nonnegative(),
  discarded: z.number().int().nonnegative(),
  janitorFailed: z.number().int().nonnegative(),
  recovered: z.number().int().nonnegative(),
  dispatchFailed: z.number().int().nonnegative(),
  resumed: z.number().int().nonnegative(),
  swept: z.number().int().nonnegative(),
  dispatched: z.number().int().nonnegative(),
  authored: z.number().int().nonnegative(),
  bounced: z.number().int().nonnegative(),
  claimRaces: z.number().int().nonnegative(),
  invalidTickets: z.number().int().nonnegative(),
  /** Added in plugin/API-era 1.4; optional so historical tick facts replay. */
  creationWithheld: z.number().int().nonnegative().optional(),
  dependencyBlocked: z.number().int().nonnegative(),
  harvestStarted: z.number().int().nonnegative(),
  harvestResumed: z.number().int().nonnegative(),
  harvestCompleted: z.number().int().nonnegative(),
  harvestEscalated: z.number().int().nonnegative(),
  harvestFailed: z.number().int().nonnegative(),
})
const restartRequiredConfigPathSchema = z.enum([
  'forge',
  'plugins',
  'workspace.provider',
  'workspace.config',
  'tickets.source',
  'tickets.teamKey',
  'tickets.claimedState',
  'tickets.createState',
  'tickets.dir',
])
const restartRequiredConfigPathsSchema = z
  .array(restartRequiredConfigPathSchema)
  .superRefine((paths, ctx) => {
    const seen = new Set<string>()
    paths.forEach((path, index) => {
      if (seen.has(path)) {
        ctx.addIssue({ code: 'custom', path: [index], message: `duplicate config path ${path}` })
      }
      seen.add(path)
    })
  })

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
    /** Optional only so historical repository journals replay without migration. */
    trigger: harvestTriggerSchema.optional(),
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
    substitution: providerSubstitutionSchema.optional(),
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
    blockers: harvestBlockerProvenanceSchema.optional(),
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
    providerAttempts: providerAttemptsSchema.optional(),
  }),
} as const

export const dispatcherStatusEventPayloadSchemas = {
  /** A terminal frontend follows exactly one run. The referenced artifact is
   * the composed Config the kernel is actually using, never an on-disk guess. */
  'dispatcher.run-started': z.strictObject({
    run: dispatchRun,
    pid: z.number().int().positive(),
    effectiveConfig: artifactRefSchema,
    roleWarnings: boundedDiagnostics,
  }),
  'dispatcher.run-stopped': z.strictObject({
    run: dispatchRun,
    outcome: z.enum(['normal', 'abnormal', 'forced']),
    exitCode: z.number().int().nullable().optional(),
    signal: z.string().min(1).optional(),
    error: z.string().min(1).optional(),
  }),
  'dispatcher.config-rejected': z.strictObject({ run: dispatchRun, error: z.string().min(1) }),
  'dispatcher.config-publication-failed': z.strictObject({
    run: dispatchRun,
    error: z.string().min(1),
  }),
  /** Brackets the one unsafe-to-force dispatcher turn. A supervisor may kill
   * an unresponsive child only when no started turn remains open. */
  'dispatcher.tick-started': z.strictObject({ run: dispatchRun }),
  'dispatcher.tick-completed': z.strictObject({
    run: dispatchRun,
    queued: z.number().int().nonnegative(),
    /** Replay-only compatibility for journals written while the isolated
     * dispatcher child transported a display sample in its tick fact. */
    observations: z.number().int().nonnegative().optional(),
    counters: tickCountersSchema,
    janitorDiagnostics: boundedDiagnostics,
    ticketDiagnostics: boundedDiagnostics,
    creationDiagnostics: boundedDiagnostics.optional(),
    dependencyDiagnostics: boundedDiagnostics,
  }),
  'dispatcher.tick-failed': z.strictObject({ run: dispatchRun, error: z.string().min(1) }),
  'dispatcher.runner-settled': z.strictObject({
    run: dispatchRun,
    slug: z.string().min(1),
    outcome: z.enum(['parked', 'lease-held', 'launch-failed', 'failed']),
    status: z.string().min(1).optional(),
    error: z.string().min(1).optional(),
  }),
  'dispatcher.harvest-runner-failed': z.strictObject({
    run: dispatchRun,
    error: z.string().min(1),
  }),
  /** Newer published release discovered by the private kernel. Keeping this
   * run-correlated makes the release courtesy available to Store-only UIs. */
  'dispatcher.upgrade-available': z.strictObject({
    run: dispatchRun,
    version: z.string().min(1),
  }),
  /** Durable acknowledgement text for controls whose exact bulk result is not
   * otherwise one event. It is presentation-neutral operator evidence. */
  'dispatcher.operator-reported': z.strictObject({
    run: dispatchRun,
    level: z.enum(['info', 'warning']),
    message: z.string().min(1),
  }),
} as const

export const dispatcherSettingEventPayloadSchemas = {
  /** Accepted main-checkout config revision. The exact TOML is deposited in
   * the repository artifact stream atomically with this fact. Historical
   * events omit run/effectiveConfig and remain replayable. */
  'dispatcher.config-reloaded': z.strictObject({
    artifact: artifactRefSchema,
    restartRequired: restartRequiredConfigPathsSchema,
    effectiveChanged: z.boolean(),
    run: dispatchRun.optional(),
    effectiveConfig: artifactRefSchema.optional(),
    roleWarnings: boundedDiagnostics.optional(),
  }),
  /** Current repository-wide intake gate sampled by every dispatcher tick. */
  'dispatcher.intake-set': setting,
  /** Repository-wide quiescence flag: pause-all sets it, resume-all clears it,
   * and while it is set no dispatcher tick attaches a runner to a queued build.
   * Deliberately independent of intake — intake governs new ticket intake, and
   * an operator who only turns intake off is declining new work, not disowning
   * work the repository has already accepted. */
  'dispatcher.pause-set': setting,
  /** Claim-time auto-merge default sampled by every dispatcher tick. */
  'dispatcher.auto-merge-default-set': setting,
} as const

export const repositoryEventPayloadSchemas = {
  ...harvestEventPayloadSchemas,
  ...dispatcherStatusEventPayloadSchemas,
  ...dispatcherSettingEventPayloadSchemas,
} as const

export type RepositoryEventType = keyof typeof repositoryEventPayloadSchemas
export const REPOSITORY_EVENT_TYPES = Object.keys(
  repositoryEventPayloadSchemas,
) as RepositoryEventType[]
export type RepositoryEventPayload<T extends RepositoryEventType> = z.infer<
  (typeof repositoryEventPayloadSchemas)[T]
>

export interface RepositoryEventEnvelope<T extends RepositoryEventType = RepositoryEventType> {
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

export interface RepositoryEventWrite<T extends RepositoryEventType = RepositoryEventType> {
  actor: Actor
  type: T
  payload: RepositoryEventPayload<T>
}

export type HarvestEventType = keyof typeof harvestEventPayloadSchemas
export type HarvestEventPayload<T extends HarvestEventType> = RepositoryEventPayload<T>
export type HarvestEventEnvelope<T extends HarvestEventType = HarvestEventType> =
  RepositoryEventEnvelope<T>
export type HarvestEvent = {
  [T in HarvestEventType]: RepositoryEventEnvelope<T>
}[HarvestEventType]
export type HarvestEventWrite<T extends HarvestEventType = HarvestEventType> =
  RepositoryEventWrite<T>

export const HARVEST_EVENT_TYPES = Object.keys(harvestEventPayloadSchemas) as HarvestEventType[]

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
  'dispatcher.run-started': ['dispatcher'],
  'dispatcher.run-stopped': ['dispatcher'],
  'dispatcher.config-rejected': ['dispatcher'],
  'dispatcher.config-publication-failed': ['dispatcher'],
  'dispatcher.tick-started': ['dispatcher'],
  'dispatcher.tick-completed': ['dispatcher'],
  'dispatcher.tick-failed': ['dispatcher'],
  'dispatcher.runner-settled': ['dispatcher'],
  'dispatcher.harvest-runner-failed': ['dispatcher'],
  'dispatcher.upgrade-available': ['dispatcher'],
  'dispatcher.operator-reported': ['human'],
  'dispatcher.config-reloaded': ['dispatcher'],
  'dispatcher.intake-set': ['human'],
  'dispatcher.pause-set': ['human'],
  'dispatcher.auto-merge-default-set': ['human'],
}

export function isHarvestEventType(value: string): value is HarvestEventType {
  return Object.hasOwn(harvestEventPayloadSchemas, value)
}

export function isHarvestEvent(event: RepositoryEvent): event is HarvestEvent {
  return isHarvestEventType(event.type)
}

export function isRepositoryEventType(value: string): value is RepositoryEventType {
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
  const result = repositoryEventPayloadSchemas[input.type].safeParse(input.payload)
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
