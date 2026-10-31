import { proveTargetLineage } from '../kernel/target-lineage'
import { assertTargetOid, observeTarget } from '../kernel/target-observation'
import {
  MissingAccountCredentialsError,
  missingAccountCredentials,
  reconcileMissingAccounts,
  type MissingAccountCredential,
} from '../accounts/availability'
import { ArtifactMetaUnsupportedError } from '../store/artifact-meta'
import type { TicketPreparation } from '../kernel/ticket-preparation'
import { sampleTargetDistance } from '../kernel/target-distance'
import { capturedBuildConfig } from './verify-cycle-config'
import { publicationRetryGate } from '../kernel/publication-retry'
import {
  NODE_VERIFICATION_CONTEXT,
  prepareNodeVerificationContext,
} from '../kernel/node-verification-context'
import {
  nodeActivityKey,
  nodePollingSchedule,
  nodePollingCheckpointRequired,
  nodePollingEvidenceValid,
  nodePollingUnsettled,
  nodeTicketObservationKey,
} from '../kernel/node-polling'
import { reportIntegrationFailures } from '../kernel/integration-attention'
import {
  resolveTicketRef,
  migrationIdentity,
  historicalTicketIdentity,
} from '../kernel/ticket-migrations'
import { suspendNativeLanding } from '../kernel/landing-publication'
import {
  actionableRestackDemand,
  restackAvailabilityFingerprint,
  restackLandingKey,
  presenceRestackPath,
} from '../kernel/node-restack-demand'
import {
  deferMixedVersion,
  mixedVersionDeferred,
  MixedVersionDeferral,
} from '../kernel/mixed-version'
import { guardForge, ForgeCooldown } from '../kernel/guarded-forge'
import { recordJanitorFailure } from '../kernel/janitor-failure'
import { isForgeFailure } from '../ports/forge-failure'
import {
  ForgeRequestDeferred,
  withForgeRequestContext,
  forgeRequestContext,
} from '../ports/forge-request-context'
import { dispatchCapacity, nodeCapacity, type CapacityBuild } from '../kernel/dispatch-capacity'
import { evaluateLandingPolicy } from '../kernel/landing-policy'
import {
  landingAuthorized,
  nativeLandingApplied,
  sameLandingCandidate,
} from '../kernel/landing-state'
import { sameParentRejection } from '../kernel/node-restack-state'
import { validateNodeParent, nodeParentBusy, type ParentContext } from '../kernel/node-parent'
import { landIntegrationRoot, auditIntegrationLanding } from '../kernel/integration-landing'
import {
  observeIntegration,
  integrationObservationInputs,
  type IntegrationObservationInputs,
} from '../kernel/integration-completeness'
import {
  integrationComplete,
  integrationCurrent,
  integrationConfig,
  integrationFailed,
  integrationVerified,
  integrationHeadVerified,
} from '../kernel/integration-state'
import {
  normalizeIdentities,
  blockerBuild,
  missingChanges,
  presenceInputs,
  confirmedLandings,
  presenceWitness,
  projectPresence,
  presenceEvidence,
  destinationAliases,
  ownedContribution,
  type ChangeIdentity,
  type PresenceInputs,
} from '../kernel/change-presence'
import { landIntoNode, settleClosedNode, preflightNodeLanding } from '../kernel/node-landing'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runNodeTransaction } from '../kernel/node-restack-transaction'
import { hasBuildTrailer } from '../kernel/build-identity'
import { readBuildDigests, readForgeHealth } from '../store/reduced-reads'
import { readBuildSelector, readBuildFacts, type CurrentBuildFacts } from '../store/reduced-reads'
import { ensureExecutionProgress } from './execution-no-progress'
import { ticketIdentity } from '../ports/tickets/identity'
import { ticketLifecycle } from '../ports/tickets/lifecycle'
import { ensureDispatchBudget } from './dispatch-failure-budget'
import type { TicketSourceDegradation } from '../kernel/ticket-source-health'
/**
 * The dispatcher process (SPEC §3.3, §12): watches the TicketSource for
 * Ready tickets, claims, provisions a workspace, and launches build-runners
 * up to a capacity limit — plus janitor duty over the post-PR epilogue
 * (§15.7, D1) and the stale-lease sweep (§15.6-C). Cron-friendly: one
 * `tick()` does one pass over everything and is safe to re-run — every
 * action is deduped against the reduced event log, and single-writer
 * discipline (§12) means at most one dispatcher runs per repo.
 *
 * Order within a tick (deliberate):
 *   a. JANITOR   — settles finished work first, releasing capacity that the
 *                  dispatch step below can immediately reuse.
 *   b. DISPATCH RECOVERY — completes interrupted pre-run build setup.
 *   c. STARTUP RESUME (first CLI tick only) — attempts every actionable
 *                  current build, including policy-exhausted infra failures.
 *   d. LEASE SWEEP — re-attaches runners to builds whose runner died.
 *   e. DISPATCH  — fills remaining capacity from Ready tickets.
 *   f. HARVEST   — observation back-pressure, independent of build capacity.
 * A build launched in an earlier step is never launched again by a later
 * one (per-tick launch dedupe); a build dispatched in step (d) is not swept
 * in the same tick because the sweep already ran.
 *
 * A repository-wide pause (`dispatcher.pause-set`, written by the dashboard's
 * pause-all) holds every QUEUED build across steps (b)–(e): none of them may
 * attach a runner to a build that has no runner yet, whichever stage reaches
 * it first. The janitor (a) is deliberately NOT gated, so abort and discard
 * still settle while the repository is at rest, and running builds are left to
 * the per-build pauses that pause-all writes alongside the flag. The flag is
 * sampled once per tick, so a pause landing mid-tick takes effect on the next
 * one — the same semantics intake already has.
 *
 * The dispatcher never runs pipeline agents (§15.7) — conflicted PRs and
 * stale leases both resolve by re-attaching a build-runner via
 * `launchRunner`. Optional pre-build judgment (spec authoring and short slug
 * naming) lives behind bounded seams before a build exists; deterministic
 * validation and fallback remain here. The supervising kernel reserves each
 * execution lease before launch; the child renews that same-holder lease.
 */
import { createHash } from 'node:crypto'
import type { Config } from '../config/schema'
import { DISPATCHER, KERNEL, agentActor } from '../events/envelope'
import { isRemoteWorkspace } from '../events/workspace-remote'
import type { AbEvent, EventWrite } from '../events/catalog'
import type { EventPayload, PinnedAsset } from '../events/payloads'
import type { IdSource } from '../ids'
import { recordAutoMergeDeferralObservation } from '../kernel/auto-merge'
import type { AutoMergeDefaultFact } from '../kernel/auto-merge-default'
import { decideNextFromFacts } from '../kernel/engine'
import { composeBuildConfig } from '../config/live'
import { BUILD_EFFECTIVE_CONFIG_ARTIFACT, parseEffectiveBuildConfig } from './build-execution-state'
import {
  DEFAULT_MAX_HARVEST_RECOVERY_ATTEMPTS,
  decideHarvestControl,
  harvestCreationsFromStates,
} from '../kernel/harvest'
import type { BuildState } from '../kernel/reducer'
import type { ArtifactRef, TicketRef } from '../ontology'
import { BUILD_EXECUTION_LEASE_TTL_MS } from '../ports/workspace/build-execution'
import type {
  DependencyState,
  Forge,
  Ticket,
  TicketSource,
  WorkspaceProvider,
  WorkspaceProvisionResult,
} from '../ports/types'
import { NoCommitsBetweenBranchesError, TicketSourceRateLimitError } from '../ports/types'
import type { Exec } from '../ports/workspace/git-worktree'
import type { ArtifactMeta, BuildDigest, BuildRecord, BuildStore, Clock } from '../store/types'
import { preparePinnedAssets } from '../store/ticket-assets'
import { resolveRepoOrigin } from '../cli/repo-state'
import { specConformance } from '../spec-standard'
export { specConformance, type SpecConformance } from '../spec-standard'
import { recordInfrastructureFailure as appendInfrastructureFailure } from './infrastructure-failure-budget'
import { settleOpenExecution } from './execution-settlement'
import { isWorkDigest, RepoViewStore } from './repo-view'
import type { OpenBuildWorkspace, ProvisionMarker } from './dispatcher-selectors'
import { settlePublicationFactsBeforeRelease } from './publication-loss'

// ── Readiness resolution (SPEC §3.3) ─────────────────────────────────────────

/**
 * What "ready for dispatch" means, resolved against the ticket source.
 *
 * The state gate is no longer source-defaulted: `readyState` is a required,
 * non-blank config value (src/config/schema.ts), so every source gates on the
 * exact configured state and always return one. The removed branch — where the
 * linear source left `state` unset when `readyState` was absent — was the
 * AUT-10 hole: with no state filter, every labelled ticket was eligible in any
 * workflow state, so a completed ticket still carrying the label got dispatched
 * again. That branch is now unrepresentable.
 *
 * The only per-source difference left is the *label* default. Linear has no
 * `ready/` directory, so a label is the only thing that can mark a ticket
 * dispatchable: the historical `["autobuild"]` default. The file tracker's gate
 * is otherwise the directory, so it defaults to no label gate. Plugin sources
 * likewise receive no host-imposed label convention. An explicit
 * `readyLabels` wins for every source.
 *
 * `[tickets].readyAssignee` (Linear only) adds a third conjunctive gate: the
 * ticket must be assigned to that user.
 */
export function readyCriteria(config: Config): {
  labels: string[]
  state: string
  assignee?: string
} {
  const { readyLabels, readyState, readyAssignee } = config.tickets
  if (config.tickets.source === 'linear') {
    return {
      labels: readyLabels ?? ['autobuild'],
      state: readyState,
      ...(readyAssignee !== undefined ? { assignee: readyAssignee } : {}),
    }
  }
  return { labels: readyLabels ?? [], state: readyState }
}

/**
 * Where the dispatcher hands work back to a human — spec-gate bounces (§6.3),
 * aborted builds, closed-unmerged PRs. Source-dependent for the same reason
 * readiness is: the file tracker's grooming area IS the `triage/` directory,
 * while a Linear team only has a "Triage" workflow state when the team's
 * triage feature is enabled — Backlog is the state every Linear team has.
 * Hosted projects default to lowercase triage; plugin sources use the neutral
 * `Triage` fallback unless configured.
 */
export function defaultTriageState(config: Config): string {
  return ticketLifecycle(config.tickets).triage
}

/**
 * Where harvest files a synthesized proposal (§12). Defaults to the triage
 * state, so the constitutional gate — nothing auto-generated reaches Ready
 * without a human — holds unless a repository names another state.
 *
 * It is a field of its own rather than a reuse of `triageState` because the
 * two answer different questions. Pointing triage at the ready state to get
 * auto-dispatched proposals would also send spec-gate bounces there, and a
 * bounce that lands back in Ready is claimed and bounced again every tick.
 */
export function defaultProposalState(config: Config): string {
  return config.tickets.proposalState ?? defaultTriageState(config)
}

// ── Spec quality gate (SPEC §6.3, docs/spec-standard.md) ─────────────────────
// Shared with deterministic harvest filing; imported/re-exported above so the
// long-standing dispatcher API remains stable.

// ── Ticket dependency gate (SPEC §13) ────────────────────────────────────────
//
// Division of labor: the TicketSource answers FACTS (does this blocker exist,
// is it resolved by my native lifecycle, what does it declare as its own
// blockers); the dispatcher decides POLICY (an unresolved blocker means don't
// dispatch; a broken graph means skip this ticket, not the tick). Keeping the
// decision here means one tested implementation instead of one per adapter,
// and no adapter's state taxonomy leaks upward.

export interface DependencyVerdict {
  /** Unresolved blocker ids — nonempty means DO NOT dispatch. */
  unresolved: string[]
  /** Actionable lines naming the affected ticket and the dependency. */
  diagnostics: string[]
}

/**
 * Walks back from `from` looking for a node already on `path`; returns the
 * cycle (first repeated node → … → itself) or null. `explored` prunes nodes
 * proven acyclic on an earlier branch, so a wide graph cannot blow up.
 *
 * Note the repeat test is against `path`, not `nodes` — which is why closing a
 * cycle back onto the ticket under analysis needs no entry for it in `nodes`.
 */
function findCycle(
  from: string,
  path: string[],
  nodes: Map<string, DependencyState>,
  explored: Set<string>,
): string[] | null {
  const node = nodes.get(from)
  if (!node?.exists || node.resolved) return null
  for (const next of node.blockedBy) {
    const seen = path.indexOf(next)
    if (seen !== -1) return [...path.slice(seen), next]
    if (explored.has(next)) continue
    const cycle = findCycle(next, [...path, next], nodes, explored)
    if (cycle) return cycle
    explored.add(next)
  }
  return null
}

/**
 * Whether the ticket `ticketId`, which declares `blockedBy`, may be
 * dispatched — given `nodes`, closed over its reachable blockers (see
 * `loadDependencyGraph`).
 *
 * The ticket's own blockers are a PARAMETER, not a lookup in `nodes`: they
 * come from the ticket itself, which is authoritative for them. `nodes` holds
 * only facts fetched from the source, so nothing here has to fabricate an
 * entry for the ticket under analysis — a fabrication that, in a cache shared
 * across a tick, is indistinguishable from a fact about a *blocker* when the
 * next ticket looks it up.
 *
 * Pure and total: a node the walk cannot find is treated as
 * already-reported-missing rather than throwing. Exported for testing, like
 * `specConformance`.
 */
export function analyzeDependencies(
  ticketId: string,
  blockedBy: string[],
  nodes: Map<string, DependencyState>,
): DependencyVerdict {
  const unresolved: string[] = []
  const diagnostics: string[] = []

  for (const blockerId of blockedBy) {
    if (blockerId === ticketId) {
      unresolved.push(blockerId)
      diagnostics.push(`ticket ${ticketId} depends on itself`)
      continue
    }
    const node = nodes.get(blockerId)
    if (!node?.exists) {
      unresolved.push(blockerId)
      diagnostics.push(
        `ticket ${ticketId} blocked by ${blockerId}, which does not exist in ` +
          'this ticket source',
      )
      continue
    }
    // A resolved blocker imposes nothing, and its own history is irrelevant —
    // never walked, so a cycle *behind* completed work is not a diagnostic.
    if (node.resolved) continue

    unresolved.push(blockerId)
    // Gating never needs the transitive walk (an unresolved blocker already
    // holds the ticket); the walk exists only to NAME a cycle, which direct
    // blockers alone cannot express.
    const cycle = findCycle(blockerId, [ticketId, blockerId], nodes, new Set<string>())
    diagnostics.push(
      cycle
        ? `ticket ${ticketId}: dependency cycle ${cycle.join(' → ')}`
        : `ticket ${ticketId} blocked by ${blockerId} (not complete)`,
    )
  }

  return { unresolved, diagnostics }
}

/** `Add rate limiting!` → `add-rate-limiting` (general title normalizer). */
export function kebab(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'build'
}

/** Deterministic naming fallback: the first three normalized title tokens. */
export function fallbackSlug(title: string): string {
  return kebab(title).split('-').slice(0, 3).join('-')
}

/**
 * Validate a judgment-produced slug base without repairing model prose. Outer
 * whitespace is harmless; everything else must already be one-to-three
 * lowercase ASCII kebab tokens. Collision suffixes are appended later and are
 * intentionally outside this budget.
 */
export function validateSlugCandidate(candidate: string | null | undefined): string | null {
  if (candidate === null || candidate === undefined) return null
  const trimmed = candidate.trim()
  return /^[a-z0-9]+(?:-[a-z0-9]+){0,2}$/.test(trimmed) ? trimmed : null
}

// ── Tick report ──────────────────────────────────────────────────────────────

/** Counts per action, for observability and tests. An idempotent re-run of
 * `tick()` over unchanged state reports all zeroes — except invalid-record,
 * in-flight-creation, and dependency fields, which are standing queue reports rather than records of
 * action. They repeat between scans and refresh on completed scans, because that is the only
 * place the source problems are visible without provider inspection. */
export interface TickReport {
  forgeRequests?: import('../ports/forge-telemetry').ForgeRequestCounts
  /** Janitor (§15.7): builds completed as merged. */
  merged: number
  /** Janitor: builds completed as closed-unmerged. */
  closed: number
  /** Janitor: `pr.conflicted` emitted + build-runner re-attached. */
  conflicted: number
  /** Janitor: aborted builds cleaned up and completed as abandoned. */
  abandoned: number
  /** Janitor: queued builds explicitly discarded and returned to Ready. */
  discarded: number
  /** Contained build janitor and ticket-preparation recovery failures this pass. */
  janitorFailed: number
  /** One actionable line per contained failure, attributed by build or attempt. */
  janitorDiagnostics: string[]
  /** Ordinary-tick recovery completed an interrupted post-creation dispatch. */
  recovered: number
  /** Post-creation dispatch attempts that durably recorded a failure. */
  dispatchFailed: number
  /** Dispatch-command startup: current builds for which a runner was launched. */
  resumed: number
  /** One line per current build left parked by open escalations on startup. */
  blockedDiagnostics: string[]
  /** Lease sweep (§15.6-C): runners re-attached to stale builds. */
  swept: number
  /** Settlement stage: foreign executions settled from durable facts plus
   * provider liveness (a recorded completion or provider proof of end). */
  settled: number
  /** Builds whose remote workspace provisioning was (re-)kicked as tracked
   * background work this tick. The tick returns without awaiting it; the
   * continuation completes the remaining boundaries and the launch. */
  provisioning: number
  /** Dispatch (§12): builds created and launched. With durable supervision
   * this counts ACCEPTED dispatches — durable boundaries recorded — not
   * awaited launches: a dispatch whose remote provisioning continues in the
   * background is still accepted. */
  dispatched: number
  /** Of `dispatched`: specs produced via the authorSpec seam (§6.3). */
  authored: number
  /** Dispatch quality gate (§6.3): tickets bounced back to Triage. */
  bounced: number
  /** Claim-before-launch (§12): claims lost to another dispatcher. */
  claimRaces: number
  /** Invalid source records excluded from this ready listing. Like dependency
   * fields, this is a standing count and is re-reported until repaired. */
  invalidTickets: number
  /** Actionable source diagnostics for each excluded invalid record. */
  ticketDiagnostics: string[]
  /** Standing queue depth: ready tickets still waiting after this tick —
   * excludes tickets already embodied by an active build, and ones that left
   * the queue this tick (dispatched, bounced, or claimed elsewhere). Like the
   * invalid/dependency fields it repeats between completed scans. */
  queued: number
  /** Ready tickets withheld while Autobuild's own external creation is still
   * between durable reservation and settled blocker recording. */
  creationWithheld: number
  /** One line per creation hold, with Harvest run/proposal provenance. */
  creationDiagnostics: string[]
  /** Ready tickets whose dependency reads failed rather than yielding a verdict. */
  dependencyCheckFailed: number
  /** Dependency gate (§13): ready tickets held back by unresolved blockers. */
  dependencyBlocked: number
  /** One line per held ticket naming its unresolved blockers — the operator's
   * only view of the dependency queue short of provider inspection. */
  dependencyDiagnostics: string[]
  /** Repository observation workflow counters (independent of build capacity).
   * The CLI's in-flight coordinator merges these when asynchronous harvest
   * runs settle; Dispatcher.tick itself only initiates the work. */
  harvestStarted: number
  harvestResumed: number
  harvestCompleted: number
  harvestEscalated: number
  harvestFailed: number
  /** Operator sandboxes idly stopped this tick (AUT-340). */
  sandboxIdleStops: number
  /** Contained idle-settlement failures this tick; retried next tick. */
  sandboxSettleFailures: number
}

