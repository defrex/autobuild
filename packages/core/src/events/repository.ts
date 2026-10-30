import { selectedAccountSchema } from '../config/accounts'
import { nativeSessionHandleSchema } from './native-session'
import { runtimeIdentitySchema } from './runtime'
import { stampCompatibility, type CompatibilityMetadata, repositoryEventPolicy } from './policy'
import { hardReadinessKeys } from '../ports/forge/readiness'
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
import {
  actorSchema,
  VIA_ACTOR_RULE,
  viaOnNonHumanActor,
  type Actor,
  type ActorKind,
} from './envelope'
import { EventValidationError } from './catalog'
import { providerAttemptSchema } from './payloads'

const round = z.number().int().positive()
const attempt = z.number().int().positive()
/** Provider-native identity of the environment one harvest run executed in. */
const harvestEnvironmentSchema = z.strictObject({
  provider: z.string().min(1),
  environmentId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
})
const empty = z.strictObject({})
const setting = z.strictObject({ enabled: z.boolean() })
const dispatchRun = z.string().min(1)
/** A durable repository setting written by a dispatcher's startup launch
 * flags. `run` optionally names the dispatcher invocation that performed the
 * write (the operator intent stays `human`); optional so historical journals
 * replay unchanged. */
const dispatcherSetting = z.strictObject({ enabled: z.boolean(), run: dispatchRun.optional() })
const boundedDiagnostics = z.array(z.string().min(1)).max(1_000)
export { forgeRequestCountsSchema } from '../ports/forge-telemetry'
import { forgeRequestCountsSchema } from '../ports/forge-telemetry'
const tickCountersSchema = z.strictObject({
  forgeRequests: forgeRequestCountsSchema.optional(),
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
  dependencyCheckFailed: z.number().int().nonnegative().optional(),
  /** Foreign executions settled from durable facts plus provider liveness.
   * Added with durable supervision; optional so historical tick facts replay. */
  settled: z.number().int().nonnegative().optional(),
  /** Builds whose remote workspace provisioning was (re-)kicked as background
   * work this tick. Added with durable supervision; optional so historical
   * tick facts replay. */
  provisioning: z.number().int().nonnegative().optional(),
  /** Operator sandboxes idly stopped this tick. Added with the operator
   * sandbox; optional so historical tick facts replay. */
  sandboxIdleStops: z.number().int().nonnegative().optional(),
  /** Contained idle-settlement failures this tick; retried next tick. */
  sandboxSettleFailures: z.number().int().nonnegative().optional(),
  /** Historical embedded-runner counter, retained for strict event replay. */
  orchestratorSandboxFailures: z.number().int().nonnegative().optional(),
  harvestStarted: z.number().int().nonnegative(),
  harvestResumed: z.number().int().nonnegative(),
  harvestCompleted: z.number().int().nonnegative(),
  harvestEscalated: z.number().int().nonnegative(),
  harvestFailed: z.number().int().nonnegative(),
})
const restartRequiredConfigPathSchema = z.enum([
  'forge',
  'plugins',
  'store',
  'workspace.provider',
  'workspace.config',
  'tickets.source',
  'tickets.teamKey',
  'tickets.claimedState',
  'tickets.createState',
  'tickets.dir',
  'orchestrator',
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

const upgradeTargetSchema = z.strictObject({
  mode: z.enum(['pinned', 'installed', 'source']),
  key: z.string().min(1),
  source: z.string().min(1),
  version: z.string().optional(),
  base: z.string().optional(),
  sha: z.string().optional(),
})
const upgradeIdentitySchema = z.strictObject({
  correlation: z.string().min(1),
  run: dispatchRun,
  lineage: z.string().min(1),
  from: runtimeIdentitySchema,
  target: upgradeTargetSchema,
})
const handoffSchema = upgradeIdentitySchema.extend({
  to: runtimeIdentitySchema,
  root: z.string().min(1),
  cacheId: z.string().min(1),
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
    /** Where this run's sessions executed. Present on hosted harvest runs;
     * absent on locally run ones. Optional only so historical journals replay
     * without migration. */
    environment: harvestEnvironmentSchema.optional(),
  }),
  /** Dispatcher-authored durable identity of one hosted harvest execution:
   * the disposable environment the provider provisioned and the detached
   * command supervising the guest runner. Written as soon as the launch
   * succeeds so a later process can re-observe the execution without
   * process memory. */
  'harvest.execution.authorized': z.strictObject({
    execution: z.string().min(1),
    run: z.string().min(1),
    launch: z.enum(['started', 'resumed']),
    leaseHolder: z.string().min(1),
  }),
  'harvest.execution.ended': z.strictObject({
    execution: z.string().min(1),
    run: z.string().min(1),
  }),
  'harvest.execution.started': z.strictObject({
    execution: z.string().min(1),
    provider: z.string().min(1),
    environmentId: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    commandId: z.string().min(1).optional(),
  }),
  /** Dispatcher-authored close of one hosted harvest execution. Absence of a
   * matching released fact keeps the execution open for durable settlement;
   * the snapshot purge outcome proves absence from the provider. */
  'harvest.execution.released': z.strictObject({
    execution: z.string().min(1),
    environmentId: z.string().min(1),
    snapshots: z.strictObject({
      outcome: z.enum(['confirmed', 'unknown']),
      deleted: z.number().int().nonnegative().optional(),
      error: z.string().min(1).optional(),
    }),
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
  'harvest.session.native-handle-recorded': z.strictObject({
    run: z.string().min(1),
    session: z.string().min(1),
    handle: nativeSessionHandleSchema,
  }),
  'harvest.session.suspended': z.strictObject({
    run: z.string().min(1),
    session: z.string().min(1),
    cause: z.enum(['shutdown', 'cutover']),
    transcript: artifactRefSchema,
    usage: z
      .strictObject({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        turns: z.number().int().nonnegative(),
      })
      .optional(),
  }),
  'harvest.session.resumed': z.strictObject({
    run: z.string().min(1),
    session: z.string().min(1),
    predecessor: z.string().min(1),
    root: z.string().min(1),
    handle: nativeSessionHandleSchema,
  }),
  'harvest.session.resume-fallback': z.strictObject({
    run: z.string().min(1),
    session: z.string().min(1),
    reason: z.enum([
      'missing-handle',
      'changed-route',
      'unsupported',
      'wrong-runner',
      'wrong-host',
      'wrong-workspace',
      'missing-state',
    ]),
    message: z.string().min(1),
  }),
  'harvest.session.started': z.strictObject({
    continuation: z
      .strictObject({
        predecessor: z.string().min(1),
        root: z.string().min(1),
        handle: nativeSessionHandleSchema.optional(),
        cause: z.enum(['shutdown', 'cutover', 'runner-loss']),
      })
      .optional(),
    run: z.string().min(1),
    session: z.string().min(1),
    role: z.enum(['harvest', 'harvest-review']),
    runner: z.string().min(1),
    model: z.string().optional(),
    /** Optional only so historical repository journals replay without migration. */
    args: z.array(z.string()).optional(),
    account: selectedAccountSchema.optional(),
    step: z.enum(['synthesize', 'review']),
    round,
    /** Stream id this session's live view writes to (SPEC §9, session
     * streams). Optional only so historical journals replay unchanged. */
    stream: z.string().min(1).optional(),
    // Native continuation can try a configured alternate before index zero.
    substitution: z
      .strictObject({
        failed: providerAttemptSchema,
        selectedIndex: z.number().int().nonnegative(),
      })
      .refine((value) => value.selectedIndex !== value.failed.index, {
        message: 'substitution must select a different configured target',
      })
      .optional(),
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
    providerAttempts: z
      .array(providerAttemptSchema)
      .min(1)
      .refine(
        (attempts) => new Set(attempts.map((attempt) => attempt.index)).size === attempts.length,
        { message: 'provider attempts must name distinct configured targets' },
      )
      .optional(),
  }),
} as const

/** Operator sandbox lifecycle facts (AUT-340). The provision/resume/activity
 * facts bracket one environment's usable window and rate-limited activity;
 * stopped/released/reset close it. Derived state lives in the pure reducer
 * `processes/sandbox-state.ts`, mirroring harvest execution settlement. */
export const orchestratorSandboxEventPayloadSchemas = {
  /** First use of one operator's environment for this repository, or a
   * post-reset reprovision. Carries the full environment identity, plus the
   * base branch head the fresh provision selected — the publication
   * precondition's reference point (a publish must be a descendant of it).
   * Optional so historical journals replay unchanged. */
  'orchestrator.sandbox.provisioned': z.strictObject({
    operator: z.string().min(1),
    environmentId: z.string().min(1),
    provider: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    workspacePath: z.string().min(1),
    baseSha: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/i)
      .optional(),
  }),
  /** A stopped environment resumed for a later tool call. */
  'orchestrator.sandbox.resumed': z.strictObject({
    operator: z.string().min(1),
    environmentId: z.string().min(1),
    provider: z.string().min(1),
    sessionId: z.string().min(1).optional(),
  }),
  /** Rate-limited activity evidence (at most one per 60 s per environment),
   * the last-evidence input to the dispatcher's idle settlement. */
  'orchestrator.sandbox.activity': z.strictObject({
    operator: z.string().min(1),
    environmentId: z.string().min(1),
  }),
  /** Dispatcher-authored idle stop: the session ended, the snapshot kept. */
  'orchestrator.sandbox.stopped': z.strictObject({
    operator: z.string().min(1),
    environmentId: z.string().min(1),
    reason: z.literal('idle'),
  }),
  /** Full teardown + snapshot purge. Operator-driven (reset, session archive)
   * or dispatcher-authored (closing an orphan's trail whose environment was
   * already absent at idle settlement, or closing the trail of an idle
   * environment whose journaled provider no longer matches the wired provider
   * — both unconfirmed, with the reason recorded in `snapshots.error`). */
  'orchestrator.sandbox.released': z.strictObject({
    operator: z.string().min(1),
    environmentId: z.string().min(1),
    snapshots: z.strictObject({
      outcome: z.enum(['confirmed', 'unknown']),
      deleted: z.number().int().nonnegative().optional(),
      error: z.string().min(1).optional(),
    }),
  }),
  /** Destructive reset marker. The following released/provisioned facts
   * carry the evidence. */
  'orchestrator.sandbox.reset': z.strictObject({
    operator: z.string().min(1),
    environmentId: z.string().min(1),
  }),
  /** One PR-only publication from an operator sandbox: the operator, the
   * delegated orchestrator session when one triggered the tool, the
   * deterministic branch the commit was pushed to, the published commit, and
   * the opened-or-adopted PR. Written after both the push and the forge call
   * succeed; the push-before-fact discipline makes a retry complete the
   * journal rather than re-push. */
  'orchestrator.sandbox.published': z.strictObject({
    operator: z.string().min(1),
    environmentId: z.string().min(1),
    branch: z.string().min(1),
    sha: z.string().regex(/^[0-9a-f]{40,64}$/i),
    session: z.string().min(1).optional(),
    pr: z.strictObject({
      number: z.number().int().positive(),
      url: z.string().min(1),
      headSha: z.string().min(1),
    }),
  }),
  /** A refused or failed publication attempt. `stage` names where it stopped
   * (the precondition checks, the push, or the forge PR call); `message` is
   * the provider's or forge's text, redacted of credential values by the
   * service. */
  'orchestrator.sandbox.publish-failed': z.strictObject({
    operator: z.string().min(1),
    environmentId: z.string().min(1),
    stage: z.enum(['checks', 'push', 'pr']),
    message: z.string().min(1),
  }),
} as const

export const dispatcherStatusEventPayloadSchemas = {
  /** Completed ticket-source measurement, independent of dispatcher runs. */
  'dispatcher.ticket-scan-completed': z.strictObject({
    startedAt: z.iso.datetime(),
    readinessFingerprint: z.string().min(1),
    criteriaFingerprint: z.string().min(1),
    mode: z.enum(['admission', 'observation']),
    queued: z.number().int().nonnegative(),
    invalidTickets: z.number().int().nonnegative(),
    ticketDiagnostics: boundedDiagnostics,
    dependencyBlocked: z.number().int().nonnegative(),
    dependencyDiagnostics: boundedDiagnostics,
    creationWithheld: z.number().int().nonnegative(),
    creationDiagnostics: boundedDiagnostics,
  }),
  /** A terminal frontend follows exactly one run. The referenced artifact is
   * the composed Config the kernel is actually using, never an on-disk guess. */
  'dispatcher.upgrade-target-resolved': z.strictObject({
    run: dispatchRun,
    lineage: z.string().min(1),
    target: upgradeTargetSchema,
  }),
  'dispatcher.target-prepared': handoffSchema,
  'dispatcher.yield-requested': handoffSchema.extend({
    successor: dispatchRun,
    mode: z.enum(['drain', 'cutover']),
    evidence: z.string().min(1),
  }),
  'dispatcher.terminal-released': handoffSchema,
  'dispatcher.takeover': handoffSchema.extend({ successor: dispatchRun }),
  'dispatcher.drain-settled': handoffSchema.extend({
    slug: z.string().min(1),
    instance: z.string().min(1),
    outcome: z.enum(['drained', 'suspended', 'unknown']),
  }),
  'dispatcher.drain-deadline': handoffSchema.extend({ deadline: z.iso.datetime() }),
  'account.credentials-unavailable': selectedAccountSchema.extend({
    source: z.enum(['environment', 'project-secrets']),
    remedy: z.string().min(1).max(4096),
  }),
  'account.credentials-recovered': z.strictObject({ name: z.string().min(1) }),
  'dispatcher.upgrade-detected': upgradeIdentitySchema,
  'dispatcher.upgrade-failed': upgradeIdentitySchema.extend({ reason: z.string().min(1) }),
  'dispatcher.runtime-rolled-back': z.strictObject({
    correlation: dispatchRun,
    run: dispatchRun,
    lineage: dispatchRun,
    predecessor: dispatchRun,
    successor: dispatchRun,
    handoff: dispatchRun,
    takeoverAt: z.iso.datetime(),
    failures: z.literal(3),
    failed: runtimeIdentitySchema,
    restored: runtimeIdentitySchema,
    failedRoot: z.string().min(1),
    restoredRoot: z.string().min(1),
    target: upgradeTargetSchema,
    reason: z.string().min(1),
  }),
  'dispatcher.rollback-hold-cleared': z.strictObject({
    correlation: dispatchRun,
    run: dispatchRun,
    lineage: dispatchRun,
    target: upgradeTargetSchema,
  }),
  'dispatcher.handoff-started': handoffSchema.extend({
    remoteBuilds: z
      .array(
        z.strictObject({
          slug: z.string().min(1),
          instance: z.string().min(1),
          runtime: runtimeIdentitySchema.optional(),
        }),
      )
      .optional(),
    successor: dispatchRun.optional(),
    mode: z.enum(['drain', 'cutover']).optional(),
    startedAt: z.iso.datetime().optional(),
    deadline: z.iso.datetime().optional(),
    builds: z
      .array(z.strictObject({ slug: z.string().min(1), instance: z.string().min(1) }))
      .optional(),
  }),
  'dispatcher.handoff-completed': handoffSchema.extend({
    successor: dispatchRun,
    mode: z.enum(['drain', 'cutover']).optional(),
    startedAt: z.iso.datetime().optional(),
    endedAt: z.iso.datetime().optional(),
    drained: z.number().int().nonnegative().optional(),
    suspended: z.number().int().nonnegative().optional(),
  }),
  'dispatcher.runtime-recorded': z.strictObject({
    run: dispatchRun,
    startedSeq: z.number().int().positive(),
    runtime: runtimeIdentitySchema,
  }),
  'dispatcher.run-started': z.strictObject({
    run: dispatchRun,
    lineage: dispatchRun.optional(),
    pid: z.number().int().positive(),
    host: z.string().trim().min(1).optional(),
    effectiveConfig: artifactRefSchema,
    roleWarnings: boundedDiagnostics,
  }),
  'dispatcher.stop-requested': z.strictObject({ run: dispatchRun, signal: z.string().min(1) }),
  'dispatcher.run-stopped': z.strictObject({
    run: dispatchRun,
    outcome: z.enum(['normal', 'abnormal', 'forced']),
    exitCode: z.number().int().nullable().optional(),
    signal: z.string().min(1).optional(),
    error: z.string().min(1).optional(),
    /** Optional clean-stop reason. Supersession is a normal exit (exit 0)
     * with this reason — never a new outcome value — so historical consumers
     * keep reading a clean stop. */
    reason: z.enum(['superseded']).optional(),
  }),
  /** Durable record that this invocation found the repository held by another
   * supervisor and performed no claims, launches, or publications. */
  'dispatcher.tick-yielded': z.strictObject({
    run: dispatchRun.optional(),
    holder: z.string().min(1),
  }),
  'dispatcher.forge-readiness-failed': z.strictObject({
    run: dispatchRun,
    forge: z.string().min(1),
    rootBranch: z.string().min(1),
    check: z.enum(hardReadinessKeys),
    detail: z.string().min(1),
    remediation: z.string().min(1),
  }),
  'dispatcher.config-rejected': z.strictObject({ run: dispatchRun, error: z.string().min(1) }),
  'dispatcher.config-publication-failed': z.strictObject({
    run: dispatchRun,
    error: z.string().min(1),
  }),
  /** Recorded boundaries of meaningful turns. The repository tick observation
   * protects active work from forced stop while these facts are buffered. */
  'dispatcher.tick-started': z.strictObject({
    run: dispatchRun,
    startedAt: z.iso.datetime().optional(),
  }),
  'dispatcher.tick-completed': z.strictObject({
    run: dispatchRun,
    queued: z.number().int().nonnegative(),
    /** Replay-only compatibility for journals written while the isolated
     * dispatcher child transported a display sample in its tick fact. */
    observations: z.number().int().nonnegative().optional(),
    counters: tickCountersSchema,
    blockedDiagnostics: boundedDiagnostics.optional(),
    janitorDiagnostics: boundedDiagnostics,
    ticketDiagnostics: boundedDiagnostics,
    creationDiagnostics: boundedDiagnostics.optional(),
    dependencyDiagnostics: boundedDiagnostics,
  }),
  'dispatcher.tick-failed': z.strictObject({ run: dispatchRun, error: z.string().min(1) }),
  'dispatcher.runner-settled': z.strictObject({
    run: dispatchRun,
    slug: z.string().min(1),
    outcome: z.enum(['parked', 'lease-held', 'launch-failed', 'failed', 'relaunch']),
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
  'dispatcher.intake-set': dispatcherSetting,
  /** Repository-wide quiescence flag: pause-all sets it, resume-all clears it,
   * and while it is set no dispatcher tick attaches a runner to a queued build.
   * Deliberately independent of intake — intake governs new ticket intake, and
   * an operator who only turns intake off is declining new work, not disowning
   * work the repository has already accepted. */
  'dispatcher.pause-set': setting,
  /** Claim-time auto-merge default sampled by every dispatcher tick. */
  'dispatcher.auto-merge-default-set': dispatcherSetting,
} as const

const ticketSourceCondition = {
  source: z.string().min(1),
  operation: z.enum(['ready-scan', 'dependency-check']),
  message: z.string().min(1),
}
export const ticketSourceHealthEventPayloadSchemas = {
  /** An existing listing-limit episode also encountered a limited dependency
   * read. Strengthens recovery evidence without closing or reopening it. */
  'dispatcher.ticket-source-dependency-limited': z.strictObject({ source: z.string().min(1) }),
  'dispatcher.ticket-source-degraded': z.discriminatedUnion('cause', [
    z.strictObject({
      ...ticketSourceCondition,
      cause: z.literal('rate-limited'),
      resetAt: z.iso.datetime(),
    }),
    z.strictObject({ ...ticketSourceCondition, cause: z.literal('ready-scan-failed') }),
  ]),
  'dispatcher.ticket-source-recovered': z.strictObject({
    source: z.string().min(1),
    cause: z.enum(['rate-limited', 'ready-scan-failed']),
    operation: z.enum(['ready-scan', 'dependency-check']),
  }),
} as const

const presenceWitnessSchema = z.strictObject({
  version: z.literal(1),
  commits: z
    .array(z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/))
    .refine(
      (ids) => ids.every((id, index) => index === 0 || ids[index - 1]! < id),
      'commits must be sorted and unique',
    ),
  identities: z
    .array(z.templateLiteral(['build:', z.string().regex(/^[a-z0-9][a-z0-9-]*$/)]))
    .refine(
      (ids) => ids.every((id, index) => index === 0 || ids[index - 1]! < id),
      'identities must be sorted and unique',
    ),
})

/** Head-bound admission evidence. Historical observations remain append-only. */
export const changePresenceEventPayloadSchemas = {
  'change-presence.observed': z.strictObject({
    witness: presenceWitnessSchema.optional(),
    branch: z.string().min(1),
    destination: z.string().min(1),
    head: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    evidence: z.string().min(1),
    identities: z
      .array(
        z.string().regex(/^(?:build:[a-z0-9][a-z0-9-]*|foreign:[0-9a-f]{40}(?:[0-9a-f]{24})?)$/),
      )
      .refine(
        (ids) => ids.every((id, index) => index === 0 || ids[index - 1]! < id),
        'identities must be sorted and unique',
      ),
  }),
} as const

export const forgeHealthEventPayloadSchemas = {
  'dispatcher.forge-degraded': z.strictObject({
    forge: z.string().min(1),
    message: z.string().min(1),
    resetAt: z.iso.datetime(),
    firstFailureAt: z.iso.datetime(),
  }),
  'dispatcher.forge-recovered': z.strictObject({
    forge: z.string().min(1),
    reason: z.string().trim().min(1).optional(),
  }),
} as const

export const ticketMigrationEventPayloadSchemas = {
  'tickets.migration-recorded': z
    .strictObject({
      identity: z.string().min(1),
      from: z.string().regex(/^[a-z][a-z0-9-]*$/),
      to: z.string().regex(/^[a-z][a-z0-9-]*$/),
      mapping: z.record(z.string().min(1), z.string().min(1)),
    })
    .superRefine((value, ctx) => {
      if (
        value.from === value.to &&
        Object.entries(value.mapping).some(([id, next]) => id !== next)
      )
        ctx.addIssue({ code: 'custom', message: 'migration sources must differ' })
      if (new Set(Object.values(value.mapping)).size !== Object.keys(value.mapping).length)
        ctx.addIssue({ code: 'custom', message: 'duplicate destination ticket id' })
    }),
} as const

/** Durable claim-to-build preparation boundaries, independent of build streams. */
const preparationIdentity = {
  attempt: z.string().min(1),
  ticket: ticketRefSchema,
}
export const ticketPreparationEventPayloadSchemas = {
  'ticket-preparation.intended': z.strictObject({
    ...preparationIdentity,
    readyState: z.string().min(1),
    claimedState: z.string().min(1),
  }),
  'ticket-preparation.claimed': z.strictObject(preparationIdentity),
  'ticket-preparation.creation-selected': z.strictObject({
    ...preparationIdentity,
    slug: z.string().min(1),
  }),
  'ticket-preparation.failed': z.strictObject({
    ...preparationIdentity,
    stage: z.string().min(1),
    claimed: z.boolean(),
    handback: z.string().min(1),
    error: z.string().min(1).max(4000),
  }),
  'ticket-preparation.recovery-failed': z.strictObject({
    ...preparationIdentity,
    claimed: z.boolean().optional(),
    preparationError: z.string().min(1).max(4000).optional(),
    handback: z.string().min(1).optional(),
    error: z.string().min(1).max(4000),
    retryAt: z.string().datetime(),
  }),
  'ticket-preparation.handback-selected': z.strictObject({
    ...preparationIdentity,
    state: z.string().min(1),
  }),
  'ticket-preparation.resolved': z.strictObject({
    ...preparationIdentity,
    outcome: z.enum(['lost-claim', 'handed-back', 'bounced', 'owned', 'abandoned']),
    reason: z.string().min(1).max(4000).optional(),
  }),
}

export const repositoryEventPayloadSchemas = {
  ...ticketPreparationEventPayloadSchemas,
  ...ticketMigrationEventPayloadSchemas,
  ...forgeHealthEventPayloadSchemas,
  ...changePresenceEventPayloadSchemas,
  ...ticketSourceHealthEventPayloadSchemas,
  ...harvestEventPayloadSchemas,
  ...orchestratorSandboxEventPayloadSchemas,
  ...dispatcherStatusEventPayloadSchemas,
  ...dispatcherSettingEventPayloadSchemas,
} as const

export type RepositoryEventType = keyof typeof repositoryEventPayloadSchemas
export const REPOSITORY_EVENT_TYPES = Object.keys(
  repositoryEventPayloadSchemas,
) as RepositoryEventType[]

/** Repository attention followed by `ab watch` with no slugs or explicit
 * `--repository`. Historical session wakes also used this catalog. */
export const REPOSITORY_ATTENTION_EVENTS = [
  'account.credentials-unavailable',
  'account.credentials-recovered',
  'harvest.escalated',
  'harvest.failed',
  'dispatcher.forge-degraded',
  'dispatcher.forge-recovered',
  'dispatcher.ticket-source-degraded',
  'dispatcher.ticket-source-recovered',
  'dispatcher.tick-failed',
  'dispatcher.config-rejected',
  'dispatcher.forge-readiness-failed',
  'dispatcher.harvest-runner-failed',
] as const satisfies readonly RepositoryEventType[]
export type RepositoryEventPayload<T extends RepositoryEventType> = z.infer<
  (typeof repositoryEventPayloadSchemas)[T]
>

export interface RepositoryEventEnvelope<T extends RepositoryEventType = RepositoryEventType> {
  compatibility?: CompatibilityMetadata
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
  compatibility?: CompatibilityMetadata
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
  'ticket-preparation.intended': ['dispatcher'],
  'ticket-preparation.claimed': ['dispatcher'],
  'ticket-preparation.creation-selected': ['dispatcher'],
  'ticket-preparation.failed': ['dispatcher'],
  'ticket-preparation.recovery-failed': ['dispatcher'],
  'ticket-preparation.handback-selected': ['dispatcher'],
  'ticket-preparation.resolved': ['dispatcher'],

  'tickets.migration-recorded': ['human'],
  'change-presence.observed': ['dispatcher', 'kernel'],
  'harvest.pause-requested': ['human'],
  'harvest.resume-requested': ['human'],
  'harvest.paused': ['kernel'],
  'harvest.resumed': ['kernel'],
  'harvest.recovery-requested': ['kernel'],
  'harvest.recovery-exhausted': ['kernel'],
  'harvest.started': ['dispatcher', 'kernel'],
  'harvest.execution.authorized': ['dispatcher'],
  'harvest.execution.ended': ['dispatcher'],
  'harvest.execution.started': ['dispatcher'],
  'harvest.execution.released': ['dispatcher'],
  'harvest.step.started': ['kernel'],
  'harvest.step.completed': ['kernel'],
  'harvest.session.started': ['kernel'],
  'harvest.session.ended': ['kernel'],
  'harvest.session.native-handle-recorded': ['kernel'],
  'harvest.session.suspended': ['kernel'],
  'harvest.session.resumed': ['kernel'],
  'harvest.session.resume-fallback': ['kernel'],

  'harvest.proposals.submitted': ['agent'],
  'harvest.review.verdict': ['agent'],
  'harvest.proposal.id-reserved': ['kernel'],
  'harvest.proposal.filed': ['kernel'],
  'harvest.completed': ['kernel'],
  'harvest.escalated': ['kernel', 'agent'],
  'harvest.failed': ['kernel'],
  'orchestrator.sandbox.provisioned': ['human'],
  'orchestrator.sandbox.resumed': ['human'],
  'orchestrator.sandbox.activity': ['human'],
  'orchestrator.sandbox.stopped': ['dispatcher'],
  // Operator-driven releases (reset, session archive) are human-authored;
  // the idle settlement's absent path closes an orphan's trail with a
  // dispatcher-authored released fact, exactly as
  // `harvest.execution.released` is dispatcher-authored.
  'orchestrator.sandbox.released': ['human', 'dispatcher'],
  'orchestrator.sandbox.reset': ['human'],
  'orchestrator.sandbox.published': ['human'],
  'orchestrator.sandbox.publish-failed': ['human'],
  'dispatcher.upgrade-target-resolved': ['dispatcher'],
  'dispatcher.target-prepared': ['dispatcher'],
  'dispatcher.yield-requested': ['dispatcher'],
  'dispatcher.terminal-released': ['dispatcher'],
  'dispatcher.takeover': ['dispatcher'],
  'dispatcher.drain-settled': ['dispatcher'],
  'dispatcher.drain-deadline': ['dispatcher'],
  'account.credentials-unavailable': ['dispatcher'],
  'account.credentials-recovered': ['dispatcher'],
  'dispatcher.upgrade-detected': ['dispatcher'],
  'dispatcher.upgrade-failed': ['dispatcher'],
  'dispatcher.runtime-rolled-back': ['dispatcher'],
  'dispatcher.rollback-hold-cleared': ['dispatcher'],
  'dispatcher.handoff-started': ['dispatcher'],
  'dispatcher.handoff-completed': ['dispatcher'],
  'dispatcher.runtime-recorded': ['dispatcher'],
  'dispatcher.run-started': ['dispatcher'],
  'dispatcher.stop-requested': ['dispatcher'],
  'dispatcher.run-stopped': ['dispatcher'],
  'dispatcher.tick-yielded': ['dispatcher'],
  'dispatcher.config-rejected': ['dispatcher'],
  'dispatcher.forge-readiness-failed': ['dispatcher'],
  'dispatcher.config-publication-failed': ['dispatcher'],
  'dispatcher.tick-started': ['dispatcher'],
  'dispatcher.tick-completed': ['dispatcher'],
  'dispatcher.ticket-scan-completed': ['dispatcher'],
  'dispatcher.ticket-source-dependency-limited': ['dispatcher'],
  'dispatcher.forge-degraded': ['dispatcher', 'kernel'],
  'dispatcher.forge-recovered': ['dispatcher', 'kernel', 'human'],
  'dispatcher.ticket-source-degraded': ['dispatcher'],
  'dispatcher.ticket-source-recovered': ['dispatcher'],
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
  compatibility?: unknown
}): RepositoryEventWrite {
  if (!isRepositoryEventType(input.type)) {
    throw new EventValidationError(
      `unknown repository event type "${input.type}" — known types: ${REPOSITORY_EVENT_TYPES.join(', ')}`,
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
  const result = repositoryEventPayloadSchemas[input.type].safeParse(input.payload)
  if (!result.success) {
    throw new EventValidationError(
      `invalid payload for "${input.type}": ${result.error.message}`,
      result.error.issues,
    )
  }
  return {
    ...(input.compatibility === undefined
      ? {}
      : {
          compatibility: stampCompatibility(repositoryEventPolicy[input.type], input.compatibility),
        }),
    actor,
    type: input.type,
    payload: result.data,
  } as RepositoryEventWrite
}

/** Producer boundary: validate strictly, then identify the actual writer. */
export function prepareRepositoryEventWrite(
  input: Parameters<typeof validateRepositoryEventWrite>[0],
): RepositoryEventWrite {
  try {
    const validated = validateRepositoryEventWrite(input)
    return {
      ...validated,
      compatibility: stampCompatibility(
        repositoryEventPolicy[validated.type],
        validated.compatibility,
      ),
    }
  } catch (error) {
    if (error instanceof EventValidationError) throw error
    throw new EventValidationError(
      `invalid compatibility metadata: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
