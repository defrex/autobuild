/**
 * The event vocabulary (SPEC §15.3), frozen as schemas — this closes open
 * thread §18.1. It is simultaneously the store schema, the kernel's I/O, the
 * UI API, and the resume format, so payloads are strict objects: unknown keys
 * are deposit errors, and schema errors are agent feedback (D6), not build
 * failures.
 *
 * Conventions (SPEC §15.2): closed vocabularies live in type names
 * (`plan.completed`); open ones live in payloads (`verify.completed {step}`).
 * Events carry facts and refs `{kind, rev}` — never derived state, never
 * blobs, never code (D3: code travels through the Forge; events carry SHAs).
 */
import { z } from 'zod'
import {
  artifactRefSchema,
  buildOutcomeSchema,
  commitRangeSchema,
  prAttachmentFilenameSchema,
  prImageHostSchema,
  escalationResolutionSchema,
  escalationSourceSchema,
  escalationTargetSchema,
  feedbackSchema,
  findingSchema,
  hostedPrAttachmentAssetSchema,
  mediaTypeSchema,
  observationKindSchema,
  phaseSchema,
  policyEscalationCauseSchema,
  reviewVerdictKindSchema,
  ticketRefSchema,
  workspaceBaseSchema,
  type ArtifactRef,
  type VerifyOutcome,
} from '../ontology'

const empty = z.strictObject({})
const reasonOnly = z.strictObject({ reason: z.string().optional() })
const round = z.number().int().positive()
const attempt = z.number().int().positive()
const dispatchStage = z.enum(['create', 'workspace', 'spec', 'comment', 'launch'])

export const agentFailureCauseSchema = z.enum([
  'availability',
  'exhaustion',
  'credentials',
  'configuration',
])

/** One configured execution target that failed within a single phase attempt. */
export const providerAttemptSchema = z.strictObject({
  index: z.number().int().nonnegative(),
  session: z.string().min(1),
  runner: z.string().min(1),
  model: z.string().optional(),
  error: z.string().min(1),
  cause: agentFailureCauseSchema.optional(),
})

export const providerAttemptsSchema = z
  .array(providerAttemptSchema)
  .min(1)
  .superRefine((attempts, ctx) => {
    attempts.forEach((attempt, index) => {
      if (attempt.index !== index) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'index'],
          message: `provider attempt index must be ${index} at this ordered position`,
        })
      }
    })
  })

export const providerSubstitutionSchema = z
  .strictObject({
    failed: providerAttemptSchema,
    selectedIndex: z.number().int().positive(),
  })
  .superRefine((value, ctx) => {
    if (value.selectedIndex !== value.failed.index + 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['selectedIndex'],
        message: 'selectedIndex must name the configured entry immediately after failed.index',
      })
    }
  })

const verifyStepSelectionSchema = z
  .array(
    z
      .string()
      .min(1, 'verify step names must be nonempty')
      .refine((step) => step.trim().length > 0, 'verify step names must not be blank'),
  )
  .superRefine((steps, ctx) => {
    const seen = new Set<string>()
    steps.forEach((step, index) => {
      if (seen.has(step)) {
        ctx.addIssue({
          code: 'custom',
          path: [index],
          message: `duplicate verify step ${JSON.stringify(step)}`,
        })
      }
      seen.add(step)
    })
  })

const verifyCompletionBase = {
  step: z.string().min(1),
  attempt,
}

/**
 * `verify.completed` is a durable protocol. The boolean branch remains
 * readable for historical logs; every current writer uses the canonical,
 * three-outcome branch. Keeping the branches strict prevents a producer from
 * smuggling a skip through `pass: true` or recording contradictory facts.
 */
const verifyCompletedPayloadSchema = z.union([
  z.strictObject({
    ...verifyCompletionBase,
    pass: z.boolean(),
    report: artifactRefSchema.optional(),
  }),
  z.discriminatedUnion('outcome', [
    z.strictObject({
      ...verifyCompletionBase,
      outcome: z.literal('pass'),
      report: artifactRefSchema.optional(),
    }),
    z.strictObject({
      ...verifyCompletionBase,
      outcome: z.literal('fail'),
      report: artifactRefSchema.optional(),
    }),
    z.strictObject({
      ...verifyCompletionBase,
      outcome: z.literal('skipped'),
      reason: z.string().trim().min(1, 'a skipped verification requires a non-blank reason'),
    }),
  ]),
])

