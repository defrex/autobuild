import { readBuildRange } from '../store/event-reads'
import { nodeActivityKey, nodePollingSchedule } from '../kernel/node-polling'
import { buildReadFactsReducer } from '../kernel/read-facts'
import { formatRuntimeIdentity } from '../events/runtime'
import { projectHandPushed, handPushedText, type HandPushedChange } from './dashboard/hand-pushed'
import { compatibilityDiagnostic } from '../kernel/mixed-version'
import { indexLog } from '../kernel/log-index'
import { projectTree, treeVocabulary, type TreeProjection } from './dashboard/tree'
import { holdReason, mergeVocabulary } from './dashboard/landing-display'
import { reopenedSummary, reopenedText, type ReopenedSummary } from './dashboard/reopen-display'
import { ciFailureText, currentCiFailure } from '../kernel/forge-checks'
import type { HeadCheck } from '../ports/types'
import { buildVocabulary } from './dashboard/model'
import {
  objectiveSegments,
  objectiveSummary,
  pendingCleanupText,
  unmeasuredMergeText,
  type ObjectiveSummary,
} from './dashboard/objective-row'
import { readBuildDigests } from '../store/reduced-reads'
import {
  optimizationPendingCleanups,
  optimizationUnmeasuredMerges,
  type PendingCleanupView,
  type UnmeasuredMergeView,
} from '../kernel/optimization'
import { readBuildFacts } from '../store/reduced-reads'
import {
  buildPriority,
  slotRequest,
  slotWaitText,
  type SlotRequest,
} from '../kernel/dispatch-capacity'
import { URGENT_MARK } from './dashboard/queue'
import {
  ticketWaitStatus,
  ticketWaitText,
  waitingOnText,
  type TicketWaitStatus,
} from '../kernel/ticket-wait'
import type { LeafRestackState } from '../kernel/leaf-restack-state'
import { landingRestackDue } from '../kernel/engine'
import type { BuildFacts } from '../processes/repo-view'
/**
 * `ab builds` and `ab build status <slug>` — the read-only query surface on
 * build state (SPEC §8.2, §15.5). Their invocation forms require no session,
 * while a complete ambient phase identity narrows Store authority; `ab build
 * status` additionally extends that identity to authorize reading the
 * session's OWN build from a differently located checkout (see the gate
 * comment on `abBuildStatus`).
 *
 * The shape is one decision: **the projection is pure, the IO is a thin
 * shell.** The functions below map build facts plus an optional build-config
 * decision to plain data (`BuildSummary`, `BuildDetail`), and the renderers map
 * that data to `string[]`. The command entry points only resolve a store, fetch
 * the build-owned config when needed, project, and print. So `--json` IS the
 * projection object and the human text is a second renderer over the same
 * value — there is no "compute for text" path that can disagree with the JSON.
 *
 * Effective status comes from `reduceBuild` — the authoritative event-derived
 * projection (§15.5, §3.4). This is NOT a second read model: it reduces the
 * log and reads the projection's fields, never re-deriving status from
 * records, worktrees, or OS processes.
 *
 * **Status, durable progress, and lease health are separate axes.**
 * `reduceBuild` reports both effective status and the latest durable event;
 * mutable `lease`/`heartbeatAt` columns report runner liveness (§15.2.6).
 * A runner can therefore stay live while its event log is silent. The shared
 * presentation helper exposes that divergence without folding it into status
 * or lease health.
 *
 * Output carries no ANSI, ever: §16 puts themes and colors out of scope, and
 * "understandable without relying solely on color" plus "--json without ANSI
 * formatting" are both satisfied by emitting none rather than by gating on a
 * TTY check.
 */
import { join } from 'node:path'
import type { AbEvent } from '../events/catalog'
import type { EventPayload } from '../events/payloads'
import { measurementText } from './measurement-text'
import type { Actor } from '../events/envelope'
import { loadConfig } from '../config/load'
import type { Config } from '../config/schema'
import {
  BUILD_EFFECTIVE_CONFIG_ARTIFACT,
  EffectivePipelineUnreadable,
  parseBuildConfigMetadata,
  parseEffectiveBuildConfig,
  readEffectivePipeline,
} from '../processes/build-execution-state'
import {
  landingDeferralReason,
  leafLandingCandidate,
  leafLandingUndecidedReason,
} from '../kernel/landing-readiness'
import { sameLandingCandidate } from '../kernel/landing-state'
import type { PipelineSourceMeta } from '../config/pipeline-source'
import { openExecution } from '../processes/execution-settlement'
import { currentLandingWaitReasonFrom } from '../kernel/auto-merge'
import { autoMergeDisplay, effectiveStatus, type AutoMergeDisplay } from './dashboard/model'
import { decideNextFromFacts } from '../kernel/engine'
import {
  reduceBuild,
  type BuildState,
  type OpenEscalation,
  type OpenSession,
  type PrLifecycle,
} from '../kernel/reducer'
import type {
  BuildOutcome,
  BuildStatus,
  ObservationKind,
  Phase,
  TicketRef,
  VerifyOutcome,
} from '../ontology'
import type { Exec } from '../ports/workspace/git-worktree'
import type { BuildRecord, BuildStore, StreamRecord, StreamScope } from '../store/types'
import { buildProgress, isDiverged, type BuildProgress } from './build-progress'
import { normalizeGitRemoteUrl } from '../kernel/origin'
import { buildInRepository, resolveMainRepo } from './repo-state'
import { writeAssetTo } from './ticket-assets'
import { describeIssueLinks } from '../kernel/issue-keywords'
import { withAmbientReadStore, type StoreOpener } from './store-opening'

/** Backward-compatible name for callers/tests; repository resolution is shared. */
export const currentRepo = resolveMainRepo

// ── The projection ───────────────────────────────────────────────────────────

/**
 * Runner liveness, from the mutable lease columns (§15.2.6) — NOT a status.
 * `none` is deliberately its own value rather than a weaker `expired`: a build
 * that has not yet claimed its first lease reads this way, and it is the
 * common case for a freshly launched runner.
 */
export type LeaseHealth = 'held' | 'expired' | 'none'

export interface LeaseInfo {
  health: LeaseHealth
  holder?: string
  expiresAt?: string
  heartbeatAt?: string
}

export type MeasurementSummary = Pick<
  EventPayload<'attempt.measured'>,
  'candidate' | 'baseline' | 'revision' | 'delta' | 'decision' | 'medians' | 'winRate' | 'spread'
>

export interface BuildSummary {
  compatibility?: BuildState['compatibility']
  compatibilityDiagnostic?: string
  kind?: 'integration' | 'work'
  optimization?: true
  /** An optimization node's current objective revision. */
  objectiveRevision?: number
  /** An optimization node's objective progress, with elapsed budget hours
   * evaluated at the summary's `now`. */
  objective?: ObjectiveSummary
  /** A child's recorded landing measurement for its latest request: a
   * command's medians or a judge panel's win rate. */
  measurement?: MeasurementSummary
  target?: string
  integration?: ReturnType<typeof buildVocabulary>['integration']
  integrationState?: BuildState['integration']
  handPushedCommits?: HandPushedChange[]
  nodeRestack?: BuildState['nodeRestack']
  slug: string
  ticket?: TicketRef
  /** The reducer's effective status (§15.5) — never mixed with lease health. */
  status: BuildStatus
  phase?: Phase
  runningVerifySteps?: string[]
  cancelledVerifySteps?: { step: string; cause: { step: string } }[]
  round?: number
  attempt?: number
  pr?: { number: number; url: string; state?: PrLifecycle }
  updatedAt: string
  lease: LeaseInfo
  /** Durable-event progress, separate from mutable lease renewal. */
  progress: BuildProgress
  /** A node's or parked build's runner request, admitted ahead of normal
   * ticket claims (urgent work first: SPEC §12 "Slot admission order"). */
  slotWait?: SlotRequest
  /** The build's slot-admission priority when urgent; omitted means normal. */
  priority?: 'urgent'
  /** The build's ticket wait while it is requested, open, or ended and not
   * yet resumed (SPEC §11 "Ticket waits"); omitted otherwise. */
  wait?: TicketWaitStatus
  /** Set when the open ticket wait's escalation is the only one open: the
   * dashboards' `waiting` status. `status` stays the reducer's `blocked`. */
  waitOnly?: true
  /** Why the operator held the merge, while a hold that gave one stands. */
  holdReason?: string
  /** An operator reopened this leaf and it has not settled again (§15.7). */
  reopened?: ReopenedSummary
  /** Failing forge CI recorded at the open PR's live head, while it still
   * describes the build's head (`currentCiFailure`). Absent CI is unknown or
   * passing, never claimed green. */
  ciFailure?: {
    head: string
    buildHead: string
    checks: HeadCheck[]
    total: number
    text: string
  }
}

