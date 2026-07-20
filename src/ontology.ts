/**
 * The ontology (SPEC §4): one name, used everywhere; every noun lives in
 * exactly one layer. Schemas are the source of truth — the `ab` CLI and the
 * store validate deposits against them (D6), and the TypeScript types are
 * inferred.
 *
 * Reserved-word discipline: **build** names the whole pipeline execution and
 * nothing else; the coding phase is **implement**.
 */
import { z } from 'zod'

// ── Phases (SPEC §5) ─────────────────────────────────────────────────────────

export const CORE_PHASES = [
  'plan',
  'plan-review',
  'implement',
  'code-review',
  'finalize',
  'reconcile',
] as const
export type CorePhase = (typeof CORE_PHASES)[number]

/** Verify steps are config-defined — an open set (SPEC §15.2.1). */
export type VerifyPhase = `verify:${string}`
export type Phase = CorePhase | VerifyPhase

export function isCorePhase(value: string): value is CorePhase {
  return (CORE_PHASES as readonly string[]).includes(value)
}

export function isVerifyPhase(value: string): value is VerifyPhase {
  return value.startsWith('verify:') && value.length > 'verify:'.length
}

export function isPhase(value: string): value is Phase {
  return isCorePhase(value) || isVerifyPhase(value)
}

/** `verify:e2e` → `e2e` */
export function verifyStep(phase: VerifyPhase): string {
  return phase.slice('verify:'.length)
}

export function verifyPhase(step: string): VerifyPhase {
  return `verify:${step}`
}

export const phaseSchema = z.custom<Phase>(
  (value) => typeof value === 'string' && isPhase(value),
  { message: 'not a phase: expected a core phase or "verify:<step>"' },
)

// ── Findings (SPEC §15.4) ────────────────────────────────────────────────────

export const severitySchema = z.enum(['blocking', 'important', 'minor'])
export type Severity = z.infer<typeof severitySchema>

export const findingSchema = z.strictObject({
  /** Kernel-assigned at deposit, stable for the build (e.g. `f_3a91`). */
  id: z.string().min(1),
  severity: severitySchema,
  file: z.string().optional(),
  lines: z.array(z.number().int()).optional(),
  summary: z.string().min(1),
  detail: z.string().optional(),
  /** Reviewer-marked: ids of earlier findings this one continues (stall input). */
  persists: z.array(z.string()).default([]),
})
export type Finding = z.infer<typeof findingSchema>

/** What an agent submits — ids are stamped at deposit, never self-assigned. */
export const findingDraftSchema = findingSchema.omit({ id: true })
export type FindingDraft = z.infer<typeof findingDraftSchema>

// ── Verdicts (SPEC §4, §10) ──────────────────────────────────────────────────

/** Review-phase vocabulary (`plan-review`, `code-review`). */
export const reviewVerdictKindSchema = z.enum(['approve', 'revise', 'escalate'])
export type ReviewVerdictKind = z.infer<typeof reviewVerdictKindSchema>

/** Durable outcome of any `verify.completed` fact. */
export const verifyOutcomeSchema = z.enum(['pass', 'fail', 'skipped'])
export type VerifyOutcome = z.infer<typeof verifyOutcomeSchema>

/** Agent-verify CLI vocabulary (`verify:*` steps of kind "agent"). */
export const verifyVerdictKindSchema = z.enum(['pass', 'fail', 'skip'])
export type VerifyVerdictKind = z.infer<typeof verifyVerdictKindSchema>

/** Structured outcome of a review, as consumed by `converge` (SPEC §10). */
export type Verdict =
  | { verdict: 'approve' }
  | { verdict: 'revise'; findings: Finding[] }
  | { verdict: 'escalate'; reason: string }

// ── Observations (SPEC §4, §12) ──────────────────────────────────────────────

export const observationKindSchema = z.enum(['followup', 'refactor', 'latent-bug'])
export type ObservationKind = z.infer<typeof observationKindSchema>

// ── Escalations (SPEC §11, §15.3) ────────────────────────────────────────────

export const escalationSourceSchema = z.enum(['agent', 'stall', 'policy'])
export type EscalationSource = z.infer<typeof escalationSourceSchema>

export const escalationResolutionSchema = z.enum([
  'guidance',
  'dismiss-finding',
  'revise-spec',
  'abort',
  /** Bare re-attempt with no phase guidance: human UI, or policy-only startup. */
  'retry',
])
export type EscalationResolution = z.infer<typeof escalationResolutionSchema>

// ── Tickets ──────────────────────────────────────────────────────────────────

