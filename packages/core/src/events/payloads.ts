import { selectedAccountSchema } from '../config/accounts'
import { runtimeIdentitySchema } from './runtime'
import { viaSchema } from './envelope'
import { nativeSessionHandleSchema } from './native-session'
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
import { landingRuleSchema } from '../config/landing'
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

export const gitOid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
export const reconcileTransactionSchema = z.strictObject({
  id: z.string().min(1),
  attempt: z.number().int().positive(),
  restackId: z.string().min(1).optional(),
  branch: z.string().min(1),
  oldHead: gitOid,
  oldBase: gitOid,
  targetBase: gitOid,
  changeSha: gitOid,
  workspaceHead: gitOid,
  localBranchHead: gitOid,
})
export const leafRestackSchema = reconcileTransactionSchema.omit({ attempt: true }).extend({
  trigger: z.enum(['verify-entry', 'awaiting-landing']),
  cycle: z.number().int().nonnegative(),
  observation: z.number().int().positive(),
  message: z.string().min(1),
})
const archiveEntry = z.strictObject({
  ref: z.string().startsWith('refs/autobuild/archive/'),
  sha: gitOid,
})

export const landingCandidateSchema = z.strictObject({
  head: z.string().min(1),
  parent: z.string().min(1),
  cycle: z.string().min(1),
})
const landingDecision = z.strictObject({
  candidate: landingCandidateSchema,
  from: z.enum(['leaf', 'node']),
  into: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('root') }),
    z.strictObject({ kind: z.literal('node'), ticket: z.string().min(1) }),
  ]),
  labels: z.array(z.string()),
  mode: z.enum(['auto', 'consent']),
  rule: z.union([
    z.strictObject({ index: z.number().int().nonnegative(), snapshot: landingRuleSchema }),
    z.strictObject({ default: z.literal(true) }),
  ]),
})
const nodeParent = z.strictObject({
  target: z.strictObject({ ticket: ticketRefSchema, build: z.string().min(1) }).nullable(),
  branch: z.string().min(1),
})
const parentChange = z.strictObject({
  id: z.string().min(1),
  old: nodeParent,
  next: nodeParent,
  revision: z.string(),
})

const empty = z.strictObject({})
const reasonOnly = z.strictObject({ reason: z.string().optional() })
/** Fan-out provenance shared by the auto-merge command facts: the repository
 * seq of the `dispatcher.auto-merge-default-set` fact that caused the command,
 * when one did. Per-build commands omit it. `{}` stays valid, so existing
 * producers and logs replay unchanged. */
const autoMergeCommand = z.strictObject({
  integrationConsent: z.literal(true).optional(),
  defaultSeq: z.number().int().positive().optional(),
})
/** A fan-out reconciliation marker: the repository seq of the newest
 * `dispatcher.auto-merge-default-set` fact a build has observed when that fact
 * already matched the build's requested state. It advances the build's
 * provenance without appending a duplicate request/cancel command, so a later
 * per-build toggle stands until a strictly newer default fact arrives
 * (f_28b3fba1). Dispatcher-authored: it records a reconciliation, not a
 * human command. */
const autoMergeDefaultObserved = z.strictObject({
  defaultSeq: z.number().int().positive(),
})
const round = z.number().int().positive()
const attempt = z.number().int().positive()
const dispatchStage = z.enum(['create', 'workspace', 'spec', 'comment', 'branch', 'launch'])
const infrastructureOperation = z.enum([
  'provision',
  'start',
  'wait',
  'stop',
  'delete',
  'reconcile',
])
const infrastructureCause = z.enum([
  'missing',
  'session-expired',
  'timeout',
  'provider-limit',
  'provider-error',
  'unknown-outcome',
])

export const agentFailureCauseSchema = z.enum([
  'availability',
  'exhaustion',
  'credentials',
  'configuration',
])