export interface VerifyProgress {
  /** Full-log attempt high-water retained for status-output compatibility. */
  attempt: number
  /** Current cycle only — selected by sequence boundary, never attempt. */
  steps: { step: string; outcome: VerifyOutcome; reason?: string }[]
  currentStep?: string
  runningSteps?: string[]
  cancelled?: { step: string; cause: { step: string } }[]
}

export interface SetupFailureDetail {
  attempt: number
  command: string
  exitStatus: number | null
  output: string
}

export interface BuildObservation {
  id: string
  kind: ObservationKind
  summary: string
  files?: string[]
  refs?: string[]
}

export type BuildDecisionProjection =
  | {
      kind: 'awaiting-pr'
      reason?: string
      /** Set when status's own config read is the build's verify pin but the
       * dispatcher's first read, the latest effective config, does not parse
       * or cannot be read: the dispatcher then withholds every decision. */
      pipelineUnreadable?: string
    }
  | {
      kind: 'repository-completion'
      prState: Extract<PrLifecycle, 'merged' | 'closed'>
    }
  | { kind: 'parked'; reason: string }
  | { kind: 'runner-work' }
  | { kind: 'unavailable'; diagnostic: string }

export interface LeafRestackStatus {
  trigger: 'verify-entry' | 'awaiting-landing' | 'wait-resume'
  state: 'replaying' | 'conflicted' | 'completed' | 'advanced'
  onto: string
  /** Commands that resolved this replay's conflicts by regeneration, not an agent. */
  regenerated?: string[]
}

/** The open restack, else the newer of the last completed restack and the
 * last wait-resume fast-forward. Reduced state only. */
export function leafRestackStatus(restack: LeafRestackState): LeafRestackStatus | undefined {
  const { active, advanced, completed } = restack
  const regenerated = (fact: LeafRestackState['regeneration']) =>
    fact?.outcome === 'resolved' ? { regenerated: fact.commands.map((c) => c.command) } : {}
  if (active !== undefined) {
    const resolved = regenerated(restack.regeneration)
    return {
      trigger: active.trigger,
      state:
        restack.replay?.conflicted && resolved.regenerated === undefined
          ? 'conflicted'
          : 'replaying',
      onto: active.targetBase,
      ...resolved,
    }
  }
  if (advanced !== undefined && (restack.advancedAt ?? 0) > (restack.completedAt ?? 0))
    return { trigger: advanced.trigger, state: 'advanced', onto: advanced.to }
  if (completed !== undefined)
    return {
      trigger: completed.trigger,
      state: 'completed',
      onto: completed.targetBase,
      ...(restack.completedRegeneration?.id === completed.id
        ? regenerated(restack.completedRegeneration)
        : {}),
    }
  return undefined
}

export interface BuildDetail extends BuildSummary {
  /** An optimization node's attempts merged without a landing measurement,
   * each holding its slot until an operator settles it. Omitted when none. */
  unmeasuredMerges?: UnmeasuredMergeView[]
  /** An optimization node's settled attempts whose build branch awaits
   * deletion. Omitted when none. */
  pendingCleanups?: PendingCleanupView[]
  nodePolling?: {
    mode: 'active' | 'idle'
    intervalSeconds: number
    lastChecked?: string
  }
  runnerAttaches: import('../kernel/read-facts').RunnerAttach[]
  tree?: TreeProjection
  /** Immutable policy provenance and durable command/native application state. */
  landing?: BuildState['landing']
  /** Current work-owner decision. Open PRs use the build-owned config; ended
   * PRs project the repository completion path directly from durable state. */
  decision?: BuildDecisionProjection
  /** Why an open-PR leaf parked at awaiting-pr has no landing decision for its
   * current candidate. */
  landingUndecided?: string
  /** Why an open-PR node's current integration candidate has no landing
   * decision: a recorded deferral for unrecorded changed paths. */
  landingDeferred?: string
  /** The build's effective auto-merge display state (off, requested, enabled,
   * cancelling) — the same projection the dashboards render, so `--json` and
   * the text agree and `waiting: on PR` can say why it is waiting. */
  autoMerge: AutoMergeDisplay
  supersededEscalations?: BuildState['verifyStage']['superseded']
  openEscalations: OpenEscalation[]
  /** A work build's open or latest restack: why it ran (its trigger), the
   * target base it moves onto, and where it stands. */
  restack?: LeafRestackStatus
  /** The open `target.rewritten` wait. `adoptedBase` is set when the
   * rewritten-from commit is a base the build's first local provision adopted
   * from a pre-existing branch, a wait only abort clears (#1261). */
  targetRewrite?: {
    branch: string
    previousSha: string
    sha: string
    adoptedBase?: { branch: string; sha: string }
  }
  /** Per-loop review overrides for the current spec; omitted when none are set. */
  reviewRoundCeilings?: { plan?: number; code?: number }
  /** Frozen forge issue links with effective intent; omitted when none. */
  issueLinks?: BuildState['issueLinks']
  /** Present with `issueLinks`: whether finalize sealed them for the PR. */
  issueLinksSealed?: boolean
  /** The role profile frozen at claim; `configured: false` when the latest
   * session found it removed and used the repository roles. Omitted when none. */
  profile?: { name: string; configured: boolean }
  suspendedSessions: OpenSession[]
  sessionTotals: BuildState['sessions']['totals']
  openSessions: StatusOpenSession[]
  observations: BuildObservation[]
  /** Current setup failure only; a later successful attachment clears it. */
  setupFailure?: SetupFailureDetail
  /** True when the latest recorded execution has no following
   * `execution.ended` — the guest may still be running under durable
   * supervision even with no dispatcher process alive. */
  executionOpen?: boolean
  /** Latest provider execution and current lifecycle failure. Full history is
   * available with --events. */
  execution?: EventPayload<'execution.started'> & { seq: number }
  infrastructureFailure?: EventPayload<'infrastructure.failed'> & {
    seq: number
  }
  cleanupPending: boolean
  verify: VerifyProgress
  lastEvent?: { type: string; seq: number; ts: string; actor: Actor }
  /** Present only with `--events <n>`: the newest n, chronological. */
  events?: AbEvent[]
  /** Which `autobuild.toml` the build's pinned pipeline was read from, and the
   * effective-config artifact revision it was deposited under (SPEC §16.1).
   * Absent when no effective-config artifact has been deposited. */
  pipelineSource?: PipelineSourceMeta
  effectiveConfigRev?: number
  outcome?: BuildOutcome
}

/**
 * `none` when there is no lease; `expired` when it has run out; else `held`.
 *
 * The boundary matches `Dispatcher.leaseSweep` (src/processes/dispatcher.ts),
 * whose has-lease branch is `if (expiresAt > now) continue // healthy` — so
 * `expiresAt === now` is expired in both places and the sweep and this report
 * agree.
 *
 * That agreement is on the has-lease branch only. `leaseSweep` also grants an
 * ABSENT lease a first-claim grace window (`updatedAt` within `leaseTtlMs`)
 * before it acts, while this reports `none` regardless. The divergence is
 * intended: `none` is a distinct word from `expired`, and teaching this
 * function the grace window would put a dispatcher policy knob (`leaseTtlMs`)
 * into a read-only reporter. It is documented in the guide instead.
 */
export function leaseHealth(record: BuildRecord, now: Date): LeaseHealth {
  if (record.lease === undefined) return 'none'
  return new Date(record.lease.expiresAt).getTime() <= now.getTime() ? 'expired' : 'held'
}

function leaseInfo(record: BuildRecord, now: Date): LeaseInfo {
  return {
    health: leaseHealth(record, now),
    ...(record.lease !== undefined
      ? { holder: record.lease.holder, expiresAt: record.lease.expiresAt }
      : {}),
    ...(record.heartbeatAt !== undefined ? { heartbeatAt: record.heartbeatAt } : {}),
  }
}

/** The child's recorded landing measurement, from reduced state alone. */
function measurementSummary(state: BuildState): MeasurementSummary | undefined {
  const result = state.landingMeasurement?.result
  if (result === undefined) return undefined
  return {
    candidate: result.candidate,
    baseline: result.baseline,
    revision: result.revision,
    delta: result.delta,
    decision: result.decision,
    ...(result.medians !== undefined ? { medians: { ...result.medians } } : {}),
    ...(result.winRate !== undefined ? { winRate: result.winRate } : {}),
    ...(result.spread !== undefined ? { spread: result.spread } : {}),
  }
}

/**
 * The summary over an ALREADY-reduced state — so `detail` reduces the log
 * once and builds both projections from it, rather than reducing twice.
 */