export const ticketRefSchema = z.strictObject({
  source: z.string().min(1),
  id: z.string().min(1),
  url: z.string().optional(),
  title: z.string().optional(),
})
export type TicketRef = z.infer<typeof ticketRefSchema>

// ── Artifacts ────────────────────────────────────────────────────────────────

/**
 * Revisions are 0-based per kind: the first deposit of a kind is rev 0
 * (normative in SPEC §6.3 — the spec is "kind `spec`, revision 0"), and every
 * later deposit of the same kind is max+1.
 */
export const artifactRefSchema = z.strictObject({
  kind: z.string().min(1),
  rev: z.number().int().nonnegative(),
})
export type ArtifactRef = z.infer<typeof artifactRefSchema>

/** Closed set of core kinds; verify reports are per-step (open set). */
export const CORE_ARTIFACT_KINDS = [
  'spec',
  'plan',
  'plan-review',
  'implement-notes',
  'code-review',
  'pr-description',
  'reconcile-notes',
  'transcript',
] as const
export type CoreArtifactKind = (typeof CORE_ARTIFACT_KINDS)[number]

/** `e2e` → `verify-report:e2e` */
export function verifyReportKind(step: string): string {
  return `verify-report:${step}`
}

// ── Dashboard frame hosting ──────────────────────────────────────────────────

/** Deliberately narrower than GitHub's full repository-name policy: one
 * non-blank, whitespace-free `owner/repo` pair is enough for deterministic
 * routing without pretending to validate a remote identifier locally. */
export const githubRepositorySchema = z
  .string()
  .regex(
    /^[^/\s]+\/[^/\s]+$/,
    'expected exactly one non-blank GitHub repository pair in "owner/repo" form',
  )
export type GitHubRepository = z.infer<typeof githubRepositorySchema>

/** Optional, frozen destination for review-window dashboard PNG copies. */
export const dashboardFrameHostSchema = z.strictObject({
  provider: z.literal('github-release'),
  repository: githubRepositorySchema,
  releaseId: z.number().int().positive(),
})
export type DashboardFrameHostTarget = z.infer<typeof dashboardFrameHostSchema>

/** Durable deletion handle returned by GitHub after one frame is hosted. */
export const hostedDashboardFrameAssetSchema = z.strictObject({
  provider: z.literal('github-release'),
  repository: githubRepositorySchema,
  releaseId: z.number().int().positive(),
  assetId: z.number().int().positive(),
  url: z
    .string()
    .url()
    .refine((url) => url.startsWith('https://'), 'hosted dashboard frame URL must use HTTPS'),
})
export type HostedDashboardFrameAsset = z.infer<
  typeof hostedDashboardFrameAssetSchema
>

// ── Builds ───────────────────────────────────────────────────────────────────

export const buildOutcomeSchema = z.enum(['merged', 'closed-unmerged', 'abandoned'])
export type BuildOutcome = z.infer<typeof buildOutcomeSchema>

/** Derived status — a reduction of events, never stored (SPEC §15.5). */
export const BUILD_STATUSES = [
  'queued',
  'running',
  'paused',
  'blocked',
  'done',
  'aborted',
] as const
export type BuildStatus = (typeof BUILD_STATUSES)[number]

export const commitRangeSchema = z.strictObject({
  base: z.string().min(1),
  head: z.string().min(1),
})
export type CommitRange = z.infer<typeof commitRangeSchema>

/** How a workspace's branch tip was selected at provision time. */
export const workspaceBaseSchema = z.discriminatedUnion('source', [
  z.strictObject({
    source: z.literal('remote'),
    sha: z.string().min(1),
  }),
  z.strictObject({
    source: z.literal('local'),
    sha: z.string().min(1),
    remoteError: z.string().min(1),
  }),
  z.strictObject({
    source: z.literal('existing'),
    sha: z.string().min(1),
  }),
])
export type WorkspaceBase = z.infer<typeof workspaceBaseSchema>

// ── Feedback (producer round input — SPEC §10, §15.3 implement.started) ──────

export const feedbackSchema = z.union([
  /** Findings from a revise verdict, by id (payloads carry refs, not blobs). */
  z.strictObject({ findings: z.array(z.string()) }),
  /** A verify failure report routed back into the code loop (SPEC §5). */
  z.strictObject({
    verify: z.strictObject({ step: z.string(), report: artifactRefSchema }),
  }),
  /** A human escalation answer fed in as authoritative feedback (§15.6-B). */
  z.strictObject({
    guidance: z.strictObject({ escalation: z.string(), answer: z.string() }),
  }),
])
export type Feedback = z.infer<typeof feedbackSchema>