/** One configured execution target that failed within a single phase attempt. */
export const providerAttemptSchema = z.strictObject({
  account: selectedAccountSchema.optional(),
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
  baseSha: gitOid.optional(),
  headSha: gitOid.optional(),
  restackId: z.string().min(1).optional(),
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
      skipCause: z.literal('post-reconcile-policy').optional(),
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

/** One ticket asset revision a build froze (SPEC §6.3): the identity and
 * shape of what `listTicketAssets` returned at the pinning moment. */
export const pinnedAssetSchema = z.strictObject({
  snapshot: z
    .strictObject({
      kind: z.string().regex(/^ticket-snapshot-[a-f0-9-]+$/),
      revision: z.number().int().nonnegative(),
    })
    .optional(),
  kind: z.string().min(1),
  name: z.string().min(1),
  revision: z.number().int().nonnegative(),
  layout: z.enum(['file', 'tree']),
  size: z.number().int().nonnegative(),
  fileCount: z.number().int().nonnegative(),
  dirCount: z.number().int().nonnegative(),
})

export type PinnedAsset = z.infer<typeof pinnedAssetSchema>

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
  'build.compatibility-deferred': z.strictObject({
    boundary: z.number().int().positive(),
    types: z.array(z.string().min(1)).min(1),
    writerVersions: z.array(z.string().min(1)),
    legacyVersionUnavailable: z.boolean(),
    diagnostic: z.string().min(1),
  }),
  // ── Build lifecycle ────────────────────────────────────────────────────────
  'build.created': z.strictObject({
    ticket: ticketRefSchema,
    repo: z.string().min(1),
    baseBranch: z.string().min(1),
    kind: z.enum(['work', 'node']).optional(),
    target: z.strictObject({ ticket: ticketRefSchema, build: z.string().min(1) }).optional(),
    /** Claim-time auto-merge intent retained across dispatch recovery until the
     * ordinary human-authored command fact can be materialized. */
    autoMergeRequestedBy: z.string().min(1).optional(),
    /** Claim-time auto-merge intent provenance: the repository seq of the
     * `dispatcher.auto-merge-default-set` fact the claim sampled. Retained for
     * the same recovery window as `autoMergeRequestedBy`; omitted when the
     * claim sampled no default fact. */
    autoMergeDefaultSeq: z.number().int().positive().optional(),
    /** Frozen at claim time. Historical logs and disabled installs omit it. */
    pr: z
      .strictObject({
        imageHost: prImageHostSchema.optional(),
      })
      .optional(),
    /** Ticket assets frozen at claim time. Omitted when the ticket had none
     * and in historical logs. */
    assets: z.array(pinnedAssetSchema).optional(),
  }),
  'node.opening': z.strictObject({
    branch: z.string().min(1),
    parent: z.string().min(1),
    sha: z.string().min(1),
  }),
  'node.restack-requested': z
    .strictObject({
      id: z.string().min(1),
      reason: z.enum(['operator', 'presence']),
      branch: z.string().min(1),
      parent: z.string().min(1),
      dependent: ticketRefSchema.optional(),
      identities: z.array(z.string()).optional(),
    })
    .refine(
      (request) =>
        request.reason !== 'presence' ||
        (request.dependent !== undefined &&
          request.identities !== undefined &&
          request.identities.length > 0),
      'presence demand requires a dependent ticket and nonempty identities',
    ),
  'node.restack-satisfied': z.strictObject({
    id: z.string().min(1),
    parent: z.string().min(1),
    outcome: z.enum(['covered', 'destination-changed']),
  }),
  'node.parent-distance': z.strictObject({
    base: z.string().min(1),
    parent: z.string().min(1),
    branch: z.string().min(1),
    count: z.number().int().nonnegative().nullable(),
  }),
  'node.parent-requested': parentChange,
  'node.parent-accepted': parentChange,
  'node.parent-pr-retargeted': z.strictObject({ id: z.string().min(1), base: z.string().min(1) }),
  'node.parent-completed': z.strictObject({ id: z.string().min(1) }),
  'node.parent-cancelled': z.strictObject({ id: z.string().min(1), reason: z.string() }),
  'node.parent-rejection-cleared': z.strictObject({
    revision: z.string(),
    target: z.string().nullable(),
  }),
  'node.parent-rejected': z.strictObject({
    revision: z.string(),
    target: z.string().nullable(),
    reason: z.string(),
  }),
  'node.opened': z.strictObject({ sha: z.string().min(1) }),
  'node.writer-reserved': z.strictObject({
    id: z.string().min(1),
    operation: z.enum(['restack', 'landing']),
    requests: z.array(z.string().min(1)).optional(),
    expected: z.string().min(1),
    parent: z.string().min(1),
    oldBase: z.string().min(1),
    source: z.string().min(1).optional(),
    archive: z.string().min(1),
    changes: z.array(
      z.strictObject({
        sha: z.string().min(1),
        build: z.string().min(1).optional(),
        mainline: z.literal(1).optional(),
      }),
    ),
    upstreamBuilds: z.array(z.string()),
    merges: z.array(
      z.strictObject({
        sha: z.string().min(1),
        parent: z.string().min(1),
        identities: z.array(z.string()),
        build: z.string().optional(),
        missing: z.array(z.string()),
      }),
    ),
  }),
  'node.item-prepared': z.strictObject({
    id: z.string().min(1),
    index: z.number().int().nonnegative(),
    base: z.string().min(1),
  }),
  'node.item-replayed': z.strictObject({
    id: z.string().min(1),
    index: z.number().int().nonnegative(),
    base: z.string().min(1),
    head: z.string().min(1),
    dropped: z.boolean(),
    dropReason: z.enum(['upstream-identity', 'upstream-commit']).optional(),
  }),
  'node.item-conflicted': z.strictObject({
    files: z.array(z.string()).optional(),
    id: z.string().min(1),
    index: z.number().int().nonnegative(),
    base: z.string().min(1),
  }),
  'node.publish-intended': z.strictObject({ id: z.string().min(1), head: z.string().min(1) }),
  'node.rewritten': z.strictObject({
    id: z.string().min(1),
    previous: z.string().min(1),
    head: z.string().min(1),
  }),
  'node.writer-settled': z.strictObject({
    id: z.string().min(1),
    outcome: z.enum(['completed', 'contended', 'abandoned']),
    actual: z.string().nullable().optional(),
  }),
  'node.contribution-recorded': z.strictObject({
    landing: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    head: z.string().min(1),
    base: z.string().min(1),
    identities: z.array(
      z.string().regex(/^(?:build:[a-z0-9][a-z0-9-]*|foreign:[0-9a-f]{40}(?:[0-9a-f]{24})?)$/),
    ),
  }),
  'node.inventory': z.strictObject({
    head: z.string().min(1),
    base: z.string().min(1).optional(),
    builds: z.array(z.string()),
    contributions: z.array(z.string()).optional(),
    foreign: z.array(z.string()),
  }),
  'integration.abandoned': z.strictObject({ id: z.string().min(1), reason: z.string().min(1) }),
  'integration.observed': z.strictObject({
    membershipSource: z.string().optional(),
    openChildren: z.array(z.string()),
    diagnostics: z.array(z.string()),
    contributions: z.array(z.string()),
    children: z
      .array(
        z.strictObject({
          source: z.string(),
          id: z.string(),
          title: z.string().optional(),
          builds: z.array(z.string()).optional(),
          claims: z.array(z.string()).optional(),
        }),
      )
      .optional(),
  }),
  'integration.verification-failed': z.strictObject({
    id: z.string().trim().min(1),
    head: z.string().trim().min(1),
    parent: z.string().trim().min(1),
    steps: z
      .array(z.string().trim().min(1))
      .min(1)
      .refine((steps) => new Set(steps).size === steps.length, 'failed steps must be unique'),
    guidance: z.string().trim().min(1),
  }),
  'integration.prepared': z.strictObject({
    id: z.string().min(1),
    head: z.string().min(1),
    parent: z.string().min(1),
    context: z
      .strictObject({
        kind: z.literal('node-verification-context'),
        rev: z.number().int().nonnegative(),
      })
      .optional(),
    config: z.string().min(1),
  }),
  'integration.landing-intended': z
    .strictObject({
      id: z.string().min(1),
      cycle: z.string().min(1),
      head: z.string().min(1),
      parent: z.string().min(1),
      commandSeq: z.number().int().positive().optional(),
      decisionSeq: z.number().int().positive().optional(),
      fenced: z.boolean(),
      evidence: z.array(z.string()),
    })
    .refine(
      (value) => value.commandSeq !== undefined || value.decisionSeq !== undefined,
      'merge intent requires decisionSeq or legacy commandSeq',
    ),
  'integration.landed': z.strictObject({
    operation: z.string().optional(),
    head: z.string().min(1),
    landed: z.string().min(1),
    provenance: z.enum(['kernel', 'human']),
    verified: z.boolean(),
    fenced: z.boolean(),
  }),
  'integration.audited': z.strictObject({
    operation: z.string().min(1),
    verifiedTree: z.string().min(1),
    landedTree: z.string().min(1),
    identities: z.array(z.string()),
  }),
  'node.poll-checked': z.strictObject({
    activityKey: z.string().min(1),
    unchangedSince: z.iso.datetime(),
    nodeIdleAfterSeconds: z.number().int().positive(),
    nodeIdlePollSeconds: z.number().int().positive(),
  }),
  'node.compared': z.strictObject({
    parentSha: z.string().min(1),
    headSha: z.string().min(1),
    ahead: z.number().int().nonnegative(),
  }),
  'pr.opened': z.strictObject({
    pr: z.strictObject({
      number: z.number().int().positive(),
      url: z.string().min(1),
      headSha: z.string().min(1),
    }),
  }),
  'build.completed': z.strictObject({ outcome: buildOutcomeSchema }),
  'runner.runtime-recorded': z.strictObject({
    instance: z.string().min(1),
    attachedSeq: z.number().int().positive(),
    runtime: runtimeIdentitySchema,
  }),
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
    /** Working-copy path in the provider execution environment. Optional only
     * for historical event replay. */
    path: z.string().min(1).optional(),
    /** Dispatcher-reachable path. Remote providers intentionally omit it. */
    localPath: z.string().min(1).optional(),
    /** True when the provider reported a remote publication capability at
     * provision time. Absent ⇒ local (historical journals). AUT-505 removes
     * the legacy fallback that reads absent as the provider name. */
    remote: z.boolean().optional(),
    branch: z.string().min(1),
    base: workspaceBaseSchema,
  }),
  'workspace.released': z.union([
    empty,
    z.strictObject({
      ref: z.string().min(1),
      reason: z.enum(['completion', 'abort', 'pause', 'blocked', 'replacement', 'discard']),
    }),
  ]),
  /** Durable marker that background provisioning of this build's remote
   * workspace has begun. The marker's liveness is the build's execution lease:
   * a holder heartbeats it while provisioning, so a dead provisioner's marker
   * is adopted within one lease TTL. */
  'workspace.provision-started': z.strictObject({
    provider: z.string().min(1),
    branch: z.string().min(1),
    generation: z.number().int().nonnegative(),
  }),
  /** Dispatcher-owned identity and provider lifecycle evidence. These facts do
   * not carry pipeline progress; they make disposable execution observable. */
  'execution.relaunch-requested': z.strictObject({
    instance: z.string().min(1),
    correlation: z.string().min(1),
    from: runtimeIdentitySchema,
    to: runtimeIdentitySchema,
  }),
  'execution.drain-authorized': z.strictObject({
    targetRuntime: runtimeIdentitySchema.optional(),
    correlation: z.string().min(1),
    run: z.string().min(1),
    runtime: runtimeIdentitySchema,
    instance: z.string().min(1),
  }),
  'execution.drain-settled': z.strictObject({
    correlation: z.string().min(1),
    instance: z.string().min(1),
  }),
  'execution.started': z.strictObject({
    provider: z.string().min(1),
    workspaceRef: z.string().min(1),
    instance: z.string().min(1),
    environmentId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    /** Provider-native detached command id, recorded at launch so a later
     * process can re-observe the execution without process memory. Optional
     * only so historical journals replay without migration. */
    commandId: z.string().min(1).optional(),
  }),
  /** Confirmed executor completion is the infrastructure retry-epoch boundary. */
  'execution.ended': z.strictObject({
    instance: z.string().min(1),
    workspaceRef: z.string().min(1),
    outcome: z.enum(['completed', 'stopped', 'lost', 'relaunch']),
    exitCode: z.number().int().nullable().optional(),
  }),
  'infrastructure.failed': z.strictObject({
    provider: z.string().min(1),
    workspaceRef: z.string().min(1),
    instance: z.string().min(1),
    environmentId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    operation: infrastructureOperation,
    cause: infrastructureCause,
    attempt,
    retryable: z.boolean(),
    cleanupPending: z.boolean(),
    error: z.string().min(1),
  }),
  'infrastructure.cleanup-attempted': z.strictObject({
    provider: z.string().min(1),
    workspaceRef: z.string().min(1),
    operation: z.enum(['stop', 'delete', 'reconcile']),
    attempt,
    outcome: z.enum(['confirmed', 'absent', 'unknown']),
    error: z.string().min(1).optional(),
    /** Snapshot-purge evidence for environments whose provider leaves automatic
     * snapshots behind. Absence is provable from Store events without querying
     * the provider; emitters without snapshots omit the field. */
    snapshots: z
      .strictObject({
        outcome: z.enum(['confirmed', 'absent', 'unknown']),
        deleted: z.number().int().min(0).optional(),
        error: z.string().min(1).optional(),
      })
      .optional(),
  }),
  /** Optional summary publication identities and durable write budgets. */
  'pr-summary.requested': z.strictObject({
    occurrence: z.number().int().positive(),
    boundary: z.number().int().positive(),
  }),
  'pr-summary.attempted': z.strictObject({
    occurrence: z.number().int().positive(),
    boundary: z.number().int().positive(),
    pr: z.number().int().positive(),
  }),
  'pr-summary.result': z.strictObject({
    attempt: z.number().int().positive(),
    outcome: z.enum(['success', 'failure', 'rate-limited']),
    eligibleAfter: z.string().datetime().optional(),
  }),
  'pr-summary.settled': z.strictObject({
    request: z.number().int().positive(),
    disposition: z.enum(['attempted', 'skipped', 'deferred']),
  }),
  'finalize.step-started': z.strictObject({ step: z.string().min(1) }),
  'publication.retry-scheduled': z.strictObject({
    operation: z.enum(['restack', 'reconcile']),
    rewriteId: z.string().min(1),
    round: round,
    anchor: z.number().int().nonnegative(),
    failure: z.number().int().min(1).max(6),
    error: z.string().min(1),
    retryAt: z.iso.datetime(),
  }),
  'publication.retry-exhausted': z.strictObject({
    operation: z.enum(['restack', 'reconcile']),
    rewriteId: z.string().min(1),
    round: round,
    anchor: z.number().int().nonnegative(),
    failure: z.literal(7),
    error: z.string().min(1),
  }),
  /** Remote phases deposit their output and park before trusted publication.
   * The dispatcher settles the request only after the VM session and execution
   * lease are gone, then appends the ordinary phase completion fact. */
  'publication.requested': z.discriminatedUnion('operation', [
    z.strictObject({
      operation: z.literal('restack'),
      branch: z.string().min(1),
      sha: gitOid,
      rewrite: leafRestackSchema.extend({ headSha: gitOid }),
    }),
    z.strictObject({
      operation: z.literal('implement'),
      branch: z.string().min(1),
      sha: z.string().regex(/^[0-9a-f]{40,64}$/i),
      round,
      base: z.string().regex(/^[0-9a-f]{40,64}$/i),
      artifact: artifactRefSchema,
    }),
    z.strictObject({
      operation: z.literal('reconcile'),
      rewrite: reconcileTransactionSchema.extend({ conflicted: z.boolean() }).optional(),
      branch: z.string().min(1),
      sha: z.string().regex(/^[0-9a-f]{40,64}$/i),
      artifact: artifactRefSchema,
    }),
    z.strictObject({
      operation: z.literal('finalize'),
      branch: z.string().min(1),
      sha: z.string().regex(/^[0-9a-f]{40,64}$/i),
      description: artifactRefSchema,
    }),
    z.strictObject({
      operation: z.literal('finalize-step'),
      branch: z.string().min(1),
      sha: z.string().regex(/^[0-9a-f]{40,64}$/i),
      step: z.string().min(1),
    }),
  ]),
  /** Durable loss record: the dispatcher released (or is about to release) the
   * workspace while the referenced `publication.requested` (named by `request`,
   * its seq) could not be completed. Appended by the last-chance release guard
   * (settlePublicationBeforeRelease) BEFORE `workspace.released`, so an
   * operator reading the log alone can distinguish pending (a request with no
   * settling successor), done (the operation's completion fact), and lost
   * (this event). Deliberately no competing status field — this fact plus the
   * request's seq is the whole surface. Recovery continues through the
   * existing abandoned-publication flow, which re-runs the phase. */
  'publication.lost': z.strictObject({
    /** seq of the lost `publication.requested` event. */
    request: z.number().int().positive(),
    operation: z.enum(['implement', 'reconcile', 'restack', 'finalize', 'finalize-step']),
    branch: z.string().min(1),
    sha: z.string().regex(/^[0-9a-f]{40,64}$/i),
    reason: z.string().trim().min(1),
  }),
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
  'build.janitor-attempt-failed': z.strictObject({
    firstFailureAt: z.iso.datetime(),
    attempt: z.number().int().positive(),
    message: z.string().min(1),
    nextAttemptAt: z.iso.datetime(),
  }),
  'build.janitor-failing': z.strictObject({ message: z.string().min(1) }),
  'build.janitor-recovered': empty,
  'landing.application-failed': z.strictObject({
    candidate: landingCandidateSchema,
    decisionSeq: z.number().int().positive(),
    commandSeq: z.number().int().positive().optional(),
    message: z.string().min(1),
    attempt: z.number().int().positive(),
    after: z.iso.datetime(),
  }),
  'landing.decided': landingDecision,
  'build.hold-requested': empty,
  'build.land-requested': z.strictObject({ decisionSeq: z.number().int().positive() }),
  'landing.command-acknowledged': z.strictObject({ commandSeq: z.number().int().positive() }),
  'landing.native-enable-started': empty,
  'landing.forge-merged': z.strictObject({
    classification: z.enum(['human', 'possible-stale-enable']),
    overrodeHold: z.boolean(),
  }),
  'landing.native-applied': z.strictObject({
    retry: z
      .strictObject({
        attempt: z.number().int().positive(),
        after: z.string().datetime(),
      })
      .optional(),
    enableSeq: z.number().int().positive().optional(),
    enabled: z.boolean(),
    candidate: landingCandidateSchema.optional(),
    decisionSeq: z.number().int().positive().optional(),
    commandSeq: z.number().int().positive().optional(),
    operation: z.string().min(1).optional(),
    publicationHead: z.string().min(1).optional(),
  }),
  'build.auto-merge-requested': autoMergeCommand,
  'build.auto-merge-cancelled': autoMergeCommand,
  'build.auto-merge-default-observed': autoMergeDefaultObserved,
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
  'spec.revised': z.union([
    z.strictObject({
      artifact: artifactRefSchema,
      escalation: z.number().int().positive(),
      assets: z.array(pinnedAssetSchema).optional(),
    }),
    z.strictObject({
      artifact: artifactRefSchema,
      operator: z.strictObject({ user: z.string().min(1), via: viaSchema.optional() }),
      assets: z.array(pinnedAssetSchema).optional(),
    }),
  ]),

  // ── Sessions (every agent run is bracketed by these) ──────────────────────
  'session.started': z.strictObject({
    /** Write-ahead continuation intent; independent of native acceptance. */
    continuation: z
      .strictObject({
        predecessor: z.string().min(1),
        root: z.string().min(1),
        handle: nativeSessionHandleSchema,
        cause: z.enum(['shutdown', 'pause', 'runner-loss']),
        activeMs: z.number().nonnegative(),
        budgetMs: z.number().positive(),
      })
      .optional(),
    budgetMs: z.number().positive().optional(),
    session: z.string().min(1),
    role: z.string().min(1),
    runner: z.string().min(1),
    model: z.string().optional(),
    /** Optional only so historical events replay without migration. */
    args: z.array(z.string()).optional(),
    account: selectedAccountSchema.optional(),
    phase: phaseSchema,
    round: round.optional(),
    /** Stream id this session's live view writes to (SPEC §9, session
     * streams). Optional only so historical events replay unchanged. */
    stream: z.string().min(1).optional(),
    /** Present only when this target substituted for the preceding failed one. */
    substitution: providerSubstitutionSchema.optional(),
  }),
  'session.suspended': z.strictObject({
    session: z.string().min(1),
    phase: phaseSchema,
    round: round.optional(),
    handle: nativeSessionHandleSchema.optional(),
    cause: z.enum(['shutdown', 'pause']),
    activeMs: z.number().nonnegative(),
    transcript: artifactRefSchema,
    usage: z
      .strictObject({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        turns: z.number().int().nonnegative(),
      })
      .optional(),
  }),
  'session.resumed': z.strictObject({
    session: z.string().min(1),
    predecessor: z.string().min(1),
    root: z.string().min(1),
    handle: nativeSessionHandleSchema,
    cause: z.enum(['shutdown', 'pause', 'runner-loss']),
    stale: z.boolean(),
  }),
  'session.resume-fallback': z.strictObject({
    session: z.string().min(1),
    stale: z.boolean().optional(),
    reason: z.string().min(1),
  }),
  'session.native-handle-recorded': z.strictObject({
    session: z.string().min(1),
    phase: phaseSchema,
    round: round.optional(),
    handle: nativeSessionHandleSchema,
  }),
  'session.ended': z.union([
    /** Ordinary completion retains the historical transcript-bearing shape. */
    z.strictObject({
      session: z.string().min(1),
      activeMs: z.number().nonnegative().optional(),
      transcript: artifactRefSchema,
      usage: z.strictObject({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        turns: z.number().int().nonnegative(),
      }),
    }),
    /** A recovering runner closes work whose transcript died with its prior
     * instance. Takeover evidence replaces, rather than fabricates, a corpus
     * artifact. */
    z.strictObject({
      session: z.string().min(1),
      outcome: z.literal('reclaimed'),
      reclaimedBy: z.strictObject({
        instance: z.string().min(1),
        resumedFromSeq: z.number().int().nonnegative(),
      }),
    }),
  ]),

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
    verifyStageFailure: z.number().int().positive().optional(),
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
  'verify.config-captured': z.strictObject({
    cycle: z.number().int().nonnegative(),
    artifact: artifactRefSchema,
    head: gitOid,
    identity: z.string().min(1),
    source: z.strictObject({
      ref: z.enum(['branch-head', 'worktree-dirty']),
      commit: gitOid.optional(),
    }),
  }),
  'verify.config-superseded': z.strictObject({
    captureSeq: z.number().int().positive(),
    head: gitOid,
    identity: z.string().min(1),
  }),
  'verify.started': z.strictObject({
    baseSha: gitOid.optional(),
    headSha: gitOid.optional(),
    restackId: z.string().min(1).optional(),
    step: z.string().min(1),
    attempt,
    /** An answered escalation raised by this agent verifier returns to the
     * same step. The start citation is the durable delivery carrier; the
     * subsequent matching `session.started` is the exactly-once consumption
     * boundary. Optional for historical logs and guidance-free check/skip
     * starts. */
    feedback: feedbackSchema.optional(),
  }),
  'verify.reconcile-policy-captured': z.strictObject({
    cycle: z.number().int().nonnegative().optional(),
    reconcileSeq: z.number().int().positive(),
    steps: z
      .array(
        z.strictObject({
          step: z.string().min(1),
          enabled: z.boolean(),
          source: z.string().min(1),
        }),
      )
      .superRefine((steps, ctx) => {
        if (new Set(steps.map((s) => s.step)).size !== steps.length)
          ctx.addIssue({ code: 'custom', message: 'duplicate policy step' })
        for (const s of steps)
          if (
            s.source !== 'verify.afterReconcile' &&
            s.source !== `verify.${s.step}.afterReconcile`
          )
            ctx.addIssue({ code: 'custom', message: 'invalid policy source' })
      }),
  }),
  'verify.completed': verifyCompletedPayloadSchema,
  'verify.cancelled': z.strictObject({
    ...verifyCompletionBase,
    cause: z.strictObject({ step: z.string().min(1) }),
  }),
  'verify.stage-failed': z.strictObject({
    attempt,
    cycle: z.number().int().nonnegative(),
    stage: z.array(z.string().min(1)).min(1),
    baseSha: gitOid.optional(),
    headSha: gitOid.optional(),
    restackId: z.string().min(1).optional(),
    failed: z.array(
      z.strictObject({ step: z.string().min(1), report: artifactRefSchema.optional() }),
    ),
    cancelled: z.array(
      z.strictObject({
        step: z.string().min(1),
        cause: z.strictObject({ step: z.string().min(1) }),
      }),
    ),
  }),
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
  'pr.merged': z.strictObject({
    sha: z.string().min(1),
    buildTrailerPresent: z.boolean().optional(),
  }),
  'pr.closed': empty,
  'pr.conflicted': z.strictObject({ baseSha: z.string().min(1) }),
  'reconcile.progress-checked': z.strictObject({
    /** seq of the repeat pr.conflicted fact this authoritative read answers. */
    conflictSeq: z.number().int().positive(),
    /** Completed reconcile whose merge target is being compared. */
    attempt,
    baseSha: z.string().min(1),
  }),
  'target.distance': z
    .strictObject({
      branch: z.string().min(1),
      sha: gitOid,
      head: gitOid.nullable(),
      count: z.number().int().nonnegative().nullable(),
    })
    .refine((sample) => sample.count === null || sample.head !== null),
  'target.rewritten': z.strictObject({
    branch: z.string().min(1),
    previousSha: gitOid,
    sha: gitOid,
  }),
  'target.rewrite-cleared': z.strictObject({ branch: z.string().min(1), sha: gitOid }),
  'target.moved': z.strictObject({ branch: z.string().min(1), sha: gitOid }),
  'restack.prepared': leafRestackSchema,
  'restack.replayed': z.strictObject({
    id: z.string().min(1),
    conflicted: z.boolean(),
    files: z.array(z.string()).optional(),
  }),
  'restack.publish-intended': leafRestackSchema.extend({ headSha: gitOid }),
  'restack.rewritten': leafRestackSchema.extend({
    headSha: gitOid,
    archives: z.array(archiveEntry),
    observedHead: gitOid.nullable().optional(),
  }),
  'restack.contended': z.strictObject({
    id: z.string().min(1),
    request: z.number().int().positive(),
    actual: gitOid.nullable(),
  }),
  'restack.completed': leafRestackSchema.extend({ headSha: gitOid }),
  'reconcile.started': z.strictObject({
    attempt,
    baseSha: z.string().min(1),
    restackId: z.string().min(1).optional(),
  }),
  'reconcile.prepared': reconcileTransactionSchema,
  'reconcile.contended': z.strictObject({
    id: z.string().min(1),
    request: z.number().int().positive(),
    actual: gitOid.nullable(),
  }),
  'reconcile.replayed': z.strictObject({
    id: z.string().min(1),
    conflicted: z.boolean(),
    files: z.array(z.string()).optional(),
  }),
  'reconcile.publish-intended': reconcileTransactionSchema.extend({
    headSha: gitOid,
    conflicted: z.boolean(),
    artifact: artifactRefSchema,
  }),
  'reconcile.rewritten': reconcileTransactionSchema.extend({
    headSha: gitOid,
    /** Later readback when a successful CAS was overtaken before acknowledgement. */
    observedHead: gitOid.nullable().optional(),
    conflicted: z.boolean(),
    archives: z.array(archiveEntry),
  }),
  'reconcile.completed': z.union([
    z.strictObject({ mergeCommit: z.string().min(1), artifact: artifactRefSchema }),
    z.strictObject({ headSha: gitOid, rewriteId: z.string().min(1), artifact: artifactRefSchema }),
  ]),

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
    /** The ticket's assets sampled with a revise-from-ticket authorization, so a
     * retry re-pins the set that was authorized. Absent otherwise. */
    assets: z.array(pinnedAssetSchema).optional(),
    /** Absolute per-loop/current-spec review budget selected by the operator. */
    reviewRoundCeiling: z.number().int().positive().optional(),
  }),
  /** Infra failure — distinct from verdicts (a verdict is a fact, not a failure). */
  'session.build-read-failed': z.strictObject({
    session: z.string().min(1),
    phase: phaseSchema,
    round,
    operation: z.literal('context'),
    reason: z.literal('own-build-read'),
    diagnostic: z.string().trim().min(1),
  }),
  'phase.deferred': z.strictObject({
    session: z.string().min(1),
    phase: phaseSchema,
    round,
    reason: z.literal('own-build-read'),
    diagnostic: z.string().trim().min(1),
  }),
  'phase.deferral-escalated': z.strictObject({
    session: z.string().min(1),
    phase: phaseSchema,
    round,
    id: z.string().min(1),
    evidenceSeq: z.number().int().positive(),
    question: z.string().min(1),
    refs: z.array(z.string()),
  }),
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
  baseSha?: string
  headSha?: string
  restackId?: string
  step: string
  attempt: number
  outcome: VerifyOutcome
  report?: ArtifactRef
  reason?: string
  skipCause?: 'post-reconcile-policy'
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
      baseSha: payload.baseSha,
      headSha: payload.headSha,
      restackId: payload.restackId,
      step: payload.step,
      attempt: payload.attempt,
      outcome: payload.pass ? 'pass' : 'fail',
      ...(payload.report !== undefined ? { report: payload.report } : {}),
    }
  }
  if (payload.outcome === 'skipped') {
    return {
      baseSha: payload.baseSha,
      headSha: payload.headSha,
      restackId: payload.restackId,
      step: payload.step,
      attempt: payload.attempt,
      outcome: 'skipped',
      reason: payload.reason,
      ...(payload.skipCause !== undefined ? { skipCause: payload.skipCause } : {}),
    }
  }
  return {
    baseSha: payload.baseSha,
    headSha: payload.headSha,
    restackId: payload.restackId,
    step: payload.step,
    attempt: payload.attempt,
    outcome: payload.outcome,
    ...(payload.report !== undefined ? { report: payload.report } : {}),
  }
}

export function isEventType(value: string): value is EventType {
  return Object.hasOwn(eventPayloadSchemas, value)
}