export function summarizeFrom(
  record: BuildRecord,
  state: BuildState,
  now: Date,
  slotWait?: SlotRequest,
): BuildSummary {
  // `phase`, `round`, and `attempt` describe ONE phase occurrence, so they come
  // from ONE source: the in-flight phase, else the last completed one — the
  // same `currentPhase ?? lastCompletedPhase` the reducer uses to derive
  // `state.phase`. Reading `phase` from that pair while reading round/attempt
  // from `currentPhase` alone made the three disagree the moment a phase
  // completed: `verify.completed` clears `currentPhase`, so between two verify
  // steps a build on attempt 3 reported `verify:unit r1` — the attempt gone and
  // the loop round stamped onto a phase that carries none. That reads as "first
  // pass through verify" while verify is actually thrashing on its third.
  //
  // PhaseContext is authoritative about which axis a phase HAS (§15.3): loop
  // phases carry `round`, verify and reconcile carry `attempt`, finalize
  // carries neither. Taking both straight from it is what makes "current round
  // or attempt WHEN APPLICABLE" fall out, instead of being re-decided here.
  const active = state.currentPhase ?? state.lastCompletedPhase
  const round = active?.round
  const attempt = active?.attempt
  const wait = ticketWaitStatus(state)
  const objective = objectiveSummary(state, now)
  const measurement = measurementSummary(state)
  const heldBecause = holdReason(state.landing)
  const reopened = reopenedSummary(state)
  const ciFailure = currentCiFailure(state)
  return {
    slug: record.slug,
    ...buildVocabulary(state),
    ...(state.kind === 'node' && state.optimization !== undefined
      ? { objectiveRevision: state.optimization.revision }
      : {}),
    ...(objective !== undefined ? { objective } : {}),
    ...(measurement !== undefined ? { measurement } : {}),
    ...((state.verify.running?.length ?? 0) > 1
      ? { runningVerifySteps: state.verify.running }
      : {}),
    ...(Object.values(state.verifyStage.cancellations).some((c) => c.seq > state.verify.cycleSince)
      ? {
          cancelledVerifySteps: Object.values(state.verifyStage.cancellations)
            .filter((c) => c.seq > state.verify.cycleSince)
            .map((c) => ({ step: c.step, cause: c.cause })),
        }
      : {}),
    ...(state.kind === 'node' ? { integrationState: state.integration } : {}),
    ...(state.kind === 'node'
      ? {
          nodeRestack: state.nodeRestack,
          handPushedCommits: projectHandPushed(state.nodeRestack),
        }
      : {}),
    // record.ticket is a TicketRef already carrying id/title/url — no artifact
    // read and no ticket-provider call (live ticket state is out of scope).
    ...(record.ticket !== undefined ? { ticket: record.ticket } : {}),
    ...(state.compatibility.unknownFacts
      ? {
          compatibility: state.compatibility,
          compatibilityDiagnostic: compatibilityDiagnostic(state.compatibility),
        }
      : {}),
    status: state.status,
    ...(active?.phase !== undefined ? { phase: active.phase } : {}),
    ...(round !== undefined ? { round } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(state.pr !== undefined
      ? {
          pr: {
            number: state.pr.number,
            url: state.pr.url,
            ...(state.prState !== undefined ? { state: state.prState } : {}),
          },
        }
      : {}),
    updatedAt: record.updatedAt,
    lease: leaseInfo(record, now),
    progress: buildProgress(record, state),
    ...(slotWait ? { slotWait } : {}),
    ...(buildPriority(state) === 'urgent' ? { priority: 'urgent' as const } : {}),
    ...(wait !== undefined ? { wait } : {}),
    ...(effectiveStatus(state) === 'waiting' ? { waitOnly: true as const } : {}),
    ...(heldBecause !== undefined ? { holdReason: heldBecause } : {}),
    ...(reopened !== undefined ? { reopened } : {}),
    ...(ciFailure !== undefined
      ? {
          ciFailure: {
            head: ciFailure.head,
            buildHead: ciFailure.buildHead,
            checks: structuredClone(ciFailure.checks),
            total: ciFailure.total,
            text: ciFailureText(ciFailure),
          },
        }
      : {}),
  }
}

/**
 * One build's summary. `round`/`attempt` come from the in-flight phase when
 * there is one, so "current round or attempt when applicable" reflects what is
 * happening now rather than the last thing that finished.
 */
export function summarize(record: BuildRecord, events: AbEvent[], now: Date): BuildSummary {
  return summarizeFrom(record, reduceBuild(events), now)
}

/** Summary plus the detail fields; `eventCount` appends the newest n events. */
/** One open session enriched with its live-view stream status (SPEC §9). */
export interface StatusOpenSession extends OpenSession {
  /** Open until the stream closes; the store's records are authoritative. */
  streamStatus?: 'open' | 'closed'
}

export function detail(
  record: BuildRecord,
  events: AbEvent[],
  now: Date,
  eventCount?: number,
  decision?: BuildDecisionProjection,
  streams?: readonly StreamRecord[],
): BuildDetail {
  return detailFromFacts(
    record,
    {
      state: reduceBuild(events),
      runnerAttaches: buildReadFactsReducer.reduce(events).runnerAttaches,
      log: indexLog(events),
      observations: events
        .filter((event) => event.type === 'observation.recorded')
        .map((event) => event.payload),
      open: openExecution(events),
      firstWorkspace: events.find(
        (event): event is Extract<AbEvent, { type: 'workspace.provisioned' }> =>
          event.type === 'workspace.provisioned',
      ),
    },
    now,
    eventCount === undefined ? undefined : events.slice(-eventCount),
    decision,
    streams,
  )
}

/** A node's integration candidate whose decision is deferred, from reduced state. */
function nodeLandingDeferred(state: BuildState): { landingDeferred?: string } {
  const cycle = state.integration?.cycle
  if (state.kind !== 'node' || state.prState !== 'open' || !cycle) return {}
  const candidate = { head: cycle.head, parent: cycle.parent, cycle: cycle.id }
  if (sameLandingCandidate(candidate, state.landing?.decision?.candidate)) return {}
  const reason = landingDeferralReason(state, candidate)
  return reason === undefined ? {} : { landingDeferred: reason }
}

/** The open target rewrite, naming a base adopted from a pre-existing branch
 * at the build's first local provision. */
function targetRewriteDetail(
  state: BuildState,
  firstWorkspace: BuildFacts['firstWorkspace'],
): Pick<BuildDetail, 'targetRewrite'> {
  const rewrite = state.targetRewrite?.payload
  if (rewrite === undefined) return {}
  const first = firstWorkspace?.payload
  const adopted =
    state.kind !== 'node' &&
    first !== undefined &&
    first.base.source === 'existing' &&
    first.remote !== true &&
    first.base.sha === rewrite.previousSha
  return {
    targetRewrite: {
      branch: rewrite.branch,
      previousSha: rewrite.previousSha,
      sha: rewrite.sha,
      ...(adopted ? { adoptedBase: { branch: first.branch, sha: first.base.sha } } : {}),
    },
  }
}

/** An optimization node's slot-holding conditions, from its reduced digest. */
function optimizationDetail(
  state: BuildState,
): Pick<BuildDetail, 'unmeasuredMerges' | 'pendingCleanups'> {
  if (state.kind !== 'node' || state.optimization === undefined) return {}
  const unmeasuredMerges = optimizationUnmeasuredMerges(state.optimization)
  const pendingCleanups = optimizationPendingCleanups(state.optimization)
  return {
    ...(unmeasuredMerges.length > 0 ? { unmeasuredMerges } : {}),
    ...(pendingCleanups.length > 0 ? { pendingCleanups } : {}),
  }
}

export function detailFromFacts(
  record: BuildRecord,
  facts: Pick<BuildFacts, 'state' | 'open'> &
    Partial<Pick<BuildFacts, 'log' | 'runnerAttaches' | 'firstWorkspace'>> & {
      observations: BuildState['observations']
    },
  now: Date,
  events?: AbEvent[],
  decision?: BuildDecisionProjection,
  streams?: readonly StreamRecord[],
): BuildDetail {
  const state = facts.state
  const streamStatus = new Map<string, { stream?: string; status: 'open' | 'closed' }>()
  if (streams !== undefined) {
    for (const record of streams) {
      if (record.scope.kind !== 'build') continue
      streamStatus.set(record.label, {
        stream: record.id,
        status: record.status,
      })
    }
  }
  const summary = summarizeFrom(record, state, now)
  // §15.6-A: only the CURRENT cycle's results describe the current code.
  // Without this filter an earlier cycle's passes read as current — wrong, and
  // wrong in the reassuring direction.
  //
  // The cycle test is `seq > verify.cycleSince`, never result attempt equality:
  // `maxAttemptSeen` is the full-log high-water and still names the failed
  // cycle in the window before the next `verify.started`. `cycleSince` is the
  // authoritative boundary the reducer and engine.ts already agree on (max of
  // restart, code-review approve, and reconcile) — reading it here is what
  // keeps this command's report equal to the projection used elsewhere rather
  // than a second, drifting opinion.
  const steps = state.verify.results
    .filter((result) => result.seq > state.verify.cycleSince)
    .map((result) => ({
      step: result.step,
      outcome: result.outcome,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
    }))
  return {
    ...summary,
    runnerAttaches: facts.runnerAttaches ?? [],
    ...(facts.log ? { tree: projectTree(record, state, facts.log.restack) } : {}),
    autoMerge: autoMergeDisplay(state),
    ...(state.landing && Object.keys(state.landing).length ? { landing: state.landing } : {}),
    ...(decision !== undefined ? { decision } : {}),
    ...(decision?.kind === 'awaiting-pr' &&
    state.kind !== 'node' &&
    state.prState === 'open' &&
    facts.log &&
    !sameLandingCandidate(
      leafLandingCandidate(state, facts.log.restack),
      state.landing?.decision?.candidate,
    )
      ? {
          landingUndecided: leafLandingUndecidedReason(
            state,
            facts.log.restack,
            decision.pipelineUnreadable,
          ),
        }
      : {}),
    ...nodeLandingDeferred(state),
    ...optimizationDetail(state),
    ...(state.verifyStage.superseded.length
      ? { supersededEscalations: state.verifyStage.superseded }
      : {}),
    openEscalations: state.openEscalations,
    ...(state.kind !== 'node' && facts.log && leafRestackStatus(facts.log.restack)
      ? { restack: leafRestackStatus(facts.log.restack) }
      : {}),
    ...(state.issueLinks.length > 0
      ? {
          issueLinks: state.issueLinks,
          issueLinksSealed: state.issueLinksSealedSeq !== undefined,
        }
      : {}),
    ...(state.profile !== undefined ? { profile: { ...state.profile } } : {}),
    ...targetRewriteDetail(state, facts.firstWorkspace),
    ...(state.reviewRoundCeilings.plan !== undefined || state.reviewRoundCeilings.code !== undefined
      ? { reviewRoundCeilings: { ...state.reviewRoundCeilings } }
      : {}),
    suspendedSessions: state.sessions.suspended,
    sessionTotals: state.sessions.totals,
    openSessions: state.sessions.open.map((session) => {
      const record = streamStatus.get(`session:${session.session}`)
      return {
        ...session,
        ...(record?.stream !== undefined ? { stream: record.stream } : {}),
        ...(record !== undefined ? { streamStatus: record.status } : {}),
      }
    }),
    // Observations are historical facts rather than a derived current-state
    // opinion. Preserve event order and exact optional evidence fields.
    observations: facts.observations.map((observation) => ({
      id: observation.id,
      kind: observation.kind,
      summary: observation.summary,
      ...(observation.files !== undefined ? { files: observation.files } : {}),
      ...(observation.refs !== undefined ? { refs: observation.refs } : {}),
    })),
    ...(state.setupFailure !== undefined
      ? {
          setupFailure: {
            attempt: state.setupFailure.attempt,
            command: state.setupFailure.command,
            exitStatus: state.setupFailure.exitStatus,
            output: state.setupFailure.output,
          },
        }
      : {}),
    ...(state.executions.at(-1) !== undefined ? { execution: state.executions.at(-1)! } : {}),
    // Durable supervision: a recorded execution with no following end is the
    // source of truth for whether a guest may still be running.
    executionOpen: facts.open !== null,
    ...(state.infrastructureFailure !== undefined
      ? { infrastructureFailure: state.infrastructureFailure }
      : {}),
    cleanupPending:
      state.infrastructureFailure?.cleanupPending === true ||
      state.cleanupAttempts.at(-1)?.outcome === 'unknown',
    verify: {
      // Preserve the status API's display counter while sourcing it explicitly
      // from the reducer's full-log high-water, never from cycle membership.
      attempt: state.verify.maxAttemptSeen,
      steps,
      ...((state.verify.running?.length ?? 0) > 1 ? { runningSteps: state.verify.running } : {}),
      ...(Object.values(state.verifyStage.cancellations).some(
        (c) => c.seq > state.verify.cycleSince,
      )
        ? {
            cancelled: Object.values(state.verifyStage.cancellations)
              .filter((c) => c.seq > state.verify.cycleSince)
              .map((c) => ({ step: c.step, cause: c.cause })),
          }
        : {}),
      ...(state.verify.currentStep !== undefined ? { currentStep: state.verify.currentStep } : {}),
    },
    ...(state.lastEvent !== undefined
      ? {
          lastEvent: {
            type: state.lastEvent.type,
            seq: state.lastEvent.seq,
            ts: state.lastEvent.ts,
            actor: state.lastEvent.actor,
          },
        }
      : {}),
    // getEvents returns seq-ordered events, so the newest n slice out already
    // chronological — which is what the AC asks for.
    ...(events !== undefined ? { events } : {}),
    ...(state.outcome !== undefined ? { outcome: state.outcome } : {}),
  }
}

// ── Renderers ────────────────────────────────────────────────────────────────

/** Lease health as a literal word — never a color (§16: colors out of scope). */
function healthWord(health: LeaseHealth): string {
  return health === 'none' ? 'no-lease' : health
}

/** Preserve printable text while making terminal control bytes inert. Newlines
 * are split by the caller so multiline setup output remains readable. */
export function safeStatusText(value: string): string {
  let displayed = ''
  for (const char of value) {
    const code = char.codePointAt(0)!
    displayed += code >= 0x20 && code !== 0x7f ? char : `\\u{${code.toString(16)}}`
  }
  return displayed
}

/** `r<round>` / `a<attempt>` suffixed onto the phase — the loop vs verify axis. */
function phaseCell(summary: BuildSummary): string {
  if (summary.runningVerifySteps?.length)
    return `${summary.runningVerifySteps.map((step) => `verify:${step}`).join(', ')}${summary.attempt === undefined ? '' : ` a${summary.attempt}`}`
  if (summary.phase === undefined) return '—'
  if (summary.attempt !== undefined) return `${summary.phase} a${summary.attempt}`
  if (summary.round !== undefined) return `${summary.phase} r${summary.round}`
  return summary.phase
}

/** `#7 open https://…` — state AND link, per the summary's required fields. */
function prCell(summary: BuildSummary): string {
  if (summary.pr === undefined) return '—'
  const state = summary.pr.state !== undefined ? ` ${summary.pr.state}` : ''
  return `#${summary.pr.number}${state} ${summary.pr.url}`
}

/** Long enough to recognize the ticket, short enough to keep rows scannable. */
const TITLE_WIDTH = 40

/** `AUT-6 Interactive build dashboard…` — id AND title, per the same list. */
function ticketCell(summary: BuildSummary): string {
  const ticket = summary.ticket
  if (ticket === undefined) return '—'
  if (ticket.title === undefined || ticket.title === '') return ticket.id
  const title =
    ticket.title.length > TITLE_WIDTH ? `${ticket.title.slice(0, TITLE_WIDTH - 1)}…` : ticket.title
  return `${ticket.id} ${title}`
}

/** Coarse relative age — a status read wants "how stale", not a timestamp. */
export function relativeTime(iso: string, now: Date): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return iso
  const seconds = Math.round((now.getTime() - then) / 1000)
  if (seconds < 0) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/**
 * Delegated-write attribution (§15.1): a human actor carrying a via marker
 * renders as `human (via session os_…)` / `human (via mcp client)`; plain
 * actors render unchanged. The JSON output and the operator API's build
 * detail serialize the actor object verbatim, so the marker reaches those
 * surfaces without transformation.
 */
function viaMarker(actor: Actor): string {
  if (actor.kind !== 'human' || actor.via === undefined) return actor.kind
  return `human (via ${actor.via.kind === 'session' ? `session ${actor.via.id}` : `mcp ${actor.via.client}`})`
}

function padColumns(rows: string[][]): string[] {
  const widths: number[] = []
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length)
    })
  }
  return rows.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd(),
  )
}