/** A pushed head is a success checkpoint, never a claim attached to failure. */
const finalizeStepCompletedPayloadSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    step: z.string().min(1),
    ok: z.literal(true),
    note: z.string().optional(),
    headSha: z.string().trim().min(1, 'a finalize publication head must be non-blank').optional(),
  }),
  z.strictObject({
    step: z.string().min(1),
    ok: z.literal(false),
    note: z.string().optional(),
  }),
])

/** Shared by `plan-review.verdict` and `code-review.verdict` (symmetric by design). */
const reviewVerdictPayload = z.strictObject({
  round,
  verdict: reviewVerdictKindSchema,
  findings: z.array(findingSchema),
  artifact: artifactRefSchema,
  /** Present when `verdict` is `escalate`. */
  reason: z.string().optional(),
})

export const eventPayloadSchemas = {
  // ── Build lifecycle ────────────────────────────────────────────────────────
  'build.created': z.strictObject({
    ticket: ticketRefSchema,
    repo: z.string().min(1),
    baseBranch: z.string().min(1),
    /** Claim-time auto-merge intent retained across dispatch recovery until the
     * ordinary human-authored command fact can be materialized. */
    autoMergeRequestedBy: z.string().min(1).optional(),
    /** Frozen at claim time. Historical logs and disabled installs omit it. */
    pr: z
      .strictObject({
        imageHost: prImageHostSchema.optional(),
      })
      .optional(),
  }),
  'build.completed': z.strictObject({ outcome: buildOutcomeSchema }),
  'runner.attached': z.strictObject({
    instance: z.string().min(1),
    host: z.string().min(1),
    resumedFromSeq: z.number().int().nonnegative().optional(),
  }),
  /** Pre-phase setup infrastructure failed. `null` explicitly means the
   * command could not produce an exit status (for example, Exec threw). */
  'runner.setup-failed': z.strictObject({
    command: z.string().min(1),
    attempt,
    exitStatus: z.number().int().nullable(),
    output: z.string(),
  }),
  'workspace.provisioned': z.strictObject({
    provider: z.string().min(1),
    ref: z.string().min(1),
    /** Locally reachable working copy. Optional for historical event replay. */
    path: z.string().min(1).optional(),
    branch: z.string().min(1),
    base: workspaceBaseSchema,
  }),
  'workspace.released': empty,
  /** Checkpoints in the dispatcher-owned, retry-safe abort cleanup saga. */
  'abort.remote-branch-deleted': z.strictObject({ branch: z.string().min(1) }),
  'abort.local-branch-deleted': z.strictObject({ branch: z.string().min(1) }),
  'abort.ticket-returned': z.strictObject({
    ticket: ticketRefSchema,
    state: z.string().min(1),
    label: z.string().min(1),
  }),
  /** A post-creation dispatch attempt stopped before runner attachment. */
  'dispatch.failed': z.strictObject({
    stage: dispatchStage,
    attempt,
    error: z.string().min(1),
  }),
  /** Durable boundary preventing duplicate ticket notifications on recovery. */
  'dispatch.comment-posted': empty,

  // ── Operator commands (D2: commands are events in the same log) ───────────
  'build.pause-requested': reasonOnly,
  'build.resume-requested': reasonOnly,
  'build.abort-requested': reasonOnly,
  'build.discard-requested': empty,
  'build.auto-merge-requested': empty,
  'build.auto-merge-cancelled': empty,
  'build.paused': empty,
  'build.resumed': empty,
  'build.aborted': empty,

  // ── Spec (SPEC §6.3) ───────────────────────────────────────────────────────
  'spec.imported': z.strictObject({
    artifact: artifactRefSchema,
    ticket: ticketRefSchema,
  }),
  'spec.authored': z.strictObject({
    artifact: artifactRefSchema,
    session: z.string().min(1),
  }),
  'spec.revised': z.strictObject({
    artifact: artifactRefSchema,
    /** seq of the `escalation.raised` event that forced the revision. */
    escalation: z.number().int().positive(),
  }),

  // ── Sessions (every agent run is bracketed by these) ──────────────────────
  'session.started': z.strictObject({
    session: z.string().min(1),
    role: z.string().min(1),
    runner: z.string().min(1),
    model: z.string().optional(),
    phase: phaseSchema,
    round: round.optional(),
    /** Present only when this target substituted for the preceding failed one. */
    substitution: providerSubstitutionSchema.optional(),
  }),
  'session.ended': z.strictObject({
    session: z.string().min(1),
    transcript: artifactRefSchema,
    usage: z.strictObject({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      turns: z.number().int().nonnegative(),
    }),
  }),

  // ── Plan loop / code loop (symmetric by design) ────────────────────────────
  'plan.started': z.strictObject({
    round,
    /** Symmetric with `implement.started` (§15.6-B): guidance answered on a
     * plan-loop escalation must reach the producer even when the runner
     * parked and re-attached with a fresh session. The start is the carrier
     * `ab context` materializes from; a later matching `session.started` is
     * the durable consumption boundary. */
    feedback: feedbackSchema.optional(),
  }),
  'plan.completed': z.strictObject({
    round,
    artifact: artifactRefSchema,
    /** Effective plan-selected verify set in config order. Optional only so
     * historical logs retain their default-all meaning. */
    verifySteps: verifyStepSelectionSchema.optional(),
  }),
  'plan-review.started': z.strictObject({ round }),
  'plan-review.verdict': reviewVerdictPayload,
  'implement.started': z.strictObject({
    round,
    /** Carries routed feedback for this producer occurrence. Guidance remains
     * recoverable until a matching `session.started` records launch. */
    feedback: feedbackSchema.optional(),
  }),
  'implement.completed': z.strictObject({
    round,
    commits: commitRangeSchema,
    artifact: artifactRefSchema,
  }),
  'code-review.started': z.strictObject({ round }),
  'code-review.verdict': reviewVerdictPayload,

  // ── Verify / finalize ──────────────────────────────────────────────────────
  'verify.started': z.strictObject({
    step: z.string().min(1),
    attempt,
    /** An answered escalation raised by this agent verifier returns to the
     * same step. The start citation is the durable delivery carrier; the
     * subsequent matching `session.started` is the exactly-once consumption
     * boundary. Optional for historical logs and guidance-free check/skip
     * starts. */
    feedback: feedbackSchema.optional(),
  }),
  'verify.completed': verifyCompletedPayloadSchema,
  'finalize.started': empty,
  'finalize.completed': z.strictObject({
    pr: z.strictObject({
      number: z.number().int().positive(),
      url: z.string().min(1),
      headSha: z.string().min(1),
    }),
  }),
  'finalize.step-completed': finalizeStepCompletedPayloadSchema,

  // Any agent session may explicitly designate an exact deposited revision.
  // Successful external uploads are recorded immediately so retries can adopt
  // them and terminal cleanup never depends on a workspace or current config.
  'pr-attachment.designated': z.strictObject({
    artifact: artifactRefSchema,
    filename: prAttachmentFilenameSchema,
    mediaType: mediaTypeSchema,
  }),
  'pr-attachment.hosted': z.strictObject({
    /** seq of the correlated pr-attachment.designated fact. */
    designationSeq: z.number().int().positive(),
    asset: hostedPrAttachmentAssetSchema,
  }),
  'pr-attachment.reclaimed': z.strictObject({
    /** seq of the correlated pr-attachment.hosted fact. */
    hostedSeq: z.number().int().positive(),
  }),
  'pr-attachment.reclaim-failed': z.strictObject({
    hostedSeq: z.number().int().positive(),
    attempt,
    error: z.string().min(1),
  }),

  // ── Post-PR (D1: janitor duty of the dispatcher — SPEC §15.7) ─────────────
  'pr.auto-merge-enabled': z.strictObject({
    /** seq of the human auto-merge command this forge mutation applied. */
    commandSeq: z.number().int().positive(),
  }),
  'pr.auto-merge-disabled': z.strictObject({
    /** seq of the human auto-merge command this forge mutation applied. */
    commandSeq: z.number().int().positive(),
  }),
  'pr.merged': z.strictObject({ sha: z.string().min(1) }),
  'pr.closed': empty,
  'pr.conflicted': z.strictObject({ baseSha: z.string().min(1) }),
  'reconcile.progress-checked': z.strictObject({
    /** seq of the repeat pr.conflicted fact this authoritative read answers. */
    conflictSeq: z.number().int().positive(),
    /** Completed reconcile whose merge target is being compared. */
    attempt,
    baseSha: z.string().min(1),
  }),
  'reconcile.started': z.strictObject({ attempt, baseSha: z.string().min(1) }),
  'reconcile.completed': z.strictObject({
    mergeCommit: z.string().min(1),
    artifact: artifactRefSchema,
  }),

  // ── Cross-cutting ──────────────────────────────────────────────────────────
  'observation.recorded': z.strictObject({
    id: z.string().min(1),
    kind: observationKindSchema,
    summary: z.string().min(1),
    files: z.array(z.string()).optional(),
    refs: z.array(z.string()).optional(),
  }),
  'escalation.raised': z.strictObject({
    id: z.string().min(1),
    phase: escalationTargetSchema,
    round: round.optional(),
    source: escalationSourceSchema,
    /** Optional only so cause-less historical policy facts remain replayable.
     * validateEventWrite requires it on every current policy append. */
    policyCause: policyEscalationCauseSchema.optional(),
    question: z.string().min(1),
    refs: z.array(z.string()).optional(),
  }),
  'escalation.answered': z.strictObject({
    id: z.string().min(1),
    answer: z.string().min(1),
    resolution: escalationResolutionSchema,
    /** Exact replacement spec authorized by a `revise-spec` answer. */
    artifact: artifactRefSchema.optional(),
  }),
  /** Infra failure — distinct from verdicts (a verdict is a fact, not a failure). */
  'phase.failed': z.strictObject({
    phase: phaseSchema,
    round: round.optional(),
    attempt,
    error: z.string().min(1),
    willRetry: z.boolean(),
    /** Ordered configured targets tried inside this one phase attempt. */
    providerAttempts: providerAttemptsSchema.optional(),
  }),
} as const

