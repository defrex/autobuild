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
  dashboardFrameHostSchema,
  escalationResolutionSchema,
  escalationSourceSchema,
  feedbackSchema,
  findingSchema,
  hostedDashboardFrameAssetSchema,
  observationKindSchema,
  phaseSchema,
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
    /** Frozen at claim time. Historical logs and disabled installs omit it. */
    dashboardFrames: dashboardFrameHostSchema.optional(),
  }),
  'build.completed': z.strictObject({ outcome: buildOutcomeSchema }),
  'runner.attached': z.strictObject({
    instance: z.string().min(1),
    host: z.string().min(1),
    resumedFromSeq: z.number().int().nonnegative().optional(),
  }),
  'workspace.provisioned': z.strictObject({
    provider: z.string().min(1),
    ref: z.string().min(1),
    branch: z.string().min(1),
    base: workspaceBaseSchema,
  }),
  'workspace.released': empty,

  // ── Operator commands (D2: commands are events in the same log) ───────────
  'build.pause-requested': reasonOnly,
  'build.resume-requested': reasonOnly,
  'build.abort-requested': reasonOnly,
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
     * parked and re-attached with a fresh session — the started payload is
     * the carrier `ab context` materializes from. */
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
  'verify.started': z.strictObject({ step: z.string().min(1), attempt }),
  'verify.completed': verifyCompletedPayloadSchema,
  'finalize.started': empty,
  'finalize.completed': z.strictObject({
    pr: z.strictObject({
      number: z.number().int().positive(),
      url: z.string().min(1),
      headSha: z.string().min(1),
    }),
  }),
  'finalize.step-completed': z.strictObject({
    step: z.string().min(1),
    ok: z.boolean(),
    note: z.string().optional(),
  }),

  // Successful external uploads are recorded immediately so retries can
  // adopt them and terminal-build cleanup never depends on a workspace or the
  // repository's current config.
  'dashboard-frame.hosted': z.strictObject({
    frameId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    artifact: artifactRefSchema,
    asset: hostedDashboardFrameAssetSchema,
  }),
  'dashboard-frame.reclaimed': z.strictObject({
    /** seq of the correlated dashboard-frame.hosted fact. */
    hostedSeq: z.number().int().positive(),
  }),
  'dashboard-frame.reclaim-failed': z.strictObject({
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
    phase: phaseSchema,
    round: round.optional(),
    source: escalationSourceSchema,
    question: z.string().min(1),
    refs: z.array(z.string()).optional(),
  }),
  'escalation.answered': z.strictObject({
    id: z.string().min(1),
    answer: z.string().min(1),
    resolution: escalationResolutionSchema,
  }),
  /** Infra failure — distinct from verdicts (a verdict is a fact, not a failure). */
  'phase.failed': z.strictObject({
    phase: phaseSchema,
    round: round.optional(),
    attempt,
    error: z.string().min(1),
    willRetry: z.boolean(),
  }),
} as const

export type EventType = keyof typeof eventPayloadSchemas

export const EVENT_TYPES = Object.keys(eventPayloadSchemas) as EventType[]

export type EventPayload<T extends EventType> = z.infer<
  (typeof eventPayloadSchemas)[T]
>

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