/**
 * One aligned row per build. `emptyNote` names the filter in effect when there
 * is nothing to show, so an empty result is an honest answer rather than a
 * blank that reads like a bug.
 */
export function renderSummaries(summaries: BuildSummary[], now: Date, emptyNote: string): string[] {
  if (summaries.length === 0) return [emptyNote]
  // The two free-text columns (ticket title, PR link) go last, where their
  // width costs no alignment on the scannable columns to their left.
  const rows: string[][] = [
    ['BUILD', 'STATUS', 'PHASE', 'LEASE', 'HEARTBEAT', 'PROGRESS', 'TICKET', 'PR'],
  ]
  for (const summary of summaries) {
    const progressAge =
      summary.progress.lastEventAt === undefined
        ? '—'
        : relativeTime(summary.progress.lastEventAt, now)
    const ticketWait =
      summary.wait?.state === 'waiting' ? `, ${waitingOnText(summary.wait.tickets)}` : ''
    const slotWait = summary.slotWait
      ? `, ${slotWaitText(summary.slotWait, summary.priority ?? 'normal')}`
      : ''
    rows.push([
      summary.slug,
      `${summaryStatus(summary)}${summary.priority === 'urgent' ? ` ${URGENT_MARK}` : ''}`,
      summary.kind === 'integration'
        ? `${summary.optimization ? treeVocabulary.optimizationKind : treeVocabulary.integrationKind} ${summary.integration ?? ''}${slotWait}`
        : `${phaseCell(summary)}${slotWait}${ticketWait}`,
      healthWord(summary.lease.health),
      summary.progress.heartbeatAt === undefined
        ? '—'
        : relativeTime(summary.progress.heartbeatAt, now),
      `${progressAge}${isDiverged(summary.progress, now) ? ' diverged' : ''}`,
      `${ticketCell(summary)}${summary.target ? ` target ${summary.target}` : ''}`,
      prCell(summary),
    ])
  }
  // Objective progress, hold reasons, reopen details and failing forge CI
  // ride on continuation lines without affecting the table's column alignment.
  return padColumns(rows).flatMap((line, index) => {
    const summary = index === 0 ? undefined : summaries[index - 1]!
    const objective = summary?.objective
    const held = summary?.holdReason
    const reopened = summary?.reopened
    return [
      line,
      ...(objective === undefined
        ? []
        : [`    ${objectiveSegments(objective, objective.elapsedHours).join(' · ')}`]),
      ...(held === undefined
        ? []
        : [`    ${mergeVocabulary.label} ${safeStatusText(mergeVocabulary.held(held))}`]),
      ...(reopened === undefined ? [] : [`    ${safeStatusText(reopenedText(reopened))}`]),
      ...(summary?.ciFailure === undefined
        ? []
        : [`    ! ${safeStatusText(summary.ciFailure.text)}`]),
    ]
  })
}