export type EventType = keyof typeof eventPayloadSchemas

export const EVENT_TYPES = Object.keys(eventPayloadSchemas) as EventType[]

export type EventPayload<T extends EventType> = z.infer<(typeof eventPayloadSchemas)[T]>

/** Canonical read shape shared by the reducer, engine, and query surfaces. */
export interface NormalizedVerifyCompletion {
  step: string
  attempt: number
  outcome: VerifyOutcome
  report?: ArtifactRef
  reason?: string
}

/**
 * Normalize exactly once at each event-consumer boundary. Legacy booleans keep
 * their historical meaning; `skipped` is never represented as either boolean.
 */
export function normalizeVerifyCompletion(
  payload: EventPayload<'verify.completed'>,
): NormalizedVerifyCompletion {
  if ('pass' in payload) {
    return {
      step: payload.step,
      attempt: payload.attempt,
      outcome: payload.pass ? 'pass' : 'fail',
      ...(payload.report !== undefined ? { report: payload.report } : {}),
    }
  }
  if (payload.outcome === 'skipped') {
    return {
      step: payload.step,
      attempt: payload.attempt,
      outcome: 'skipped',
      reason: payload.reason,
    }
  }
  return {
    step: payload.step,
    attempt: payload.attempt,
    outcome: payload.outcome,
    ...(payload.report !== undefined ? { report: payload.report } : {}),
  }
}

export function isEventType(value: string): value is EventType {
  return Object.hasOwn(eventPayloadSchemas, value)
}