export function emptyTickReport(): TickReport {
  return {
    merged: 0,
    closed: 0,
    conflicted: 0,
    abandoned: 0,
    discarded: 0,
    janitorFailed: 0,
    janitorDiagnostics: [],
    recovered: 0,
    dispatchFailed: 0,
    resumed: 0,
    blockedDiagnostics: [],
    swept: 0,
    settled: 0,
    provisioning: 0,
    dispatched: 0,
    authored: 0,
    bounced: 0,
    claimRaces: 0,
    invalidTickets: 0,
    ticketDiagnostics: [],
    queued: 0,
    creationWithheld: 0,
    creationDiagnostics: [],
    dependencyCheckFailed: 0,
    dependencyBlocked: 0,
    dependencyDiagnostics: [],
    harvestStarted: 0,
    harvestResumed: 0,
    harvestCompleted: 0,
    harvestEscalated: 0,
    harvestFailed: 0,
    sandboxIdleStops: 0,
    sandboxSettleFailures: 0,
  }
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

const DEFAULT_SLUG_NAMING_TIMEOUT_MS = 10_000
/** Heartbeat cadence of a background provisioning continuation's execution
 * lease. A dead provisioner is therefore adopted within one lease TTL. */
const PROVISION_HEARTBEAT_MS = 15_000
const DEFAULT_PROVISION_STALE_MS = 20 * 60 * 1000

/** Outcome of one attempt to complete an interrupted dispatch. `deferred`
 * means durable progress was made (background provisioning kicked or already
 * in flight) and a later tick continues; the launch is never awaited here. */
export type DispatchOutcome = 'completed' | 'deferred' | 'parked' | 'failed'

/** One tracked background provisioning continuation (process-local). Its
 * durable residue is the `workspace.provision-started` marker plus the
 * execution lease it claims and heartbeats. */
interface ProvisionContinuation {
  readonly slug: string
  readonly instance: string
  readonly controller: AbortController
  promise: Promise<void>
}

export interface DispatcherOpts {
  /**
   * Grace for builds with NO lease at all: the sweep treats an absent lease
   * as expired only once this long has passed since the build's last store
   * update — a just-launched runner needs time to claim its first lease.
   * Default 0 (the simple predicate: absent ≡ expired). Expired-but-present
   * leases are always swept immediately.
   */
  leaseTtlMs?: number
  /**
   * Ticket state that hands work back to a human. Aborted work and
   * closed-unmerged PRs go back here rather than to a done-state — an abort
   * or close is a human decision that the ticket needs human re-triage, not
   * silent completion. Bounced tickets (§6.3) land here too. Absent =
   * defaultTriageState(config): [tickets].triageState, else 'Backlog'
   * (linear) / 'Triage' (file).
   */
  triageState?: string
  /** Ticket state for merged builds. Default 'Done'. */
  doneState?: string
  /** Internal deadline for the optional pre-build naming seam. Production is
   * fixed; injection exists only so timeout behavior is deterministic in tests. */
  slugNamingTimeoutMs?: number
  /** Must match the HarvestRunner's durable outer recovery budget. */
  maxHarvestRecoveryAttempts?: number
  /** Backstop for the crash window between a `workspace.provision-started`
   * append and its owner's lease claim: an open marker with NO lease is
   * adopted only once it is older than this. The primary adoption gate is the
   * execution lease itself — a dead heartbeating owner is adopted within one
   * lease TTL (60 s). Default 20 minutes. */
  provisionStaleMs?: number
}

export interface TickOpts {
  /**
   * Attempt every actionable, non-terminal build for this repo before the
   * ordinary stale-lease sweep. `ab dispatch` sets this only on its first
   * tick so crash recovery does not repeatedly probe healthy runners. Open
   * escalations remain human gates and are only reported as parked.
   */
  resumeCurrent?: boolean
  /** The caller refreshed the repository view for this tick already (the CLI
   * does, to sample the repository-wide controls from the same state). The
   * tick then skips its own refresh so one tick performs one discovery read. */
  viewRefreshed?: boolean
  /**
   * Repository-derived intake gate supplied by the CLI for this tick. False
   * skips only the ready-ticket list/claim/dispatch stage; janitor, startup
   * resume, lease sweep, and in-flight runners continue. Absent defaults true.
   */
  acceptNewWork?: boolean
  /** Repair/settle active execution policies only; suppress all intake and launches. */
  observationOnly?: boolean
  /**
   * Repository-derived claim-time default supplied by the CLI for this tick.
   * True records the existing durable auto-merge request only on builds
   * created by this tick's ticket claims. Absent/false preserves the sequence.
   */
  defaultAutoMerge?: boolean
  /** Human attribution for a claim-time auto-merge request. Required when
   * `defaultAutoMerge` is true; the CLI resolves USER/USERNAME/fallback. */
  autoMergeUser?: string
  /** Invocation bound in epoch ms against `deps.clock`. Once the clock reads
   * at or past it, no additional forge/store transport call is STARTED inside
   * the tick: per-item loops gate each new unit of work on the remaining
   * budget, so the tick's overrun past the bound is bounded to the single
   * transport call already in flight when the deadline passed. In-flight
   * calls are deliberately not cancelled — aborting mid-write risks tearing
   * durable store state. Skipped work is simply left un-attempted: ticks are
   * idempotent (§3.3 re-run safety) and the next invocation picks it up,
   * exactly as capacity exhaustion already defers tickets. Absent ⇒ unbounded
   * (today's exact behavior). */
  deadlineAt?: number
}

/** Process-local launch coordination result. Durable lease acquisition remains
 * the BuildRunner's responsibility; "scheduled" means only that this process
 * accepted a runner launch rather than suppressing a known in-flight slug. */
export type LaunchRunnerResult = 'scheduled' | 'already-active'

export interface DispatcherDeps {
  /** Current selected-account presence; no store reads. */
  missingAccounts?: () => MissingAccountCredential[]
  accountCredentialSource?: MissingAccountCredential['source']
  store: BuildStore
  tickets: TicketSource
  workspaces: WorkspaceProvider
  /** Providers that owned workspaces recorded under an earlier
   * `[workspace].provider`, so their builds can still be released after a
   * configuration switch. A workspace is only ever reaped or released by the
   * provider named on its provisioned fact. */
  retiredWorkspaces?: readonly WorkspaceProvider[]
  forge: Forge
  config: Config
  /** Configuration-only publication for incompatible pins; never launches a runner. */
  repairBuildConfig?: (slug: string) => Promise<void>
  /** Current process snapshot, captured once at the beginning of each tick.
   * Omission preserves the cron/static-config API. */
  getConfig?: () => Config
  /** The repo this dispatcher serves — a local path (§15.7: `git ls-remote`
   * against it needs no network) or the repository's normalized origin when
   * there is no checkout (origin mode; base facts then come from the forge's
   * `remoteBranchSha`). One dispatcher per repo (§12). */
  repo: string
  /** Explicit normalized origin for the served repository. When set (origin
   * mode), the dispatcher never probes the checkout's git for its origin —
   * there is no checkout — and stamps created builds directly with it. */
  repoOrigin?: string
  /** The physical main checkout when one exists (checkout mode). Local
   * workspace providers (git-worktree) provision FROM it; origin mode has no
   * checkout, and its remote providers never need one. */
  checkout?: string
  exec: Exec
  /** Launch (or re-attach — §15.6-C, §15.7) a build-runner for `slug`. The
   * dispatcher never runs pipeline agents itself. The launcher reports local
   * single-flight suppression so resume/sweep counters describe real schedules. */
  launchRunner: (slug: string) => Promise<LaunchRunnerResult>
  /**
   * Non-interactive spec authoring for thin-but-groomed tickets (§6.3):
   * returns a candidate spec body, or null when the ticket cannot be
   * expanded. Pragmatism, documented: the seam returns only the body — the
   * dispatcher stamps the authoring agent's session id itself (via `ids`)
   * for the `spec.authored` actor/payload, rather than widening the seam to
   * return session metadata the fake would have to invent.
   */
  authorSpec?: (ticket: Ticket) => Promise<string | null>
  /** Start the repository-scoped observation workflow without awaiting it.
   * The owner must single-flight and track the promise; Dispatcher invokes
   * this after ready-ticket dispatch, independent of drain/build capacity. */
  startHarvest?: () => void
  /** Optional one-shot judgment over the final conforming spec. The dispatcher
   * supplies cancellation and treats every absence/failure/invalid result as a
   * local deterministic fallback, so naming can never prevent build creation. */
  nameSlug?: (spec: string, signal: AbortSignal) => Promise<string | null>
  /** Settle pending publication for `slug` after durable proof that the
   * guest execution ended. Supplied by the DispatchLoop; the settlement stage
   * invokes it only on a recorded completion. */
  settlePublication?: (slug: string) => Promise<void>
  /** Slugs THIS process supervises in memory. The settlement stage skips
   * them: their completion chain owns the durable facts. */
  activeExecutions?: () => ReadonlySet<string>
  /** Hosted-harvest execution ids THIS process supervises in memory. The
   * harvest settlement stage skips them: their completion chain owns the
   * durable facts. */
  activeHarvestExecutions?: () => ReadonlySet<string>
  ids: IdSource
  clock: Clock
  opts?: DispatcherOpts
}

/** Latest `workspace.provisioned` not followed by a `workspace.released` —
 * the reducer deliberately ignores workspace events (liveness is the
 * dispatcher's concern), so the janitor scans the raw log. */
function openWorkspace(events: CurrentBuildFacts): OpenBuildWorkspace | null {
  return events.workspace
}

/** The build's base branch, from its own `build.created` fact (§15.3);
 * falls back to the repo config for logs missing one. */
function baseBranchOf(events: CurrentBuildFacts, config: Config): string {
  return events.baseBranch ?? config.baseBranch
}

function artifactRefOf(deposited: ArtifactMeta[]): ArtifactRef {
  const meta = deposited[0]
  if (!meta) throw new Error('spec deposit produced no artifact meta')
  return { kind: meta.kind, rev: meta.revision }
}

/**
 * Whether a repository-wide pause holds this build back from being given a
 * runner. Narrow on purpose, and the narrowness is load-bearing:
 *
 * - `queued` is exactly "a build record exists and no runner is attached" —
 *   the gap the repository pause exists to close. It is also the set bulk
 *   pause eligibility deliberately excludes, so the two halves of the control
 *   cover the whole space with no overlap.
 * - `running` builds are NOT held here. They are parked by the per-build pause
 *   the same keypress writes, and holding them in the dispatcher would strand
 *   `pendingCommands` delivery — the lease sweep is the only thing that
 *   re-attaches a runner so a build whose runner died can receive its abort or
 *   resume (§15.2.7).
 * - `done` / `aborted` / `blocked` / `paused` builds are the janitor's and the
 *   engine's business; the janitor is not gated, so abort and discard keep
 *   settling while the repository is at rest.
 */
export function heldByRepositoryPause(state: BuildState, paused: boolean): boolean {
  return paused && state.status === 'queued'
}

export const SWEEP_PIN_CACHE_CAPACITY = 128

export class Dispatcher {
  // Only scheduling is cached. Eligibility facts still come from durable state,
  // and each admitted verification/publication samples the source this pass.
  private integrationInputs?: Promise<IntegrationObservationInputs>
  private integrationPublicationInputs?: Promise<IntegrationObservationInputs>
  private readonly integrationPolls = new Map<string, { key: string; at: number }>()
  private readonly integrationLandingPolls = new Map<string, { key: string; at: number }>()
  private integrationPollDue(
    polls: Map<string, { key: string; at: number }>,
    slug: string,
    key: string,
  ): boolean {
    const now = this.deps.clock().getTime()
    const previous = polls.get(slug)
    if (previous?.key === key && now - previous.at < 300_000) return false
    polls.set(slug, { key, at: now })
    return true
  }
  // Work targets are frozen; settled activity is refreshed only when its
  // compact readiness digest changes. Neither cache decides eligibility.
  private readonly nodePollingBuilds = new Map<
    string,
    {
      target?: string
      activity: Pick<BuildState, 'pollingActivity'>
      settledKey?: string
    }
  >()
  private readonly nodePollingTickReads = new Map<string, Promise<BuildState>>()

  private async integrationClaimKey(slug: string, state: BuildState): Promise<string> {
    return nodeTicketObservationKey(state, await this.nodePollingChildren(slug))
  }
  private async nodePollingChildren(slug: string, refresh = false) {
    const children: { slug: string; state: Pick<BuildState, 'pollingActivity'> }[] = []
    for (const { record, digest } of await this.repoBuildDigests()) {
      if (record.slug === slug) continue
      const known = this.nodePollingBuilds.get(record.slug)
      // Only node relationships can move. Unrelated known work never needs
      // another full-facts read, even while it is running.
      if (digest.kind !== 'node' && known && known.target !== slug) continue
      const settledKey =
        digest.terminal && !digest.executionOpen
          ? JSON.stringify([
              digest.terminal,
              digest.readinessChangeSeq,
              digest.merged,
              digest.prClosed,
            ])
          : undefined
      let current = known
      if (!current || settledKey === undefined || current.settledKey !== settledKey) {
        let read =
          refresh || (known && known.settledKey !== settledKey)
            ? undefined
            : this.nodePollingTickReads.get(record.slug)
        if (!read) {
          read = this.store.buildFacts(record.slug).then((facts) => facts.state)
          this.nodePollingTickReads.set(record.slug, read)
        }
        const state = await read
        current = {
          target: state.target?.build,
          activity: { pollingActivity: state.pollingActivity },
          settledKey,
        }
        if (state.lastSeq > 0) this.nodePollingBuilds.set(record.slug, current)
      }
      if (current.target === slug) children.push({ slug: record.slug, state: current.activity })
    }
    return children
  }

  private observeIntegration(slug: string, publication = false) {
    return observeIntegration(this.store, this.deps.tickets, slug, () => {
      if (publication) {
        this.integrationPublicationInputs ??= integrationObservationInputs(
          this.store,
          this.deps.tickets,
          this.deps.repo,
        )
        return this.integrationPublicationInputs
      }
      this.integrationInputs ??= integrationObservationInputs(
        this.store,
        this.deps.tickets,
        this.deps.repo,
      )
      return this.integrationInputs
    })
  }

  // Disposable parsed pins only. Current facts, live policy and cycle captures
  // are recomputed on every decision; action boundaries never use this cache.
  private readonly sweepPins = new Map<string, { revision: number; config: Config }>()

  /** Read at each decision boundary: artifact revisions are independent of events. */
  private async decideBuild(
    slug: string,
    state: Parameters<typeof decideNextFromFacts>[0],
    log: Parameters<typeof decideNextFromFacts>[1],
    report: TickReport,
    sweep = false,
  ): Promise<ReturnType<typeof decideNextFromFacts> | undefined> {
    let revision: number | undefined
    try {
      let pinned: Config | undefined
      let cacheable = false
      if (sweep && this.store.getLatestArtifactMeta) {
        try {
          const meta = await this.store.getLatestArtifactMeta(slug, BUILD_EFFECTIVE_CONFIG_ARTIFACT)
          if (meta === null) {
            this.sweepPins.delete(slug)
            return decideNextFromFacts(state, log, this.deps.config)
          }
          revision = meta.revision
          cacheable = true
          const cached = this.sweepPins.get(slug)
          if (cached?.revision === revision) {
            pinned = cached.config
            // Map insertion order is the deterministic LRU order.
            this.sweepPins.delete(slug)
            this.sweepPins.set(slug, cached)
          } else {
            this.sweepPins.delete(slug)
          }
        } catch (error) {
          if (!(error instanceof ArtifactMetaUnsupportedError)) throw error
          this.sweepPins.delete(slug)
        }
      }
      if (pinned === undefined) {
        let artifact = await this.store.getArtifact(slug, BUILD_EFFECTIVE_CONFIG_ARTIFACT)
        if (artifact === null) {
          this.sweepPins.delete(slug)
          return decideNextFromFacts(state, log, this.deps.config)
        }
        revision = artifact.meta.revision
        try {
          pinned = parseEffectiveBuildConfig(artifact)
        } catch (error) {
          this.sweepPins.delete(slug)
          if (this.deps.repairBuildConfig === undefined) throw error
          await this.deps.repairBuildConfig(slug)
          artifact = await this.store.getArtifact(slug, BUILD_EFFECTIVE_CONFIG_ARTIFACT)
          if (artifact === null) throw new Error('configuration repair deposited no pipeline')
          revision = artifact.meta.revision
          pinned = parseEffectiveBuildConfig(artifact)
        }
        if (cacheable) {
          // A concurrent deposit may have advanced the revision after the probe:
          // label the bytes with the full response's revision, never the probe's.
          this.sweepPins.delete(slug)
          this.sweepPins.set(slug, { revision, config: pinned })
          if (this.sweepPins.size > SWEEP_PIN_CACHE_CAPACITY) {
            this.sweepPins.delete(this.sweepPins.keys().next().value!)
          }
        }
      }
      return decideNextFromFacts(
        state,
        log,
        await capturedBuildConfig(
          this.store,
          slug,
          state,
          composeBuildConfig(pinned, this.deps.config),
        ),
      )
    } catch (error) {
      this.sweepPins.delete(slug)
      report.blockedDiagnostics.push(
        `build ${slug} pipeline${revision === undefined ? '' : ` revision ${revision}`} unavailable: pipeline decisions withheld; next tick retries. Restore readable build-branch configuration or use a compatible dispatcher version. ${error instanceof Error || isForgeFailure(error) ? error.message : String(error)}`,
      )
      return undefined
    }
  }

  /** Memoized normalized origin of the served repository (one git call per
   * dispatcher), recorded on created builds so ambient reads can accept a
   * differently located checkout of the same repository by origin equality.
   * Origin mode supplies it explicitly (deps.repoOrigin) and never execs. */
  private repoOrigin?: Promise<string | undefined>

  private resolveRepoOriginOnce(): Promise<string | undefined> {
    if (this.deps.repoOrigin !== undefined) {
      this.repoOrigin ??= Promise.resolve(this.deps.repoOrigin)
      return this.repoOrigin
    }
    // Probe the physical checkout, not the store identity: since the identity
    // change `deps.repo` is the normalized origin (or a path only for
    // origin-less fixtures), and `git remote get-url` in a URL cwd silently
    // loses the origin. Origin mode returns above and never execs.
    this.repoOrigin ??= resolveRepoOrigin(this.deps.checkout ?? this.deps.repo, this.deps.exec)
    return this.repoOrigin
  }
  private readonly leaseTtlMs: number
  private get doneState(): string {
    return (
      this.deps.opts?.doneState ??
      (this.deps.config.tickets.source === 'hosted'
        ? ticketLifecycle(this.deps.config.tickets).done
        : undefined) ??
      'Done'
    )
  }
  private readonly slugNamingTimeoutMs: number
  private readonly maxHarvestRecoveryAttempts: number
  private readonly provisionStaleMs: number
  /** Process-local background provisioning, keyed by slug. A tick that sees a
   * slug here defers to the continuation; it never blocks on it. */
  private readonly continuations = new Map<string, ProvisionContinuation>()

  // Batched confirmed landing evidence is shared across nodes for this tick.
  // Only durable availability facts authorize the shortcut after restart.
  private availabilityLandings?: ReturnType<typeof confirmedLandings>
  private availabilityLandingKey?: string
  private availabilityEntries?: ReturnType<Dispatcher['repoBuildDigests']>

  /** The incremental repository view every stage reads and writes through
   * (AUT-647): `deps.store` itself when the caller already wrapped it. */
  private readonly store: RepoViewStore

  /** `deps.settlePublication`, followed by a delta read of the build: the
   * guest-side settlement appends through its own store handle, which the view
   * only learns of by reading. */
  private get settlePublication(): ((slug: string) => Promise<void>) | undefined {
    const settle = this.deps.settlePublication
    if (settle === undefined) return undefined
    return async (slug) => {
      if (await deferMixedVersion(this.store, slug)) return
      try {
        await settle(slug)
      } finally {
        await this.store.refreshBuild(slug)
      }
    }
  }

  constructor(private readonly deps: DispatcherDeps) {
    this.store =
      deps.store instanceof RepoViewStore
        ? deps.store
        : new RepoViewStore(deps.store, { repo: deps.repo })
    deps.forge = guardForge(deps.forge, {
      store: this.store,
      repo: deps.repo,
      name: deps.config.forge,
      now: deps.clock,
    })
    this.leaseTtlMs = deps.opts?.leaseTtlMs ?? 0
    this.slugNamingTimeoutMs = deps.opts?.slugNamingTimeoutMs ?? DEFAULT_SLUG_NAMING_TIMEOUT_MS
    this.maxHarvestRecoveryAttempts =
      deps.opts?.maxHarvestRecoveryAttempts ?? DEFAULT_MAX_HARVEST_RECOVERY_ATTEMPTS
    this.provisionStaleMs = deps.opts?.provisionStaleMs ?? DEFAULT_PROVISION_STALE_MS
  }

  /**
   * One cron-friendly pass (§3.3): janitor → interrupted dispatch recovery →
   * optional startup resume → lease sweep → dispatch. Startup resume is opt-in
   * because the CLI invokes it
   * once per command, while ordinary watch ticks must preserve policy parks.
   */
  /** Invocation-budget gate: true when a `deadlineAt` was supplied and the
   * clock already reads at or past it. Pure clock arithmetic — the per-item
   * loops consult this before starting each new forge/store transport call,
   * bounding the tick's overrun to the one call already in flight. */
  private outOfBudget(opts: TickOpts): boolean {
    return opts.deadlineAt !== undefined && this.deps.clock().getTime() >= opts.deadlineAt
  }

  lastForgeRequests?: import('../ports/forge-telemetry').ForgeRequestCounts
  async tick(opts: TickOpts = {}): Promise<TickReport> {
    this.availabilityEntries = undefined
    this.availabilityLandings = undefined
    this.availabilityLandingKey = undefined
    const builds = new Map<string, number>()
    let total = 0
    let unattributed = 0
    const categories = { restPrimary: 0, restNotModified: 0, graphql: 0 }
    let classified = this.deps.forge.name === 'github'
    const stop = this.deps.forge.observeRequests?.((request) => {
      const build = request.build ?? forgeRequestContext().build
      total++
      if (request.outcome) {
        categories[request.outcome]++
        classified = true
      }
      if (build) builds.set(build, (builds.get(build) ?? 0) + 1)
      else unattributed++
    })
    const counts = () => ({
      total,
      ...(classified ? categories : {}),
      unattributed,
      builds: [...builds]
        .map(([build, requests]) => ({ build, requests }))
        .sort((a, b) => b.requests - a.requests || a.build.localeCompare(b.build))
        .slice(0, 10),
      complete: true,
    })
    this.lastForgeRequests = undefined
    try {
      const report = await (this.deps.forge.withReadScope
        ? this.deps.forge.withReadScope(() => this.runTick(opts))
        : this.runTick(opts))
      if (stop || this.deps.config.forge === 'local-git') report.forgeRequests = counts()
      return report
    } finally {
      if (stop || this.deps.config.forge === 'local-git') this.lastForgeRequests = counts()
      stop?.()
    }
  }

  private async runTick(opts: TickOpts): Promise<TickReport> {
    this.integrationInputs = undefined
    this.integrationPublicationInputs = undefined
    this.nodePollingTickReads.clear()
    // One immutable config for this complete decision pass. A reload racing the
    // tick is observed by the next tick, never half-way through this one.
    this.deps.config = this.deps.getConfig?.() ?? this.deps.config
    if (opts.viewRefreshed !== true) await this.store.refresh()
    const autoMergeUser = undefined
    const report = emptyTickReport()
    this.restoreScan(report)
    /** Builds already launched this tick — a janitor/startup re-attach must
     * not be doubled by the sweep, nor a fresh dispatch by anything. */
    const launched = new Set<string>()
    // One journal read for both repository-wide controls: a pause that lands
    // mid-tick takes effect on the next tick, matching intake (which the CLI
    // likewise samples before calling `tick`); the auto-merge default fact is
    // the durable driver of this tick's fan-out below. Neither control
    // pretends to a serialization the store does not offer.
    const repoFacts = this.store.repositoryFacts()
    if (this.deps.missingAccounts) await this.reconcileAccountPresence(this.deps.missingAccounts())
    const paused = repoFacts.settings.paused
    const autoMergeSeedFact = undefined
    // Stage 0 — SETTLEMENT: observe foreign executions from durable facts plus
    // provider liveness and settle their completion, lease, and publication.
    // Runs before the janitor so its executionLeaseLive checks see freshly
    // released or renewed leases.
    // Stage entries are budget-gated so an already-spent budget does not even
    // open the first record listing of the next stage; each stage's own
    // per-iteration gate (below) covers a deadline that passes mid-stage.
    if (this.outOfBudget(opts)) return report
    await this.settleForeignExecutions(report, opts)
    if (this.outOfBudget(opts)) return report
    await this.settleHarvestExecutions(opts)
    if (this.outOfBudget(opts)) return report
    await this.settleOrchestratorSandboxes(report, opts)
    if (opts.observationOnly) return report
    if (this.outOfBudget(opts)) return report
    // The default fan-out runs before the janitor so one tick both records the
    // consent and lets the janitor act on it (the janitor reduces a fresh read
    // inside `checkPr`). Independent of intake and `acceptNewWork` — the
    // durable fact drives it, so a second dispatcher polling the same
    // repository converges the same state.
    if (this.outOfBudget(opts)) return report
    await this.recoverTicketPreparations(report, opts)
    if (this.outOfBudget(opts)) return report
    await this.janitor(report, launched, opts)
    if (this.outOfBudget(opts)) return report
    await this.recoverDispatches(report, launched, paused, opts)
    if (this.outOfBudget(opts)) return report
    if (opts.resumeCurrent === true) await this.resumeCurrent(report, launched, paused, opts)
    if (this.outOfBudget(opts)) return report
    await this.leaseSweep(report, launched, paused, opts)
    if (this.outOfBudget(opts)) return report
    if (opts.acceptNewWork !== false) {
      await this.dispatch(report, launched, autoMergeUser, paused, opts, autoMergeSeedFact)
    }
    // Fire-and-forget by contract: long synthesize/review sessions must not
    // stop janitor, lease sweep, ticket dispatch, or signal handling on later
    // watch ticks. Durable pause and infrastructure-error stops suppress
    // launch. Pending control commands still launch the runner so the kernel
    // can settle them under the repository lease.
    await this.triggerHarvest()
    return report
  }

  /** The repository-wide quiescence flag, from durable state. Guarded like
   * `triggerHarvest`: `getRepoEvents` throws for a repository row no tick has
   * created yet, and an unpaused repository is the correct reading of one that
   * has never recorded a setting. */
  private triageState(): string {
    return this.deps.opts?.triageState ?? defaultTriageState(this.deps.config)
  }

  /** This repository's builds paired with their digests, from one record
   * listing and one digest read — the tick loops' per-build event reads start
   * from here so a settled terminal build costs none. Records are read before
   * digests (as `operator/query.ts` does) so a concurrent create cannot fail
   * the completeness check. */
  private async repoBuildDigests(
    includeDeferred = false,
  ): Promise<{ record: BuildRecord; digest: BuildDigest }[]> {
    const store = this.store
    const { repo } = this.deps
    const records = (await store.listBuilds()).filter((record) => record.repo === repo)
    const digests = await readBuildDigests(store, repo)
    const blocked = new Set<string>()
    for (const record of records) {
      if (
        (digests.get(record.slug)?.compatibility?.decisiveFacts ?? 0) > 0 &&
        (await deferMixedVersion(store, record.slug))
      )
        blocked.add(record.slug)
    }
    return records
      .filter((record) => includeDeferred || !blocked.has(record.slug))
      .map((record) => {
        const digest = digests.get(record.slug)
        if (digest === undefined) {
          throw new Error(
            `build digest missing for ${record.slug}: the digest read broke completeness`,
          )
        }
        return { record, digest }
      })
  }

  /** Builds with no terminal fact: the only ones whose tick duties change
   * their state (decide, resume, lease sweep, capacity). */
  private async nonterminalBuilds(): Promise<BuildRecord[]> {
    return (await this.repoBuildDigests())
      .filter(({ digest }) => digest.terminal === undefined)
      .map(({ record }) => record)
  }

  /** Builds that still have work: nonterminal ones, plus terminal builds whose
   * post-terminal duty is outstanding — an `aborted` build awaiting its
   * cleanup's `build.completed`, a `done` build with an unreclaimed release
   * asset, or any build with an execution the provider has not been seen to
   * end. A terminal, settled build costs no event reads. */
  private async workBuilds(): Promise<BuildRecord[]> {
    return (await this.repoBuildDigests())
      .filter(({ digest }) => isWorkDigest(digest) || digest.integrationAuditPending === true)
      .map(({ record }) => record)
  }

  private async sourceCondition(
    next?: TicketSourceDegradation,
    successfulOperation?: 'ready-scan' | 'dependency-check',
  ): Promise<void> {
    const current = this.store.repositoryFacts().health
    if (next !== undefined && current?.cause === next.cause && current.source === next.source) {
      if (
        next.cause === 'rate-limited' &&
        next.operation === 'dependency-check' &&
        current.operation !== 'dependency-check'
      ) {
        await this.store.appendRepo(this.deps.repo, {
          actor: DISPATCHER,
          type: 'dispatcher.ticket-source-dependency-limited',
          payload: { source: current.source },
        })
      }
      return
    }
    if (
      next === undefined &&
      current?.operation === 'dependency-check' &&
      successfulOperation !== 'dependency-check'
    )
      return
    if (current !== undefined) {
      await this.store.appendRepo(this.deps.repo, {
        actor: DISPATCHER,
        type: 'dispatcher.ticket-source-recovered',
        payload: { source: current.source, cause: current.cause, operation: current.operation },
      })
    }
    if (next !== undefined) {
      await this.store.ensureRepo(this.deps.repo)
      await this.store.appendRepo(this.deps.repo, {
        actor: DISPATCHER,
        type: 'dispatcher.ticket-source-degraded',
        payload: next,
      })
    }
  }

  private async sourceFailure(
    error: unknown,
    operation: 'ready-scan' | 'dependency-check',
  ): Promise<void> {
    const message = error instanceof Error || isForgeFailure(error) ? error.message : String(error)
    await this.sourceCondition(
      error instanceof TicketSourceRateLimitError
        ? {
            source: error.source,
            cause: 'rate-limited',
            operation,
            message,
            resetAt: new Date(error.resetAt).toISOString(),
          }
        : {
            source: this.deps.tickets.name,
            cause: 'ready-scan-failed',
            operation,
            message: message || 'Ready scan failed',
          },
    )
  }

  private async listReady() {
    try {
      return await this.deps.tickets.listReady(readyCriteria(this.deps.config))
    } catch (error) {
      await this.sourceFailure(error, 'ready-scan')
      throw error
    }
  }

  private async currentTicketId(record: BuildRecord): Promise<string> {
    if (!record.ticket) throw new Error(`build ${record.slug} has no ticket`)
    return resolveTicketRef(
      this.store.repositoryFacts().ticketMigrations,
      record.ticket,
      this.deps.tickets.name,
      record.slug,
    ).id
  }

  private async activeTicketIdentities(refs: TicketRef[], listed: Ticket[]): Promise<Set<string>> {
    const key = (ref: TicketRef) => `${ref.source}:${ref.id}`
    const migrations = this.store.repositoryFacts().ticketMigrations
    const records = await this.repoBuildDigests()
    const normalized = refs.map((ref) => {
      try {
        return resolveTicketRef(
          migrations,
          ref,
          this.deps.tickets.name,
          records.find(
            ({ record }) => record.ticket?.source === ref.source && record.ticket.id === ref.id,
          )?.record.slug,
        )
      } catch (error) {
        // An unrelated source remains excluded only in its original namespace.
        // A recorded cutover that omits a live claim must block admission.
        if (migrations.migrations.some((m) => m.from === ref.source && m.from !== m.to)) throw error
        return ref
      }
    })
    const ids = new Set(normalized.map(key))
    if (this.deps.tickets.name !== 'hosted' || listed.length === 0) return ids
    const listedIds = new Set(listed.map((ticket) => key(ticket.ref)))
    const identity = ticketIdentity(this.deps.tickets)
    try {
      for (const ref of normalized) {
        if (ref.source === 'hosted' && !listedIds.has(key(ref))) ids.add(await identity(ref))
      }
    } catch (error) {
      await this.sourceFailure(error, 'ready-scan')
      throw error
    }
    return ids
  }

  /** Observation-only ready listing for Store-backed frontends while intake is
   * disabled. It shares the active-ticket exclusion with dispatch but performs
   * no dependency fetch, claim, bounce, build, workspace, or launch side
   * effect, and deliberately does not alter TickReport compatibility. */
  async observeReady(opts: Pick<TickOpts, 'viewRefreshed'> = {}): Promise<{
    queued: number
    invalidTickets: number
    ticketDiagnostics: string[]
  }> {
    this.deps.config = this.deps.getConfig?.() ?? this.deps.config
    if (opts.viewRefreshed !== true) await this.store.refresh()
    const report = emptyTickReport()
    this.restoreScan(report)
    const checkpoint = await this.scanCheckpoint('observation')
    if (checkpoint.due) {
      const listing = await this.listReady()
      const refs: TicketRef[] = []
      for (const { record, digest } of await this.repoBuildDigests()) {
        if (record.ticket && digest.terminal === undefined) refs.push(record.ticket)
      }
      const activeTicketIds = await this.activeTicketIdentities(refs, listing.tickets)
      report.queued = listing.tickets.filter(
        (ticket) =>
          !activeTicketIds.has(`${ticket.ref.source}:${ticket.ref.id}`) &&
          !Object.values(this.store.repositoryFacts().preparation).some((attempt) => {
            const ref = resolveTicketRef(
              this.store.repositoryFacts().ticketMigrations,
              attempt.ticket,
              this.deps.tickets.name,
              attempt.slug ?? attempt.attempt,
            )
            return ref.source === ticket.ref.source && ref.id === ticket.ref.id
          }),
      ).length
      report.invalidTickets = listing.diagnostics.length
      report.ticketDiagnostics = [...listing.diagnostics]
      report.dependencyBlocked = 0
      report.dependencyDiagnostics = []
      report.creationWithheld = 0
      report.creationDiagnostics = []
      await this.sourceCondition(undefined, 'ready-scan')
      await this.completeScan(checkpoint, report)
    }
    return {
      queued: report.queued,
      invalidTickets: report.invalidTickets,
      ticketDiagnostics: report.ticketDiagnostics,
    }
  }

  private latestScan() {
    return this.store.repositoryFacts().scan
  }

  private restoreScan(report: TickReport): void {
    const previous = this.latestScan()
    if (previous === undefined) return
    for (const key of [
      'queued',
      'invalidTickets',
      'dependencyBlocked',
      'creationWithheld',
    ] as const)
      report[key] = previous[key]
    for (const key of [
      'ticketDiagnostics',
      'dependencyDiagnostics',
      'creationDiagnostics',
    ] as const)
      report[key] = [...previous[key]]
  }

  private async scanCheckpoint(mode: 'admission' | 'observation') {
    const digest = (await this.repoBuildDigests())
      .filter(({ digest }) => digest.readinessChangeSeq !== undefined)
      .map(({ record, digest }) => [record.slug, digest.readinessChangeSeq] as const)
      .sort(([a], [b]) => a.localeCompare(b))
    const hash = (value: unknown) =>
      createHash('sha256').update(JSON.stringify(value)).digest('hex')
    const readinessFingerprint = hash(digest)
    const criteriaFingerprint = hash(readyCriteria(this.deps.config))
    const startedAt = this.deps.clock().toISOString()
    const previous = this.latestScan()
    const cached = await this.store.getScanCadence(this.deps.repo)
    // Outcomes always come from the reduction. This row only acknowledges their cadence.
    const valid =
      previous !== undefined &&
      cached !== null &&
      cached.scanSeq === this.store.repositoryFacts().scanSeq &&
      cached.mode === previous.mode &&
      cached.readinessFingerprint === previous.readinessFingerprint &&
      cached.criteriaFingerprint === previous.criteriaFingerprint &&
      Number.isFinite(Date.parse(cached.startedAt))
    const baseline = valid ? cached : previous
    const elapsed =
      baseline === undefined ? Infinity : Date.parse(startedAt) - Date.parse(baseline.startedAt)
    return {
      startedAt,
      mode,
      readinessFingerprint,
      criteriaFingerprint,
      allowClockRollback: elapsed < 0,
      due:
        previous === undefined ||
        elapsed < 0 ||
        elapsed >= this.deps.config.ticketScanIntervalSeconds * 1000 ||
        previous.readinessFingerprint !== readinessFingerprint ||
        previous.criteriaFingerprint !== criteriaFingerprint ||
        (mode === 'admission' && previous.mode === 'observation'),
    }
  }

  private async completeScan(
    checkpoint: Awaited<ReturnType<Dispatcher['scanCheckpoint']>>,
    report: TickReport,
  ): Promise<void> {
    const payload = {
      startedAt: checkpoint.startedAt,
      mode: checkpoint.mode,
      readinessFingerprint: checkpoint.readinessFingerprint,
      criteriaFingerprint: checkpoint.criteriaFingerprint,
      queued: report.queued,
      invalidTickets: report.invalidTickets,
      ticketDiagnostics: report.ticketDiagnostics.slice(0, 1000),
      dependencyBlocked: report.dependencyBlocked,
      dependencyDiagnostics: report.dependencyDiagnostics.slice(0, 1000),
      creationWithheld: report.creationWithheld,
      creationDiagnostics: report.creationDiagnostics.slice(0, 1000),
    }
    const previous = this.latestScan()
    const unchanged =
      previous !== undefined &&
      Object.keys(payload)
        .filter((key) => key !== 'startedAt')
        .every(
          (key) =>
            JSON.stringify(previous[key as keyof typeof payload]) ===
            JSON.stringify(payload[key as keyof typeof payload]),
        )
    await this.store.ensureRepo(this.deps.repo)
    let scanSeq = this.store.repositoryFacts().scanSeq
    if (!unchanged) {
      const event = await this.store.appendRepo(this.deps.repo, {
        actor: DISPATCHER,
        type: 'dispatcher.ticket-scan-completed',
        payload,
      })
      scanSeq = event.seq
    }
    if (scanSeq === undefined) throw new Error('completed scan has no canonical fact')
    await this.store.putScanCadence(
      this.deps.repo,
      {
        scanSeq,
        startedAt: checkpoint.startedAt,
        mode: checkpoint.mode,
        readinessFingerprint: checkpoint.readinessFingerprint,
        criteriaFingerprint: checkpoint.criteriaFingerprint,
      },
      checkpoint.allowClockRollback,
    )
  }

  private accountsAvailable(): boolean {
    return !this.deps.missingAccounts?.().length
  }

  private accountReconciliation: Promise<unknown> = Promise.resolve()

  private reconcileAccountPresence(
    missing: readonly MissingAccountCredential[],
    merge = false,
  ): Promise<void> {
    const operation = this.accountReconciliation.then(async () => {
      if (missing.length && !this.store.journalRecorded())
        await this.store.ensureRepo(this.deps.repo)
      const current = this.store.repositoryFacts().missingAccounts
      const next = merge
        ? Object.values({
            ...current,
            ...Object.fromEntries(missing.map((account) => [account.name, account])),
          })
        : missing
      await reconcileMissingAccounts(next, current, (event) =>
        this.store.appendRepo(this.deps.repo, event),
      )
    })
    this.accountReconciliation = operation.catch(() => {})
    return operation
  }

  async holdForMissingAccounts(error: unknown): Promise<boolean> {
    if (!(error instanceof MissingAccountCredentialsError)) return false
    const absent = missingAccountCredentials(
      Object.fromEntries(error.missing.map((account) => [account.name, account.descriptor])),
      {},
      this.deps.accountCredentialSource,
    )
    await this.reconcileAccountPresence(absent, true)
    return true
  }

  private async triggerHarvest(): Promise<void> {
    if (!this.accountsAvailable()) return
    const start = this.deps.startHarvest
    if (start === undefined) return
    // Use the tick sample, advanced by any local repository append.
    if (!this.store.journalRecorded()) {
      start()
      return
    }
    // Bounded subset (AUT-489): the harvest reducer consumes durable types only.
    const state = this.store.repositoryFacts().harvest
    if (decideHarvestControl(state, this.maxHarvestRecoveryAttempts).kind !== 'park') {
      start()
    }
  }

  private async forgeCoolingDown(): Promise<boolean> {
    const active = await readForgeHealth(this.store, this.deps.repo)
    return !!active && Date.parse(active.resetAt) > this.deps.clock().getTime()
  }

  private async launch(
    slug: string,
    launched: Set<string>,
    report: TickReport = emptyTickReport(),
  ): Promise<LaunchRunnerResult> {
    if (!this.accountsAvailable()) return 'already-active'
    if (await this.forgeCoolingDown()) return 'already-active'
    if (await deferMixedVersion(this.store, slug)) return 'already-active'
    const launchState = (await this.store.buildFacts(slug)).state
    if (
      launchState.kind === 'node' &&
      !launchState.nodeRestack?.conflict &&
      !integrationCurrent(launchState)
    )
      return 'already-active'
    if (launched.has(slug)) return 'already-active'
    launched.add(slug)
    const facts = (await readBuildFacts(this.store, slug)).value
    if (facts.log.restack.target === undefined && facts.lastCreated !== undefined) {
      const branch = facts.lastCreated.payload.baseBranch
      await this.observeTarget(slug, branch, undefined, report)
    }
    if (
      !(await ensureExecutionProgress(
        this.store,
        this.deps.ids,
        slug,
        this.deps.config,
        (state, log) => this.decideBuild(slug, state, log, report),
      ))
    ) {
      return 'already-active'
    }
    return this.deps.launchRunner(slug)
  }

  // ── 0. Settlement stage (durable supervision) ──────────────────────────────

  /** The provider that owns a recorded execution, by the provider name on its
   * `execution.started` fact. An execution from a provider this process no
   * longer knows cannot be observed and is left to the stale-lease path. */
  private executionOwner(provider: string): WorkspaceProvider | null {
    if (provider === this.deps.workspaces.name) return this.deps.workspaces
    return this.deps.retiredWorkspaces?.find((candidate) => candidate.name === provider) ?? null
  }

  /** Observe and settle every foreign open execution of this repo. A build
   * this process supervises in memory is skipped — its completion chain owns
   * the durable facts. One listBuilds plus at most two bounded provider round
   * trips per unsettled build; a failing build is contained so the rest of
   * the stage still settles. */
  private async settleForeignExecutions(report: TickReport, opts: TickOpts = {}): Promise<void> {
    const active = this.deps.activeExecutions?.() ?? new Set<string>()
    for (const record of await this.workBuilds()) {
      if (active.has(record.slug)) continue
      // Budget gate: once spent, stop settling further foreign executions.
      if (this.outOfBudget(opts)) break
      try {
        const { open } = await this.store.buildFacts(record.slug)
        if (open === null) continue
        const owner = this.executionOwner(open.provider)
        const execution = owner?.buildExecution
        if (execution?.observe === undefined || open.commandId === undefined) continue
        const settlement = await settleOpenExecution(
          {
            store: this.store,
            execution,
            ids: this.deps.ids,
            ...(this.settlePublication !== undefined
              ? { settlePublication: this.settlePublication }
              : {}),
          },
          record.slug,
          open,
        )
        if (settlement === 'settled') report.settled += 1
      } catch {
        // An unobservable build must not stall settlement of the rest; the
        // next tick retries it.
      }
    }
  }

  /** Durable settlement for hosted-harvest executions (AUT-305), next to the
   * build pass above and run in the same settlement stage: every
   * `harvest.execution.started` without a matching released fact whose
   * execution is not supervised by this process is observed through the
   * owning provider. `lost`/`ended` reaps the disposable environment and
   * journals the close fact with the snapshot purge outcome; `running`
   * leaves it — the guest is the live supervisor and holds the adopted
   * repository lease, and the next pass reaps it after it ends. The run
   * itself needs no settlement here: an interrupted run stays open in the
   * journal and the next threshold-triggered harvest resumes it under the
   * repository lease. */
  private async settleHarvestExecutions(opts: TickOpts = {}): Promise<void> {
    const active = this.deps.activeHarvestExecutions?.() ?? new Set<string>()
    const facts = this.store.repositoryFacts()
    for (const execution of facts.openHarvest) {
      if (active.has(execution.execution)) continue
      // Budget gate: once spent, stop settling further harvest executions;
      // the next tick retries what remains.
      if (this.outOfBudget(opts)) break
      try {
        const owner = this.executionOwner(execution.provider)
        const capability = owner?.harvestExecution
        if (
          owner === null ||
          capability?.observe === undefined ||
          execution.commandId === undefined
        )
          continue
        const observation = await capability.observe({
          provider: execution.provider,
          workspaceRef: execution.environmentId,
          environmentId: execution.environmentId,
          ...(execution.sessionId !== undefined ? { sessionId: execution.sessionId } : {}),
          commandId: execution.commandId,
        })
        if (observation.attention) {
          const current = this.store.repositoryFacts()
          const authorization = current.harvestAuthorizations[JSON.stringify(execution.execution)]
          const run = current.harvest.runs.find((run) => run.run === authorization?.payload.run)
          // A model session has a durable run authorization. Escalation is
          // terminal and deduplicates across ticks and dispatcher restarts;
          // the execution itself remains observable until its command exits.
          if (run?.status === 'running')
            await this.store.appendRepo(this.deps.repo, {
              actor: KERNEL,
              type: 'harvest.escalated',
              payload: {
                run: run.run,
                source: 'policy',
                reason: observation.attention,
                observations: run.observations,
              },
            })
        }
        // Conservatism: an unresolvable observation (provider error) throws
        // and is contained below — it never reaps.
        if (observation.state === 'running') continue
        let snapshots: { outcome: 'confirmed' | 'unknown'; deleted?: number; error?: string } = {
          outcome: 'unknown',
          error: 'provider did not report the snapshot purge',
        }
        if (owner.recovery !== undefined) {
          const reap = await owner.recovery.reap({
            provider: owner.name,
            ref: execution.environmentId,
            path: execution.environmentId,
            branch: '',
          })
          snapshots = {
            outcome: reap.snapshots.outcome === 'unknown' ? 'unknown' : 'confirmed',
            ...(reap.snapshots.deleted !== undefined ? { deleted: reap.snapshots.deleted } : {}),
            ...(reap.snapshots.error !== undefined ? { error: reap.snapshots.error } : {}),
          }
        } else {
          await owner.release({
            provider: owner.name,
            ref: execution.environmentId,
            path: execution.environmentId,
            branch: '',
          })
        }
        await this.store.appendRepo(this.deps.repo, {
          actor: DISPATCHER,
          type: 'harvest.execution.released',
          payload: {
            execution: execution.execution,
            environmentId: execution.environmentId,
            snapshots,
          },
        })
      } catch {
        // An unobservable harvest execution must not stall the rest of the
        // settlement stage; the next tick retries it.
      }
    }
  }

  /** Durable idle settlement for operator sandboxes (AUT-340), staged after
   * harvest settlement: every journal-live environment whose latest evidence
   * is older than `[orchestrator].sandbox.idleMinutes` is stopped through the
   * provider (snapshot kept) and closed with a dispatcher-authored fact.
   * Because activity evidence is durably journaled, this one rule also
   * settles the orphan case — a dead `ab mcp` process stops appending
   * activity, so the next tick idles its environment out, exactly as harvest
   * executions are settled. A journal-live environment whose journaled
   * provider no longer matches the wired provider is likewise dispositioned
   * once idle: its trail is closed with an unconfirmed release fact (AUT-377)
   * — never a stop, since this dispatcher cannot reach a provider it is not
   * wired to — and if the old provider returns, the next operator ensure()
   * re-provisions and re-brackets the environment, so the disposition is
   * reachable again. The stage is a no-op unless `[orchestrator]` is
   * enabled and the wired provider hosts the capability; `unsupported`
   * providers (local worktrees) are skipped silently. */
  private async settleOrchestratorSandboxes(
    report: TickReport,
    opts: TickOpts = {},
  ): Promise<void> {
    const config = this.deps.config
    if (config.orchestrator?.enabled !== true) return
    const capability = this.deps.workspaces.orchestratorSandbox
    if (capability === undefined) return
    const providerName = this.deps.workspaces.name
    const facts = this.store.repositoryFacts()
    const idleMs = config.orchestrator.sandbox.idleMinutes * 60_000
    for (let environment of facts.sandboxes) {
      if (environment.state !== 'live') continue
      // Budget gate: once spent, stop settling further environments; the
      // next tick retries what remains.
      if (this.outOfBudget(opts)) break
      const lastEvidence = Date.parse(environment.lastEvidenceTs)
      if (Number.isFinite(lastEvidence) && this.deps.clock().getTime() - lastEvidence < idleMs) {
        continue
      }
      try {
        // Other processes may have recorded activity while earlier tick work
        // awaited an outside read. Revalidate only an impending disposition.
        await this.store.refreshJournal()
        const current = this.store
          .repositoryFacts()
          .sandboxes.find(
            (candidate) =>
              candidate.operator === environment.operator &&
              candidate.environmentId === environment.environmentId,
          )
        if (current === undefined || current.state !== 'live') continue
        const currentEvidence = Date.parse(current.lastEvidenceTs)
        if (
          Number.isFinite(currentEvidence) &&
          this.deps.clock().getTime() - currentEvidence < idleMs
        ) {
          continue
        }
        environment = current
        if (environment.provider !== providerName) {
          // Provider-mismatch disposition (AUT-377): the journaled provider no
          // longer matches the wired provider, so environmentIds are out of this
          // dispatcher's reach and idle settlement would otherwise skip it on
          // every tick forever. Close the trail with an unconfirmed release —
          // never a stop: nothing was stopped through a provider this
          // dispatcher no longer owns. If the provider returns, the next
          // operator ensure() re-provisions and re-brackets the environment.
          await this.store.appendRepo(this.deps.repo, {
            actor: DISPATCHER,
            type: 'orchestrator.sandbox.released',
            payload: {
              operator: environment.operator,
              environmentId: environment.environmentId,
              snapshots: {
                outcome: 'unknown',
                error: `environment owned by provider "${environment.provider}", not the wired provider "${providerName}" — unreachable at idle settlement`,
              },
            },
          })
          report.sandboxIdleStops += 1
          continue
        }
        const outcome = await capability.stop({
          operator: environment.operator,
          environmentId: environment.environmentId,
        })
        if (outcome.outcome === 'unsupported') continue
        if (outcome.outcome === 'stopped') {
          await this.store.appendRepo(this.deps.repo, {
            actor: DISPATCHER,
            type: 'orchestrator.sandbox.stopped',
            payload: {
              operator: environment.operator,
              environmentId: environment.environmentId,
              reason: 'idle',
            },
          })
          report.sandboxIdleStops += 1
        } else {
          // The environment vanished without a stop (expired, reaped, or a
          // dead host): close the orphan's trail with an unconfirmed-purge
          // release fact, dispatcher-authored exactly as
          // `harvest.execution.released` is.
          await this.store.appendRepo(this.deps.repo, {
            actor: DISPATCHER,
            type: 'orchestrator.sandbox.released',
            payload: {
              operator: environment.operator,
              environmentId: environment.environmentId,
              snapshots: {
                outcome: 'unknown',
                error: 'environment absent at idle settlement',
              },
            },
          })
          report.sandboxIdleStops += 1
        }
      } catch (error) {
        // Contained: the next tick retries this environment.
        report.sandboxSettleFailures += 1
        report.janitorDiagnostics.push(
          `operator sandbox ${environment.environmentId}: idle settlement failed — ${error instanceof Error || isForgeFailure(error) ? error.message : String(error)}`,
        )
      }
    }
  }

  // ── Background provisioning (durable supervision) ──────────────────────────

  /** The latest `workspace.provision-started` not yet followed by a
   * provisioned/released fact — an open provisioning marker. */
  private openProvisionMarker(events: CurrentBuildFacts): ProvisionMarker | undefined {
    return events.provisionMarker
  }

  /** Liveness of the lease behind an open provision marker: `live` means a
   * fresh heartbeat (someone is provisioning); `expired` means the owner died
   * within the last TTL and is adopted immediately; `absent` means the owner
   * may have crashed between marker and claim — adopted only after the
   * `provisionStaleMs` backstop. */
  private async provisionMarkerLiveness(slug: string): Promise<'live' | 'expired' | 'absent'> {
    const record = await this.store.getBuild(slug)
    if (record?.lease === undefined) return 'absent'
    return new Date(record.lease.expiresAt).getTime() > this.deps.clock().getTime()
      ? 'live'
      : 'expired'
  }

  /** Kick (or defer to) the background provisioning continuation for a remote
   * build with no open workspace. Returns what happened so the caller can
   * report progress without awaiting any of it. */
  private async ensureProvisionContinuation(
    record: BuildRecord,
    events: CurrentBuildFacts,
    tail: 'dispatch' | 'launch',
    seed?: {
      ticket: Ticket
      body: string
      authoredSession?: string
      autoMergeUser?: string
      autoMergeDefaultSeq?: number
      assets?: PinnedAsset[]
    },
  ): Promise<'kicked' | 'in-flight' | 'foreign-live'> {
    const slug = record.slug
    if (!this.accountsAvailable()) return 'in-flight'
    if (this.continuations.has(slug)) return 'in-flight'
    const marker = this.openProvisionMarker(events)
    if (marker !== undefined) {
      const liveness = await this.provisionMarkerLiveness(slug)
      const failedAttempt = events.latestWorkspaceFailureSeq > marker.seq
      if (liveness === 'live') return 'foreign-live'
      if (
        liveness === 'absent' &&
        !failedAttempt &&
        this.deps.clock().getTime() - new Date(marker.ts).getTime() < this.provisionStaleMs
      ) {
        // A lease-less marker is the crash window this backstop exists for:
        // the owner may still be between the append and its claim. A failed
        // attempt (dispatch.failed after the marker) adopts immediately.
        return 'foreign-live'
      }
      // Expired lease, failed attempt, or an old lease-less marker: adopt.
    }
    const branch = record.branch ?? `ab/${slug}`
    const generation = events.workspaceGenerations
    await this.store.append(slug, {
      actor: DISPATCHER,
      type: 'workspace.provision-started',
      payload: { provider: this.deps.workspaces.name, branch, generation },
    })
    const entry: ProvisionContinuation = {
      slug,
      instance: `provision-${this.deps.ids('inst')}`,
      controller: new AbortController(),
      promise: Promise.resolve(),
    }
    // Registered synchronously before any await of the continuation itself so
    // a concurrent re-entry defers to it instead of double-kicking.
    this.continuations.set(slug, entry)
    entry.promise = this.runProvisionContinuation(entry, {
      branch,
      generation,
      seed,
      tail,
    }).catch(() => {
      // Detached work must never reject into the dispatcher process. Failure
      // recording can itself fail on a store outage; durable boundaries and
      // lease expiry let the next tick repair or retry the unfinished work.
    })
    return 'kicked'
  }

  /** The background continuation: claim and heartbeat the build's execution
   * lease, provision, append the durable fact, then complete the remaining
   * boundaries and launch. Every provider call and boundary write is fenced
   * by the cancellation token, so a superseded supervisor exits without
   * colliding with its replacement. Failures append
   * `dispatch.failed {stage: 'workspace'}` (plus the infrastructure failure
   * when applicable) and stay retryable. */
  private async runProvisionContinuation(
    entry: ProvisionContinuation,
    input: {
      branch: string
      generation: number
      seed?:
        | {
            ticket: Ticket
            body: string
            authoredSession?: string
            autoMergeUser?: string
            autoMergeDefaultSeq?: number
            assets?: PinnedAsset[]
          }
        | undefined
      tail: 'dispatch' | 'launch'
    },
  ): Promise<void> {
    const store = this.store
    const { workspaces, config } = this.deps
    const slug = entry.slug
    let leaseClaimed = false
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let boundary: 'workspace' | 'read' | 'dispatch' | 'launch' = 'workspace'
    const stage: EventPayload<'dispatch.failed'>['stage'] = 'workspace'
    try {
      if (entry.controller.signal.aborted) {
        // Signalled before the body even started (teardown raced the kick):
        // exit before claiming anything; stopProvisioning already released
        // the marker's lease so the next supervisor adopts immediately.
        return
      }
      if (await deferMixedVersion(store, slug)) return
      leaseClaimed = await store.claimLease(slug, entry.instance, BUILD_EXECUTION_LEASE_TTL_MS)
      if (!leaseClaimed) return // another live holder — the next tick re-evaluates
      heartbeat = setInterval(() => {
        void store.claimLease(slug, entry.instance, BUILD_EXECUTION_LEASE_TTL_MS).catch(() => {
          // Store unreachable: retry on the next beat; expiry fences.
        })
      }, PROVISION_HEARTBEAT_MS)
      heartbeat.unref?.()
      if (entry.controller.signal.aborted) {
        // Teardown: exit before provisioning. The finally releases the lease,
        // so the next supervisor adopts the marker immediately.
        return
      }
      const events = (await readBuildFacts(store, slug)).value
      if (mixedVersionDeferred(events.state)) {
        await deferMixedVersion(store, slug)
        return
      }
      const priorGenerations = events.workspaceGenerations
      const handle = await workspaces.provision({
        // Local providers provision FROM the physical checkout; remote
        // providers ignore the value (their host seams are injected).
        repo: this.deps.checkout ?? this.deps.repo,
        baseBranch:
          events.state.kind === 'node' && events.state.integration?.cycle
            ? input.branch
            : baseBranchOf(events, config),
        branch: input.branch,
        ...(priorGenerations > 0 || input.generation > 0
          ? {
              publication: await this.confirmedWorkspacePublication(events, slug),
              revision: events.state.integration?.cycle?.head ?? this.recoveryCheckpoint(events),
              generation: Math.max(priorGenerations, input.generation),
            }
          : {}),
      })
      // The provisioned fact is true and welcome even when a teardown signal
      // landed mid-call; the token check below still prevents a superseded
      // supervisor from launching.
      await store.append(slug, {
        actor: DISPATCHER,
        type: 'workspace.provisioned',
        payload: {
          provider: handle.provider,
          ref: handle.ref,
          path: handle.path,
          ...(handle.localPath !== undefined ? { localPath: handle.localPath } : {}),
          remote: workspaces.publication !== undefined,
          branch: handle.branch,
          base: handle.base,
        },
      } satisfies EventWrite<'workspace.provisioned'>)
      // Release before the launch: the launcher re-claims the lease under the
      // runner's own instance. The tiny gap is safe because every downstream
      // action is single-flight in-process and lease-fenced cross-process.
      if (heartbeat !== undefined) {
        clearInterval(heartbeat)
        heartbeat = undefined
      }
      await store.releaseLease(slug, entry.instance)
      leaseClaimed = false
      if (entry.controller.signal.aborted) return
      boundary = 'read'
      const record = await store.getBuild(slug)
      if (record === null) return
      const queued = (await readBuildFacts(store, slug)).value.state.status === 'queued'
      boundary = input.tail === 'dispatch' || queued ? 'dispatch' : 'launch'
      if (boundary === 'dispatch') await this.completeDispatchBoundaries(record, input.seed)
      else if (this.accountsAvailable()) await this.deps.launchRunner(slug)
    } catch (error) {
      // Dispatch boundaries own their failure facts and exhaustion repair.
      // A failed tail read/write leaves durable unfinished work for the next
      // tick; it is not another provider workspace failure. Replacement
      // runner launch errors retain the existing infrastructure-budget path.
      if (await this.holdForMissingAccounts(error)) return
      if (boundary === 'read' || boundary === 'dispatch') return
      const events = (await readBuildFacts(store, slug)).value
      if (workspaces.recovery !== undefined) {
        const open = openWorkspace(events)
        const latestRef = events.latestRelease
        await this.recordInfrastructureFailure(slug, events, {
          provider: workspaces.name,
          workspaceRef:
            open?.ref ??
            (latestRef?.type === 'workspace.released' && 'ref' in latestRef.payload
              ? latestRef.payload.ref
              : slug),
          operation: 'provision',
          error,
          cleanupPending: true,
        })
      }
      const attempt = events.dispatchFailureCount + 1
      const message = (
        error instanceof Error || isForgeFailure(error) ? error.message : String(error)
      ).trim()
      await store.append(slug, {
        actor: DISPATCHER,
        type: 'dispatch.failed',
        payload: {
          stage,
          attempt,
          error: message || 'dispatch failed without an error message',
        },
      })
    } finally {
      if (heartbeat !== undefined) clearInterval(heartbeat)
      if (leaseClaimed) {
        try {
          await store.releaseLease(slug, entry.instance)
        } catch {
          // Expiry fences an ambiguous release.
        }
      }
      if (this.continuations.get(slug)?.instance === entry.instance) {
        this.continuations.delete(slug)
      }
    }
  }

  /** Await every in-flight provisioning continuation. A test/observability
   * seam — a tick never awaits these; the durable facts remain the contract. */
  async drainProvisioning(): Promise<void> {
    await Promise.allSettled([...this.continuations.values()].map((entry) => entry.promise))
  }

  /** Whether any provisioning continuation is still running in this process.
   * A one-shot invocation consults it to keep awaiting (within its deadline)
   * instead of tearing the continuation down as abandoned. */
  provisioningInFlight(): boolean {
    return this.continuations.size > 0
  }

  /** Teardown: signal every live continuation, then record a durable failure
   * fact for any whose provisioning marker is still open (so the next
   * supervisor adopts it immediately rather than after the crash backstop),
   * then release each one's provisioning lease, in that order. Never awaited
   * by a tick. */
  async stopProvisioning(): Promise<void> {
    const entries = [...this.continuations.values()]
    for (const entry of entries) entry.controller.abort()
    for (const entry of entries) {
      try {
        const events = (await readBuildFacts(this.store, entry.slug)).value
        if (this.openProvisionMarker(events) !== undefined) {
          const attempt = events.dispatchFailureCount + 1
          await this.store.append(entry.slug, {
            actor: DISPATCHER,
            type: 'dispatch.failed',
            payload: {
              stage: 'workspace',
              attempt,
              error:
                'provisioning abandoned at dispatcher teardown; the next supervisor adopts the open marker',
            },
          })
        }
      } catch {
        // The durable marker plus the released lease still gate adoption.
      }
      try {
        await this.store.releaseLease(entry.slug, entry.instance)
      } catch {
        // Expiry fences an ambiguous release.
      }
    }
  }

  // ── a. Janitor (SPEC §15.7, D1) ────────────────────────────────────────────

  private async janitor(
    report: TickReport,
    launched: Set<string>,
    opts: TickOpts = {},
  ): Promise<void> {
    // Listing is repository-wide work: if it fails there is no individual
    // build to attribute, so the caller's existing top-level boundary owns it.
    // Only this repo's builds that still have work (§12: another repo's
    // builds are another dispatcher's duty; settled terminal builds cost no
    // event reads).
    const entries = (await this.repoBuildDigests()).filter(
      ({ digest }) => isWorkDigest(digest) || digest.integrationAuditPending === true,
    )
    // Receipt reporting requires no forge call, capacity or workspace. Recover
    // every episode before the transport-budget and janitor-backoff gates.
    for (const { record, digest } of entries) {
      if (digest.kind !== 'node' || !digest.nodeOpened || digest.terminal) continue
      try {
        await reportIntegrationFailures(this.store, record.slug)
      } catch (error) {
        report.janitorDiagnostics.push(
          `build ${record.slug}: integration attention recovery failed — ${String(error)}`,
        )
      }
    }
    for (const { record, digest } of entries) {
      // Budget gate: the janitor's per-build path issues forge/store transport
      // calls (PR probes, closePr, deleteBranch); once the budget is spent,
      // stop starting new ones. The remaining builds stay janitor due — the
      // next invocation re-runs them (§3.3 idempotency).
      if (this.outOfBudget(opts)) break
      await withForgeRequestContext({ build: record.slug }, async () => {
        let previous: BuildState['janitor']
        let attempted = false
        let failed = false
        try {
          // Once a record is known, contain its complete janitor path: loading
          // and reducing facts, cleanup, forge/ticket calls, and store writes.
          // Existing partial facts leave the same work due on the next tick.
          const initialFacts = await this.store.buildFacts(record.slug)
          let { state, workspace, log } = initialFacts
          previous = state.janitor
          const controlDue =
            state.pendingCommands.length > 0 ||
            state.discardRequest !== undefined ||
            (state.pr &&
              state.landing?.command &&
              state.landing.command.seq !== state.landing.acknowledgedSeq)
          if (
            !controlDue &&
            previous &&
            Date.parse(previous.nextAttemptAt) > this.deps.clock().getTime()
          )
            return
          if (mixedVersionDeferred(state)) {
            await deferMixedVersion(this.store, record.slug)
            return
          }
          const executionLeaseLive = this.hasLiveExecutionLease(record)
          attempted = !executionLeaseLive
          // Raw history, read at most once and only by a branch that acts on it:
          // the facts above answer every quiet-path question without it.
          let loaded: CurrentBuildFacts | undefined
          const history = async (): Promise<CurrentBuildFacts> => {
            loaded ??= (await readBuildFacts(this.store, record.slug)).value
            return loaded
          }
          const pollStart = state
          const pollChildren =
            state.kind === 'node' ? await this.nodePollingChildren(record.slug) : []
          const pollKey = nodeActivityKey(state, pollChildren)
          const pollSchedule =
            state.kind === 'node' && !nodePollingUnsettled(state)
              ? nodePollingSchedule(
                  state,
                  pollKey,
                  this.deps.config.policy,
                  this.deps.clock(),
                  executionLeaseLive ||
                    initialFacts.open !== null ||
                    initialFacts.publication.pending() ||
                    initialFacts.publication.abandonedPending() ||
                    undefined,
                )
              : undefined
          if (state.kind === 'node' && !controlDue && pollSchedule && !pollSchedule.due) {
            attempted = false
            return
          }
          let incompleteObservation = false
          const diagnosticsBefore = report.janitorDiagnostics.length
          const completeNodePoll = async () => {
            if (
              pollStart.kind !== 'node' ||
              !pollStart.nodeOpened ||
              incompleteObservation ||
              executionLeaseLive ||
              report.janitorDiagnostics.length !== diagnosticsBefore ||
              this.outOfBudget(opts)
            )
              return
            const current = (await this.store.buildFacts(record.slug)).state
            if (nodePollingUnsettled(current) && current.status !== 'done') return
            const children = await this.nodePollingChildren(record.slug, true)
            const key = nodeActivityKey(current, children)
            // A command or child event arriving during observation stays due.
            const commandTypes = [
              'build.land-requested',
              'build.hold-requested',
              'node.restack-requested',
              'escalation.answered',
              'node.parent-requested',
            ]
            if (
              commandTypes.some(
                (type) => current.pollingActivity?.[type] !== pollStart.pollingActivity?.[type],
              ) ||
              nodeActivityKey(pollStart, children) !== pollKey
            )
              return
            const now = this.deps.clock().toISOString()
            const previousCheck = current.nodePolling
            if (
              !nodePollingCheckpointRequired(current, key, this.deps.config.policy, new Date(now))
            )
              return
            await this.store.appendIfCurrent(record.slug, current.lastSeq, {
              actor: DISPATCHER,
              type: 'node.poll-checked',
              payload: {
                activityKey: key,
                unchangedSince: nodePollingEvidenceValid(
                  current,
                  key,
                  this.deps.config.policy,
                  new Date(now),
                )
                  ? previousCheck!.unchangedSince
                  : now,
                nodeIdleAfterSeconds: this.deps.config.policy.nodeIdleAfterSeconds,
                nodeIdlePollSeconds: this.deps.config.policy.nodeIdlePollSeconds,
              },
            })
          }
          let observedPr: Awaited<ReturnType<Forge['getPrState']>> | undefined
          // A replacement head is followed first by a forge read and cancellation,
          // ahead of node cascade, controls, or any other action for this build.
          if (
            state.status !== 'done' &&
            state.status !== 'aborted' &&
            state.prState === 'open' &&
            state.pr &&
            state.landing?.native?.operation
          ) {
            const path = this.forgeWorkspacePathOf(workspace)
            const observed = await this.deps.forge.getPrState(path, state.pr.number)
            observedPr = observed
            if (observed.state !== 'open') {
              await this.checkPr(
                record,
                {
                  history,
                  workspace,
                  observed: (pr) => {
                    incompleteObservation ||= pr.state === 'open' && pr.mergeable === null
                  },
                },
                state,
                report,
                launched,
                executionLeaseLive,
                observedPr,
              )
              return
            }
            const result =
              observed.nativeAutoMerge === false
                ? { kind: 'applied' as const }
                : await this.deps.forge.setAutoMerge(path, state.pr.number, false)
            if (result.kind !== 'applied')
              throw new Error('Replacement-head native cancellation unconfirmed')
            observedPr = { ...observed, nativeAutoMerge: false }
          }
          // Pipeline/ticket/workspace state is settled, but release-asset cleanup
          // has its own crash window after build.completed. Revisit only pending
          // hosted handles; this never relaunches a runner or consumes capacity.
          if (
            state.kind === 'node' &&
            state.integration?.landing?.operation &&
            !state.integration.audit
          ) {
            await this.withKernelRepository((path) =>
              auditIntegrationLanding({
                store: this.store,
                forge: this.kernelForge(),
                exec: this.kernelForge().kernelExec ?? this.deps.exec,
                workspacePath: path,
                slug: record.slug,
                id: this.deps.ids('esc'),
              }),
            )
          }
          if (state.status === 'done') {
            if (digest.reclaimPending === true) {
              await this.reclaimPrAttachments(record.slug, await history())
            }
            return
          }
          if (state.kind === 'node' && state.status !== 'aborted') {
            const command =
              state.pendingCommands.find((c) => c.command === 'abort') ??
              state.pendingCommands.at(0)
            if (command !== undefined && !executionLeaseLive) {
              await this.store.append(record.slug, {
                actor: DISPATCHER,
                type:
                  command.command === 'abort'
                    ? 'build.aborted'
                    : command.command === 'pause'
                      ? 'build.paused'
                      : 'build.resumed',
                payload: {},
              })
              if (command.command === 'abort')
                await this.cleanupAborted(record, await history(), report)
              return
            }
            if (state.nodeOpened) {
              let primed = false
              if (
                record.branch &&
                state.baseBranch &&
                !((state.status === 'paused' || state.status === 'blocked') && !state.pr)
              ) {
                primed = await this.primeNodeReads(record, state, report)
              }
              if (
                primed &&
                state.pr &&
                (
                  await this.deps.forge.getPrState(
                    this.deps.checkout ?? this.deps.repo,
                    state.pr.number,
                  )
                ).state !== 'open'
              ) {
                await this.checkPr(
                  record,
                  {
                    history,
                    workspace,
                    observed: (pr) => {
                      incompleteObservation ||= pr.state === 'open' && pr.mergeable === null
                    },
                  },
                  state,
                  report,
                  launched,
                  executionLeaseLive,
                )
                await completeNodePoll()
                return
              }
              const previousParent = state.baseBranch
              await this.observeTicketTarget(record, state, report)
              loaded = undefined
              ;({ state, workspace, log } = await this.store.buildFacts(record.slug))
              if (record.branch && state.baseBranch && previousParent !== state.baseBranch) {
                await this.primeNodeReads(record, state, report)
              }
            }
            if ((state.status === 'paused' || state.status === 'blocked') && !state.pr) return
            if (state.nodeOpened && state.baseBranch) {
              if (
                await this.observeTarget(
                  record.slug,
                  state.baseBranch,
                  log.restack.target?.sha,
                  report,
                )
              ) {
                loaded = undefined
                ;({ state, workspace, log } = await this.store.buildFacts(record.slug))
              }
            }
            if (
              state.nodeOpened &&
              state.status !== 'paused' &&
              (state.status !== 'blocked' || integrationFailed(state)) &&
              state.prState !== 'merged' &&
              state.prState !== 'closed' &&
              !executionLeaseLive
            ) {
              await this.prepareIntegration(record, state, report, launched, { refreshOnly: true })
              ;({ state, workspace, log } = await this.store.buildFacts(record.slug))
              await this.cascadeNode(record, state, report, launched, opts)
              loaded = undefined
              ;({ state, workspace, log } = await this.store.buildFacts(record.slug))
            }
            if (state.nodeOpened && !executionLeaseLive) {
              await this.prepareIntegration(record, state, report, launched)
              loaded = undefined
              ;({ state, workspace, log } = await this.store.buildFacts(record.slug))
            }
            if (state.nodeOpened !== undefined && state.pr === undefined) {
              await this.pollEmptyNode(record, state)
              await completeNodePoll()
              return
            }
          }
          // Abort is destructive human judgment and therefore outranks a queued
          // discard when both requests raced into the same stream.
          if (
            !executionLeaseLive &&
            state.status === 'queued' &&
            state.pendingCommands.some((command) => command.command === 'abort')
          ) {
            const acknowledged = await this.store.append(record.slug, {
              actor: DISPATCHER,
              type: 'build.aborted',
              payload: {},
            } satisfies EventWrite<'build.aborted'>)
            void acknowledged
            // The view folded the acknowledgement it just appended.
            loaded = undefined
            await this.cleanupAborted(record, await history(), report)
            return
          }
          // Discard is a queued-only recovery control. A request that raced with
          // runner attachment is deliberately inert: it must never tear a live
          // runner's workspace down or return its ticket for a duplicate build.
          if (
            !executionLeaseLive &&
            state.status === 'queued' &&
            state.discardRequest !== undefined
          ) {
            await this.cleanupDiscarded(record, await history(), report)
            return
          }
          if (!executionLeaseLive && state.status === 'aborted') {
            await this.cleanupAborted(record, await history(), report)
            return
          }
          if (state.kind !== 'node' && state.status !== 'aborted')
            await this.observeTicketTarget(record, state, report)
          if (state.kind !== 'node' && state.status !== 'aborted' && state.status !== 'queued') {
            const branch = await readBuildSelector(this.store, record.slug, 'baseBranch')
            if (branch !== undefined) {
              if (await this.observeTarget(record.slug, branch, log.restack.target?.sha, report)) {
                loaded = undefined
                ;({ state, workspace, log } = await this.store.buildFacts(record.slug))
              }
            }
          }
          if (
            state.kind !== 'node' &&
            state.status !== 'queued' &&
            state.status !== 'aborted' &&
            state.prState !== 'merged' &&
            state.prState !== 'closed'
          ) {
            const facts = await this.store.buildFacts(record.slug)
            const target = facts.log.restack.target
            if (target && target.branch === facts.state.baseBranch) {
              let sample = {
                branch: target.branch,
                sha: target.sha,
                head: null,
                count: null,
              } as EventPayload<'target.distance'>
              try {
                sample = await sampleTargetDistance({
                  ...target,
                  buildBranch: record.branch ?? `ab/${record.slug}`,
                  ...(facts.workspace && !isRemoteWorkspace(facts.workspace)
                    ? { localPath: this.forgeWorkspacePathOf(facts.workspace) }
                    : {}),
                  exec: this.deps.exec,
                  forge: this.deps.forge,
                })
              } catch (error) {
                if (
                  error instanceof ForgeRequestDeferred ||
                  (isForgeFailure(error) && error.details.kind === 'rate-limited')
                )
                  throw error
                if (facts.log.restack.distance?.count != null)
                  report.janitorDiagnostics.push(
                    `build ${record.slug}: target distance failed — ${error instanceof Error ? error.message : String(error)}`,
                  )
              }
              const current = await this.store.buildFacts(record.slug)
              if (
                current.state.status !== 'done' &&
                current.state.status !== 'aborted' &&
                current.state.prState !== 'merged' &&
                current.state.prState !== 'closed' &&
                current.state.baseBranch === target.branch &&
                current.log.restack.target?.sha === target.sha &&
                current.log.restack.completedAt === facts.log.restack.completedAt &&
                current.state.implement.commits?.head === facts.state.implement.commits?.head &&
                (current.log.restack.distance?.branch !== sample.branch ||
                  current.log.restack.distance?.sha !== sample.sha ||
                  current.log.restack.distance?.head !== sample.head ||
                  current.log.restack.distance?.count !== sample.count)
              ) {
                await this.store.append(record.slug, {
                  actor: DISPATCHER,
                  type: 'target.distance',
                  payload: sample,
                })
                loaded = undefined
              }
            }
          }
          if (state.pr) {
            await this.checkPr(
              record,
              {
                history,
                workspace,
                observed: (pr) => {
                  incompleteObservation ||= pr.state === 'open' && pr.mergeable === null
                },
              },
              state,
              report,
              launched,
              executionLeaseLive,
              observedPr,
            )
          }
          await completeNodePoll()
        } catch (error) {
          if (error instanceof ForgeRequestDeferred) {
            attempted = false
            return
          }
          if (error instanceof MixedVersionDeferral) {
            attempted = false
            return
          }
          failed = true
          const message =
            error instanceof Error || isForgeFailure(error) ? error.message : String(error)
          await recordJanitorFailure(
            this.store,
            record.slug,
            previous,
            message,
            this.deps.clock(),
            this.deps.config.policy,
          )
          report.janitorFailed += 1
          report.janitorDiagnostics.push(`build ${record.slug}: janitor failed — ${message}`)
        } finally {
          if (attempted && !failed && previous)
            await this.store.append(record.slug, {
              actor: DISPATCHER,
              type: 'build.janitor-recovered',
              payload: {},
            })
        }
      })
    }
  }

  /** Priming saves requests but must not block parent recovery or ordinary observations. */
  private async primeNodeReads(
    record: BuildRecord,
    state: BuildState,
    report: TickReport,
  ): Promise<boolean> {
    if (!this.deps.forge.primeNodeReads || !record.branch || !state.baseBranch) return false
    try {
      await this.deps.forge.primeNodeReads({
        workspacePath: this.deps.checkout ?? this.deps.repo,
        parent: state.baseBranch,
        head: record.branch,
        ...(state.pr ? { prNumber: state.pr.number } : {}),
      })
      return true
    } catch (error) {
      if (
        error instanceof ForgeRequestDeferred ||
        (isForgeFailure(error) && error.details.kind === 'rate-limited')
      )
        throw error
      report.janitorDiagnostics.push(
        `build ${record.slug}: node read priming failed — ${error instanceof Error || isForgeFailure(error) ? error.message : String(error)}`,
      )
      return false
    }
  }

  private parentContext(): ParentContext {
    return {
      store: this.store,
      source: this.deps.tickets,
      repo: this.deps.repo,
      root: this.deps.config.baseBranch,
      configuredSource: this.deps.config.tickets.source,
      supportsRetarget: async () =>
        !!this.deps.forge.retargetPr && !!this.deps.forge.inspectLandingPr,
    }
  }

  /** Tracker observation can withhold a new parent, but cannot stop recovery
   * against the durable effective parent or observation of terminal PRs. */
  private async observeTicketTarget(record: BuildRecord, state: BuildState, report: TickReport) {
    try {
      if (state.kind === 'node') await this.observeNodeParent(record, state, report)
      else await this.observeWorkTarget(record, state, report)
    } catch (error) {
      report.janitorDiagnostics.push(
        `build ${record.slug}: ticket target observation failed — ${error instanceof Error || isForgeFailure(error) ? error.message : String(error)}`,
      )
    }
  }

  private async clearParentRejection(record: BuildRecord, ticket: Ticket) {
    const state = (await this.store.buildFacts(record.slug)).state
    if (!state.nodeRestack?.parentRejection) return
    await this.store.appendIfCurrent(record.slug, state.lastSeq, {
      actor: DISPATCHER,
      type: 'node.parent-rejection-cleared',
      payload: { revision: ticket.revision, target: ticket.target ?? null },
    })
  }

  private async rejectParent(
    record: BuildRecord,
    ticket: Ticket,
    reason: string,
    report: TickReport,
  ) {
    const rejection = { revision: ticket.revision, target: ticket.target ?? null, reason }
    const state = (await this.store.buildFacts(record.slug)).state
    if (!sameParentRejection(state.nodeRestack?.parentRejection, rejection))
      await this.store.append(record.slug, {
        actor: DISPATCHER,
        type: 'node.parent-rejected',
        payload: rejection,
      })
    report.janitorDiagnostics.push(`build ${record.slug}: ${reason}`)
  }

  private async observeWorkTarget(record: BuildRecord, state: BuildState, report: TickReport) {
    if (!record.ticket) return
    const ticket = await this.deps.tickets.get(await this.currentTicketId(record))
    if (!ticket) {
      report.janitorDiagnostics.push(
        `build ${record.slug}: claimed ticket cannot be read; frozen work target retained`,
      )
      return
    }
    const effective = state.target
      ? resolveTicketRef(
          this.store.repositoryFacts().ticketMigrations,
          state.target.ticket,
          this.deps.tickets.name,
          record.slug,
        ).id
      : undefined
    const canonical =
      effective && this.deps.config.tickets.source === 'hosted'
        ? ((await this.deps.tickets.get(effective))?.ref.id ?? effective)
        : effective
    if (ticket.target !== canonical)
      await this.rejectParent(
        record,
        ticket,
        'changing a claimed work ticket target requires abort and re-dispatch',
        report,
      )
    else await this.clearParentRejection(record, ticket)
  }

  /** Provider edits and interrupted caller writes converge through this same
   * durable path, independently of ticket readiness or caller liveness. */
  private async observeNodeParent(record: BuildRecord, state: BuildState, report: TickReport) {
    if (!record.ticket) return
    if (nodeParentBusy(state)) return
    if (
      state.pr &&
      (await this.deps.forge.getPrState(this.deps.checkout ?? this.deps.repo, state.pr.number))
        .state !== 'open'
    )
      return
    const node = state.nodeRestack
    if (node?.parentChange) {
      // Replay is frozen until its receipt, including through reconcile and
      // lease loss. Later source edits wait for both Git and PR acknowledgement.
      const move = node.parentChange
      if (node.parentReplay !== move.id) return
      const forge = this.deps.forge
      if (state.pr && node.parentPr !== move.id) {
        const path = this.deps.checkout ?? this.deps.repo
        if ((await forge.getPrState(path, state.pr.number)).state !== 'open') return
        const cancelled = await forge.setAutoMerge(path, state.pr.number, false)
        if (cancelled.kind !== 'applied') return
        await forge.retargetPr!(path, state.pr.number, move.next.branch)
        const inspected = await forge.inspectLandingPr!(path, state.pr.number)
        if (
          !inspected.open ||
          inspected.base !== move.next.branch ||
          inspected.head !== record.branch ||
          inspected.headSha !== node.inventory?.head
        )
          throw new Error('parent PR acknowledgement disagrees with effective target')
        await this.store.append(record.slug, {
          actor: DISPATCHER,
          type: 'node.parent-pr-retargeted',
          payload: { id: move.id, base: move.next.branch },
        })
      }
      await this.store.append(record.slug, {
        actor: DISPATCHER,
        type: 'node.parent-completed',
        payload: { id: move.id },
      })
      this.integrationInputs = undefined
      this.integrationPublicationInputs = undefined
      return
    }
    const ticket = await this.deps.tickets.get(await this.currentTicketId(record))
    if (!ticket) throw new Error('node ticket cannot be read; parent observation failed closed')
    const desired = ticket.target ?? null
    const request = node?.parentRequest
    const effective = state.target
      ? resolveTicketRef(
          this.store.repositoryFacts().ticketMigrations,
          state.target.ticket,
          this.deps.tickets.name,
          record.slug,
        ).id
      : undefined
    const canonical =
      effective && this.deps.config.tickets.source === 'hosted'
        ? ((await this.deps.tickets.get(effective))?.ref.id ?? effective)
        : effective
    if (!request && desired === (canonical ?? null)) {
      await this.clearParentRejection(record, ticket)
      return
    }
    // Settle the current writer before sampling any new destination.
    if (node?.active || state.sessions.open.length || this.hasLiveExecutionLease(record)) return
    const holder = this.deps.ids('parent-writer')
    if (!(await this.store.claimNodeWriter(record.slug, holder, 60_000))) return
    try {
      state = (await this.store.buildFacts(record.slug)).state
      if (
        nodeParentBusy(state) ||
        state.nodeRestack?.active ||
        state.nodeRestack?.parentChange ||
        state.nodeRestack?.parentRequest?.id !== request?.id
      )
        return
      if (
        request &&
        desired !==
          (request.next.target
            ? resolveTicketRef(
                this.store.repositoryFacts().ticketMigrations,
                request.next.target.ticket,
                this.deps.tickets.name,
                record.slug,
              ).id
            : null)
      ) {
        await this.store.appendIfCurrent(record.slug, state.lastSeq, {
          actor: DISPATCHER,
          type: 'node.parent-cancelled',
          payload: { id: request.id, reason: 'source readback does not confirm requested target' },
        })
        return
      }
      let next: EventPayload<'node.parent-accepted'>['next']
      try {
        next = await validateNodeParent(this.parentContext(), record, ticket)
        if (
          request &&
          (next.branch !== request.next.branch || next.target?.build !== request.next.target?.build)
        )
          throw new Error('destination generation changed; retry target update')
      } catch (error) {
        if (request)
          await this.store.append(record.slug, {
            actor: DISPATCHER,
            type: 'node.parent-cancelled',
            payload: { id: request.id, reason: String(error) },
          })
        await this.rejectParent(
          record,
          ticket,
          error instanceof Error || isForgeFailure(error) ? error.message : String(error),
          report,
        )
        return
      }
      if (state.pr) {
        const path = this.deps.checkout ?? this.deps.repo
        if ((await this.deps.forge.getPrState(path, state.pr.number)).state !== 'open') return
        if ((await this.deps.forge.setAutoMerge(path, state.pr.number, false)).kind !== 'applied')
          return
      }
      if (!(await this.store.renewNodeWriter(record.slug, holder))) return
      const move = {
        id: request?.id ?? this.deps.ids('node-parent'),
        old: { target: state.target ?? null, branch: state.baseBranch! },
        next,
        revision: ticket.revision,
      }
      await this.store.appendIfCurrent(record.slug, state.lastSeq, {
        actor: DISPATCHER,
        type: 'node.parent-accepted',
        payload: move,
      })
      this.integrationInputs = undefined
      this.integrationPublicationInputs = undefined
    } finally {
      await this.store.releaseNodeWriter(record.slug, holder)
    }
  }

  private async observeTarget(
    slug: string,
    branch: string,
    _previous: string | undefined,
    report: TickReport,
  ): Promise<boolean> {
    try {
      const sha = await this.baseSha(branch)
      return (
        (await observeTarget({
          store: this.store,
          forge: this.deps.forge,
          slug,
          branch,
          sha,
          actor: DISPATCHER,
          proveRewrite: (node, from) =>
            proveTargetLineage({
              store: this.store,
              forge: this.deps.forge,
              node,
              from,
              branch,
              sha,
            }),
        })) !== 'unchanged'
      )
    } catch (error) {
      const message =
        error instanceof Error || isForgeFailure(error) ? error.message : String(error)
      report.janitorDiagnostics.push(`build ${slug}: target observation failed — ${message}`)
      return false
    }
  }

  private forgeWorkspacePath(events: CurrentBuildFacts): string {
    return this.forgeWorkspacePathOf(openWorkspace(events))
  }

  private forgeWorkspacePathOf(open: OpenBuildWorkspace | null): string {
    if (open !== null && isRemoteWorkspace(open)) return this.deps.repo
    // Local forges run git with cwd = workspacePath: it must be the physical
    // checkout, never the store identity (an origin URL since the identity
    // change; a path only for origin-less fixtures).
    return open?.localPath ?? open?.path ?? open?.ref ?? this.deps.checkout ?? this.deps.repo
  }

  /** Deferral withholds decisions, but cannot free an existing capacity reservation. */
  private async capacityBuilds(): Promise<CapacityBuild[]> {
    const builds: CapacityBuild[] = []
    for (const { record, digest } of await this.repoBuildDigests(true)) {
      if (digest.terminal) continue
      const facts = await this.store.buildFacts(record.slug)
      builds.push({
        record,
        state: facts.state,
        workspace: facts.workspace !== null,
        provisioning:
          digest.kind === 'node' &&
          (await readBuildFacts(this.store, record.slug)).value.provisionMarker !== undefined,
      })
    }
    return builds
  }

  private async nodeHasCapacity(slug: string): Promise<boolean> {
    const builds = await this.capacityBuilds()
    return (
      nodeCapacity(
        builds,
        slug,
        this.deps.clock(),
        migrationIdentity(this.store.repositoryFacts().ticketMigrations, this.deps.tickets.name),
      ).occupied < this.deps.config.capacity
    )
  }

  private hasLiveExecutionLease(record: BuildRecord): boolean {
    return (
      record.lease !== undefined &&
      new Date(record.lease.expiresAt).getTime() > this.deps.clock().getTime()
    )
  }

  /** Complete abort cleanup as an ordered checkpointed saga. External effects
   * are idempotent; a fact after each one prevents already-settled work from
   * repeating on later ticks. `build.completed` is deliberately last. */
  private async cleanupAborted(
    record: BuildRecord,
    events: CurrentBuildFacts,
    report: TickReport,
  ): Promise<void> {
    const store = this.store
    const { tickets, forge } = this.deps
    const branch = record.branch
    if (events.state.target && branch && events.state.pr) {
      const target = await store.getBuild(events.state.target.build)
      if (target?.branch) {
        const active = (await store.buildFacts(target.slug)).state.nodeRestack?.active
        if (active?.operation === 'landing' && active.source === record.slug) {
          await this.withKernelRepository((workspacePath) =>
            landIntoNode({
              store,
              forge: this.kernelForge(),
              exec: forge.kernelExec ?? this.deps.exec,
              workspacePath,
              slug: record.slug,
              node: target.slug,
              branch,
              destination: target.branch!,
              pr: events.state.pr!.number,
              holder: this.deps.ids('node-writer'),
              id: active.id,
              eligible: async () => false,
            }),
          )
          if (
            (await store.buildFacts(target.slug)).state.nodeRestack?.active?.source === record.slug
          )
            return
          Object.assign(events, (await readBuildFacts(store, record.slug)).value)
        }
      }
    }
    if (
      events.state.kind === 'node' &&
      branch &&
      !(await this.withKernelRepository((workspacePath) =>
        settleClosedNode({
          store,
          forge: this.kernelForge(),
          exec: forge.kernelExec ?? this.deps.exec,
          workspacePath,
          slug: record.slug,
          branch,
          holder: this.deps.ids('node-writer'),
        }),
      ))
    )
      return
    // Whether this build ever owned a local checkout workspace, judged on the
    // provisioned facts (not the open one, which is null when the build never
    // provisioned or already released — only the former must skip the
    // local-branch git step; a released local workspace may still have left a
    // branch in the checkout). Remote workspaces never create a local branch
    // in the main checkout, and origin mode has no checkout at all: the
    // local-branch git step is skipped, and the saga's later steps tolerate
    // its absence.
    const hadLocalWorkspace = events.localWorkspace
    const has = (type: AbEvent['type']): boolean => events.seenTypes.includes(type)
    const append = async <T extends EventWrite['type']>(write: EventWrite<T>): Promise<void> => {
      const _event = await store.append(record.slug, write)
      Object.assign(events, (await readBuildFacts(store, record.slug)).value)
    }
    const fail = (operation: string, identity: string, error: unknown): never => {
      if (error instanceof ForgeCooldown || isForgeFailure(error)) throw error
      const detail = error instanceof Error || isForgeFailure(error) ? error.message : String(error)
      throw new Error(
        `abort cleanup ${operation} failed for ${identity}; remaining cleanup will retry on next dispatcher tick — ${detail}`,
      )
    }

    if (record.lease !== undefined) {
      try {
        await store.releaseLease(record.slug, record.lease.holder)
      } catch (error) {
        fail('lease release', `build ${record.slug}`, error)
      }
    }

    const reduced = events.state
    if (reduced.pr !== undefined && !has('pr.closed') && !has('pr.merged')) {
      const closePr = forge.closePr
      if (closePr === undefined) {
        fail(
          'PR close',
          `${forge.name} PR #${reduced.pr.number}`,
          new Error(
            `selected forge "${forge.name}" does not implement closePr; upgrade its plugin`,
          ),
        )
      }
      try {
        const result = await closePr!.call(
          forge,
          this.forgeWorkspacePath(events),
          reduced.pr.number,
        )
        await append(
          result.state === 'merged'
            ? {
                actor: DISPATCHER,
                type: 'pr.merged',
                payload: await this.mergeEvidence(
                  record,
                  this.forgeWorkspacePath(events),
                  result.sha,
                  reduced.kind,
                ),
              }
            : { actor: DISPATCHER, type: 'pr.closed', payload: {} },
        )
      } catch (error) {
        fail('PR close', `${forge.name} PR #${reduced.pr.number}`, error)
      }
    }

    try {
      const released = await this.releaseWorkspace(record.slug, events, 'abort')
      if (released !== undefined)
        Object.assign(events, (await readBuildFacts(store, record.slug)).value)
    } catch (error) {
      fail('workspace release', `build ${record.slug}`, error)
    }

    // A provider push happens before its completion fact is appended. Always
    // attempt the exact idempotent delete so an abort in that crash window
    // cannot strand an otherwise unobservable remote branch.
    if (branch !== undefined && !has('abort.remote-branch-deleted')) {
      const deleteBranch = forge.deleteBranch
      if (deleteBranch === undefined) {
        fail(
          'remote branch deletion',
          `${forge.name} branch ${branch}`,
          new Error(
            `selected forge "${forge.name}" does not implement deleteBranch; upgrade its plugin`,
          ),
        )
      }
      try {
        // Local forges treat workspacePath as a git cwd: pass the physical
        // checkout, not the store identity (an origin URL in checkout mode).
        // API forges ignore the argument.
        await deleteBranch!.call(forge, this.deps.checkout ?? this.deps.repo, branch)
        await append({
          actor: DISPATCHER,
          type: 'abort.remote-branch-deleted',
          payload: { branch },
        })
      } catch (error) {
        fail('remote branch deletion', `${forge.name} branch ${branch}`, error)
      }
    }

    if (branch !== undefined && !has('abort.local-branch-deleted') && hadLocalWorkspace) {
      const ref = `refs/heads/${branch}`
      try {
        // Local-branch cleanup runs in the physical checkout — the store
        // identity is an origin URL (or a path only for origin-less fixtures),
        // and git with cwd = a URL fails the whole saga.
        const cwd = this.deps.checkout ?? this.deps.repo
        const valid = await this.deps.exec(['git', 'check-ref-format', ref], {
          cwd,
        })
        if (valid.exitCode !== 0) throw new Error(`invalid exact build ref ${ref}`)
        const deleted = await this.deps.exec(['git', 'update-ref', '-d', ref], {
          cwd,
        })
        if (deleted.exitCode !== 0) {
          throw new Error(
            deleted.stderr.trim() || deleted.stdout.trim() || `git exited ${deleted.exitCode}`,
          )
        }
        await append({
          actor: DISPATCHER,
          type: 'abort.local-branch-deleted',
          payload: { branch },
        })
      } catch (error) {
        fail('local branch deletion', ref, error)
      }
    }

    if (record.ticket !== undefined && !has('abort.ticket-returned')) {
      const label = 'autobuild:aborted'
      try {
        const current = await tickets.get(await this.currentTicketId(record))
        if (current === null) throw new Error(`ticket no longer exists in ${tickets.name}`)
        if (!current.labels.includes(label)) {
          await tickets.update(await this.currentTicketId(record), {
            labels: [...current.labels, label],
          })
        }
        const triageState = this.triageState()
        await tickets.transition(await this.currentTicketId(record), triageState)
        await tickets.comment(
          await this.currentTicketId(record),
          `build ${record.slug} aborted — returned to ${triageState}`,
        )
        await append({
          actor: DISPATCHER,
          type: 'abort.ticket-returned',
          payload: { ticket: record.ticket, state: triageState, label },
        })
      } catch (error) {
        fail('ticket handback', `${tickets.name} ticket ${record.ticket.id}`, error)
        return
      }
    }

    await append({
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'abandoned' },
    })
    await this.reclaimPrAttachments(record.slug, events)
    report.abandoned += 1
  }

  /** A discard is recovery from dispatcher plumbing, not judgment about the
   * ticket. Return it to the configured Ready state and terminalize last so
   * every partial cleanup is retried after a crash. */
  private async cleanupDiscarded(
    record: BuildRecord,
    events: CurrentBuildFacts,
    report: TickReport,
  ): Promise<void> {
    const store = this.store
    const { tickets } = this.deps
    await this.releaseWorkspace(record.slug, events, 'discard')
    if (record.lease !== undefined) {
      await store.releaseLease(record.slug, record.lease.holder)
    }
    if (record.ticket !== undefined) {
      await tickets.transition(
        await this.currentTicketId(record),
        this.deps.config.tickets.readyState,
      )
      await tickets.comment(
        await this.currentTicketId(record),
        `build ${record.slug} was discarded during dispatch — returned to ${this.deps.config.tickets.readyState}`,
      )
    }
    await store.append(record.slug, {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'discarded' },
    } satisfies EventWrite<'build.completed'>)
    report.discarded += 1
  }

  /** Inspection is evidence, never a prerequisite for observing a merge. */
  private async mergeEvidence(
    record: BuildRecord,
    workspacePath: string,
    sha: string,
    kind?: 'work' | 'node',
  ): Promise<{ sha: string; buildTrailerPresent?: boolean }> {
    if (kind === 'node')
      await this.recoverNodeContributions(await this.repoBuildDigests(), { slug: record.slug, sha })
    const read = this.deps.forge.readCommitMessage
    if (read === undefined) return { sha }
    try {
      const message = await read.call(this.deps.forge, workspacePath, sha)
      return { sha, buildTrailerPresent: hasBuildTrailer(message, record.slug) }
    } catch (error) {
      await this.store.append(record.slug, {
        actor: KERNEL,
        type: 'observation.recorded',
        payload: {
          id: this.deps.ids('obs'),
          kind: 'followup',
          summary: `Merged commit ${sha} identity inspection failed; inspect its Autobuild-Build trailer manually: ${error instanceof Error || isForgeFailure(error) ? error.message : String(error)}`,
          refs: [sha],
        },
      })
      return { sha }
    }
  }

  /** Post-PR epilogue (§15.7): poll the forge, emit `pr.*` facts (deduped
   * against the reduced `prState`), release/complete, project to the ticket. */
  private async checkPr(
    record: BuildRecord,
    // `workspace` is the open workspace fact; `history` loads the raw log, which
    // only the branches that act on a PR transition need.
    source: {
      history: () => Promise<CurrentBuildFacts>
      workspace: OpenBuildWorkspace | null
      observed?: (pr: Awaited<ReturnType<Forge['getPrState']>>) => void
    },
    state: BuildState,
    report: TickReport,
    launched: Set<string>,
    executionLeaseLive: boolean,
    observedPr?: Awaited<ReturnType<Forge['getPrState']>>,
  ): Promise<void> {
    const store = this.store
    const { tickets, forge } = this.deps
    if (await deferMixedVersion(store, record.slug)) return
    const pr = state.pr
    if (!pr) return
    // Forge calls run from the workspace when it still exists (it does until
    // the build completes); fall back to the repo itself for odd logs.
    const workspacePath = this.forgeWorkspacePathOf(source.workspace)
    const integration = state.kind === 'node'
    const nodeTarget = state.target !== undefined
    const target = nodeTarget ? await store.getBuild(state.target!.build) : null
    const reservation = target
      ? (await store.buildFacts(target.slug)).state.nodeRestack?.active
      : undefined
    const recoverLanding =
      reservation?.operation === 'landing' && reservation.source === record.slug
    let prState: Awaited<ReturnType<typeof forge.getPrState>>
    try {
      prState = observedPr ?? (await forge.getPrState(workspacePath, pr.number))
    } catch (error) {
      if (!recoverLanding && state.prState !== 'merged') throw error
      prState = { state: 'open', mergeable: null }
    }
    source.observed?.(prState)
    if (state.prState === 'merged' && state.mergedSha)
      prState = { state: 'merged', sha: state.mergedSha }
    let nativeCancelled = false
    if (
      nodeTarget &&
      prState.state === 'open' &&
      !recoverLanding &&
      prState.nativeAutoMerge !== false
    ) {
      const cancelled = await forge.setAutoMerge(workspacePath, pr.number, false)
      if (cancelled.kind !== 'applied')
        throw new Error('node-target native auto-merge cancellation unconfirmed')
      nativeCancelled = true
    }
    // Converge native state on every poll, including paused and unready builds.
    // A replacement publication invalidates readiness, even if a stale enable
    // finished after the publisher confirmed cancellation.
    const ready = async (candidate: BuildState): Promise<boolean> => {
      if (
        (integration ? executionLeaseLive : candidate.sessions.open.length > 0) ||
        candidate.status === 'paused' ||
        candidate.status === 'done' ||
        candidate.status === 'aborted' ||
        candidate.openEscalations.length ||
        candidate.pendingCommands.length
      )
        return false
      if (integration) {
        const artifact = await store.getArtifact(record.slug, BUILD_EFFECTIVE_CONFIG_ARTIFACT)
        const config = artifact
          ? composeBuildConfig(parseEffectiveBuildConfig(artifact), this.deps.config)
          : this.deps.config
        return integrationVerified(
          candidate,
          await capturedBuildConfig(store, record.slug, candidate, config),
        )
      }
      const facts = await store.buildFacts(record.slug)
      const decision = await this.decideBuild(record.slug, facts.state, facts.log, report)
      return decision?.kind === 'wait' && decision.reason === 'awaiting-pr'
    }
    const candidateOf = async (current: BuildState) =>
      integration
        ? current.integration?.cycle && {
            head: current.integration.cycle.head,
            parent: current.integration.cycle.parent,
            cycle: current.integration.cycle.id,
          }
        : current.pr && {
            head: current.pr.headSha,
            parent:
              (await store.buildFacts(record.slug)).log.restack.completed?.targetBase ??
              (await store.buildFacts(record.slug)).log.restack.initialBase ??
              '',
            cycle: String(current.finalizeCompletedSeq),
          }
    let isReady = prState.state === 'open' && (await ready(state))
    if (
      prState.state === 'open' &&
      !recoverLanding &&
      (!isReady ||
        !landingAuthorized(state.landing) ||
        !sameLandingCandidate(await candidateOf(state), state.landing?.decision?.candidate))
    ) {
      const cancellation =
        nativeCancelled || prState.nativeAutoMerge === false
          ? { kind: 'applied' as const }
          : await forge.setAutoMerge(workspacePath, pr.number, false)
      if (cancellation.kind !== 'applied') throw new Error('Native merge cancellation unconfirmed')
      nativeCancelled = true
    }
    if (isReady) {
      while (true) {
        const current = (await store.buildFacts(record.slug)).state
        const candidate = await candidateOf(current)
        if (!candidate?.parent || !(await ready(current))) {
          isReady = false
          break
        }
        if (sameLandingCandidate(candidate, current.landing?.decision?.candidate)) {
          state = current
          break
        }
        if (!record.ticket) throw new Error('Merge policy requires a readable source ticket')
        const ticket = await tickets.get(await this.currentTicketId(record))
        if (!ticket)
          throw new Error(
            `Merge policy source ticket ${record.ticket.id} is unavailable; retrying on next poll`,
          )
        const input = {
          from: integration ? ('node' as const) : ('leaf' as const),
          into: current.target
            ? {
                kind: 'node' as const,
                ticket: resolveTicketRef(
                  this.store.repositoryFacts().ticketMigrations,
                  current.target.ticket,
                  this.deps.tickets.name,
                  record.slug,
                ).id,
              }
            : { kind: 'root' as const },
          labels: ticket.labels,
        }
        const decision = evaluateLandingPolicy(this.deps.config.landing, input)
        if (!(await ready(current))) {
          isReady = false
          break
        }
        if (
          await store.appendIfCurrent(record.slug, current.lastSeq, {
            actor: DISPATCHER,
            type: 'landing.decided',
            payload: { candidate, ...input, ...decision },
          })
        ) {
          state = (await store.buildFacts(record.slug)).state
          break
        }
      }
    }
    if (
      prState.state === 'open' &&
      !recoverLanding &&
      (nodeTarget || !isReady || !landingAuthorized(state.landing))
    ) {
      const result =
        nativeCancelled || prState.nativeAutoMerge === false
          ? { kind: 'applied' as const }
          : await forge.setAutoMerge(workspacePath, pr.number, false)
      if (result.kind !== 'applied')
        throw new Error('Native merge cancellation unconfirmed; retrying')
      const current = (await store.buildFacts(record.slug)).state
      if (current.landing?.native?.enabled !== false)
        await store.append(record.slug, {
          actor: DISPATCHER,
          type: 'landing.native-applied',
          payload: { enabled: false },
        })
    }
    const command = state.landing?.command
    if (
      command &&
      state.landing?.acknowledgedSeq !== command.seq &&
      (command.kind === 'land' || prState.state !== 'open' || !recoverLanding)
    )
      await store.append(record.slug, {
        actor: DISPATCHER,
        type: 'landing.command-acknowledged',
        payload: { commandSeq: command.seq },
      })

    // A positive conflict re-enters reconcile before any enable attempt. In
    // particular, an ungated fallback can never race ahead of the conflict
    // event and its full post-reconcile verification cycle.
    if (
      !integration &&
      !recoverLanding &&
      prState.state === 'open' &&
      prState.mergeable === false
    ) {
      // Dedupe: a reduced prState of 'conflicted' means reconcile is already
      // pending (a `reconcile.completed` returns it to 'open').
      if (state.prState === 'conflicted') return
      const events = await source.history()
      const baseSha = await this.baseSha(baseBranchOf(events, this.deps.config))
      const _conflicted = await store.append(record.slug, {
        actor: DISPATCHER,
        type: 'pr.conflicted',
        payload: { baseSha },
      } satisfies EventWrite<'pr.conflicted'>)
      Object.assign(events, (await readBuildFacts(this.store, record.slug)).value)
      if (openWorkspace(events) === null && this.deps.workspaces.recovery !== undefined) {
        // The reconcile workspace is provisioned by the tracked background
        // continuation, whose tail re-attaches the build-runner; this tick
        // never blocks on guest bootstrap.
        const kicked = await this.ensureProvisionContinuation(record, events, 'launch')
        if (kicked === 'kicked') report.provisioning += 1
        report.conflicted += 1
        return
      }
      // The dispatcher never runs agents (§15.7): re-attach a build-runner,
      // which executes the reconcile epilogue phase.
      await this.launch(record.slug, launched, report)
      report.conflicted += 1
      return
    }

    // Enabling and the ungated fallback begin from the same durable intent
    // predicate. Only `applied` acknowledges native state. A direct merge is
    // owned solely by this janitor and only after the engine is parked at
    // awaiting-pr (all verify/finalize work complete).
    const commandSeq = state.landing?.command?.seq ?? state.landing?.decision?.seq
    const canApply = async (): Promise<boolean> => {
      if (integration ? executionLeaseLive : state.sessions.open.length > 0) return false
      await store.refreshBuild(record.slug)
      const latest = await store.buildFacts(record.slug)
      if (integration) {
        const artifact = await store.getArtifact(record.slug, BUILD_EFFECTIVE_CONFIG_ARTIFACT)
        const config = artifact
          ? composeBuildConfig(parseEffectiveBuildConfig(artifact), this.deps.config)
          : this.deps.config
        const candidate = latest.state
        if (
          !landingAuthorized(candidate.landing) ||
          candidate.landing?.decision?.seq !== state.landing?.decision?.seq ||
          candidate.status === 'paused' ||
          candidate.status === 'done' ||
          candidate.status === 'aborted' ||
          candidate.openEscalations.length ||
          candidate.pendingCommands.length ||
          !integrationVerified(
            candidate,
            await capturedBuildConfig(store, record.slug, candidate, config),
          )
        )
          return false
        await this.observeIntegration(record.slug, true)
        if (!record.branch || !latest.state.baseBranch || !forge.compareBranches) return false
        const exact = await forge.compareBranches(latest.state.baseBranch, record.branch)
        const current = (await store.buildFacts(record.slug)).state
        const cycle = current.integration?.cycle
        return (
          landingAuthorized(current.landing) &&
          current.landing?.decision?.seq === state.landing?.decision?.seq &&
          current.status !== 'paused' &&
          current.status !== 'aborted' &&
          current.status !== 'done' &&
          !current.openEscalations.length &&
          !current.pendingCommands.length &&
          integrationVerified(current, config) &&
          cycle?.head === exact.headSha &&
          cycle.parent === exact.parentSha
        )
      }
      const decision = await this.decideBuild(record.slug, latest.state, latest.log, report)
      return (
        latest.state.pr?.number === pr.number &&
        latest.state.prState === 'open' &&
        landingAuthorized(latest.state.landing) &&
        latest.state.landing?.decision?.seq === state.landing?.decision?.seq &&
        sameLandingCandidate(await candidateOf(latest.state), state.landing?.decision?.candidate) &&
        decision?.kind === 'wait' &&
        decision.reason === 'awaiting-pr'
      )
    }
    const integrationPublicationDue =
      !integration ||
      prState.state === 'merged' ||
      this.integrationPollDue(
        this.integrationLandingPolls,
        record.slug,
        `${state.integration?.cycle?.id ?? ''}:${state.verify.results.at(-1)?.seq ?? ''}:${state.landing?.command?.seq ?? state.landing?.decision?.seq ?? ''}:${state.nodeComparison?.headSha ?? ''}:${state.nodeRestack?.observedParent?.sha ?? ''}`,
      )
    if (
      integrationPublicationDue &&
      nodeTarget &&
      (recoverLanding ||
        (prState.state === 'open' &&
          ((landingAuthorized(state.landing) && commandSeq !== undefined) ||
            (integration && state.integration?.intent !== undefined)))) &&
      !executionLeaseLive &&
      record.branch
    ) {
      if (target?.branch && target.branch === state.baseBranch) {
        if (!recoverLanding && !(await canApply())) {
          const intent = state.integration?.intent
          if (integration && intent)
            await store.append(record.slug, {
              actor: KERNEL,
              type: 'integration.abandoned',
              payload: {
                id: intent.id,
                reason: 'Nested merge eligibility changed before reservation',
              },
            })
          return
        }
        const preflight = recoverLanding
          ? undefined
          : await preflightNodeLanding(
              this.kernelForge(),
              workspacePath,
              pr.number,
              record.branch,
              target.branch,
            )
        const reason =
          preflight ??
          (await this.withKernelRepository((kernelPath) =>
            landIntoNode({
              store,
              forge: this.kernelForge(),
              exec: forge.kernelExec ?? this.deps.exec,
              workspacePath: kernelPath,
              slug: record.slug,
              node: target.slug,
              branch: record.branch!,
              destination: target.branch!,
              pr: pr.number,
              holder: this.deps.ids('node-writer'),
              id: this.deps.ids('node-landing').replaceAll('_', '-'),
              ...(integration
                ? {
                    stack: {
                      head: state.integration!.cycle!.head,
                      parent: state.integration!.cycle!.parent,
                      cycle: state.integration!.cycle!.id,
                    },
                  }
                : {}),
              eligible: canApply,
            }),
          ))
        if (reason && commandSeq !== undefined)
          await recordAutoMergeDeferralObservation(
            store,
            record.slug,
            reason,
            pr.number,
            commandSeq,
            this.deps.ids('obs'),
          )
        if ((await store.buildFacts(target.slug)).state.nodeRestack?.active?.source === record.slug)
          return
        await store.refreshBuild(record.slug)
        state = (await store.buildFacts(record.slug)).state
        if (state.prState === 'merged') {
          if (state.mergedSha) prState = { state: 'merged', sha: state.mergedSha }
        }
      } else if (commandSeq !== undefined) {
        await recordAutoMergeDeferralObservation(
          store,
          record.slug,
          {
            code: 'unproven-gate-state',
            detail:
              'Frozen destination node generation is unavailable or disagrees with its branch. Native merge is withheld; human action required.',
          },
          pr.number,
          commandSeq,
          this.deps.ids('obs'),
        )
      }
    }
    const native = state.landing?.native
    const failure = state.landing?.applicationFailure
    const failureRetry =
      failure &&
      failure.decisionSeq === state.landing?.decision?.seq &&
      failure.commandSeq === state.landing?.command?.seq &&
      sameLandingCandidate(failure.candidate, state.landing?.decision?.candidate)
        ? failure
        : undefined
    const retry =
      failureRetry ??
      (native?.retry &&
      native.decisionSeq === state.landing?.decision?.seq &&
      native.commandSeq === state.landing?.command?.seq &&
      sameLandingCandidate(native.candidate, state.landing?.decision?.candidate)
        ? native.retry
        : undefined)
    if (
      !integration &&
      !nodeTarget &&
      prState.state === 'open' &&
      landingAuthorized(state.landing) &&
      (prState.nativeAutoMerge === false ||
        !nativeLandingApplied(state.landing) ||
        !!state.landing?.nativeEnablePending) &&
      (!retry || Date.parse(retry.after) <= this.deps.clock().getTime()) &&
      commandSeq !== undefined &&
      (await canApply())
    ) {
      const decision = state.landing!.decision!
      // The provider checks eligibility immediately before mutating. Inspection
      // deferrals therefore leave no uncertainty facts on quiet polls.
      let enableSeq = state.landing?.nativeEnablePending
      const settleFailedEnable = async () => {
        if (enableSeq === undefined) return
        const cancelled = await forge.setAutoMerge(workspacePath, pr.number, false)
        if (cancelled.kind !== 'applied')
          throw new Error('Native merge cancellation unconfirmed; retrying')
        const attempt = (retry?.attempt ?? 0) + 1
        await store.append(record.slug, {
          actor: DISPATCHER,
          type: 'landing.native-applied',
          payload: {
            enabled: false,
            enableSeq,
            candidate: decision.candidate,
            decisionSeq: decision.seq,
            ...(state.landing?.command ? { commandSeq: state.landing.command.seq } : {}),
            retry: {
              attempt,
              after: new Date(
                this.deps.clock().getTime() +
                  Math.min(300_000, 30_000 * 2 ** Math.min(attempt - 1, 4)),
              ).toISOString(),
            },
          },
        })
      }
      const result =
        prState.nativeAutoMerge === true && !nativeCancelled
          ? { kind: 'applied' as const }
          : await forge
              .setAutoMerge(workspacePath, pr.number, true, {
                buildSlug: record.slug,
                baseBranch: state.baseBranch ?? this.deps.config.baseBranch,
                canApply: async () => {
                  if (!(await canApply())) return false
                  if (enableSeq === undefined)
                    enableSeq = (
                      await store.append(record.slug, {
                        actor: DISPATCHER,
                        type: 'landing.native-enable-started',
                        payload: {},
                      })
                    ).seq
                  return true
                },
              })
              .catch(async (error: unknown) => {
                if (isForgeFailure(error)) {
                  const attempt = (retry?.attempt ?? 0) + 1
                  await store.append(record.slug, {
                    actor: DISPATCHER,
                    type: 'landing.application-failed',
                    payload: {
                      candidate: decision.candidate,
                      decisionSeq: decision.seq,
                      ...(state.landing?.command ? { commandSeq: state.landing.command.seq } : {}),
                      message: error.message,
                      attempt,
                      after: new Date(
                        Math.max(
                          this.deps.clock().getTime() +
                            Math.min(300_000, 30_000 * 2 ** Math.min(attempt - 1, 4)),
                          error.details.kind === 'rate-limited'
                            ? Date.parse(error.details.resetAt)
                            : 0,
                        ),
                      ).toISOString(),
                    },
                  })
                  // An uncertain enable stays pending. Never spend another request during a limit.
                  throw error
                }
                await settleFailedEnable()
                throw error
              })
      // Only an attempt that reached the mutation guard needs cancellation.
      // Persist retry timing with its receipt so restart cannot reset backoff.
      if (result.kind !== 'applied') await settleFailedEnable()
      if (result.kind === 'applied') {
        const latest = (await store.buildFacts(record.slug)).state
        if (await canApply()) {
          if (
            latest.landing?.nativeEnablePending ||
            latest.landing?.native?.enabled !== true ||
            latest.landing.native.decisionSeq !== decision.seq ||
            latest.landing.native.commandSeq !== latest.landing.command?.seq
          )
            await store.append(record.slug, {
              actor: DISPATCHER,
              type: 'landing.native-applied',
              payload: {
                enabled: true,
                ...(enableSeq !== undefined ? { enableSeq } : {}),
                candidate: decision.candidate,
                decisionSeq: decision.seq,
                ...(latest.landing?.command ? { commandSeq: latest.landing.command.seq } : {}),
              },
            })
        } else {
          // Enable may have won after cancellation. Repair immediately, and
          // again on the next poll if this process dies at this boundary.
          const cancelled = await forge.setAutoMerge(workspacePath, pr.number, false)
          if (cancelled.kind === 'applied')
            await store.append(record.slug, {
              actor: DISPATCHER,
              type: 'landing.native-applied',
              payload: { enabled: false, ...(enableSeq !== undefined ? { enableSeq } : {}) },
            })
        }
      } else if (result.kind === 'deferred' && result.reason) {
        await recordAutoMergeDeferralObservation(
          store,
          record.slug,
          result.reason,
          pr.number,
          commandSeq,
          this.deps.ids('obs'),
        )
      } else if (result.kind === 'ungated' && prState.mergeable === true && (await canApply())) {
        await forge.squashMerge(workspacePath, pr.number, result.headSha, {
          buildSlug: record.slug,
          baseBranch: state.baseBranch ?? this.deps.config.baseBranch,
        })
      }
    }

    if (
      integration &&
      integrationPublicationDue &&
      !nodeTarget &&
      record.branch &&
      !executionLeaseLive &&
      (state.integration?.intent || (commandSeq !== undefined && (await canApply())))
    ) {
      const cycle = state.integration?.cycle
      const intent = state.integration?.intent
      if (cycle && commandSeq !== undefined)
        await this.withKernelRepository((path) =>
          landIntegrationRoot({
            store,
            forge: this.kernelForge(),
            exec: forge.kernelExec ?? this.deps.exec,
            workspacePath: path,
            slug: record.slug,
            branch: record.branch!,
            destination: state.baseBranch!,
            pr: pr.number,
            holder: this.deps.ids('node-writer'),
            id: this.deps.ids('integration-landing'),
            ...(intent?.commandSeq !== undefined ? { commandSeq: intent.commandSeq } : {}),
            decisionSeq: intent?.decisionSeq ?? state.landing?.decision?.seq,
            head: intent?.head ?? cycle.head,
            parent: intent?.parent ?? cycle.parent,
            cycle: intent?.cycle ?? cycle.id,
            eligible: canApply,
          }),
        )
      state = (await store.buildFacts(record.slug)).state
      source.observed?.(prState)
      if (state.prState === 'merged' && state.mergedSha)
        prState = { state: 'merged', sha: state.mergedSha }
    }
    if (integration && prState.state === 'merged' && !state.integration?.landing) {
      const head = prState.headSha
      await store.append(record.slug, {
        actor: DISPATCHER,
        type: 'integration.landed',
        payload: {
          head: head ?? 'unknown',
          landed: prState.sha,
          provenance: 'human',
          fenced: false,
          verified: !!head && integrationHeadVerified(state, head),
        },
      })
    }

    if (
      integration &&
      (prState.state === 'merged' || prState.state === 'closed') &&
      record.branch &&
      !executionLeaseLive
    ) {
      if (
        !(await this.withKernelRepository((kernelPath) =>
          settleClosedNode({
            store,
            forge: this.kernelForge(),
            exec: forge.kernelExec ?? this.deps.exec,
            workspacePath: kernelPath,
            slug: record.slug,
            branch: record.branch!,
            holder: this.deps.ids('node-writer'),
          }),
        ))
      )
        return
    }
    switch (prState.state) {
      case 'merged': {
        if (executionLeaseLive) return
        const events = await source.history()
        if (!landingAuthorized(state.landing) && !state.landing?.forgeMerge) {
          // Use our durable native-effect evidence, never provider origin.
          // Absence of a confirmed disabled receipt is indeterminate too.
          const classification =
            state.landing?.native?.enabled === false && !state.landing.nativeEnablePending
              ? ('human' as const)
              : ('possible-stale-enable' as const)
          const overrodeHold = state.landing?.command?.kind === 'hold'
          await store.append(record.slug, {
            actor: KERNEL,
            type: 'landing.forge-merged',
            payload: { classification, overrodeHold },
          })
          if (classification === 'possible-stale-enable')
            await store.append(record.slug, {
              actor: KERNEL,
              type: 'observation.recorded',
              payload: {
                id: this.deps.ids('obs'),
                kind: 'followup',
                summary:
                  'Merge contrary to policy: native auto-merge was armed or indeterminate when the forge merged without merge authorization. Operator attention required; the target has not been rewritten.',
                refs: ['landing-contrary-to-policy'],
              },
            })
        }
        // Emit the fact once (a crash between steps re-runs this block; the
        // reduced prState dedupes the event, the log dedupes the release).
        if (state.prState !== 'merged') {
          await store.append(record.slug, {
            actor: DISPATCHER,
            type: 'pr.merged',
            payload: await this.mergeEvidence(record, workspacePath, prState.sha, state.kind),
          } satisfies EventWrite<'pr.merged'>)
        }
        await this.releaseWorkspace(record.slug, events)
        if (record.ticket) {
          await tickets.transition(await this.currentTicketId(record), this.doneState)
          await tickets.comment(
            await this.currentTicketId(record),
            `build ${record.slug} merged: ${pr.url}`,
          )
        }
        await store.append(record.slug, {
          actor: DISPATCHER,
          type: 'build.completed',
          payload: { outcome: 'merged' },
        } satisfies EventWrite<'build.completed'>)
        await this.reclaimPrAttachments(record.slug, events)
        report.merged += 1
        return
      }
      case 'closed': {
        if (executionLeaseLive) return
        const events = await source.history()
        // Closed without merge is a human decision — back to Triage (§15.7).
        if (state.prState !== 'closed') {
          await store.append(record.slug, {
            actor: DISPATCHER,
            type: 'pr.closed',
            payload: {},
          } satisfies EventWrite<'pr.closed'>)
        }
        await this.releaseWorkspace(record.slug, events)
        if (record.ticket) {
          const triageState = this.triageState()
          await tickets.transition(await this.currentTicketId(record), triageState)
          await tickets.comment(
            await this.currentTicketId(record),
            `build ${record.slug} PR closed without merging (${pr.url}) — returned to ${triageState}`,
          )
        }
        await store.append(record.slug, {
          actor: DISPATCHER,
          type: 'build.completed',
          payload: { outcome: 'closed-unmerged' },
        } satisfies EventWrite<'build.completed'>)
        await this.reclaimPrAttachments(record.slug, events)
        report.closed += 1
        return
      }
      case 'open':
        // Unknown mergeability and transient auto-merge classifications are
        // retried on a later poll; never guess.
        return
    }
  }

  /** Reclaim review-window release copies after terminal completion. Cleanup
   * is deliberately post-terminal and best-effort: a provider, timeout, or
   * store failure cannot roll back build.completed/ticket/workspace work.
   * Pending handles remain derivable and are retried on every later tick. */
  private async reclaimPrAttachments(slug: string, events: CurrentBuildFacts): Promise<void> {
    for (const hosted of events.pendingAttachments) {
      const priorAttempts = events.reclaimCounts[String(hosted.seq)] ?? 0
      try {
        const capability = this.deps.forge.prAttachments
        if (capability === undefined) {
          throw new Error(
            `forge ${this.deps.forge.name} does not support PR attachment reclamation`,
          )
        }
        await capability.reclaim({
          // Physical checkout for cwd-style reclaimers (local git), not the
          // store identity; API-based reclaimers ignore it.
          workspacePath: this.deps.checkout ?? this.deps.repo,
          asset: hosted.payload.asset,
        })
        await this.store.append(slug, {
          actor: DISPATCHER,
          type: 'pr-attachment.reclaimed',
          payload: { hostedSeq: hosted.seq },
        })
      } catch (error) {
        if (error instanceof ForgeCooldown) throw error
        try {
          await this.store.append(slug, {
            actor: DISPATCHER,
            type: 'pr-attachment.reclaim-failed',
            payload: {
              hostedSeq: hosted.seq,
              attempt: priorAttempts + 1,
              error:
                (error instanceof Error || isForgeFailure(error)
                  ? error.message
                  : String(error)
                ).trim() || 'PR attachment reclamation failed without an error message',
            },
          })
        } catch {
          // The hosted fact remains pending; a later tick retries both the
          // idempotent delete and its durable acknowledgement.
        }
      }
    }
  }

  private async confirmedWorkspacePublication(events: CurrentBuildFacts, slug: string) {
    const sha = await readBuildSelector(this.store, slug, 'publishedBranchHead')
    return sha === undefined ? undefined : { sha, cacheHeads: events.gitTips }
  }

  private recoveryCheckpoint(events: CurrentBuildFacts): string | undefined {
    return events.recoveryCheckpoint
  }

  private async recordInfrastructureFailure(
    slug: string,
    events: CurrentBuildFacts,
    input: {
      provider: string
      workspaceRef: string
      operation: 'provision' | 'start' | 'wait' | 'stop' | 'delete' | 'reconcile'
      error: unknown
      cleanupPending: boolean
    },
  ): Promise<void> {
    if (await this.holdForMissingAccounts(input.error)) return
    const execution = events.state.executions.at(-1)
    const _appended = await appendInfrastructureFailure(
      { store: this.store, ids: this.deps.ids },
      {
        slug,
        events,
        maxAttempts: this.deps.config.policy.maxInfrastructureAttempts,
        provider: input.provider,
        workspaceRef: input.workspaceRef,
        instance: execution !== undefined ? execution.instance : 'dispatcher-recovery',
        ...(execution !== undefined && execution.environmentId !== undefined
          ? { environmentId: execution.environmentId }
          : {}),
        ...(execution !== undefined && execution.sessionId !== undefined
          ? { sessionId: execution.sessionId }
          : {}),
        operation: input.operation,
        error: input.error,
        cleanupPending: input.cleanupPending,
      },
    )
    Object.assign(events, (await readBuildFacts(this.store, slug)).value)
  }

  /** The provider that owns a recorded workspace: the one named on its
   * provisioned fact. A handle from any other provider (a build that outlived
   * a `[workspace].provider` change) is never handed to the current provider,
   * whose reap or release would misread the ref. */
  private workspaceOwner(open: { provider: string }): WorkspaceProvider | null {
    if (open.provider === this.deps.workspaces.name) return this.deps.workspaces
    return this.deps.retiredWorkspaces?.find((provider) => provider.name === open.provider) ?? null
  }

  /** Fence and remove a stale remote environment. A replacement is created
   * only after exact-name cleanup is durably acknowledged. */
  private async reapStaleWorkspace(
    slug: string,
    events: CurrentBuildFacts,
    reason: 'pause' | 'blocked' | 'replacement',
  ): Promise<boolean> {
    const open = openWorkspace(events)
    if (open === null) return false
    const recovery = this.workspaceOwner(open)?.recovery
    if (recovery === undefined) return false
    // Last-chance settlement boundary (AUT-328): record the pending
    // publication's fate BEFORE the destructive reap. The guard's append
    // failure propagates — a stale workspace with an unrecorded pending
    // request is never reaped (the next tick retries).
    try {
      events = await settlePublicationFactsBeforeRelease(
        { store: this.store, settlePublication: this.settlePublication },
        slug,
        events,
        reason,
      )
    } catch (error) {
      // Keep this generation and its pending work until forge recovery,
      // while allowing the sweep to supervise the remaining builds.
      if (error instanceof ForgeRequestDeferred) return false
      throw error
    }
    const attempt = (events.cleanupCounts[JSON.stringify(open.ref)] ?? 0) + 1
    try {
      const outcome = await recovery.reap({
        provider: open.provider,
        ref: open.ref,
        path: open.path ?? open.ref,
        ...(open.localPath !== undefined ? { localPath: open.localPath } : {}),
        branch: open.branch,
      })
      const _cleaned = await this.store.append(slug, {
        actor: DISPATCHER,
        type: 'infrastructure.cleanup-attempted',
        payload: {
          provider: open.provider,
          workspaceRef: open.ref,
          operation: 'reconcile',
          attempt,
          outcome: outcome.outcome,
          snapshots: outcome.snapshots,
        },
      })
      Object.assign(events, (await readBuildFacts(this.store, slug)).value)
      const _released = await this.store.append(slug, {
        actor: DISPATCHER,
        type: 'workspace.released',
        payload: { ref: open.ref, reason },
      })
      Object.assign(events, (await readBuildFacts(this.store, slug)).value)
      return true
    } catch (error) {
      const message =
        error instanceof Error || isForgeFailure(error) ? error.message : String(error)
      const _failed = await this.store.append(slug, {
        actor: DISPATCHER,
        type: 'infrastructure.cleanup-attempted',
        payload: {
          provider: open.provider,
          workspaceRef: open.ref,
          operation: 'reconcile',
          attempt,
          outcome: 'unknown',
          error: message || 'cleanup failed without an error message',
        },
      })
      Object.assign(events, (await readBuildFacts(this.store, slug)).value)
      await this.recordInfrastructureFailure(slug, events, {
        provider: open.provider,
        workspaceRef: open.ref,
        operation: 'reconcile',
        error,
        cleanupPending: true,
      })
      return false
    }
  }

  /** Release the build's workspace if the log shows one still provisioned;
   * append `workspace.released`. Log-deduped, so re-runs are no-ops. */
  private async releaseWorkspace(
    slug: string,
    events: CurrentBuildFacts,
    reason: 'completion' | 'abort' | 'pause' | 'blocked' | 'replacement' | 'discard' = 'completion',
  ): Promise<AbEvent | undefined> {
    const open = openWorkspace(events)
    if (!open) return undefined
    const owner = this.workspaceOwner(open)
    // No live provider can act on this ref; leave the fact open rather than
    // claim a release that never happened.
    if (owner === null) return undefined
    const handle = {
      provider: open.provider,
      ref: open.ref,
      path: open.path ?? open.ref,
      branch: open.branch,
    }
    // Last-chance settlement boundary (AUT-328): settle or durably record the
    // pending publication BEFORE any provider cleanup call, while the
    // workspace still exists. The guard's append failure propagates — the
    // release never proceeds past an unrecorded pending request.
    events = await settlePublicationFactsBeforeRelease(
      { store: this.store, settlePublication: this.settlePublication },
      slug,
      events,
      reason,
    )
    const recovery = owner.recovery
    if (recovery !== undefined) {
      const attempt = (events.cleanupCounts[JSON.stringify(open.ref)] ?? 0) + 1
      try {
        const outcome = await recovery.reap(handle)
        const _cleaned = await this.store.append(slug, {
          actor: DISPATCHER,
          type: 'infrastructure.cleanup-attempted',
          payload: {
            provider: open.provider,
            workspaceRef: open.ref,
            operation: 'delete',
            attempt,
            outcome: outcome.outcome,
            snapshots: outcome.snapshots,
          },
        })
        Object.assign(events, (await readBuildFacts(this.store, slug)).value)
      } catch (error) {
        const message =
          error instanceof Error || isForgeFailure(error) ? error.message : String(error)
        const _failed = await this.store.append(slug, {
          actor: DISPATCHER,
          type: 'infrastructure.cleanup-attempted',
          payload: {
            provider: open.provider,
            workspaceRef: open.ref,
            operation: 'delete',
            attempt,
            outcome: 'unknown',
            error: message || 'cleanup failed without an error message',
          },
        })
        Object.assign(events, (await readBuildFacts(this.store, slug)).value)
        await this.recordInfrastructureFailure(slug, events, {
          provider: open.provider,
          workspaceRef: open.ref,
          operation: 'delete',
          error,
          cleanupPending: true,
        })
        throw error
      }
    } else {
      await owner.release(handle)
    }
    return this.store.append(slug, {
      actor: DISPATCHER,
      type: 'workspace.released',
      payload: { ref: open.ref, reason },
    } satisfies EventWrite<'workspace.released'>)
  }

  /** Only the authoritative forge may resolve a destination tip. */
  private async baseSha(baseBranch: string): Promise<string> {
    const read = this.deps.forge.remoteBranchSha
    if (!read) throw new Error('forge remoteBranchSha capability unavailable')
    const sha = await read.call(this.deps.forge, baseBranch)
    assertTargetOid(sha)
    return sha
  }

  private dispatchBudget(slug: string): Promise<boolean> {
    return ensureDispatchBudget(
      this.store,
      this.deps.ids,
      slug,
      this.deps.config.policy.maxDispatchAttempts,
      this.deps.workspaces.recovery !== undefined,
    )
  }

  // ── b. Interrupted dispatch recovery ───────────────────────────────────────

  /** The claim-time `build.created` payload. Assets are omitted when the ticket
   * had none, so a no-asset build's log is exactly what it was before. */
  private buildCreatedPayload(
    ticket: TicketRef,
    repo: string,
    seed:
      | {
          autoMergeUser?: string
          autoMergeDefaultSeq?: number
          assets?: PinnedAsset[]
          kind?: 'work' | 'node'
          target?: EventPayload<'build.created'>['target']
          baseBranch?: string
        }
      | undefined,
  ): EventPayload<'build.created'> {
    const { config } = this.deps
    return {
      ticket,
      repo,
      baseBranch: seed?.baseBranch ?? config.baseBranch,
      ...(seed?.kind !== undefined ? { kind: seed.kind } : {}),
      ...(seed?.target !== undefined ? { target: seed.target } : {}),
      ...(seed?.autoMergeUser !== undefined ? { autoMergeRequestedBy: seed.autoMergeUser } : {}),
      ...(seed?.autoMergeDefaultSeq !== undefined
        ? { autoMergeDefaultSeq: seed.autoMergeDefaultSeq }
        : {}),
      ...(config.pr !== undefined ? { pr: config.pr } : {}),
      ...(seed?.assets !== undefined && seed.assets.length > 0 ? { assets: seed.assets } : {}),
    }
  }

  /** Every boundary before runner attachment is derived from durable facts.
   * Missing facts are the todo list; successful provider calls are followed
   * immediately by their facts, so an ordinary later tick can continue. */
  // ── b. Interrupted dispatch recovery ─────────────────────────────────────────

  /** Every boundary before runner attachment is derived from durable facts.
   * Missing facts are the todo list; successful provider calls are followed
   * immediately by their facts, so an ordinary later tick can continue.
   *
   * Remote (recovery-capable) providers never provision inline: the workspace
   * stage kicks a tracked background continuation and returns `deferred`, so a
   * tick never blocks on guest bootstrap. The continuation provisions, then
   * completes the remaining boundaries and the launch. Local providers keep
   * the original inline provisioning byte-for-byte. */
  private async attemptDispatchCompletion(
    record: BuildRecord,
    launched: Set<string>,
    report: TickReport,
    seed?: {
      ticket: Ticket
      body: string
      authoredSession?: string
      autoMergeUser?: string
      autoMergeDefaultSeq?: number
      assets?: PinnedAsset[]
    },
  ): Promise<DispatchOutcome> {
    if (!this.accountsAvailable()) return 'parked'
    const store = this.store
    const { config } = this.deps
    if (await deferMixedVersion(this.store, record.slug)) return 'parked'
    if (!(await this.dispatchBudget(record.slug))) return 'parked'
    let stage: EventPayload<'dispatch.failed'>['stage'] = 'create'
    try {
      let events = (await readBuildFacts(store, record.slug)).value
      if (events.created === undefined) {
        if (events.state.lastSeq !== 0 || record.ticket === undefined) {
          throw new Error(
            'build record lacks the immutable ticket facts needed to reconstruct build.created',
          )
        }
        // Legacy path: a record an older dispatcher left with an empty stream.
        // New claims write `build.created` atomically with the record, so this
        // can only sample the ticket's current assets (SPEC §6.3).
        const assets =
          seed?.assets ??
          (await preparePinnedAssets(
            this.deps.tickets,
            store,
            record.repo,
            await this.currentTicketId(record),
          ).catch((error) => {
            // Preserve legacy recovery only without native assets. Native preparation
            // must never publish an empty pin after losing the source bytes.
            if (this.deps.tickets.assets || this.deps.tickets.name === 'hosted') throw error
            return []
          }))
        await store.appendIfCurrent(record.slug, 0, {
          actor: DISPATCHER,
          type: 'build.created',
          payload: this.buildCreatedPayload(record.ticket, record.repo, { ...seed, assets }),
        })
        events = (await readBuildFacts(store, record.slug)).value
        if (events.created === undefined) {
          throw new Error('build.created reconstruction lost its conditional append race')
        }
      }

      const created = events.created
      if (created.payload.kind === 'node')
        return this.completeDispatchBoundaries(record, seed, report, launched)

      stage = 'workspace'
      if (openWorkspace(events) === null) {
        if (this.deps.workspaces.recovery !== undefined) {
          // Recovery-capable provider: durable marker + tracked background
          // continuation. The tick makes durable progress and returns; the
          // continuation provisions, then completes the remaining boundaries
          // and the launch.
          const kicked = await this.ensureProvisionContinuation(record, events, 'dispatch', seed)
          if (kicked === 'kicked') report.provisioning += 1
          launched.add(record.slug)
          return 'deferred'
        }
        const priorGenerations = events.workspaceGenerations
        const handle = await this.deps.workspaces.provision({
          // Local providers provision FROM the physical checkout; remote
          // providers ignore the value (their host seams are injected).
          repo: this.deps.checkout ?? this.deps.repo,
          baseBranch: baseBranchOf(events, config),
          branch: record.branch ?? `ab/${record.slug}`,
          ...(priorGenerations > 0
            ? {
                publication: await this.confirmedWorkspacePublication(events, record.slug),
                revision: events.state.integration?.cycle?.head ?? this.recoveryCheckpoint(events),
                generation: priorGenerations,
              }
            : {}),
        })
        await store.append(record.slug, {
          actor: DISPATCHER,
          type: 'workspace.provisioned',
          payload: {
            provider: handle.provider,
            ref: handle.ref,
            path: handle.path,
            ...(handle.localPath !== undefined ? { localPath: handle.localPath } : {}),
            remote: this.deps.workspaces.publication !== undefined,
            branch: handle.branch,
            base: handle.base,
          },
        } satisfies EventWrite<'workspace.provisioned'>)
        events = (await readBuildFacts(store, record.slug)).value
      }
    } catch (error) {
      if (await this.holdForMissingAccounts(error)) return 'parked'
      if (error instanceof MixedVersionDeferral) return 'parked'
      const events = (await readBuildFacts(store, record.slug)).value
      if (stage === 'workspace' && this.deps.workspaces.recovery !== undefined) {
        const open = openWorkspace(events)
        await this.recordInfrastructureFailure(record.slug, events, {
          provider: this.deps.workspaces.name,
          workspaceRef: open?.ref ?? record.slug,
          operation: 'provision',
          error,
          cleanupPending: true,
        })
      }
      const attempt = events.dispatchFailureCount + 1
      const message = (
        error instanceof Error || isForgeFailure(error) ? error.message : String(error)
      ).trim()
      await store.append(record.slug, {
        actor: DISPATCHER,
        type: 'dispatch.failed',
        payload: {
          stage,
          attempt,
          error: message || 'dispatch failed without an error message',
        },
      })
      report.dispatchFailed += 1
      await this.dispatchBudget(record.slug)
      return 'failed'
    }
    return this.completeDispatchBoundaries(record, seed, report, launched)
  }

  /** The post-workspace dispatch boundaries — spec, comment, launch — shared
   * by the synchronous local path and the background continuation. Stage
   * failures record their own durable `dispatch.failed` fact. */
  private async completeDispatchBoundaries(
    record: BuildRecord,
    seed?: {
      ticket: Ticket
      body: string
      authoredSession?: string
      autoMergeUser?: string
      autoMergeDefaultSeq?: number
      assets?: PinnedAsset[]
    },
    report?: TickReport,
    launched?: Set<string>,
  ): Promise<Exclude<DispatchOutcome, 'deferred'>> {
    const store = this.store

    if (await deferMixedVersion(this.store, record.slug)) return 'parked'
    if (!(await this.dispatchBudget(record.slug))) return 'parked'
    let stage: EventPayload<'dispatch.failed'>['stage'] = 'spec'
    let authored = false
    try {
      const events = (await readBuildFacts(store, record.slug)).value
      const state = events.state
      if (state.status !== 'queued' || state.discardRequest !== undefined) return 'parked'
      if (!events.specRecorded) {
        let ticket: Ticket
        if (seed?.ticket !== undefined) {
          ticket = seed.ticket
        } else {
          const ticketId = record.ticket?.id
          if (ticketId === undefined) {
            throw new Error('build record has no ticket to recover its spec from')
          }
          const recoveredTicket = await this.deps.tickets.get(ticketId)
          if (recoveredTicket === null) {
            throw new Error(`claimed ticket ${ticketId} is no longer readable`)
          }
          ticket = recoveredTicket
        }

        let body = seed?.body ?? ticket.body
        let conformance = specConformance(body)
        let authoredSession = seed?.authoredSession
        if (!conformance.conforms && this.deps.authorSpec !== undefined) {
          const candidate = await this.deps.authorSpec(ticket)
          if (candidate !== null) {
            conformance = specConformance(candidate)
            if (conformance.conforms) {
              body = candidate
              authoredSession = this.deps.ids('s')
            }
          }
        }
        if (!conformance.conforms) {
          throw new Error(
            `claimed ticket no longer conforms to the spec standard: ${conformance.missing.join('; ')}`,
          )
        }

        const spec = {
          kind: 'spec',
          content: body,
          metadata: { ticket: ticket.ref.id, source: ticket.ref.source },
        }
        if (authoredSession !== undefined) {
          const session = authoredSession
          await store.appendWithArtifacts(record.slug, [spec], (deposited) => ({
            actor: agentActor('spec', session),
            type: 'spec.authored' as const,
            payload: { artifact: artifactRefOf(deposited), session },
          }))
          authored = true
        } else {
          await store.appendWithArtifacts(record.slug, [spec], (deposited) => ({
            actor: DISPATCHER,
            type: 'spec.imported' as const,
            payload: { artifact: artifactRefOf(deposited), ticket: ticket!.ref },
          }))
        }
      }

      stage = 'comment'
      if (record.ticket !== undefined && !events.commentPosted) {
        await this.deps.tickets.comment(
          await this.currentTicketId(record),
          `build ${record.slug} dispatched`,
        )
        await store.append(record.slug, {
          actor: DISPATCHER,
          type: 'dispatch.comment-posted',
          payload: {},
        })
      }

      if (state.kind === 'node') {
        stage = 'branch'
        await store.refreshBuild(record.slug)
        const current = (await store.buildFacts(record.slug)).state
        if (current.status !== 'queued' || current.pendingCommands.length > 0) return 'parked'
        await this.openNode(record, current)
        return 'completed'
      }

      stage = 'launch'
      // Discard validation and recovery selection happened before several
      // provider awaits. Re-read immediately before launch so a request made
      // during those boundaries parks cleanly for the next janitor pass.
      await store.refreshBuild(record.slug)
      const launchState = (await readBuildFacts(store, record.slug)).value.state
      if (launchState.status !== 'queued' || launchState.discardRequest !== undefined) {
        return 'parked'
      }
      if (!this.accountsAvailable()) return 'parked'
      if (launched === undefined) await this.deps.launchRunner(record.slug)
      else await this.launch(record.slug, launched, report)
      if (authored && report !== undefined) report.authored += 1
      return 'completed'
    } catch (error) {
      if (await this.holdForMissingAccounts(error)) return 'parked'
      const events = (await readBuildFacts(store, record.slug)).value
      const attempt = events.dispatchFailureCount + 1
      const message = (
        error instanceof Error || isForgeFailure(error) ? error.message : String(error)
      ).trim()
      await store.append(record.slug, {
        actor: DISPATCHER,
        type: 'dispatch.failed',
        payload: {
          stage,
          attempt,
          error: message || 'dispatch failed without an error message',
        },
      })
      if (report !== undefined) report.dispatchFailed += 1
      await this.dispatchBudget(record.slug)
      return 'failed'
    }
  }

  private async recoverDispatches(
    report: TickReport,
    launched: Set<string>,
    paused: boolean,
    opts: TickOpts = {},
  ): Promise<void> {
    for (const record of await this.nonterminalBuilds()) {
      if (
        record.ticket === undefined ||
        launched.has(record.slug) ||
        this.continuations.has(record.slug)
      ) {
        continue
      }
      // Budget gate: recovery issues store transport calls per build.
      if (this.outOfBudget(opts)) break
      const { state } = await this.store.buildFacts(record.slug)
      if (
        state.status !== 'queued' ||
        state.discardRequest !== undefined ||
        heldByRepositoryPause(state, paused)
      ) {
        continue
      }
      // Queued itself means runner attachment is still missing. Always enter
      // the fact-driven helper: it skips every completed boundary and retries
      // only the final launch when setup is already durable.
      const outcome = await this.attemptDispatchCompletion(record, launched, report)
      if (outcome === 'completed') report.recovered += 1
      // A failed boundary owns this tick's attempt; startup and lease recovery
      // must not bypass the unfinished dispatch boundary later in the tick.
      if (outcome === 'failed') launched.add(record.slug)
    }
  }

  // ── c. Dispatch-command startup resume (SPEC §2.2, §15.6-C) ────────────────

  /**
   * A fresh `ab dispatch` invocation attempts every current build for this
   * repo, even when its old lease has not expired yet. Lease claiming remains
   * the exclusivity gate: a genuinely live runner wins and the attempted
   * replacement harmlessly skips.
   *
   * `decideNext` keeps every human judgment gate intact while still selecting
   * pending operator-command acknowledgements before it returns a blocked
   * wait. Open escalations are reported for plain-mode observability but never
   * answered by process startup.
   */
  private async resumeCurrent(
    report: TickReport,
    launched: Set<string>,
    paused: boolean,
    opts: TickOpts = {},
  ): Promise<void> {
    const store = this.store
    for (const record of await this.nonterminalBuilds()) {
      if (launched.has(record.slug)) continue
      // Budget gate: resume launches runners (transport-backed work).
      if (this.outOfBudget(opts)) break

      const facts = await store.buildFacts(record.slug)
      const state = facts.state
      if (
        state.status === 'done' ||
        state.status === 'aborted' ||
        (state.status === 'queued' && state.discardRequest !== undefined) ||
        heldByRepositoryPause(state, paused)
      ) {
        continue
      }

      if (
        state.status === 'queued' &&
        !state.pendingCommands.some((command) => command.command === 'abort') &&
        !(await this.dispatchBudget(record.slug))
      )
        continue
      const decision = await this.decideBuild(record.slug, state, facts.log, report)
      if (decision === undefined) continue
      if (decision.kind === 'wait') {
        if (decision.reason === 'blocked' && state.openEscalations.length > 0) {
          report.blockedDiagnostics.push(
            `build ${record.slug} skipped: open escalations ${state.openEscalations
              .map((escalation) => escalation.id)
              .join(', ')}`,
          )
        }
        continue
      }
      // Disposable remote environments must pass through the stale-lease
      // fencing sweep below; startup must never attach directly to an old VM.
      if (this.deps.workspaces.recovery !== undefined) continue
      const result = await this.launch(record.slug, launched, report)
      if (result === 'scheduled') report.resumed += 1
    }
  }

  // ── d. Lease sweep (SPEC §15.6-C) ──────────────────────────────────────────

  /**
   * Predicate: lease expired or absent + the engine has runner work →
   * re-attach a runner. Actionability is `decideNext`'s, not a status
   * heuristic — the two must agree or work the engine would decide is never
   * executed (a runner is the only pendingCommands/decision consumer). Every
   * non-`wait` decision re-attaches; that covers phase work, but also:
   *
   * - pending operator commands on paused/blocked builds (D2, §15.2.7: "a
   *   runner that is dead still receives its commands on resume" — the
   *   request does not change status, only the kernel's acknowledgement
   *   does, so a status gate would strand resume/abort forever);
   * - post-PR phase work while prState is 'open' (§15.7: the verify re-run
   *   after `reconcile.completed`; §5: finalize post-steps still due after
   *   `finalize.completed`) and the reconcile run while 'conflicted';
   * - engine-side escalation raises (stall/policy) a dead runner never
   *   appended.
   *
   * Every `wait` reason is correctly parked: blocked/paused (human), awaiting
   * spec (human lands rev N+1; the next tick sees run-phase plan), awaiting
   * PR (janitor duty), done/aborted (janitor duty). The supervising launcher
   * reserves the execution lease and the child renews it; the reduced log tells it where to resume
   * (started-without-terminal work re-runs from the phase start).
   */
  private async leaseSweep(
    report: TickReport,
    launched: Set<string>,
    paused: boolean,
    opts: TickOpts = {},
  ): Promise<void> {
    const now = this.deps.clock().getTime()
    // Terminal builds are filtered on the digest before the lease and TTL
    // checks, so a zero TTL cannot fall through to a log read.
    for (const record of await this.nonterminalBuilds()) {
      if (launched.has(record.slug)) continue
      // Budget gate: the sweep re-attaches runners per expired build.
      if (this.outOfBudget(opts)) break
      if (record.lease) {
        if (new Date(record.lease.expiresAt).getTime() > now) continue // healthy
      }
      const facts = await this.store.buildFacts(record.slug)
      const state = facts.state
      if (mixedVersionDeferred(state)) {
        await deferMixedVersion(this.store, record.slug)
        continue
      }
      if (
        (state.status === 'queued' && state.discardRequest !== undefined) ||
        heldByRepositoryPause(state, paused)
      ) {
        continue
      }
      if (
        state.status === 'queued' &&
        !state.pendingCommands.some((command) => command.command === 'abort') &&
        !(await this.dispatchBudget(record.slug))
      )
        continue
      const pendingRewrite = facts.publication.latestUncompletedRequest()?.payload
      const retryIntent =
        pendingRewrite?.operation === 'reconcile' && pendingRewrite.rewrite
          ? { operation: 'reconcile' as const, id: pendingRewrite.rewrite.id }
          : facts.log.restack.intent
            ? { operation: 'restack' as const, id: facts.log.restack.intent.id }
            : undefined
      // Publication waits must not prevent a replacement runner from
      // acknowledging controls, including abort on an exhausted episode.
      if (retryIntent && state.pendingCommands.length === 0) {
        try {
          await publicationRetryGate(
            { store: this.store, slug: record.slug, clock: this.deps.clock, actor: DISPATCHER },
            retryIntent.operation,
            retryIntent.id,
          )
        } catch (error) {
          if (error instanceof ForgeRequestDeferred) continue
          throw error
        }
      }
      const decision = await this.decideBuild(record.slug, state, facts.log, report, true)
      if (decision === undefined) continue
      if (state.status === 'done' || state.status === 'aborted') continue
      const orphanEligible = (state: BuildState) =>
        !paused &&
        state.status === 'running' &&
        (state.kind !== 'node' || integrationCurrent(state)) &&
        state.sessions.open.some((session) => session.suspensionCause === undefined)
      const provedEnded =
        facts.open === null &&
        (facts.lastExecution === 'completed' || facts.lastExecution === 'relaunch')
      const cleanup = state.verifyStage.cleanupExecutionSeq
      if (
        !record.lease &&
        now - new Date(record.updatedAt).getTime() < this.leaseTtlMs &&
        facts.lastExecution !== 'relaunch' &&
        !(cleanup !== undefined && state.verifyStage.executionSeq <= cleanup) &&
        !(provedEnded && (decision.kind !== 'wait' || orphanEligible(state)))
      )
        continue // preserve first-claim grace, but never postpone proved-ended work

      if (
        state.kind === 'node' &&
        (!integrationCurrent(state) || facts.workspace === null) &&
        decision.kind !== 'wait'
      )
        continue // cascade owns node runner admission
      // Raw history, read at most once and only by a branch that acts on it.
      let loaded: CurrentBuildFacts | undefined
      const history = async (): Promise<CurrentBuildFacts> => {
        loaded ??= (await readBuildFacts(this.store, record.slug)).value
        return loaded
      }
      // Liveness gate (durable supervision): a recorded execution the provider
      // observes as RUNNING is left completely alone — no settle, no reap, no
      // replacement, no re-attach. This is the change that stops a supervisor
      // restart from replacing a healthy environment generation. A provider-
      // proved end settles first (completion facts, lease release, publication)
      // and then falls through to the normal decision; a provider-proved loss
      // falls through to the existing stale path below.
      let orphanRecoveryDue = orphanEligible(state) && facts.open === null
      const foreignExecution = facts.open
      // A provider- or log-proved end in the same generation re-attaches in
      // place: the guest finished its work, the workspace is still the
      // build's, and replacing the environment would discard a healthy
      // generation. Only an unproven stale lease or a proved loss reaps.
      // A start that later found the open workspace missing is a proved loss
      // too: the recorded end no longer vouches for an environment that is
      // gone, and re-attaching would fail against the same ref forever.
      const failure = state.infrastructureFailure
      const workspaceMissing =
        failure?.cause === 'missing' &&
        failure.operation === 'start' &&
        failure.workspaceRef === facts.workspace?.ref
      let endedInPlace =
        (facts.lastExecution === 'completed' || facts.lastExecution === 'relaunch') &&
        !workspaceMissing
      if (
        foreignExecution !== null &&
        foreignExecution.commandId !== undefined &&
        !launched.has(record.slug)
      ) {
        const owner = this.executionOwner(foreignExecution.provider)
        const execution = owner?.buildExecution
        if (execution?.observe !== undefined) {
          const settlement = await settleOpenExecution(
            {
              store: this.store,
              execution,
              ...(this.settlePublication !== undefined
                ? { settlePublication: this.settlePublication }
                : {}),
            },
            record.slug,
            foreignExecution,
          )
          if (settlement === 'running') continue
          // Unknown liveness is never proof that an open execution is dead.
          // Settlement may itself raise provider attention. Revalidate cleanup
          // eligibility from the advanced canonical state before admission.
          orphanRecoveryDue = orphanEligible((await this.store.buildFacts(record.slug)).state)
          if (settlement === 'settled') {
            report.settled += 1
            endedInPlace = true
          }
        }
      }
      const publicationRecoveryDue =
        state.status !== 'paused' &&
        state.status !== 'blocked' &&
        (facts.publication.pending() || facts.publication.abandonedPending())
      const open = facts.workspace
      // A provider- or log-proved END in the same generation re-attaches in
      // place: the guest finished its work, the workspace is still the
      // build's, and replacing the environment would discard a healthy
      // generation. Only an unproven stale lease or a proved loss reaps.
      if (open !== null && this.workspaceOwner(open)?.recovery !== undefined && !endedInPlace) {
        const parked = decision.kind === 'wait' && !publicationRecoveryDue && !orphanRecoveryDue
        const reason =
          state.status === 'paused'
            ? ('pause' as const)
            : state.status === 'blocked'
              ? ('blocked' as const)
              : ('replacement' as const)
        const reaped = await this.reapStaleWorkspace(record.slug, await history(), reason)
        if (!reaped) continue
        if (!parked) {
          // Recovery-capable provider: reap inline (bounded), then kick the
          // same background continuation — it provisions and launches without
          // blocking this tick. Local providers never enter this branch.
          const kicked = await this.ensureProvisionContinuation(record, await history(), 'launch')
          if (kicked === 'kicked') {
            report.provisioning += 1
            report.swept += 1
          }
          continue
        }
      }
      // Reachable via the reap block above: when the wait decision is parked
      // (no publication recovery due) the `if (!parked)` arm continues, but the
      // parked arm falls through here after a successful reap. Without this
      // guard the tick would reach the unconditional `launch` below and start a
      // fresh runner for a paused or blocked build whose workspace was just
      // reaped. Every other path that reaches this line with a wait decision
      // already continued earlier.
      if (decision.kind === 'wait' && !publicationRecoveryDue && !orphanRecoveryDue) continue
      if (
        facts.workspace === null &&
        this.deps.workspaces.recovery !== undefined &&
        (await history()).workspaceGenerations > 0
      ) {
        const kicked = await this.ensureProvisionContinuation(record, await history(), 'launch')
        if (kicked === 'kicked') {
          report.provisioning += 1
          report.swept += 1
          continue
        }
        // In-flight or foreign-live: whoever owns the marker completes the
        // boundaries and the launch; this tick performs neither.
        continue
      }
      try {
        const result = await this.launch(record.slug, launched, report)
        if (result === 'scheduled') report.swept += 1
      } catch (error) {
        // Launchers normally record provider failures themselves. Preserve
        // durable attention if orphan cleanup fails before that boundary,
        // without counting an already-recorded failure twice.
        if (orphanRecoveryDue && open !== null) {
          const current = (await readBuildFacts(this.store, record.slug)).value
          if (current.infrastructureCount === facts.infrastructureCount)
            await this.recordInfrastructureFailure(record.slug, current, {
              provider: open.provider,
              workspaceRef: open.ref,
              operation: 'start',
              error,
              cleanupPending: false,
            })
        }
        throw error
      }
    }
  }

  /** Retry a fixed batch under the same repository ownership as intake.
   * No provider calls for parked deadlines; no history or orphan scans. */
  private async recoverTicketPreparations(report: TickReport, opts: TickOpts): Promise<void> {
    const pending = Object.values(this.store.repositoryFacts().preparation)
      .filter(
        (attempt) => !attempt.retryAt || Date.parse(attempt.retryAt) <= this.deps.clock().getTime(),
      )
      .sort(
        (a, b) =>
          Date.parse(a.retryAt ?? '1970-01-01T00:00:00.000Z') -
            Date.parse(b.retryAt ?? '1970-01-01T00:00:00.000Z') ||
          a.attempt.localeCompare(b.attempt),
      )
      .slice(0, 8)
    const failures: unknown[] = []
    for (const attempt of pending) {
      if (this.outOfBudget(opts)) break
      try {
        await this.recoverTicketPreparation(attempt)
      } catch (error) {
        failures.push(error)
      }
    }
    for (const error of failures) {
      report.janitorFailed += 1
      report.janitorDiagnostics.push(String(error))
    }
  }

  private async preparationResolved(
    attempt: TicketPreparation,
    outcome: 'lost-claim' | 'handed-back' | 'bounced' | 'owned' | 'abandoned',
    reason?: string,
  ): Promise<void> {
    await this.store.appendRepo(this.deps.repo, {
      actor: DISPATCHER,
      type: 'ticket-preparation.resolved',
      payload: {
        attempt: attempt.attempt,
        ticket: attempt.ticket,
        outcome,
        ...(reason ? { reason: reason.slice(0, 4000) } : {}),
      },
    })
  }

  private async recoverTicketPreparation(attempt: TicketPreparation): Promise<void> {
    try {
      // A rejected create can have committed. Unavailable or conflicting readback
      // is never absence and must not authorize a ticket transition.
      if (attempt.slug) {
        const record = await this.store.getBuild(attempt.slug)
        if (record) {
          const created = (await this.store.buildFacts(attempt.slug)).created
          if (
            record.repo !== this.deps.repo ||
            record.ticket?.source !== attempt.ticket.source ||
            record.ticket?.id !== attempt.ticket.id ||
            created?.payload.repo !== this.deps.repo ||
            created.payload.ticket?.source !== attempt.ticket.source ||
            created.payload.ticket?.id !== attempt.ticket.id
          )
            return await this.preparationResolved(
              attempt,
              'abandoned',
              `Conflicting build ownership at ${attempt.slug}; ticket unchanged. Inspect ownership before manually retrying. Original failure: ${attempt.error ?? 'unknown'}`,
            )
          await this.preparationResolved(attempt, 'owned')
          return
        }
      }
      const ref = resolveTicketRef(
        this.store.repositoryFacts().ticketMigrations,
        attempt.ticket,
        this.deps.tickets.name,
        attempt.slug ?? attempt.attempt,
      )
      const ticket = await this.deps.tickets.get(ref.id)
      if (!ticket)
        return await this.preparationResolved(
          attempt,
          'abandoned',
          'Ticket no longer exists; ticket unchanged.',
        )
      if (ticket.state === undefined)
        return await this.preparationResolved(
          attempt,
          'abandoned',
          'Ticket state is unavailable; ticket unchanged. Inspect the provider record before manually retrying.',
        )
      const state = (value: string) => value.toLowerCase()
      const handback = attempt.handback ?? attempt.readyState
      if (state(ticket.state) === state(handback)) {
        await this.preparationResolved(
          attempt,
          handback === attempt.readyState ? 'handed-back' : 'bounced',
        )
        return
      }
      if (!attempt.claimed || state(ticket.state) !== state(attempt.claimedState))
        return await this.preparationResolved(
          attempt,
          'abandoned',
          `Uncertain claim or externally changed ticket state ${ticket.state}; ticket unchanged. Inspect ownership before manually retrying. Original failure: ${attempt.error ?? 'unknown'}`,
        )
      await this.deps.tickets.transition(ref.id, handback)
      await this.preparationResolved(
        attempt,
        handback === attempt.readyState ? 'handed-back' : 'bounced',
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        await this.store.appendRepo(this.deps.repo, {
          actor: DISPATCHER,
          type: 'ticket-preparation.recovery-failed',
          payload: {
            attempt: attempt.attempt,
            ticket: attempt.ticket,
            claimed: attempt.claimed,
            handback: attempt.handback ?? attempt.readyState,
            ...(attempt.error ? { preparationError: attempt.error } : {}),
            error: message.slice(0, 4000) || 'unknown recovery failure',
            retryAt: new Date(this.deps.clock().getTime() + 30_000).toISOString(),
          },
        })
      } catch (diagnosticError) {
        throw new AggregateError(
          [error, diagnosticError],
          `ticket preparation recovery failed: ${message}; diagnostic append failed: ${String(diagnosticError)}`,
        )
      }
      throw new Error(
        `ticket preparation recovery failed: ${message}; original preparation failure: ${attempt.error ?? 'unfinished durable preparation'}`,
        { cause: error },
      )
    }
  }

  // ── e. Dispatch (SPEC §12, §6.3) ───────────────────────────────────────────

  private async dispatch(
    report: TickReport,
    launched: Set<string>,
    autoMergeUser: string | undefined,
    paused: boolean,
    opts: TickOpts = {},
    autoMergeSeedFact: AutoMergeDefaultFact | undefined = undefined,
  ): Promise<void> {
    if (!this.accountsAvailable()) return
    const health = this.store.repositoryFacts().forgeHealth
    if (health && Date.parse(health.resetAt) > this.deps.clock().getTime()) return
    const store = this.store
    const { tickets, config } = this.deps
    const checkpoint = await this.scanCheckpoint('admission')
    if (!checkpoint.due) return
    // Clear only standing measurement fields; action counters belong to this tick.
    report.queued = report.invalidTickets = report.dependencyBlocked = report.creationWithheld = 0
    report.ticketDiagnostics = []
    report.dependencyDiagnostics = []
    report.creationDiagnostics = []
    // Blocked and paused builds still occupy a slot: their workspaces and
    // pending work are live, only waiting on a human. Capacity is per repo
    // (§16.1) — another repo's builds never consume this repo's slots.
    const capacityBuilds = await this.capacityBuilds()
    const active = dispatchCapacity(capacityBuilds, config.capacity, this.deps.clock()).occupied
    const activeRefs: TicketRef[] = capacityBuilds
      .filter(({ state }) => state.status !== 'done' && state.status !== 'aborted')
      .flatMap(({ record }) => (record.ticket ? [record.ticket] : []))
    let capacity = config.capacity - active

    // The ready scan runs even at full capacity: `queued` is the operator's
    // standing queue-depth report and must stay honest exactly when the
    // dispatcher is saturated. Sources that keep a claimed ticket in the
    // ready state are deduped against the active builds embodying them.
    const journalBeforeReady = this.store.repositoryFacts().harvest
    const listing = await this.listReady()
    const activeTicketIds = await this.activeTicketIdentities(activeRefs, listing.tickets)
    // A provider listing can race reservation and blocker filing. Preserve
    // the before/after union, refreshing once only when admission is possible.
    if (listing.tickets.length > 0) await this.store.refreshJournal()
    const journalAfterReady = this.store.repositoryFacts()
    if (journalAfterReady.health?.cause === 'ready-scan-failed') {
      await this.sourceCondition(undefined, 'ready-scan')
    }
    const creationHolds = new Map(
      harvestCreationsFromStates(journalBeforeReady, journalAfterReady.harvest).map((creation) => [
        creation.creationKey.toLowerCase(),
        creation,
      ]),
    )
    const ready = listing.tickets.filter(
      (ticket) =>
        !activeTicketIds.has(`${ticket.ref.source}:${ticket.ref.id}`) &&
        !Object.values(this.store.repositoryFacts().preparation).some((attempt) => {
          const ref = resolveTicketRef(
            this.store.repositoryFacts().ticketMigrations,
            attempt.ticket,
            this.deps.tickets.name,
            attempt.slug ?? attempt.attempt,
          )
          return ref.source === ticket.ref.source && ref.id === ticket.ref.id
        }),
    )
    report.invalidTickets += listing.diagnostics.length
    report.ticketDiagnostics.push(...listing.diagnostics)
    report.queued = ready.length
    const withheld = new Set<string>()
    for (const ticket of ready) {
      if (ticket.creationKey === undefined) continue
      const creation = creationHolds.get(ticket.creationKey.toLowerCase())
      if (creation === undefined) continue
      withheld.add(ticket.ref.id)
      report.creationWithheld += 1
      report.creationDiagnostics.push(
        `ticket ${ticket.ref.id}: creation withheld — Harvest run ${creation.run}, ` +
          `proposal ${creation.proposalKey}, reservation repo seq ${creation.reservationSeq} ` +
          'has not reached a safe post-create listing boundary',
      )
    }
    // This stage creates a build and launches it in one step, so it is also a
    // way to attach a runner to a queued build. A pause-all turns intake off,
    // so in practice this stage does not run while paused; it becomes reachable
    // only if an operator toggles intake back on without resuming, or if the
    // intake write failed after the pause write landed. The ready scan above
    // still runs either way, so the standing queue-depth report stays honest —
    // this only declines to claim a ticket into a build that would immediately
    // sit held.
    if (
      paused ||
      (capacity <= 0 &&
        !ready.some(
          (ticket) =>
            ticket.kind === 'node' ||
            (ticket.target !== undefined && (ticket.blockedBy?.length ?? 0) > 0),
        ))
    ) {
      await this.sourceCondition(undefined, 'ready-scan')
      if (!this.outOfBudget(opts)) await this.completeScan(checkpoint, report)
      return
    }
    // One dependency-node cache per scan: blockers are commonly shared across
    // the ready set. Never reuse ticket or dependency objects between scans.
    const nodes = new Map<string, DependencyState>(
      listing.tickets.map((ticket) => [
        ticket.ref.id,
        {
          id: ticket.ref.id,
          exists: true,
          resolved: ticket.resolved,
          blockedBy: [...(ticket.blockedBy ?? [])],
        },
      ]),
    )

    // Finish read-only evaluation before any intake claim: a later source
    // failure must leave the entire ready set unclaimed. Publish dependency
    // diagnostics only after the complete preflight succeeds.
    let scanSuccessful = true
    const treeEntries = await this.repoBuildDigests()
    const hasNodes =
      treeEntries.some(({ digest }) => digest.kind === 'node') ||
      ready.some((ticket) => ticket.kind === 'node')
    let presence: PresenceInputs | undefined
    const migrations = this.store.repositoryFacts().ticketMigrations
    const normalizeTicket = historicalTicketIdentity(migrations, this.deps.tickets.name)
    const builtTickets = hasNodes
      ? new Set(
          treeEntries.flatMap(({ record }) =>
            record.ticket ? [normalizeTicket(record.ticket, record.slug)] : [],
          ),
        )
      : undefined
    const needsPresence = (candidate: Ticket) =>
      (candidate.blockedBy ?? []).some((id) => {
        const build = blockerBuild(treeEntries, candidate.ref.source, id, normalizeTicket)
        return (
          id !== candidate.ref.id &&
          build !== undefined &&
          typeof build !== 'string' &&
          build.digest.terminal !== 'aborted' &&
          (build.digest.kind !== 'node' || build.digest.mergedSha !== undefined)
        )
      })
    const destinationHeads = new Map<
      string,
      { branch: string; destination: string; head: string; identities: string[] }
    >()
    const demands: { slug: string; request: EventPayload<'node.restack-requested'> }[] = []
    const verdicts = new Map<string, DependencyVerdict>()
    const failed = new Set<string>()
    const targetBlocked = new Set<string>()
    const preflightTargets = new Map<string, string>()
    for (const ticket of ready) {
      if (this.outOfBudget(opts)) return
      if (withheld.has(ticket.ref.id)) continue
      const target = await this.resolveNodeTarget(ticket)
      if (typeof target === 'string') {
        targetBlocked.add(ticket.ref.id)
        report.dependencyBlocked += 1
        report.dependencyDiagnostics.push(`ticket ${ticket.ref.id}: ${target}`)
        continue
      }
      preflightTargets.set(ticket.ref.id, JSON.stringify(target))
      if (this.outOfBudget(opts)) return
      if ((!hasNodes && ticket.blockersResolved === true) || (ticket.blockedBy ?? []).length === 0)
        continue
      let verdict: DependencyVerdict
      try {
        if (!(await this.loadDependencyGraph(ticket, nodes, opts, builtTickets))) return
        if (hasNodes) {
          if (!presence && needsPresence(ticket)) {
            await this.recoverNodeContributions(treeEntries)
            const entries = await this.repoBuildDigests()
            const destinations = ready
              .filter(
                (candidate) =>
                  needsPresence(candidate) &&
                  !withheld.has(candidate.ref.id) &&
                  candidate.target !== undefined,
              )
              .flatMap((candidate) => {
                const node = blockerBuild(
                  entries,
                  candidate.ref.source,
                  candidate.target!,
                  normalizeTicket,
                )
                return node && typeof node !== 'string' && node.digest.kind === 'node'
                  ? [node.record.slug]
                  : []
              })
            presence = await presenceInputs(this.store, entries, destinations)
          }
          const inputs = presence ?? {
            entries: treeEntries,
            states: new Map(),
            aliases: new Map(),
            landings: [],
          }
          verdict = await this.presenceVerdict(
            ticket,
            target,
            nodes,
            inputs,
            demands,
            destinationHeads,
          )
        } else verdict = analyzeDependencies(ticket.ref.id, ticket.blockedBy ?? [], nodes)
      } catch (error) {
        if (error instanceof TicketSourceRateLimitError) {
          await this.sourceFailure(error, 'dependency-check')
          throw error
        }
        scanSuccessful = false
        failed.add(ticket.ref.id)
        report.dependencyCheckFailed += 1
        report.dependencyDiagnostics.push(
          `ticket ${ticket.ref.id}: dependency check failed — ${error instanceof Error || isForgeFailure(error) ? error.message : String(error)}`,
        )
        continue
      }
      verdicts.set(ticket.ref.id, verdict)
    }
    if (this.outOfBudget(opts)) return
    if (failed.size === 0) {
      await this.sourceCondition(undefined, 'dependency-check')
      for (const { slug, request } of demands) {
        if (this.outOfBudget(opts)) return
        const current = (await this.store.buildFacts(slug)).state
        const pending = Object.values(current.nodeRestack?.requests ?? {})
        if (
          current.baseBranch !== request.branch ||
          pending.some(
            (old) =>
              old.reason === 'presence' &&
              old.branch === request.branch &&
              old.dependent?.source === request.dependent?.source &&
              old.dependent?.id === request.dependent?.id &&
              (request.identities ?? []).every((id) => old.identities?.includes(id)),
          )
        )
          continue
        await this.store.appendIfCurrent(slug, current.lastSeq, {
          actor: DISPATCHER,
          type: 'node.restack-requested',
          payload: request,
        })
      }
    }
    for (const verdict of verdicts.values()) {
      if (verdict.unresolved.length > 0) {
        report.dependencyBlocked += 1
        report.dependencyDiagnostics.push(...verdict.diagnostics)
      }
    }
    for (const ticket of ready) {
      if (this.outOfBudget(opts)) break
      if (ticket.kind !== 'node' && capacity <= 0) continue
      if (withheld.has(ticket.ref.id)) continue
      if (failed.has(ticket.ref.id) || targetBlocked.has(ticket.ref.id)) continue
      if ((verdicts.get(ticket.ref.id)?.unresolved.length ?? 0) > 0) continue

      const target = await this.resolveNodeTarget(ticket)
      if (typeof target === 'string') {
        report.dependencyBlocked += 1
        report.dependencyDiagnostics.push(`ticket ${ticket.ref.id}: ${target}`)
        continue
      }
      if (hasNodes && preflightTargets.get(ticket.ref.id) !== JSON.stringify(target)) {
        report.dependencyBlocked += 1
        report.dependencyDiagnostics.push(
          `ticket ${ticket.ref.id}: target changed after dependency preflight`,
        )
        continue
      }
      if (hasNodes) {
        const branch = target?.branch ?? config.baseBranch
        const destination = target?.target.build ?? `root:${branch}`
        const observed = destinationHeads.get(destination)
        if (
          observed &&
          (!this.deps.forge.remoteBranchSha ||
            (await this.deps.forge.remoteBranchSha(branch)) !== observed.head)
        ) {
          report.dependencyBlocked += 1
          report.dependencyDiagnostics.push(
            `ticket ${ticket.ref.id}: destination ${destination} (${branch}) moved after dependency preflight; waiting for fresh presence evidence`,
          )
          continue
        }
      }
      const attempt: TicketPreparation = {
        attempt: this.deps.ids('prep'),
        ticket: ticket.ref,
        readyState: config.tickets.readyState,
        claimedState: ticketLifecycle(config.tickets).doing,
        claimed: false,
      }
      await store.ensureRepo(this.deps.repo)
      await store.appendRepo(this.deps.repo, {
        actor: DISPATCHER,
        type: 'ticket-preparation.intended',
        payload: {
          attempt: attempt.attempt,
          ticket: attempt.ticket,
          readyState: attempt.readyState,
          claimedState: attempt.claimedState,
        },
      })
      let stage = 'claim'
      let established = false
      let record: BuildRecord
      let body = ticket.body
      let authoredSession: string | undefined
      let createdSeed: Parameters<Dispatcher['buildCreatedPayload']>[2]
      try {
        if (!(await tickets.claim(ticket.ref.id))) {
          await this.preparationResolved(attempt, 'lost-claim')
          report.claimRaces += 1
          report.queued -= 1
          continue
        }
        attempt.claimed = true
        stage = 'claim-confirmation'
        await store.appendRepo(this.deps.repo, {
          actor: DISPATCHER,
          type: 'ticket-preparation.claimed',
          payload: { attempt: attempt.attempt, ticket: attempt.ticket },
        })
        stage = 'assets'
        // Freeze the ticket's assets at the claim (SPEC §6.3): sampled before the
        // spec-authoring interval so edits made during it are never pinned.
        const assets = await preparePinnedAssets(tickets, store, this.deps.repo, ticket.ref.id)

        // Quality gate (§6.3): import a conforming ticket body as the spec;
        // author one for thin-but-groomed tickets; otherwise bounce.
        stage = 'spec'
        let conformance = specConformance(body)
        if (!conformance.conforms && this.deps.authorSpec) {
          const authored = await this.deps.authorSpec(ticket)
          if (authored !== null) {
            conformance = specConformance(authored)
            if (conformance.conforms) {
              body = authored
              authoredSession = this.deps.ids('s')
            }
          }
        }
        if (!conformance.conforms) {
          attempt.handback = this.triageState()
          await store.appendRepo(this.deps.repo, {
            actor: DISPATCHER,
            type: 'ticket-preparation.handback-selected',
            payload: { attempt: attempt.attempt, ticket: attempt.ticket, state: attempt.handback },
          })
          stage = 'bounce'
          await this.bounce(ticket, conformance.missing)
          await this.preparationResolved(attempt, 'bounced')
          report.bounced += 1
          report.queued -= 1
          continue
        }

        stage = 'naming'
        const baseSlug = await this.chooseSlugBase(ticket.title, body)
        const slug = await this.uniqueSlug(baseSlug)
        const branch = `${ticket.kind === 'node' ? 'ab-node' : 'ab'}/${slug}`
        const repoOrigin = await this.resolveRepoOriginOnce()
        createdSeed = {
          ...(ticket.kind === 'node' ? { kind: ticket.kind } : {}),
          ...(target !== undefined ? { target: target.target, baseBranch: target.branch } : {}),
          ...(autoMergeUser !== undefined ? { autoMergeUser } : {}),
          // Claim-time provenance: the newest durable default fact that agrees
          // with the launch sample, recorded on `build.created` so the fan-out's
          // seq comparison sees the claim as already answering that fact — and
          // so a newer opposite fact (an interleaved toggle) stays strictly
          // ahead of it and reconciles this build on the next tick (f_b851c0e8).
          ...(autoMergeSeedFact !== undefined
            ? { autoMergeDefaultSeq: autoMergeSeedFact.seq }
            : {}),
          assets,
        }
        // `build.created` rides with the record so the pinned assets and the
        // record exist together or not at all.
        stage = 'creation-identity'
        attempt.slug = slug
        await store.appendRepo(this.deps.repo, {
          actor: DISPATCHER,
          type: 'ticket-preparation.creation-selected',
          payload: { attempt: attempt.attempt, ticket: attempt.ticket, slug },
        })
        stage = 'create-build'
        record = await store.createBuild({
          slug,
          repo: this.deps.repo,
          ticket: ticket.ref,
          branch,
          ...(repoOrigin !== undefined ? { repoOrigin } : {}),
          created: {
            actor: DISPATCHER,
            type: 'build.created',
            payload: this.buildCreatedPayload(ticket.ref, this.deps.repo, createdSeed),
          },
        })
        established = true
        await this.preparationResolved(attempt, 'owned')
      } catch (error) {
        // Settlement and completion errors after successful creation cannot
        // release the claim. A later tick settles the retained creation identity.
        if (established) throw error
        const errors: unknown[] = [error]
        attempt.error =
          (error instanceof Error ? error.message : String(error)).slice(0, 4000) ||
          'unknown preparation failure'
        attempt.stage = stage
        try {
          await store.appendRepo(this.deps.repo, {
            actor: DISPATCHER,
            type: 'ticket-preparation.failed',
            payload: {
              attempt: attempt.attempt,
              ticket: attempt.ticket,
              stage,
              claimed: attempt.claimed,
              handback: attempt.handback ?? attempt.readyState,
              error: attempt.error,
            },
          })
        } catch (diagnosticError) {
          errors.push(diagnosticError)
        }
        try {
          await this.recoverTicketPreparation(attempt)
        } catch (recoveryError) {
          errors.push(recoveryError)
        }
        throw new AggregateError(
          errors,
          `ticket preparation failed (${stage}): ${errors.map(String).join('; ')}`,
        )
      }
      report.queued -= 1
      if (ticket.kind !== 'node') capacity -= 1
      const outcome = await this.attemptDispatchCompletion(record, launched, report, {
        ticket,
        body,
        ...(authoredSession !== undefined ? { authoredSession } : {}),
        ...createdSeed,
      })
      // Accepted dispatches: durable boundaries recorded. A deferred outcome
      // means the remote provisioning continuation owns the rest.
      if (outcome === 'completed' || outcome === 'deferred') report.dispatched += 1
    }
    if (scanSuccessful && !this.outOfBudget(opts)) await this.completeScan(checkpoint, report)
  }

  /**
   * Walk unresolved branches in provider order. Listing facts and dependency
   * reads share a tick-local cache; traversal visits are local to this root.
   */
  private async resolveNodeTarget(
    ticket: Ticket,
  ): Promise<
    | { target: NonNullable<EventPayload<'build.created'>['target']>; branch: string }
    | string
    | undefined
  > {
    const forge = this.deps.forge
    if (
      ticket.kind === 'node' &&
      (!forge.createNodeBranch || !forge.compareBranches || !forge.remoteBranchSha)
    )
      return `integration requires forge ${forge.name} capabilities createNodeBranch, compareBranches and remoteBranchSha; upgrade the plugin`
    if (ticket.target === undefined) return undefined
    const migrations = this.store.repositoryFacts().ticketMigrations
    const entries = (await this.repoBuildDigests())
      .filter(
        ({ record }) =>
          record.ticket &&
          (() => {
            try {
              const ref = resolveTicketRef(
                migrations,
                record.ticket,
                ticket.ref.source,
                record.slug,
              )
              return ref.id === ticket.target
            } catch {
              return false
            }
          })(),
      )
      .sort(
        (a, b) =>
          b.record.createdAt.localeCompare(a.record.createdAt) ||
          b.record.slug.localeCompare(a.record.slug),
      )
    const latest = entries[0]
    if (latest && entries[1]?.record.createdAt === latest.record.createdAt)
      return `target node ${ticket.target} has ambiguous build generations at ${latest.record.createdAt}`
    if (!latest) return `target node ${ticket.target} is not yet claimed`
    const { record, digest } = latest
    if (digest.kind !== 'node') return `target ${ticket.target} is not a node`
    if (digest.terminal || digest.prClosed || digest.merged)
      return `target node ${ticket.target} is ${digest.terminal === 'aborted' ? 'aborted' : digest.merged ? 'landed' : 'closed'}`
    const state = (await this.store.buildFacts(record.slug)).state
    if (
      state.status === 'done' ||
      state.status === 'aborted' ||
      state.prState === 'merged' ||
      state.prState === 'closed'
    )
      return `target node ${ticket.target} is ${state.prState === 'merged' ? 'landed' : 'closed'}`
    if (state.pendingCommands.some((c) => c.command === 'abort'))
      return `target node ${ticket.target} is closing`
    if (state.integration?.intent && !state.integration.landing)
      return `target node ${ticket.target} is merging`
    if (!digest.nodeOpened || !record.branch) return `target node ${ticket.target} is not yet open`
    return {
      target: {
        ticket: resolveTicketRef(migrations, record.ticket!, this.deps.tickets.name, record.slug),
        build: record.slug,
      },
      branch: record.branch,
    }
  }

  private async openNode(record: BuildRecord, state: BuildState): Promise<void> {
    if (!record.branch || !state.baseBranch)
      throw new Error('integration lacks frozen branch facts')
    const forge = this.deps.forge
    if (!forge.createNodeBranch || !forge.remoteBranchSha)
      throw new Error('forge lacks node branch capabilities')
    let intent = state.nodeOpening
    if (!intent) {
      intent = {
        branch: record.branch,
        parent: state.baseBranch,
        sha: await forge.remoteBranchSha(state.baseBranch),
      }
      const written = await this.store.appendIfCurrent(record.slug, state.lastSeq, {
        actor: DISPATCHER,
        type: 'node.opening',
        payload: intent,
      })
      if (!written) return
    }
    const sha = await forge.createNodeBranch(intent.branch, intent.sha)
    await this.store.refreshBuild(record.slug)
    const latest = (await this.store.buildFacts(record.slug)).state
    if (latest.status !== 'queued' || latest.pendingCommands.length > 0 || latest.nodeOpened) return
    await this.store.appendIfCurrent(record.slug, latest.lastSeq, {
      actor: DISPATCHER,
      type: 'node.opened',
      payload: { sha },
    })
  }

  private kernelForge(): Forge {
    const forge = this.deps.forge
    if (!forge.kernelRewrite) return forge
    return new Proxy(forge, {
      get(target, key) {
        if (key === 'rewrite') return target.kernelRewrite
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  private async kernelRepository(root: string): Promise<string> {
    const checkout = this.deps.checkout ?? this.deps.repo
    if (!this.deps.repoOrigin) return checkout
    // Origin-mode CLI wiring supplies a scratch checkout path too. Only an
    // actual Git repository can provide the kernel's local object database.
    if (this.deps.checkout) {
      const probe = await this.deps.exec(['git', 'rev-parse', '--git-dir'], { cwd: checkout })
      if (probe.exitCode === 0) return checkout
    }
    const path = join(root, 'repository.git')
    const clone = await (this.deps.forge.kernelExec ?? this.deps.exec)(
      ['git', 'clone', '--bare', this.deps.repoOrigin, path],
      {
        cwd: root,
      },
    )
    if (clone.exitCode !== 0) throw new Error(clone.stderr)
    return path
  }

  private async withKernelRepository<T>(run: (path: string) => Promise<T>): Promise<T> {
    const root = await mkdtemp(join(tmpdir(), 'autobuild-node-transport-'))
    try {
      return await run(await this.kernelRepository(root))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  private async cascadeNode(
    record: BuildRecord,
    state: BuildState,
    report: TickReport,
    launched: Set<string>,
    opts: TickOpts,
  ): Promise<void> {
    if (await deferMixedVersion(this.store, record.slug)) return
    if (state.nodeRestack?.parentRequest && !state.nodeRestack.active) return
    if (
      state.nodeRestack?.parentChange &&
      state.nodeRestack.parentReplay === state.nodeRestack.parentChange.id
    )
      return
    const forge = this.kernelForge()
    const settled = (await readBuildFacts(this.store, record.slug)).value
    if (
      settled.publication.pending() ||
      (settled.open !== null &&
        (settled.open.commandId !== undefined || this.hasLiveExecutionLease(record)))
    )
      return
    if (
      state.pr &&
      (await forge.getPrState(this.deps.checkout ?? this.deps.repo, state.pr.number)).state !==
        'open'
    )
      return
    if (
      state.nodeRestack?.active?.operation === 'landing' ||
      (state.integration?.intent && !state.integration.landing)
    )
      return
    if (
      !record.branch ||
      !state.baseBranch ||
      !forge.rewrite ||
      (!forge.snapshotBase && !forge.kernelExec)
    )
      return
    // The forge API can prove an unchanged inventory without downloading Git
    // history. Active work and hand pushes still enter the transaction path.
    if (
      !state.nodeRestack?.active &&
      !state.nodeRestack?.parentChange &&
      state.sessions.open.length === 0 &&
      forge.remoteBranchSha
    ) {
      const [parent, head] = await Promise.all([
        forge.remoteBranchSha(state.baseBranch),
        forge.remoteBranchSha(record.branch),
      ])
      this.availabilityEntries ??= this.repoBuildDigests()
      const entries = await this.availabilityEntries
      this.availabilityLandings ??= confirmedLandings(entries)
      this.availabilityLandingKey ??= restackLandingKey(this.availabilityLandings)
      const evidence = await presenceInputs(
        this.store,
        entries,
        [record.slug],
        this.availabilityLandings,
      )
      const fingerprint =
        parent && head
          ? restackAvailabilityFingerprint(
              state,
              record.branch,
              state.baseBranch,
              head,
              parent,
              evidence,
              this.availabilityLandingKey,
            )
          : ''
      const actionable = actionableRestackDemand(state, fingerprint)
      if (
        (parent === state.nodeRestack?.contributionBase || !actionable) &&
        state.nodeRestack?.distance?.parent === parent &&
        state.nodeRestack.distance.base === state.nodeRestack.contributionBase &&
        head === state.nodeRestack?.inventory?.head &&
        (!Object.keys(state.nodeRestack?.requests ?? {}).length || !actionable)
      )
        return
    }
    const holder = this.deps.ids('node-writer')
    const root = await mkdtemp(join(tmpdir(), 'autobuild-node-'))
    const workspacePath = join(root, 'replay')
    let checkout = this.deps.checkout ?? this.deps.repo
    let added = false
    let claimed = false
    try {
      // Repository download is read-only and may exceed the writer lease TTL.
      // Acquire writer authority only after it completes.
      checkout = await this.kernelRepository(root)
      claimed = await this.store.claimNodeWriter(record.slug, holder, 60_000)
      if (!claimed) return
      const latest = (await readBuildFacts(this.store, record.slug)).value
      if (latest.publication.pending()) return
      if (latest.open !== null) {
        const refreshed = await this.store.getBuild(record.slug)
        if (
          latest.open.commandId !== undefined ||
          (refreshed && this.hasLiveExecutionLease(refreshed))
        )
          return
        await this.store.append(record.slug, {
          actor: DISPATCHER,
          type: 'execution.ended',
          payload: {
            instance: latest.open.instance,
            workspaceRef: latest.open.workspaceRef,
            outcome: 'lost',
          },
        })
      }
      state = (await this.store.buildFacts(record.slug)).state
      // An ended execution may have died between an item's atomic receipt and
      // its phase/session acknowledgements. Reclaim only after supervision has
      // settled the complete execution, before any public stack rewrite.
      for (const session of state.sessions.open) {
        await this.store.append(record.slug, {
          actor: KERNEL,
          type: 'session.ended',
          payload: {
            session: session.session,
            outcome: 'reclaimed',
            reclaimedBy: { instance: holder, resumedFromSeq: state.lastSeq },
          },
        })
      }
      if (
        !state.nodeRestack?.conflict &&
        state.currentPhase?.phase === 'reconcile' &&
        state.nodeRestack?.active &&
        state.nodeRestack.items.length > 0
      ) {
        const notes = await this.store.getArtifact(record.slug, 'reconcile-notes')
        if (!notes) throw new Error('missing source build identity resolution notes')
        await this.store.append(record.slug, {
          actor: KERNEL,
          type: 'reconcile.completed',
          payload: {
            headSha: state.nodeRestack.items.at(-1)!.head,
            rewriteId: state.nodeRestack.active.id,
            artifact: { kind: notes.meta.kind, rev: notes.meta.revision },
          },
        })
      }
      const result = await this.deps.exec(
        ['git', 'worktree', 'add', '--detach', workspacePath, 'HEAD'],
        { cwd: checkout },
      )
      if (result.exitCode !== 0) throw new Error(result.stderr)
      added = true
      const beforeReplay = async (operation: string) => {
        for (const child of await this.repoBuildDigests()) {
          if (child.digest.terminal || child.digest.kind === 'node') continue
          const childState = (await this.store.buildFacts(child.record.slug)).state
          if (
            childState.target?.build !== record.slug ||
            !childState.pr ||
            childState.prState !== 'open'
          )
            continue
          await suspendNativeLanding(
            { store: this.store, forge, slug: child.record.slug, workspacePath: checkout },
            `node:${record.slug}:${operation}`,
          )
        }
      }
      const outcome = await runNodeTransaction(
        {
          store: this.store,
          slug: record.slug,
          forge,
          exec: forge.kernelExec ?? this.deps.exec,
          workspacePath,
          holder,
          beforeReplay,
          canWrite: async () => {
            if (await deferMixedVersion(this.store, record.slug)) return false
            if (this.outOfBudget(opts)) return false
            if (state.pr && (await forge.getPrState(checkout, state.pr.number)).state !== 'open')
              return false
            await this.store.refreshBuild(record.slug)
            const current = (await this.store.buildFacts(record.slug)).state
            return (
              current.status !== 'done' &&
              current.status !== 'aborted' &&
              current.status !== 'paused' &&
              (current.status !== 'blocked' || integrationFailed(current)) &&
              current.prState !== 'merged' &&
              current.prState !== 'closed' &&
              current.pendingCommands.length === 0 &&
              current.sessions.open.length === 0
            )
          },
        },
        {
          branch: record.branch,
          parentBranch: state.baseBranch!,
          id: this.deps.ids('node-restack').replaceAll('_', '-'),
        },
      )
      if (outcome === 'completed') {
        const completed = (await readBuildFacts(this.store, record.slug)).value
        if (openWorkspace(completed)) await this.releaseWorkspace(record.slug, completed)
      }
      if (outcome === 'conflict') {
        const facts = (await readBuildFacts(this.store, record.slug)).value
        const node = facts.state.nodeRestack!
        const conflict = node.conflict!
        const change = node.active!.changes[conflict.index]!
        if (change.build) {
          if (!(await this.store.getBuild(change.build)))
            throw new Error(`missing source build identity ${change.build}`)
          const source = (await readBuildFacts(this.store, change.build)).value.state
          if (
            source.specRev === undefined ||
            source.plan.artifactRev === undefined ||
            !source.plan.approved ||
            source.implement.artifactRev === undefined
          )
            throw new Error(`missing source build identity context for ${change.build}`)
          for (const [kind, revision] of [
            ['spec', source.specRev],
            ['plan', source.plan.artifactRev],
            ['implement-notes', source.implement.artifactRev],
          ] as const) {
            const contextKind = `node-source-${node.active!.id}-${conflict.index}-${kind}`
            if (await this.store.getArtifact(record.slug, contextKind)) continue
            const artifact = await this.store.getArtifact(change.build, kind, revision)
            if (!artifact)
              throw new Error(`missing source build identity context ${kind} for ${change.build}`)
            await this.store.putArtifact(record.slug, {
              kind: contextKind,
              content: artifact.content,
            })
          }
        }

        if (!this.accountsAvailable()) return
        if (!(await this.nodeHasCapacity(record.slug))) return
        if (openWorkspace(facts) === null && this.deps.workspaces.recovery) {
          const kicked = await this.ensureProvisionContinuation(record, facts, 'launch')
          if (kicked === 'kicked') report.provisioning += 1
        } else {
          if (openWorkspace(facts) === null) {
            const handle = await this.deps.workspaces.provision({
              repo: checkout,
              baseBranch: state.baseBranch!,
              branch: record.branch!,
            })
            await this.store.append(record.slug, {
              actor: DISPATCHER,
              type: 'workspace.provisioned',
              payload: {
                provider: handle.provider,
                ref: handle.ref,
                path: handle.path,
                localPath: handle.localPath,
                remote: false,
                branch: handle.branch,
                base: handle.base,
              },
            })
          }
          await this.launch(record.slug, launched, report)
        }
      }
    } catch (error) {
      if (await this.holdForMissingAccounts(error)) return
      const message =
        error instanceof Error || isForgeFailure(error) ? error.message : String(error)
      // Safety refusals require human judgment. Infrastructure failures remain
      // retryable dispatch failures and retain their active reservation.
      if (
        message.includes('node restack refused') ||
        message.includes('contribution base') ||
        message.includes('build identity')
      ) {
        await this.store.refreshBuild(record.slug)
        const current = (await this.store.buildFacts(record.slug)).state
        if (!current.openEscalations.length)
          await this.store.append(record.slug, {
            actor: KERNEL,
            type: 'escalation.raised',
            payload: {
              id: this.deps.ids('esc'),
              phase: 'reconcile',
              source: 'agent',
              question: message,
            },
          })
      } else throw error
    } finally {
      if (added)
        await this.deps.exec(['git', 'worktree', 'remove', '--force', workspacePath], {
          cwd: checkout,
        })
      await rm(root, { recursive: true, force: true })
      if (claimed) await this.store.releaseNodeWriter(record.slug, holder)
    }
  }

  private async prepareIntegration(
    record: BuildRecord,
    state: BuildState,
    report: TickReport,
    launched: Set<string>,
    sampling: { refreshOnly?: boolean } = {},
  ): Promise<void> {
    if (
      state.targetRewrite ||
      state.status === 'paused' ||
      state.status === 'done' ||
      state.status === 'aborted' ||
      state.pendingCommands.length ||
      state.openEscalations.length ||
      state.prState === 'merged' ||
      state.prState === 'closed' ||
      state.integration?.intent ||
      state.nodeRestack?.parentRequest ||
      state.nodeRestack?.parentChange
    )
      return
    const forge = this.kernelForge()
    if (!record.branch || !state.baseBranch || !forge.compareBranches) return
    const comparison = await forge.compareBranches(state.baseBranch!, record.branch!)
    if (JSON.stringify(comparison) !== JSON.stringify(state.nodeComparison))
      await this.store.append(record.slug, {
        actor: DISPATCHER,
        type: 'node.compared',
        payload: comparison,
      })
    state = (await this.store.buildFacts(record.slug)).state
    const claims = await this.integrationClaimKey(record.slug, state)
    const unchangedFailure = integrationFailed(state)
    if (
      !unchangedFailure &&
      this.integrationPollDue(
        this.integrationPolls,
        record.slug,
        `${state.restartSince}:${comparison.headSha}:${comparison.parentSha}:${state.nodeRestack?.inventory?.head ?? ''}:${state.landing?.command?.seq ?? state.landing?.decision?.seq ?? ''}:${claims}`,
      )
    ) {
      await this.observeIntegration(record.slug)
      state = (await this.store.buildFacts(record.slug)).state
    }
    if (sampling.refreshOnly) return
    if (
      state.integration?.cycle &&
      !state.nodeRestack?.active &&
      (!integrationCurrent(state) || integrationFailed(state))
    ) {
      const stale = (await readBuildFacts(this.store, record.slug)).value
      if (openWorkspace(stale)) await this.releaseWorkspace(record.slug, stale)
      state = (await this.store.buildFacts(record.slug)).state
    }
    if (
      unchangedFailure ||
      !integrationComplete(state) ||
      state.nodeRestack?.active ||
      state.integration?.intent ||
      state.nodeRestack?.contributionBase !== comparison.parentSha ||
      state.openEscalations.length ||
      state.status === 'paused' ||
      state.status === 'done' ||
      state.status === 'aborted' ||
      state.pendingCommands.length ||
      state.prState === 'merged' ||
      state.prState === 'closed'
    )
      return
    const artifact = await this.store.getArtifact(record.slug, BUILD_EFFECTIVE_CONFIG_ARTIFACT)
    const config = await capturedBuildConfig(
      this.store,
      record.slug,
      state,
      artifact
        ? composeBuildConfig(parseEffectiveBuildConfig(artifact), this.deps.config)
        : this.deps.config,
    )
    if (
      !integrationCurrent(state) ||
      state.integration?.cycle?.config !== integrationConfig(config)
    ) {
      await this.observeIntegration(record.slug)
      state = (await this.store.buildFacts(record.slug)).state
      if (!integrationComplete(state)) return
      const holder = this.deps.ids('node-writer')
      if (!(await this.store.claimNodeWriter(record.slug, holder, 60_000))) return
      try {
        const current = (await this.store.buildFacts(record.slug)).state
        if (
          current.nodeRestack?.active ||
          current.nodeRestack?.parentRequest ||
          current.nodeRestack?.parentChange ||
          current.pendingCommands.length
        )
          return
        const exact = await forge.compareBranches(state.baseBranch!, record.branch!)
        if (exact.parentSha !== comparison.parentSha || exact.headSha !== comparison.headSha) return
        const cycle = {
          id: this.deps.ids('integration-cycle'),
          parent: exact.parentSha,
          head: exact.headSha,
        }
        let context: string | undefined
        await this.withKernelRepository(async (path) => {
          const head = await forge.rewrite!.snapshot({
            workspacePath: path,
            branch: record.branch!,
            destinationRef: `refs/autobuild/reconcile/${record.slug}/verify-head`,
          })
          if (head !== exact.headSha)
            throw new Error('node head moved while preparing verification')
          await forge.rewrite!.archive({
            workspacePath: path,
            ref: `refs/autobuild/archive/${record.slug}/${head}`,
            sha: head,
          })
          if (
            config.verify.steps.some((step) => config.verify.stepConfigs[step]?.kind === 'agent')
          ) {
            const exec = forge.kernelExec ?? this.deps.exec
            // Snapshot fetch brings the complete head ancestry, including merge sides.
            // A parent may have advanced independently and need its own fetch.
            const parent = await exec(['git', 'cat-file', '-e', `${exact.parentSha}^{commit}`], {
              cwd: path,
            })
            if (parent.exitCode !== 0) {
              const fetched = await exec(['git', 'fetch', '--no-tags', 'origin', exact.parentSha], {
                cwd: path,
              })
              if (fetched.exitCode !== 0)
                throw new Error(`cannot fetch node verification parent: ${fetched.stderr}`)
            }
            context = await prepareNodeVerificationContext(
              this.store,
              record.repo,
              cycle,
              current,
              { exec, workspacePath: path },
            )
          }
        })
        if (!(await this.store.renewNodeWriter(record.slug, holder))) return
        const prepared = await this.store.appendWithArtifactsIfCurrent(
          record.slug,
          current.lastSeq,
          context === undefined ? [] : [{ kind: NODE_VERIFICATION_CONTEXT, content: context }],
          (deposited) => ({
            actor: DISPATCHER,
            type: 'integration.prepared',
            payload: {
              ...cycle,
              config: integrationConfig(config),
              ...(deposited[0]
                ? { context: { kind: NODE_VERIFICATION_CONTEXT, rev: deposited[0].revision } }
                : {}),
            },
          }),
        )
        if (!prepared) return
      } finally {
        await this.store.releaseNodeWriter(record.slug, holder)
      }
      state = (await this.store.buildFacts(record.slug)).state
    }
    if (integrationFailed(state) || integrationVerified(state, config)) {
      const facts = (await readBuildFacts(this.store, record.slug)).value
      if (openWorkspace(facts)) await this.releaseWorkspace(record.slug, facts)
      return
    }
    if (!(await this.nodeHasCapacity(record.slug))) return
    await this.observeIntegration(record.slug)
    state = (await this.store.buildFacts(record.slug)).state
    if (!integrationCurrent(state)) return
    if (!this.accountsAvailable()) return
    const facts = (await readBuildFacts(this.store, record.slug)).value
    if (openWorkspace(facts) === null && this.deps.workspaces.recovery) {
      const kicked = await this.ensureProvisionContinuation(record, facts, 'launch')
      if (kicked === 'kicked') report.provisioning++
      return
    }
    if (openWorkspace(facts) === null) {
      let handle: WorkspaceProvisionResult
      try {
        handle = await this.deps.workspaces.provision({
          repo: this.deps.checkout ?? this.deps.repo,
          baseBranch: record.branch,
          branch: record.branch,
          revision: state.integration!.cycle!.head,
        })
      } catch (error) {
        if (await this.holdForMissingAccounts(error)) return
        throw error
      }
      await this.store.append(record.slug, {
        actor: DISPATCHER,
        type: 'workspace.provisioned',
        payload: {
          provider: handle.provider,
          ref: handle.ref,
          path: handle.path,
          localPath: handle.localPath,
          remote: false,
          branch: handle.branch,
          base: handle.base,
        },
      })
    }
    await this.launch(record.slug, launched, report)
  }

  private async pollEmptyNode(record: BuildRecord, state: BuildState): Promise<void> {
    const forge = this.deps.forge
    if (!forge.compareBranches || !record.branch || !state.baseBranch)
      throw new Error('integration lacks comparison capability or frozen branch facts')
    const observe = async () => {
      const comparison = await forge.compareBranches!(state.baseBranch!, record.branch!)
      if (
        comparison.parentSha !== state.nodeComparison?.parentSha ||
        comparison.headSha !== state.nodeComparison?.headSha ||
        comparison.ahead !== state.nodeComparison?.ahead
      ) {
        await this.store.append(record.slug, {
          actor: DISPATCHER,
          type: 'node.compared',
          payload: comparison,
        })
        state.nodeComparison = comparison
      }
      return comparison
    }
    const comparison = await observe()
    // Branch comparison is telemetry, never contribution provenance: a
    // rewritten parent can make inherited siblings appear "ahead". Only the
    // inventory of this exact source head proves that the node owns work.
    const inventory = state.nodeRestack?.inventory
    if (
      inventory?.head !== comparison.headSha ||
      !((inventory.contributions?.length ?? 0) + inventory.foreign.length)
    )
      return
    let pr: Awaited<ReturnType<typeof forge.openPr>>
    try {
      pr = await forge.openPr({
        workspacePath: this.deps.checkout ?? this.deps.repo,
        head: record.branch,
        base: state.baseBranch,
        title: `Integration: ${record.ticket?.id ?? record.slug}`,
        body: `Integration build ${record.slug}. Target: ${state.target?.ticket.id ?? state.baseBranch}. Human merge required.`,
      })
    } catch (error) {
      if (
        error instanceof NoCommitsBetweenBranchesError &&
        (await observe()).headSha === comparison.parentSha
      )
        return
      throw error
    }
    await this.store.append(record.slug, { actor: DISPATCHER, type: 'pr.opened', payload: { pr } })
  }

  /** Recover manifests after merge-observation crashes as well as before
   * recording a new merge. Never synthesize an empty historical manifest. */
  private async recoverNodeContributions(
    entries: Awaited<ReturnType<Dispatcher['repoBuildDigests']>>,
    merging?: { slug: string; sha: string },
  ): Promise<void> {
    const candidates = entries.filter(
      ({ record, digest }) =>
        digest.kind === 'node' && (digest.merged || record.slug === merging?.slug),
    )
    if (candidates.length === 0) return
    const pending = candidates.filter(
      ({ record, digest }) =>
        digest.nodeContribution?.landing !==
        (record.slug === merging?.slug ? merging.sha : digest.mergedSha),
    )
    if (pending.length === 0) return
    const inputs = await presenceInputs(
      this.store,
      entries,
      pending.map(({ record }) => record.slug),
    )
    try {
      await this.withKernelRepository(async (path) => {
        const forge = this.kernelForge()
        const git = { exec: forge.kernelExec ?? this.deps.exec, workspacePath: path }
        const visiting = new Set<string>()
        const recover = async (slug: string): Promise<void> => {
          if (visiting.has(slug)) throw new Error('cyclic node contribution evidence')
          const entry = entries.find(({ record }) => record.slug === slug)!
          const landing = slug === merging?.slug ? merging.sha : entry.digest.mergedSha
          if (!landing || entry.digest.nodeContribution?.landing === landing) return
          const state = inputs.states.get(slug)!
          if (!state.pr || !forge.inspectLandingPr)
            throw new Error('cannot establish merged node source head')
          visiting.add(slug)
          const pr = await forge.inspectLandingPr(path, state.pr.number)
          const head = pr.headSha
          const base =
            state.nodeRestack?.contributionBoundaries?.[head] ??
            (state.nodeRestack?.inventory?.head === head
              ? state.nodeRestack.contributionBase
              : undefined) ??
            (state.nodeRestack?.contributionBase === state.nodeOpened?.sha
              ? state.nodeOpened?.sha
              : undefined)
          if (!head || !base) throw new Error('missing node contribution source range')
          // Fetch retained objects when the kernel repository has not seen
          // this source head (including remote guest publication).
          for (const sha of [head, base]) {
            const exists = await git.exec(['git', 'cat-file', '-e', `${sha}^{commit}`], {
              cwd: path,
            })
            if (exists.exitCode !== 0) {
              const fetched = await git.exec(
                ['git', 'fetch', '--no-tags', '--no-write-fetch-head', 'origin', sha],
                { cwd: path },
              )
              if (fetched.exitCode !== 0)
                throw new Error(`retained node source object ${sha} unavailable`)
            }
          }
          // Nested completed nodes must be expanded before their parent is
          // frozen; a squash can erase every original child SHA.
          for (const child of candidates) {
            if (child.record.slug === slug) continue
            const childState = inputs.states.get(child.record.slug)
            if (childState?.target?.build === slug && childState.mergedSha)
              await recover(child.record.slug)
          }
          const currentIdentities = await ownedContribution(
            git,
            base,
            head,
            inputs.landings,
            inputs.aliases,
          )
          const dropped = state.nodeRestack?.droppedIdentities ?? []
          const transported = inputs.landings
            .filter(
              (proof) =>
                dropped.includes(`build:${proof.slug}`) || dropped.includes(`foreign:${proof.sha}`),
            )
            .flatMap((proof) => proof.contribution ?? [])
          const identities = normalizeIdentities([
            ...currentIdentities,
            ...(dropped as ChangeIdentity[]),
            ...transported,
          ])
          const payload = { landing, head, base, identities }
          await this.store.append(slug, {
            actor: DISPATCHER,
            type: 'node.contribution-recorded',
            payload,
          })
          state.nodeRestack ??= { items: [] }
          state.nodeRestack.contribution = payload
          entry.digest.nodeContribution = payload
          inputs.landings.push({ slug, sha: landing, contribution: identities })
          visiting.delete(slug)
        }
        for (const entry of pending) {
          try {
            await recover(entry.record.slug)
          } catch {
            visiting.clear()
          }
        }
      })
    } catch {
      // Admission reports the missing confirmed contribution. Merge facts
      // and lifecycle cleanup must still progress when Git is unavailable.
    }
  }

  private async sampleDestinationPresence(
    branch: string,
    destination: string,
    target: { target: { build: string } } | undefined,
    inputs: PresenceInputs,
    observations: Map<
      string,
      { branch: string; destination: string; head: string; identities: string[] }
    >,
  ) {
    let observed = observations.get(destination)
    if (!observed) {
      const forge = this.kernelForge()
      if (!forge.remoteBranchSha) throw new Error('forge cannot read destination head')
      const head = await forge.remoteBranchSha(branch)
      const aliases = destinationAliases(inputs, target?.target.build)
      const cached = this.store.repositoryFacts().presence[destination]
      if (cached?.head === head && cached.branch === branch && cached.witness?.version === 1) {
        const identities = projectPresence(cached.witness, inputs.landings, aliases)
        const evidence = presenceEvidence(cached.witness, identities)
        observed = { ...cached, identities }
        if (cached.evidence !== evidence) {
          await this.store.ensureRepo(this.deps.repo)
          await this.store.appendRepo(this.deps.repo, {
            actor: DISPATCHER,
            type: 'change-presence.observed',
            payload: { ...cached, identities, evidence },
          })
        }
      } else {
        if (!forge.snapshotBase && !forge.kernelExec && !forge.rewrite)
          throw new Error('forge cannot snapshot destination presence')
        observed = await this.withKernelRepository(async (path) => {
          const destinationRef = `refs/autobuild/reconcile/${target?.target.build ?? 'presence'}/presence`
          let sampled: string
          if (forge.snapshotBase)
            sampled = await forge.snapshotBase({
              workspacePath: path,
              base: branch,
              destinationRef,
            })
          else if (target && forge.rewrite)
            sampled = await forge.rewrite.snapshot({
              workspacePath: path,
              branch,
              destinationRef,
            })
          else {
            const exec = forge.kernelExec ?? this.deps.exec
            const fetch = await exec(
              [
                'git',
                'fetch',
                '--no-tags',
                '--no-write-fetch-head',
                '--refmap=',
                'origin',
                `+refs/heads/${branch}:${destinationRef}`,
              ],
              { cwd: path },
            )
            if (fetch.exitCode !== 0) throw new Error(fetch.stderr)
            const resolved = await exec(
              ['git', 'rev-parse', '--verify', `${destinationRef}^{commit}`],
              { cwd: path },
            )
            if (resolved.exitCode !== 0) throw new Error(resolved.stderr)
            sampled = resolved.stdout.trim()
          }
          if (sampled !== head) throw new Error('destination moved while sampling presence')
          const witness = await presenceWitness(
            { exec: forge.kernelExec ?? this.deps.exec, workspacePath: path },
            head,
          )
          const identities = projectPresence(witness, inputs.landings, aliases)
          const evidence = presenceEvidence(witness, identities)
          const payload = { branch, destination, head, evidence, identities, witness }
          await this.store.ensureRepo(this.deps.repo)
          await this.store.appendRepo(this.deps.repo, {
            actor: DISPATCHER,
            type: 'change-presence.observed',
            payload,
          })
          return payload
        })
      }
      observations.set(destination, observed)
    }
    return observed!
  }

  private async presenceVerdict(
    ticket: Ticket,
    target:
      | { target: NonNullable<EventPayload<'build.created'>['target']>; branch: string }
      | undefined,
    nodes: Map<string, DependencyState>,
    inputs: PresenceInputs,
    demands: { slug: string; request: EventPayload<'node.restack-requested'> }[],
    observations: Map<
      string,
      { branch: string; destination: string; head: string; identities: string[] }
    >,
  ): Promise<DependencyVerdict> {
    const branch = target?.branch ?? this.deps.config.baseBranch
    const destination = target?.target.build ?? `root:${branch}`
    const unresolved: string[] = []
    const diagnostics: string[] = []
    const required = new Map<string, ChangeIdentity[]>()
    const fallback: string[] = []
    for (const id of ticket.blockedBy ?? []) {
      const build = blockerBuild(
        inputs.entries,
        ticket.ref.source,
        id,
        historicalTicketIdentity(
          this.store.repositoryFacts().ticketMigrations,
          this.deps.tickets.name,
        ),
      )
      if (id === ticket.ref.id || !nodes.get(id)?.exists || build === undefined) {
        fallback.push(id)
        continue
      }
      if (typeof build === 'string') {
        unresolved.push(id)
        diagnostics.push(`ticket ${ticket.ref.id}: ${build}`)
        continue
      }
      if (build.digest.terminal === 'aborted') {
        unresolved.push(id)
        diagnostics.push(
          `ticket ${ticket.ref.id}: blocker ${id} latest build ${build.record.slug} is aborted`,
        )
        continue
      }
      if (build.digest.kind !== 'node') required.set(id, [`build:${build.record.slug}`])
      else {
        const contribution = build.digest.nodeContribution
        if (
          !build.digest.prClosed &&
          contribution &&
          contribution.landing === build.digest.mergedSha
        )
          required.set(id, contribution.identities as ChangeIdentity[])
        else {
          unresolved.push(id)
          diagnostics.push(
            `ticket ${ticket.ref.id}: blocker ${id} has no confirmed completed contribution for destination ${destination} (${branch})`,
          )
        }
      }
    }
    const lifecycle = analyzeDependencies(ticket.ref.id, fallback, nodes)
    unresolved.push(...lifecycle.unresolved)
    diagnostics.push(...lifecycle.diagnostics)
    if ([...required.values()].every((ids) => ids.length === 0)) return { unresolved, diagnostics }
    try {
      const observed = await this.sampleDestinationPresence(
        branch,
        destination,
        target,
        inputs,
        observations,
      )
      const missing = [
        ...new Set(
          [...required.values()].flatMap((ids) => missingChanges(ids, observed.identities)),
        ),
      ]
      if (target && missing.length) {
        const path: { slug?: string; identities: string[]; branch: string; head: string }[] = [
          { slug: target.target.build, ...observed },
        ]
        const seen = new Set<string>()
        let slug: string | undefined = target.target.build
        while (slug) {
          if (seen.has(slug)) throw new Error('cyclic node ancestry')
          seen.add(slug)
          const record = await this.store.getBuild(slug)
          if (!record || record.repo !== this.deps.repo) throw new Error('missing node ancestry')
          const state: BuildState = (await this.store.buildFacts(slug)).state
          if (state.kind !== 'node' || !state.baseBranch || state.nodeRestack?.parentRequest)
            throw new Error('uncertain node ancestry')
          slug = state.target?.build
          const parent = await this.sampleDestinationPresence(
            state.baseBranch,
            slug ?? `root:${state.baseBranch}`,
            slug ? { target: { build: slug } } : undefined,
            inputs,
            observations,
          )
          path.push({ ...(slug ? { slug } : {}), ...parent })
          if (missing.every((id) => path.some((entry) => entry.identities.includes(id)))) break
        }
        for (const requested of presenceRestackPath(path, missing)) {
          const index = path.findIndex((entry) => entry.slug === requested)
          const parent = path[index + 1]!
          const identities = missing.filter((id) =>
            path.slice(index + 1).some((entry) => entry.identities.includes(id)),
          )
          demands.push({
            slug: requested,
            request: {
              id: this.deps.ids('presence-restack'),
              reason: 'presence',
              branch: parent.branch,
              parent: parent.head,
              dependent: ticket.ref,
              identities,
            },
          })
        }
      }
      for (const [id, identities] of required) {
        const missing = missingChanges(identities, observed.identities)
        if (missing.length) {
          unresolved.push(id)
          diagnostics.push(
            `ticket ${ticket.ref.id}: blocker ${id} is not present in ${destination} (${branch}) at ${observed.head}; missing ${missing.join(', ')}`,
          )
        }
      }
    } catch (error) {
      for (const id of required.keys()) {
        unresolved.push(id)
        diagnostics.push(
          `ticket ${ticket.ref.id}: blocker ${id} presence unavailable in ${destination} (${branch}): ${error instanceof Error || isForgeFailure(error) ? error.message : String(error)}`,
        )
      }
    }
    return { unresolved, diagnostics }
  }

  private async loadDependencyGraph(
    ticket: Ticket,
    nodes: Map<string, DependencyState>,
    opts: TickOpts = {},
    builtTickets?: ReadonlySet<string>,
  ): Promise<boolean> {
    const visited = new Set<string>()
    let frontier = [...new Set(ticket.blockedBy ?? [])]
    while (frontier.length > 0) {
      if (this.outOfBudget(opts)) return false
      const uncached = frontier.filter((id) => !nodes.has(id))
      if (uncached.length > 0) {
        const states = await this.deps.tickets.dependencyStates(uncached)
        for (const state of states) nodes.set(state.id, state)
      }
      const next: string[] = []
      for (const id of frontier) {
        visited.add(id)
        const node = nodes.get(id)
        if (
          node?.exists &&
          !node.resolved &&
          !builtTickets?.has(JSON.stringify([ticket.ref.source, id]))
        )
          next.push(...node.blockedBy)
      }
      frontier = [...new Set(next)].filter((id) => !visited.has(id))
    }
    return true
  }

  /** Bounce (§6.3): back to Triage with a comment citing the standard and
   * WHICH parts are missing — failure at the cheapest point, not a build
   * that thrashes and escalates. No build is created. */
  private async bounce(ticket: Ticket, missing: string[]): Promise<void> {
    const triageState = this.triageState()
    await this.deps.tickets.transition(ticket.ref.id, triageState)
    await this.deps.tickets.comment(
      ticket.ref.id,
      `Bounced back to ${triageState}: this ticket does not conform to ` +
        `the spec standard (.agents/skills/ab-guide/references/spec-standard.md) and cannot be dispatched.\n` +
        `Missing: ${missing.join('; ')}.`,
    )
  }

  /**
   * Ask for a spec-aware base behind a hard deadline. Every failure mode is
   * deliberately indistinguishable here: naming is optional judgment, while
   * successful dispatch is deterministic policy.
   */
  private async chooseSlugBase(title: string, spec: string): Promise<string> {
    const fallback = fallbackSlug(title)
    const nameSlug = this.deps.nameSlug
    if (nameSlug === undefined) return fallback

    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => {
          controller.abort()
          reject(new Error('build slug naming deadline exceeded'))
        },
        Math.max(0, this.slugNamingTimeoutMs),
      )
    })

    try {
      const candidate = await Promise.race([nameSlug(spec, controller.signal), deadline])
      return validateSlugCandidate(candidate) ?? fallback
    } catch {
      return fallback
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** Valid bounded base, deduped store-wide with -2/-3/… suffixes. */
  private async uniqueSlug(base: string): Promise<string> {
    let slug = base
    for (let n = 2; (await this.store.getBuild(slug)) !== null; n += 1) {
      slug = `${base}-${n}`
    }
    return slug
  }
}