/** The status word text renderers print: `waiting` for a build whose only
 * open escalation is its ticket wait, else the reducer status. */
function summaryStatus(summary: BuildSummary): string {
  return summary.waitOnly ? 'waiting' : summary.status
}

/** Labeled sections, each omitted when absent ("when each is available"). */
export function renderDetail(d: BuildDetail, now: Date): string[] {
  const lines: string[] = [`build ${d.slug}`]
  if (d.nodePolling)
    lines.push(
      `  node polling: ${d.nodePolling.mode === 'idle' ? `idle; polled every ${d.nodePolling.intervalSeconds} seconds` : 'active; polled every tick'}; last checked: ${d.nodePolling.lastChecked ?? 'unrecorded'}`,
    )
  for (const attach of d.runnerAttaches)
    lines.push(
      `  runner attach #${attach.seq}: ${attach.instance}; host ${attach.host}; ${attach.ts}; ${formatRuntimeIdentity(attach.runtime)}`,
    )
  if (d.compatibility)
    lines.push(
      `  newer facts: ${d.compatibility.unknownFacts} (${d.compatibility.decisiveFacts} decisive)`,
    )
  if (d.compatibilityDiagnostic) lines.push(`  ${safeStatusText(d.compatibilityDiagnostic)}`)
  if (d.ticket !== undefined) {
    const title = d.ticket.title !== undefined ? ` — ${d.ticket.title}` : ''
    lines.push(`  ticket:   ${d.ticket.id}${title}`)
    if (d.ticket.url !== undefined) lines.push(`  ticket url: ${d.ticket.url}`)
  }
  if (d.issueLinks !== undefined) {
    const sealed = d.issueLinksSealed === true ? ' (sealed)' : ''
    lines.push(`  issues:   ${safeStatusText(describeIssueLinks(d.issueLinks))}${sealed}`)
  }
  if (d.profile !== undefined)
    lines.push(
      `  profile:  ${safeStatusText(d.profile.name)}${d.profile.configured ? '' : " (no longer configured — sessions use the repository's roles)"}`,
    )
  if (d.target)
    lines.push(
      `  ${d.kind ?? 'work'} · target ${d.target}${d.integration ? ` · ${d.integration}` : ''}`,
    )
  if (d.integrationState) {
    const integration = d.integrationState
    lines.push(`  open children: ${integration.observation?.openChildren.join(', ') || 'none'}`)
    if (integration.observation?.diagnostics.length)
      lines.push(`  completeness unavailable: ${integration.observation.diagnostics.join('; ')}`)
    if (integration.cycle)
      lines.push(
        `  verification head: ${integration.cycle.head} · parent ${integration.cycle.parent}`,
      )
    if (d.integration === 'verification failed')
      lines.push('  repair: file a child ticket targeting this node')
  }
  if (d.kind === 'integration')
    lines.push(`  hand-pushed changes (node-owned): ${handPushedText(d.handPushedCommits)}`)
  if (d.optimization) {
    lines.push(`  ${treeVocabulary.optimizationKind}: objective revision ${d.objectiveRevision}`)
    if (d.objective !== undefined)
      for (const segment of objectiveSegments(d.objective, d.objective.elapsedHours))
        lines.push(`    ${segment}`)
    for (const merge of d.unmeasuredMerges ?? []) lines.push(`    ${unmeasuredMergeText(merge)}`)
    for (const cleanup of d.pendingCleanups ?? []) lines.push(`    ${pendingCleanupText(cleanup)}`)
  }
  if (d.measurement !== undefined)
    lines.push(
      `  measurement: ${measurementText(d.measurement)} (candidate ${d.measurement.candidate.slice(0, 7)} on ${d.measurement.baseline.slice(0, 7)})`,
    )
  if (d.nodeRestack) {
    const node = d.nodeRestack
    const move = node.parentRequest ?? node.parentChange
    if (move)
      lines.push(
        `  reparenting: ${move.old.target?.ticket.id ?? move.old.branch} → ${move.next.target?.ticket.id ?? move.next.branch}`,
      )
    if (node.parentRejection) lines.push(`  target change refused: ${node.parentRejection.reason}`)
    if (node.inventory) {
      lines.push(`  node head: ${node.inventory.head}`)
      lines.push(`  build changes: ${node.inventory.builds.join(', ') || 'none'}`)
    }
    if (!node.active && node.observedParent && node.observedParent.sha !== node.contributionBase)
      lines.push(`  node restack pending: parent ${node.observedParent.sha}`)
    if (node.active) {
      lines.push(
        `  node ${node.active.operation}: ${node.active.id} · ${node.items.length}/${node.active.changes.length} changes · parent ${node.active.parent}${node.regenerated?.length ? ` · ${node.regenerated.length} regenerated` : ''}`,
      )
      if (node.conflict) {
        const change = node.active.changes[node.conflict.index]!
        lines.push(
          `  conflict item ${node.conflict.index + 1}: ${change.sha} · ${change.build ?? 'foreign'}${node.regeneration?.outcome === 'failed' ? ' · regeneration failed' : ''}`,
        )
      }
      for (const proof of node.active.merges)
        if (proof.missing.length || proof.build)
          lines.push(`  unsafe merge ${proof.sha}: ${proof.missing.join(', ') || proof.build}`)
    }
  }
  lines.push(`  status:   ${summaryStatus(d)}${d.outcome !== undefined ? ` (${d.outcome})` : ''}`)
  lines.push(`  phase:    ${phaseCell(d)}`)
  if (d.reopened !== undefined)
    lines.push(
      `  reopened: ${safeStatusText(reopenedText(d.reopened).replace(/^reopened /, ''))} (${d.reopened.at})`,
    )
  if (d.priority === 'urgent') lines.push('  priority: urgent')
  if (d.reviewRoundCeilings !== undefined) {
    const ceilings = [
      ...(d.reviewRoundCeilings.plan !== undefined ? [`plan ${d.reviewRoundCeilings.plan}`] : []),
      ...(d.reviewRoundCeilings.code !== undefined ? [`code ${d.reviewRoundCeilings.code}`] : []),
    ]
    lines.push(`  review round ceiling: ${ceilings.join(', ')}`)
  }
  lines.push(`  updated:  ${d.updatedAt} (${relativeTime(d.updatedAt, now)})`)
  if (d.pipelineSource !== undefined || d.effectiveConfigRev !== undefined) {
    const source =
      d.pipelineSource !== undefined
        ? `autobuild.toml@${
            d.pipelineSource.commit !== undefined ? d.pipelineSource.commit.slice(0, 7) : 'unknown'
          } (${d.pipelineSource.ref})`
        : 'autobuild.toml@unknown (pre-pin)'
    const rev = d.effectiveConfigRev !== undefined ? `  config rev ${d.effectiveConfigRev}` : ''
    lines.push(`  pipeline: ${source}${rev}`)
  }

  // Its own line, never folded into status: a running build with an expired
  // lease is the case this exists to make visible.
  const lease = [`  lease:    ${healthWord(d.lease.health)}`]
  if (d.lease.holder !== undefined) lease.push(`holder ${d.lease.holder}`)
  if (d.lease.expiresAt !== undefined) lease.push(`expires ${d.lease.expiresAt}`)
  lines.push(lease.join('  '))
  lines.push(
    d.progress.heartbeatAt === undefined
      ? '  heartbeat: —'
      : `  heartbeat: ${d.progress.heartbeatAt} (${relativeTime(d.progress.heartbeatAt, now)})`,
  )
  lines.push(
    d.progress.lastEventAt === undefined
      ? '  progress:  —'
      : `  progress:  ${d.progress.lastEventAt} (${relativeTime(d.progress.lastEventAt, now)})${
          isDiverged(d.progress, now) ? ' — diverged' : ''
        }`,
  )
  if (d.status === 'running' && d.lease.health === 'expired') {
    if (d.decision?.kind === 'awaiting-pr') {
      lines.push(
        '  note:     running with an expired lease — parked waiting on the PR; no runner re-attachment is pending',
      )
    } else if (d.decision?.kind === 'repository-completion') {
      lines.push(
        `  note:     running with an expired lease — the PR is ${d.decision.prState}; repository-level completion is pending and no runner re-attachment is pending`,
      )
    } else if (d.decision?.kind === 'parked') {
      lines.push(
        '  note:     running with an expired lease — the current decision is parked; no runner re-attachment is pending',
      )
    } else if (d.decision?.kind === 'unavailable') {
      lines.push(
        '  note:     running with an expired lease — runner actionability could not be determined from the unavailable build config',
      )
    } else if (d.executionOpen === true) {
      lines.push(
        '  note:     running with an expired lease — the recorded execution is still the\n' +
          '            source of truth: the guest may keep running and the lease sweep\n' +
          '            re-attaches only when the guest is actually gone',
      )
    } else {
      lines.push(
        '  note:     running with an expired lease — the runner is gone; the lease sweep will re-attach it',
      )
    }
  }

  if (d.pr !== undefined) {
    lines.push(
      `  pr:       #${d.pr.number}${d.pr.state !== undefined ? ` (${d.pr.state})` : ''} ${d.pr.url}`,
    )
  }
  if (d.tree !== undefined && (d.landing?.command || d.landing?.decision)) {
    const command = d.landing.command
    const consent =
      command?.kind === 'hold'
        ? safeStatusText(mergeVocabulary.held(d.tree.holdReason ?? undefined))
        : command?.kind === 'land'
          ? d.tree.consentedHead
            ? `consented at ${d.tree.consentedHead}`
            : 'consented (head not recorded)'
          : 'no consent recorded'
    lines.push(`  merge:    ${consent} · current head ${d.tree.currentHead ?? 'unknown'}`)
  }
  if (d.ciFailure !== undefined) {
    lines.push(`  forge CI: ${safeStatusText(d.ciFailure.text)}`)
    for (const check of d.ciFailure.checks)
      if (check.url !== undefined)
        lines.push(`    ${safeStatusText(check.name)}: ${safeStatusText(check.url)}`)
  }
  if (d.wait !== undefined)
    lines.push(
      d.wait.state === 'waiting'
        ? `  waiting on: ${safeStatusText(ticketWaitText(d.wait, d.slug))}`
        : `  waiting:  ${safeStatusText(ticketWaitText(d.wait, d.slug))}`,
    )
  if (d.targetRewrite !== undefined) {
    const rewrite = d.targetRewrite
    const target = safeStatusText(rewrite.branch)
    const previous = rewrite.previousSha.slice(0, 7)
    const current = rewrite.sha.slice(0, 7)
    lines.push(
      rewrite.adoptedBase !== undefined
        ? `  waiting:  target-rewritten — base ${previous} was adopted from pre-existing branch ${safeStatusText(rewrite.adoptedBase.branch)} at first provision, not cut from ${target}; ${target} at ${current} does not descend from it and the build cannot be restacked. Abort it; a re-dispatched build cuts a fresh branch.`
        : `  waiting:  target ${target} rewritten ${previous} → ${current}; automatic adoption withheld until the target returns or the build is aborted`,
    )
  }
  if (d.restack !== undefined)
    lines.push(
      `  restack:  ${d.restack.trigger} onto ${d.restack.onto.slice(0, 7)} — ${d.restack.state}${d.restack.regenerated ? ` (regenerated: ${d.restack.regenerated.join(', ')})` : ''}`,
    )
  if (d.decision?.kind === 'awaiting-pr') {
    // The deferral reason (a durable observation about WHY consent could not
    // be applied) takes precedence; otherwise the auto-merge state itself is
    // what the parked operator needs — off names the missing consent.
    const consent = d.decision.reason ?? `auto merge ${d.autoMerge}`
    lines.push(`  waiting:  on PR — ${consent}`)
    if (d.landingUndecided !== undefined)
      lines.push(`  landing:  undecided — ${d.landingUndecided}`)
  } else if (d.decision?.kind === 'repository-completion') {
    lines.push(
      `  waiting:  repository-level completion after the PR was ${d.decision.prState}; no runner re-attachment is pending`,
    )
  } else if (d.decision?.kind === 'unavailable') {
    lines.push(`  decision: unavailable — ${d.decision.diagnostic}`)
  }
  if (d.landingDeferred !== undefined) lines.push(`  landing:  undecided — ${d.landingDeferred}`)

  if (d.execution !== undefined) {
    lines.push(
      `  execution: ${safeStatusText(d.execution.provider)} workspace=${safeStatusText(d.execution.workspaceRef)} instance=${safeStatusText(d.execution.instance)}`,
    )
    if (d.execution.environmentId !== undefined)
      lines.push(`    environment: ${safeStatusText(d.execution.environmentId)}`)
    if (d.execution.sessionId !== undefined)
      lines.push(`    session: ${safeStatusText(d.execution.sessionId)}`)
  }
  if (d.infrastructureFailure !== undefined) {
    lines.push(
      `  infrastructure failure: ${d.infrastructureFailure.operation} attempt ${d.infrastructureFailure.attempt} (${d.infrastructureFailure.cause})`,
    )
    lines.push(`    error: ${safeStatusText(d.infrastructureFailure.error)}`)
    if (d.cleanupPending) lines.push('    cleanup: pending provider reconciliation')
  }

  if (d.setupFailure !== undefined) {
    const status =
      d.setupFailure.exitStatus === null
        ? 'exit status unavailable'
        : `exit status ${d.setupFailure.exitStatus}`
    lines.push(`  setup failure: attempt ${d.setupFailure.attempt}`)
    lines.push(`    command: ${safeStatusText(d.setupFailure.command)}`)
    lines.push(`    status:  ${status}`)
    lines.push('    output:')
    const output = d.setupFailure.output || '(no output)'
    for (const line of output.split('\n')) lines.push(`      ${safeStatusText(line)}`)
  }

  if (d.openEscalations.length > 0) {
    lines.push(`  escalations (${d.openEscalations.length} unresolved):`)
    for (const escalation of d.openEscalations) {
      lines.push(`    [${escalation.id}] ${escalation.phase}: ${escalation.question}`)
    }
  }

  if (d.suspendedSessions.length > 0) {
    lines.push(`  suspended sessions (${d.suspendedSessions.length}):`)
    for (const session of d.suspendedSessions)
      lines.push(`    ${session.session} — suspended (shutdown) on ${session.phase}`)
  }
  if (d.openSessions.length > 0) {
    lines.push(`  open sessions (${d.openSessions.length}):`)
    for (const session of d.openSessions) {
      const stream =
        session.stream !== undefined
          ? ` — stream ${session.stream} (${session.streamStatus ?? 'open'})`
          : ''
      lines.push(
        `    ${session.session} — ${session.role} on ${session.phase} (runner ${session.runner})${session.resumed ? ' — resumed' : ''}${stream}`,
      )
      if (session.prompt !== undefined)
        lines.push(`      prompt:  ${safeStatusText(session.prompt)}`)
    }
  }

  if (d.observations.length > 0) {
    lines.push(`  observations (${d.observations.length}):`)
    for (const observation of d.observations) {
      lines.push(`    [${observation.id}] ${observation.kind}: ${observation.summary}`)
      if (observation.files !== undefined) {
        lines.push(`      files: ${observation.files.join(', ')}`)
      }
      if (observation.refs !== undefined) {
        lines.push(`      refs: ${observation.refs.join(', ')}`)
      }
    }
  }

  if (d.verify.attempt > 0) {
    lines.push(`  verify:   attempt ${d.verify.attempt}`)
    for (const step of d.verify.steps) {
      if (step.outcome === 'skipped') {
        lines.push(`    SKIP  ${step.step} — ${step.reason ?? '(reason unavailable)'}`)
      } else {
        lines.push(`    ${step.outcome === 'pass' ? 'pass' : 'FAIL'}  ${step.step}`)
      }
    }
    for (const step of d.verify.runningSteps ??
      (d.verify.currentStep ? [d.verify.currentStep] : []))
      lines.push(`    running  ${step}`)
    for (const cancelled of d.verify.cancelled ?? [])
      lines.push(`    not run  ${cancelled.step}: cancelled by ${cancelled.cause.step}`)
  }

  if (d.lastEvent !== undefined) {
    lines.push(
      `  last event: ${d.lastEvent.type} (seq ${d.lastEvent.seq}) ${d.lastEvent.ts} by ${viaMarker(d.lastEvent.actor)}`,
    )
  }

  if (d.events !== undefined) {
    lines.push(`  events (newest ${d.events.length}, chronological):`)
    const rows = d.events.map((event) => [
      `    ${event.seq}`,
      event.ts,
      event.type,
      viaMarker(event.actor),
    ])
    for (const line of padColumns(rows)) lines.push(line)
  }

  return lines
}

// ── The command shells ───────────────────────────────────────────────────────

export interface StatusOpts {
  /** The cwd — resolved to the main repo root before matching (see currentRepo). */
  targetRepo: string
  /** Process environment: AB_STORE / AB_TOKEN (D8). */
  env: Record<string, string | undefined>
  exec: Exec
  stdout: (line: string) => void
  json?: boolean
  /** `--store <ref>`; same reference behavior dispatch has (§7.2). */
  storeRef?: string
  /** Injectable store seam — mirrors dispatch.ts's `wire`, keeps tests off the
   * real filesystem. */
  openStore?: StoreOpener
  /** Injectable clock; defaults to the wall clock. */
  now?: () => Date
}

/** Statuses a bare `ab builds` shows: the ones an operator can still act on. */
const ACTIVE_STATUSES: BuildStatus[] = ['running', 'collecting', 'paused', 'blocked']

export function statusFilter(all?: boolean, queued?: boolean): BuildStatus[] {
  if (all === true)
    return ['queued', 'running', 'collecting', 'paused', 'blocked', 'done', 'aborted']
  return queued === true ? [...ACTIVE_STATUSES, 'queued'] : ACTIVE_STATUSES
}

export interface AbBuildsOpts extends StatusOpts {
  queued?: boolean
  all?: boolean
}

/** `ab builds` — this repo's builds, active by default. Read-only. */
export async function abBuilds(opts: AbBuildsOpts): Promise<void> {
  const now = (opts.now ?? (() => new Date()))()
  await withAmbientReadStore(opts, async ({ store, repo }) => {
    // Repository identity is the checkout's normalized origin. Old records
    // are keyed by checkout path and are not migrated; they stay visible
    // from any checkout whose origin matches the recorded `repoOrigin`
    // (read compatibility, not migration). Foreign-origin records are hidden.
    const identity = normalizeGitRemoteUrl(repo)
    const mine = (record: BuildRecord): boolean =>
      record.repo === identity ||
      (record.repoOrigin !== undefined && normalizeGitRemoteUrl(record.repoOrigin) === identity)
    const wanted = new Set(statusFilter(opts.all, opts.queued))
    // Cross-repo aggregation is out of scope (§12: one dispatcher per repo,
    // one repo's builds per answer).
    // Records are read and held before the digest read: builds are never
    // deleted, so every identity-keyed record iterated below is guaranteed an
    // entry in the digest map fetched after it — a build created between the
    // two reads appears only in the digest map, which is harmless — and the
    // completeness check can only ever catch a genuine adapter bug, never a
    // concurrent dispatch (AUT-488 finding f_3cb67aba).
    const records = (await store.listBuilds()).filter(mine)
    // One digest read gates the per-build history reads (AUT-488): the active
    // and queued scopes never show a terminal build, so an identity-keyed
    // build whose digest already carries a terminal fact skips its `getEvents`
    // round trip and the listing's store cost stays flat as finished builds
    // accumulate. The `--all` scope includes terminal statuses, so it takes no
    // digest read and skips nothing — byte-for-byte the old loop.
    const digests = opts.all === true ? undefined : await readBuildDigests(store, identity)
    const summaries: BuildSummary[] = []
    for (const record of records) {
      if (digests !== undefined && record.repo === identity) {
        // Completeness is contractual (one entry per repo build); a missing
        // entry is an adapter bug and must fail loudly rather than silently
        // drop the build from the listing.
        const digest = digests.get(record.slug)
        if (digest === undefined) {
          throw new Error(`getRepoBuildDigests is missing an entry for build "${record.slug}"`)
        }
        // The digest's `terminal` follows `reduceBuild`'s terminal rule
        // exactly (in-order overwrite of `build.completed`/`build.aborted`,
        // never cleared — pinned against `reduceBuild` in
        // store/digest.test.ts), so `terminal !== undefined` is exactly
        // reduced status `done`/`aborted`, which the active and queued status
        // sets never include. Skipping the history read therefore cannot
        // change the emitted summaries.
        if (digest.terminal !== undefined) continue
      }
      // A record matched only through the legacy `repoOrigin` path has no
      // entry under `identity` — `getRepoBuildDigests` groups by `record.repo`
      // exactly — so it keeps its per-build history read (correct, just not
      // accelerated).
      const facts = (await readBuildFacts(store, record.slug)).value
      const summary = summarizeFrom(
        record,
        facts.state,
        now,
        slotRequest(
          {
            record,
            state: facts.state,
            workspace: facts.workspace !== null,
            provisioning: facts.provisionMarker !== undefined,
            restackDue: landingRestackDue(facts.state, facts.log),
          },
          now,
        ),
      )
      if (wanted.has(summary.status)) summaries.push(summary)
    }
    summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

    if (opts.json === true) {
      opts.stdout(JSON.stringify(summaries, null, 2))
      return
    }
    // The empty line names the filter that matched nothing and suggests only
    // the flags that would actually widen it — telling a caller who passed
    // --queued to "try --queued" reads as a broken command.
    const scope =
      opts.all === true
        ? 'builds'
        : opts.queued === true
          ? 'active or queued builds'
          : 'active builds'
    const hint =
      opts.all === true ? '' : opts.queued === true ? ' — try --all' : ' — try --queued or --all'
    for (const line of renderSummaries(summaries, now, `no ${scope} for ${repo}${hint}`)) {
      opts.stdout(line)
    }
  })
}

export interface AbBuildStatusOpts extends StatusOpts {
  slug: string
  events?: number
}

function _openWorkspacePath(events: AbEvent[]): string | undefined {
  let path: string | undefined
  for (const event of events) {
    if (event.type === 'workspace.provisioned') {
      path = event.payload.path ?? event.payload.ref
    } else if (event.type === 'workspace.released') {
      path = undefined
    }
  }
  return path
}

/** The kernel tail both config sources share, so the deposited artifact and
 * the workspace file cannot drift in what they compute — the sources differ
 * only in where the config comes from, never in what is decided with it. */
function decideFromConfig(facts: BuildFacts, config: Config): BuildDecisionProjection {
  const decision = decideNextFromFacts(facts.state, facts.log, config)
  if (decision.kind !== 'wait') return { kind: 'runner-work' }
  if (decision.reason !== 'awaiting-pr') return { kind: 'parked', reason: decision.reason }
  const reason = currentLandingWaitReasonFrom(facts.deferral, facts.state)
  return { kind: 'awaiting-pr', ...(reason !== undefined ? { reason } : {}) }
}

/** Why the dispatcher's read of the latest effective config fails, or
 * undefined when it succeeds or none is deposited. */
async function latestPipelineUnreadable(
  store: Pick<BuildStore, 'getArtifact'>,
  slug: string,
): Promise<string | undefined> {
  try {
    await readEffectivePipeline(store, slug)
    return undefined
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return error instanceof EffectivePipelineUnreadable
      ? `${BUILD_EFFECTIVE_CONFIG_ARTIFACT}@${error.revision}: ${message}`
      : `${BUILD_EFFECTIVE_CONFIG_ARTIFACT}: ${message}`
  }
}

/** Load the build-owned configuration for the current work-owner decision.
 *
 * Source order: the store's deposited `build-runner-effective-config` artifact
 * first — the exact config the dispatcher froze at the last runner launch and
 * the one the build child actually runs on — then the local workspace's
 * `autobuild.toml` when no deposit exists (older records predate per-launch
 * deposits). For a remote build the recorded workspace path is a guest path
 * that does not exist on the operator's machine; the deposit is what makes the
 * decision available there. The decision is reported unavailable only when
 * neither source can supply a configuration, and the diagnostic then names the
 * missing source rather than a filesystem path: paths embed guest locations
 * the operator cannot access. An unavailable decision is a reportable
 * degradation, never a reason to guess from the current main branch or to make
 * the read-only command fail. */
export async function projectBuildDecision(
  slug: string,
  facts: BuildFacts,
  store: Pick<BuildStore, 'getArtifact'>,
): Promise<BuildDecisionProjection | undefined> {
  const state = facts.state
  const active =
    state.status === 'running' || state.status === 'paused' || state.status === 'blocked'
  if (!active) return undefined
  if (state.prState === 'merged' || state.prState === 'closed') {
    return { kind: 'repository-completion', prState: state.prState }
  }
  if (state.prState !== 'open') return undefined

  // Source 1 — the store deposit. A deposit that fails to parse is itself
  // reportable state: it is surfaced as unavailable naming the artifact rather
  // than silently falling back to a possibly stale workspace file.
  const artifact = await store.getArtifact(
    slug,
    state.verify.configPin?.artifact.kind ?? BUILD_EFFECTIVE_CONFIG_ARTIFACT,
    state.verify.configPin?.artifact.rev,
  )
  if (artifact !== null) {
    let decision: BuildDecisionProjection
    try {
      decision = decideFromConfig(facts, parseEffectiveBuildConfig(artifact))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        kind: 'unavailable',
        diagnostic: `the deposited ${BUILD_EFFECTIVE_CONFIG_ARTIFACT} artifact could not be read: ${message}`,
      }
    }
    // With a verify pin, the artifact read above is not the dispatcher's first
    // read: it decides only after the latest effective config parses.
    if (decision.kind === 'awaiting-pr' && state.kind !== 'node' && state.verify.configPin) {
      const pipelineUnreadable = await latestPipelineUnreadable(store, slug)
      if (pipelineUnreadable !== undefined) return { ...decision, pipelineUnreadable }
    }
    return decision
  }

  // Source 2 — the local workspace, exactly as before, only when no artifact
  // is deposited.
  const workspace = facts.workspace?.path ?? facts.workspace?.ref
  if (workspace === undefined) {
    return {
      kind: 'unavailable',
      diagnostic: `no ${BUILD_EFFECTIVE_CONFIG_ARTIFACT} artifact is deposited and no unreleased build workspace is recorded, so the build config cannot be read`,
    }
  }

  try {
    return decideFromConfig(facts, await loadConfig(join(workspace, 'autobuild.toml')))
  } catch {
    // The raw error deliberately stays here: ENOENT/ENOTDIR messages embed the
    // recorded workspace path, which for a remote build is a guest location.
    return {
      kind: 'unavailable',
      diagnostic: `no ${BUILD_EFFECTIVE_CONFIG_ARTIFACT} artifact is deposited and the build config in the recorded workspace could not be read`,
    }
  }
}

type AmbientReadContext = Parameters<Parameters<typeof withAmbientReadStore>[1]>[0]

/** The build record, after the repository gate every single-build read shares
 * (see `abBuildStatus`). */
async function requireReadableBuild(
  opts: AbBuildStatusOpts,
  context: AmbientReadContext,
): Promise<BuildRecord> {
  const record = await context.store.getBuild(opts.slug)
  if (record === null) {
    throw new Error(
      `no build "${opts.slug}" in this store — run 'ab builds --all' to list ` +
        "this repo's builds, or pass --store <ref> if it lives in another store",
    )
  }
  // Own-session authority: slug equality bounds the read to the session's
  // own build, and an explicit --store must name the session's own store for
  // the bypass to apply. Every other combination falls through to the
  // ordinary repository gate, unchanged — which now keys on the checkout's
  // normalized origin identity (`context.checkout` is the physical path;
  // `buildInRepository` derives the identity from it).
  const ownSession =
    context.ambient !== undefined &&
    'build' in context.ambient &&
    context.ambient.build === opts.slug &&
    (opts.storeRef === undefined || opts.storeRef === context.ambient.store)
  if (!(ownSession || (await buildInRepository(record, context.checkout, opts.exec)))) {
    throw new Error(
      `build "${opts.slug}" belongs to repository "${record.repo}", not "${context.repo}"`,
    )
  }
  return record
}

/** `ab build status <slug>` — one build in detail. Read-only.
 *
 * Repository authority mirrors the other ambient reads: an operator invocation
 * (no ambient identity) must match the store-recorded repository by path, or
 * by normalized origin for a differently located checkout of the same
 * repository. A validated ambient *build* session additionally authorizes
 * reading its OWN build — `AB_BUILD` equal to the requested slug, from the
 * session's own store — the same trust basis as the phase-scoped
 * `ab artifact get` (AUT-312): the runner-injected tuple validated by
 * `resolveCliEnv` is the authority, so a guest checkout of the same
 * repository at a different path can read its build's status projection even
 * when the record predates origin recording. The bypass is bounded by slug
 * equality and store-ref equality, never a general relaxation; a sessionless
 * relocated-checkout read of a record without `repoOrigin` remains foreign by
 * design (the documented AUT-314 limitation).
 */
export async function abBuildStatus(opts: AbBuildStatusOpts): Promise<void> {
  const now = (opts.now ?? (() => new Date()))()
  await withAmbientReadStore(opts, async (context) => {
    const record = await requireReadableBuild(opts, context)
    const current = await readBuildFacts(context.store, opts.slug)
    const facts = current.value
    const events =
      opts.events === undefined
        ? undefined
        : await readBuildRange(
            context.store,
            opts.slug,
            Math.max(0, current.cursor - opts.events),
            { through: current.cursor },
          )
    const decision = await projectBuildDecision(opts.slug, facts, context.store)
    // Stream enrichment is presentation (SPEC §9): an unavailable read
    // degrades to payload-carried ids without a status, never a failure.
    let streams: StreamRecord[] | undefined
    try {
      streams = await context.store.listStreams({
        kind: 'build',
        build: opts.slug,
      } satisfies StreamScope)
    } catch {
      streams = undefined
    }
    const projected = detailFromFacts(record, facts, now, events, decision, streams)
    // Operator visibility (SPEC §16.1): which autobuild.toml the build's
    // pinned pipeline came from, alongside the effective-config revision.
    const configArtifact = await context.store.getArtifact(
      opts.slug,
      facts.state.verify.configPin?.artifact.kind ?? BUILD_EFFECTIVE_CONFIG_ARTIFACT,
      facts.state.verify.configPin?.artifact.rev,
    )
    const configMeta =
      configArtifact !== null ? parseBuildConfigMetadata(configArtifact) : undefined
    let nodePolling: BuildDetail['nodePolling']
    if (
      facts.state.kind === 'node' &&
      facts.state.status !== 'done' &&
      facts.state.status !== 'aborted' &&
      facts.state.prState !== 'closed' &&
      facts.state.prState !== 'merged'
    ) {
      const children: { slug: string; state: BuildState }[] = []
      for (const child of await context.store.listBuilds()) {
        if (child.repo !== record.repo) continue
        const state = (await readBuildFacts(context.store, child.slug)).value.state
        if (state.target?.build === record.slug) children.push({ slug: child.slug, state })
      }
      // The checkpoint records the dispatcher's hot policy. A held node's
      // launch artifact can predate later policy changes.
      const policy = {
        nodeIdleAfterSeconds: facts.state.nodePolling?.nodeIdleAfterSeconds ?? 600,
        nodeIdlePollSeconds: facts.state.nodePolling?.nodeIdlePollSeconds ?? 120,
      }
      nodePolling = nodePollingSchedule(
        facts.state,
        nodeActivityKey(facts.state, children),
        policy,
        now,
        facts.open !== null ||
          facts.publication.pending() ||
          facts.publication.abandonedPending() ||
          undefined,
      )
    }
    const d: BuildDetail = {
      ...projected,
      ...(nodePolling ? { nodePolling } : {}),
      ...(configMeta?.revision !== undefined ? { effectiveConfigRev: configMeta.revision } : {}),
      ...(configMeta?.pipelineSource !== undefined
        ? { pipelineSource: configMeta.pipelineSource }
        : {}),
    }
    if (opts.json === true) {
      opts.stdout(JSON.stringify(d, null, 2))
      return
    }
    for (const line of renderDetail(d, now)) opts.stdout(line)
  })
}

export interface AbBuildAssetGetOpts extends AbBuildStatusOpts {
  kind: string
  name: string
  dest: string
  rev?: number
}

/** `ab build asset get <slug> <kind> <name> <dest>` — the exact bytes a build
 * froze at its claim (SPEC §6.3), available after the build has finished. */
export async function abBuildAssetGet(opts: AbBuildAssetGetOpts): Promise<void> {
  await withAmbientReadStore(opts, async (context) => {
    await requireReadableBuild(opts, context)
    const asset = await context.store.getPinnedTicketAsset(
      opts.slug,
      opts.kind,
      opts.name,
      opts.rev,
    )
    if (asset === null) {
      const revision = opts.rev === undefined ? '' : ` revision ${opts.rev}`
      throw new Error(
        `build "${opts.slug}" pinned no ticket asset ${opts.kind}/${opts.name}${revision}`,
      )
    }
    const written = await writeAssetTo(asset, opts.dest)
    if (opts.json === true) {
      opts.stdout(JSON.stringify({ ...asset.meta, path: written }, null, 2))
      return
    }
    opts.stdout(
      `build asset downloaded: ${opts.slug} ${opts.kind}/${opts.name} revision ${asset.meta.revision} → ${written}`,
    )
  })
}
