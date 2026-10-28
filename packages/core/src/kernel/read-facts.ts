import { ticketPreparationReducer } from './ticket-preparation'
import { ticketMigrationsReducer } from './ticket-migrations'
import { dispatchUpgradeReducer } from './dispatch-upgrade'
import {
  advanceCompatibility,
  initialCompatibility,
  projectEvents,
  type CompatibilityState,
} from '../events/compatibility'
import { awaitsConsent } from './landing-readiness'
import { leafRestackReducer, type LeafRestackState } from './leaf-restack-state'
import { landingCandidateId } from './landing-policy'
import { referencedGitTips } from './reconcile-head'
import { encodeLog } from './log-index-value'
import { summaryBoundaryReducer, summaryRequestsReducer } from './pr-summary'
import { infrastructureFailureResetReducer } from '../processes/infrastructure-failure-budget'
import {
  frozenPrImageHostReducer,
  currentPrAttachmentsReducer,
  hostedPrAttachmentsReducer,
  pendingPrAttachmentReclaimsReducer,
} from './pr-attachments'
import { isRemoteWorkspace } from '../events/workspace-remote'
/** JSON-safe projections for persisted current-state consumers. */
import type { AbEvent } from '../events/catalog'
import { defineReducer } from './incremental'
import { buildReducer, type BuildAcc } from './reducer'
import {
  currentDeferralObservationReducer,
  mergeAttentionFromFacts,
  type DeferralLedger,
} from './auto-merge'
import { logIndexReducer } from './log-index'
import { publicationStateReducer } from '../processes/publication-state'
import { executionNoProgressReducer } from '../processes/execution-no-progress'
import {
  openExecutionReducer,
  lastExecutionOutcomeReducer,
} from '../processes/execution-settlement'
import {
  baseBranchReducer,
  provisionMarkerReducer,
  recoveryCheckpointReducer,
  openBuildWorkspaceReducer,
} from '../processes/dispatcher-selectors'
import { dashboardFactsReducer } from '../cli/dashboard/facts'

export interface BuildStreamSeed {
  build: BuildAcc
  deferral: DeferralLedger
  mergeAttentionPrs: number[]
  branch?: string
  restack: LeafRestackState
  consentEpisode?: { seq: number; candidate: string }
  /** Terminal identity can precede later observations; retain it at the seed cursor. */
  terminalEvent?: AbEvent
}
// Bump with either constituent's semantics or historical eligibility semantics.
export const buildStreamSeedReducer = defineReducer<BuildStreamSeed, AbEvent, BuildStreamSeed>({
  rawEvents: true,
  version:
    4 +
    ticketMigrationsReducer.version +
    leafRestackReducer.version +
    buildReducer.version +
    currentDeferralObservationReducer.version,
  initial: () => ({
    build: buildReducer.initial(),
    deferral: currentDeferralObservationReducer.initial(),
    mergeAttentionPrs: [],
    restack: leafRestackReducer.initial(),
  }),
  fold(acc, events) {
    for (const raw of events) {
      acc.build = buildReducer.advance(acc.build, [raw])
      const [event] = projectEvents([raw])
      if (!event) continue
      if (event.type === 'workspace.provisioned' || event.type === 'node.opening')
        acc.branch = event.payload.branch
      if (event.type === 'build.completed' || event.type === 'build.aborted')
        acc.terminalEvent = event
      acc.restack = leafRestackReducer.advance(acc.restack, [event])
      acc.deferral = currentDeferralObservationReducer.advance(acc.deferral, [event])
      const state = buildReducer.finish(acc.build)
      if (awaitsConsent(state, acc.restack)) {
        const candidate = landingCandidateId(state.landing!.decision!.candidate)
        if (acc.consentEpisode?.candidate !== candidate)
          acc.consentEpisode = { seq: event.seq, candidate }
      } else delete acc.consentEpisode
      const decision = mergeAttentionFromFacts(buildReducer.finish(acc.build), acc.deferral)
      if (decision && !acc.mergeAttentionPrs.includes(decision.pr.number))
        acc.mergeAttentionPrs.push(decision.pr.number)
    }
  },
  finish: (acc) => structuredClone(acc),
})

const parts = {
  infrastructureReset: infrastructureFailureResetReducer,
  summaryRequests: summaryRequestsReducer,
  summaryBoundary: summaryBoundaryReducer,
  hostedImages: hostedPrAttachmentsReducer,
  designations: currentPrAttachmentsReducer,
  imageHost: frozenPrImageHostReducer,
  pendingAttachments: pendingPrAttachmentReclaimsReducer,
  recoveryCheckpoint: recoveryCheckpointReducer,
  provisionMarker: provisionMarkerReducer,
  baseBranch: baseBranchReducer,
  build: buildReducer,
  log: logIndexReducer,
  publication: publicationStateReducer,
  executionNoProgress: executionNoProgressReducer,
  open: openExecutionReducer,
  workspace: openBuildWorkspaceReducer,
  lastExecution: lastExecutionOutcomeReducer,
  dashboard: dashboardFactsReducer,
  deferral: currentDeferralObservationReducer,
}
export interface RunnerAttach {
  seq: number
  ts: string
  instance: string
  host: string
  resumedFromSeq?: number
  runtime: import('../events/runtime').RuntimeIdentity | null
}
export interface BuildReadAcc {
  runnerAttaches: RunnerAttach[]
  summaryRequests: ReturnType<typeof summaryRequestsReducer.initial>
  summaryBoundary: ReturnType<typeof summaryBoundaryReducer.initial>
  hostedImages: ReturnType<typeof hostedPrAttachmentsReducer.initial>
  designations: ReturnType<typeof currentPrAttachmentsReducer.initial>
  imageHost: ReturnType<typeof frozenPrImageHostReducer.initial>
  pendingAttachments: ReturnType<typeof pendingPrAttachmentReclaimsReducer.initial>
  recoveryCheckpoint: ReturnType<typeof recoveryCheckpointReducer.initial>
  provisionMarker: ReturnType<typeof provisionMarkerReducer.initial>
  baseBranch: ReturnType<typeof baseBranchReducer.initial>
  build: ReturnType<typeof buildReducer.initial>
  log: ReturnType<typeof logIndexReducer.initial>
  publication: ReturnType<typeof publicationStateReducer.initial>
  executionNoProgress: ReturnType<typeof executionNoProgressReducer.initial>
  open: ReturnType<typeof openExecutionReducer.initial>
  workspace: ReturnType<typeof openBuildWorkspaceReducer.initial>
  lastExecution: ReturnType<typeof lastExecutionOutcomeReducer.initial>
  dashboard: ReturnType<typeof dashboardFactsReducer.initial>
  deferral: ReturnType<typeof currentDeferralObservationReducer.initial>
  summaryHistory: {
    kind: 'review' | 'verify'
    phase?: string
    round?: number
    verdict?: string
    count?: number
    result?: import('../events/payloads').EventPayload<'verify.completed'>
  }[]
  summaryAttempts: number[]
  summaryRequested: Record<string, Extract<AbEvent, { type: 'pr-summary.requested' }>>
  summaryEligibleAfter?: string
  finalizePublicationRequested: boolean
  latestWorkspace?: Extract<AbEvent, { type: 'workspace.provisioned' }>
  findings: Record<string, import('../ontology').Finding>
  planFeedback: Record<string, import('../ontology').Feedback | null>
  feedback: Record<string, import('../ontology').Feedback | null>
  reconcileBases: Record<string, string>
  reconcileHistory: Extract<
    AbEvent,
    { type: `reconcile.${string}` | 'workspace.provisioned' | 'phase.failed' }
  >[]
  restackHistory: Extract<AbEvent, { type: `restack.${string}` }>[]
  gitTips: string[]
  reconcileTransaction?: import('../events/payloads').EventPayload<'reconcile.prepared'>
  reconcileReplay?: import('../events/payloads').EventPayload<'reconcile.replayed'>
  firstWorkspace?: Extract<AbEvent, { type: 'workspace.provisioned' }>
  latestAbort?: Extract<AbEvent, { type: 'build.abort-requested' }>
  latestDiscard?: Extract<AbEvent, { type: 'build.discard-requested' }>
  maxPlanRevision: number
  created?: Extract<AbEvent, { type: 'build.created' }>
  lastCreated?: Extract<AbEvent, { type: 'build.created' }>
  latestRelease?: Extract<AbEvent, { type: 'workspace.released' }>
  latestWorkspaceFailureSeq: number
  workspaceGenerations: number
  dispatchFailureCount: number
  commentPosted: boolean
  specRecorded: boolean
  autoMergeEverRequested: boolean
  seenTypes: AbEvent['type'][]
  localWorkspace: boolean
  cleanupCounts: Record<string, number>
  reclaimCounts: Record<string, number>
  infrastructureReset: ReturnType<typeof infrastructureFailureResetReducer.initial>
  infrastructureCount: number
  infrastructureRaisedSeq: number
  remoteWorkspace: boolean
  terminalEvent?: AbEvent
  mergeTimes: string[]
  observationFacts: {
    payload: import('../events/payloads').EventPayload<'observation.recorded'>
    seq: number
    ts: string
  }[]
  observations: Extract<AbEvent, { type: 'observation.recorded' }>['payload'][]
}
export const buildReadFactsReducer = defineReducer({
  rawEvents: true,
  version: 4 + Object.values(parts).reduce((sum, reducer) => sum + reducer.version, 0),
  initial: (): BuildReadAcc => ({
    runnerAttaches: [],
    summaryRequests: summaryRequestsReducer.initial(),
    summaryBoundary: summaryBoundaryReducer.initial(),
    hostedImages: hostedPrAttachmentsReducer.initial(),
    designations: currentPrAttachmentsReducer.initial(),
    imageHost: frozenPrImageHostReducer.initial(),
    pendingAttachments: pendingPrAttachmentReclaimsReducer.initial(),
    recoveryCheckpoint: recoveryCheckpointReducer.initial(),
    provisionMarker: provisionMarkerReducer.initial(),
    baseBranch: baseBranchReducer.initial(),
    build: buildReducer.initial(),
    log: logIndexReducer.initial(),
    publication: publicationStateReducer.initial(),
    executionNoProgress: executionNoProgressReducer.initial(),
    open: openExecutionReducer.initial(),
    workspace: openBuildWorkspaceReducer.initial(),
    lastExecution: lastExecutionOutcomeReducer.initial(),
    dashboard: dashboardFactsReducer.initial(),
    deferral: currentDeferralObservationReducer.initial(),
    observations: [],
    observationFacts: [],
    mergeTimes: [],
    summaryHistory: [],
    summaryAttempts: [],
    summaryRequested: {},
    finalizePublicationRequested: false,
    findings: {},
    feedback: {},
    planFeedback: {},
    reconcileBases: {},
    reconcileHistory: [],
    restackHistory: [],
    gitTips: [],
    maxPlanRevision: -1,
    seenTypes: [],
    localWorkspace: false,
    cleanupCounts: {},
    reclaimCounts: {},
    infrastructureReset: infrastructureFailureResetReducer.initial(),
    infrastructureCount: 0,
    infrastructureRaisedSeq: 0,
    remoteWorkspace: false,
    latestWorkspaceFailureSeq: 0,
    workspaceGenerations: 0,
    dispatchFailureCount: 0,
    commentPosted: false,
    specRecorded: false,
    autoMergeEverRequested: false,
  }),
  fold(acc: BuildReadAcc, events: readonly AbEvent[]) {
    acc.baseBranch = baseBranchReducer.advance(acc.baseBranch, events)
    acc.provisionMarker = provisionMarkerReducer.advance(acc.provisionMarker, events)
    acc.recoveryCheckpoint = recoveryCheckpointReducer.advance(acc.recoveryCheckpoint, events)
    acc.pendingAttachments = pendingPrAttachmentReclaimsReducer.advance(
      acc.pendingAttachments,
      events,
    )
    acc.imageHost = frozenPrImageHostReducer.advance(acc.imageHost, events)
    acc.designations = currentPrAttachmentsReducer.advance(acc.designations, events)
    acc.hostedImages = hostedPrAttachmentsReducer.advance(acc.hostedImages, events)
    acc.summaryBoundary = summaryBoundaryReducer.advance(acc.summaryBoundary, events)
    acc.summaryRequests = summaryRequestsReducer.advance(acc.summaryRequests, events)
    acc.build = buildReducer.advance(acc.build, events)
    acc.log = logIndexReducer.advance(acc.log, events)
    acc.publication = publicationStateReducer.advance(acc.publication, events)
    acc.executionNoProgress = executionNoProgressReducer.advance(acc.executionNoProgress, events)
    acc.open = openExecutionReducer.advance(acc.open, events)
    acc.workspace = openBuildWorkspaceReducer.advance(acc.workspace, events)
    acc.lastExecution = lastExecutionOutcomeReducer.advance(acc.lastExecution, events)
    acc.dashboard = dashboardFactsReducer.advance(acc.dashboard, events)
    acc.deferral = currentDeferralObservationReducer.advance(acc.deferral, events)
    for (const event of projectEvents(events)) {
      if (event.type === 'runner.attached')
        acc.runnerAttaches.push({ seq: event.seq, ts: event.ts, ...event.payload, runtime: null })
      if (event.type === 'runner.runtime-recorded') {
        const attach = acc.runnerAttaches.find(
          (a) => a.seq === event.payload.attachedSeq && a.instance === event.payload.instance,
        )
        if (attach) attach.runtime = event.payload.runtime
      }
      if (event.type === 'plan-review.verdict' || event.type === 'code-review.verdict')
        acc.summaryHistory.push({
          kind: 'review',
          phase: event.type === 'plan-review.verdict' ? 'plan-review' : 'code-review',
          round: event.payload.round,
          verdict: event.payload.verdict,
          count: event.payload.findings.length,
        })
      if (event.type === 'verify.completed')
        acc.summaryHistory.push({ kind: 'verify', result: event.payload })
      if (
        event.type === 'pr-summary.attempted' &&
        !acc.summaryAttempts.includes(event.payload.occurrence)
      )
        acc.summaryAttempts.push(event.payload.occurrence)
      if (event.type === 'pr-summary.requested')
        acc.summaryRequested[String(event.payload.occurrence)] ??= event
      if (
        event.type === 'pr-summary.result' &&
        event.payload.eligibleAfter &&
        (!acc.summaryEligibleAfter ||
          Date.parse(event.payload.eligibleAfter) > Date.parse(acc.summaryEligibleAfter))
      )
        acc.summaryEligibleAfter = event.payload.eligibleAfter
      if (event.type === 'publication.requested' && event.payload.operation === 'finalize')
        acc.finalizePublicationRequested = true
      if (event.type === 'workspace.provisioned') acc.latestWorkspace = event
      if (event.type === 'plan-review.verdict')
        acc.planFeedback[String(event.payload.round + 1)] =
          event.payload.verdict === 'revise'
            ? { findings: event.payload.findings.map((finding) => finding.id) }
            : null
      if (event.type === 'plan-review.verdict' || event.type === 'code-review.verdict')
        for (const finding of event.payload.findings)
          acc.findings[JSON.stringify(finding.id)] = finding
      if (event.type === 'plan.started' || event.type === 'implement.started')
        acc.feedback[
          JSON.stringify([
            event.type === 'plan.started' ? 'plan' : 'implement',
            event.payload.round,
          ])
        ] = event.payload.feedback ?? null
      if (event.type === 'verify.started')
        acc.feedback[JSON.stringify([`verify:${event.payload.step}`, event.payload.attempt])] =
          event.payload.feedback ?? null
      if (event.type.startsWith('restack.'))
        acc.restackHistory.push(event as Extract<AbEvent, { type: `restack.${string}` }>)
      for (const tip of referencedGitTips([event]))
        if (!acc.gitTips.includes(tip)) acc.gitTips.push(tip)
      if (
        event.type === 'reconcile.started' ||
        event.type === 'reconcile.completed' ||
        event.type === 'reconcile.prepared' ||
        event.type === 'reconcile.replayed' ||
        event.type === 'reconcile.contended' ||
        event.type === 'reconcile.publish-intended' ||
        event.type === 'reconcile.rewritten' ||
        event.type === 'workspace.provisioned' ||
        event.type === 'phase.failed'
      )
        acc.reconcileHistory.push(event)
      if (event.type === 'reconcile.prepared') {
        acc.reconcileTransaction = event.payload
        delete acc.reconcileReplay
      }
      if (event.type === 'reconcile.replayed') acc.reconcileReplay = event.payload
      if (event.type === 'reconcile.started')
        acc.reconcileBases[String(event.payload.attempt)] = event.payload.baseSha
      if (event.type === 'workspace.provisioned') acc.firstWorkspace ??= event
      if (event.type === 'build.abort-requested') acc.latestAbort = event
      if (event.type === 'build.discard-requested') acc.latestDiscard = event
      if (event.type === 'plan.completed')
        acc.maxPlanRevision = Math.max(acc.maxPlanRevision, event.payload.artifact.rev)
      if (!acc.seenTypes.includes(event.type)) acc.seenTypes.push(event.type)
      if (event.type === 'workspace.provisioned' && !isRemoteWorkspace(event.payload))
        acc.localWorkspace = true
      if (event.type === 'infrastructure.cleanup-attempted') {
        const key = JSON.stringify(event.payload.workspaceRef)
        acc.cleanupCounts[key] = (acc.cleanupCounts[key] ?? 0) + 1
      }
      if (event.type === 'pr-attachment.reclaim-failed') {
        const key = String(event.payload.hostedSeq)
        acc.reclaimCounts[key] = (acc.reclaimCounts[key] ?? 0) + 1
      }
      const priorReset = infrastructureFailureResetReducer.finish(acc.infrastructureReset)
      acc.infrastructureReset = infrastructureFailureResetReducer.advance(acc.infrastructureReset, [
        event,
      ])
      if (infrastructureFailureResetReducer.finish(acc.infrastructureReset) !== priorReset)
        acc.infrastructureCount = 0
      if (event.type === 'infrastructure.failed') acc.infrastructureCount++
      if (
        event.type === 'escalation.raised' &&
        event.payload.policyCause === 'infrastructure-failure-limit'
      )
        acc.infrastructureRaisedSeq = event.seq
      if (event.type === 'build.created') {
        acc.created ??= event
        acc.lastCreated = event
      }
      if (event.type === 'workspace.provisioned') acc.workspaceGenerations++
      if (event.type === 'workspace.released') acc.latestRelease = event
      if (event.type === 'dispatch.failed') {
        acc.dispatchFailureCount++
        if (event.payload.stage === 'workspace') acc.latestWorkspaceFailureSeq = event.seq
      }
      if (event.type === 'dispatch.comment-posted') acc.commentPosted = true
      if (event.type === 'spec.imported' || event.type === 'spec.authored') acc.specRecorded = true
      if (event.type === 'build.auto-merge-requested') acc.autoMergeEverRequested = true
      if (event.type === 'workspace.provisioned' && isRemoteWorkspace(event.payload))
        acc.remoteWorkspace = true
      if (event.type === 'build.completed' || event.type === 'build.aborted')
        acc.terminalEvent = event
      if (event.type === 'observation.recorded') {
        acc.observations.push(event.payload)
        acc.observationFacts.push({ payload: event.payload, seq: event.seq, ts: event.ts })
      }
      if (event.type === 'pr.merged') acc.mergeTimes.push(event.ts)
    }
  },
  finish: (acc: BuildReadAcc) => ({
    runnerAttaches: structuredClone(acc.runnerAttaches),
    summaryRequests: summaryRequestsReducer.finish(acc.summaryRequests),
    summaryBoundary: summaryBoundaryReducer.finish(acc.summaryBoundary),
    hostedImages: [...hostedPrAttachmentsReducer.finish(acc.hostedImages)],
    designations: currentPrAttachmentsReducer.finish(acc.designations),
    imageHost: frozenPrImageHostReducer.finish(acc.imageHost),
    pendingAttachments: pendingPrAttachmentReclaimsReducer.finish(acc.pendingAttachments),
    recoveryCheckpoint: recoveryCheckpointReducer.finish(acc.recoveryCheckpoint),
    provisionMarker: provisionMarkerReducer.finish(acc.provisionMarker),
    baseBranch: baseBranchReducer.finish(acc.baseBranch),
    state: buildReducer.finish(acc.build),
    log: encodeLog(logIndexReducer.finish(acc.log)),
    publication: structuredClone(acc.publication),
    executionNoProgress: executionNoProgressReducer.finish(acc.executionNoProgress),
    open: openExecutionReducer.finish(acc.open),
    workspace: openBuildWorkspaceReducer.finish(acc.workspace),
    lastExecution: lastExecutionOutcomeReducer.finish(acc.lastExecution),
    dashboard: dashboardFactsReducer.finish(acc.dashboard),
    deferral: currentDeferralObservationReducer.finish(acc.deferral),
    observationFacts: structuredClone(acc.observationFacts),
    mergeTimes: [...acc.mergeTimes],
    observations: structuredClone(acc.observations),
    terminalEvent: acc.terminalEvent,
    summaryHistory: structuredClone(acc.summaryHistory),
    summaryAttempts: [...acc.summaryAttempts],
    summaryRequested: structuredClone(acc.summaryRequested),
    summaryEligibleAfter: acc.summaryEligibleAfter,
    finalizePublicationRequested: acc.finalizePublicationRequested,
    latestWorkspace: acc.latestWorkspace,
    planFeedback: structuredClone(acc.planFeedback),
    findings: structuredClone(acc.findings),
    feedback: structuredClone(acc.feedback),
    reconcileBases: { ...acc.reconcileBases },
    reconcileHistory: structuredClone(acc.reconcileHistory),
    restackHistory: structuredClone(acc.restackHistory),
    gitTips: [...acc.gitTips],
    reconcileTransaction: acc.reconcileTransaction,
    reconcileReplay: acc.reconcileReplay,
    firstWorkspace: acc.firstWorkspace,
    latestAbort: acc.latestAbort,
    latestDiscard: acc.latestDiscard,
    maxPlanRevision: acc.maxPlanRevision,
    seenTypes: [...acc.seenTypes],
    localWorkspace: acc.localWorkspace,
    cleanupCounts: { ...acc.cleanupCounts },
    reclaimCounts: { ...acc.reclaimCounts },
    infrastructureReset: infrastructureFailureResetReducer.finish(acc.infrastructureReset),
    infrastructureCount: acc.infrastructureCount,
    infrastructureRaisedSeq: acc.infrastructureRaisedSeq,
    remoteWorkspace: acc.remoteWorkspace,
    created: acc.created,
    lastCreated: acc.lastCreated,
    latestRelease: acc.latestRelease,
    latestWorkspaceFailureSeq: acc.latestWorkspaceFailureSeq,
    workspaceGenerations: acc.workspaceGenerations,
    dispatchFailureCount: acc.dispatchFailureCount,
    commentPosted: acc.commentPosted,
    specRecorded: acc.specRecorded,
    autoMergeEverRequested: acc.autoMergeEverRequested,
  }),
})

import type { RepositoryEvent } from '../events/repository'
import { repositoryAttentionReducer } from './repository-attention'
import { dispatchSettingsReducer } from './dispatch-settings'
import { harvestReducer } from './harvest'
import { forgeHealthReducer } from './forge-health'
import { ticketSourceHealthReducer } from './ticket-source-health'
import { autoMergeDefaultReducer } from './auto-merge-default'
import { effectiveConfigReducer } from './service-facts'
import { sandboxStatesReducer } from '../processes/sandbox-state'
import { openHarvestExecutionsReducer } from '../processes/harvest-execution-state'
import { dispatchStatusReducer } from './dispatch-status'

/** Shared current reads retain a fixed recent window. Historical holder
 * correlations outside it use the explicitly parameterized cache. */
export const RECENT_DISPATCH_RUN_LIMIT = 16
export interface RepositoryReadAcc {
  preparation: ReturnType<typeof ticketPreparationReducer.initial>
  compatibility: CompatibilityState
  presence: Record<
    string,
    Extract<RepositoryEvent, { type: 'change-presence.observed' }>['payload']
  >

  upgrades: ReturnType<typeof dispatchUpgradeReducer.initial>
  openHarvest: ReturnType<typeof openHarvestExecutionsReducer.initial>
  attention: ReturnType<typeof repositoryAttentionReducer.initial>
  harvestFailures: Record<
    string,
    { count: number; latest: Extract<RepositoryEvent, { type: 'harvest.failed' }> }
  >
  harvestVerdicts: Record<
    string,
    {
      first: Extract<RepositoryEvent, { type: 'harvest.review.verdict' }>
      latest: Extract<RepositoryEvent, { type: 'harvest.review.verdict' }>
    }
  >
  harvestAuthorizations: Record<
    string,
    Extract<RepositoryEvent, { type: 'harvest.execution.authorized' }>
  >
  harvestExecutionStarts: Record<string, string>
  latestHarvestResumedSeq: number
  harvestSessionEndings: Record<string, number>
  harvestSessions: (import('../cli/harvest').HarvestSessionStatusView & { run: string })[]
  pendingHumanResume?: number
  dismissedThrough: number
  failedAt: Record<string, string>
  settings: ReturnType<typeof dispatchSettingsReducer.initial>
  harvest: ReturnType<typeof harvestReducer.initial>
  forgeHealth: ReturnType<typeof forgeHealthReducer.initial>
  ticketMigrations: ReturnType<typeof ticketMigrationsReducer.initial>
  health: ReturnType<typeof ticketSourceHealthReducer.initial>
  autoMerge: ReturnType<typeof autoMergeDefaultReducer.initial>
  config: ReturnType<typeof effectiveConfigReducer.initial>
  sandboxes: ReturnType<typeof sandboxStatesReducer.initial>
  status: ReturnType<ReturnType<typeof dispatchStatusReducer>['initial']>
  run?: string
  scan?: Extract<RepositoryEvent, { type: 'dispatcher.ticket-scan-completed' }>['payload']
  recentRuns: [string, DispatcherRunFacts][]
  latestRun?: string
  latestStoppedRun?: string
  publications: Extract<RepositoryEvent, { type: 'orchestrator.sandbox.published' }>[]
}
export const repositoryReadFactsReducer = defineReducer({
  rawEvents: true,
  version:
    4 +
    ticketMigrationsReducer.version +
    dispatchUpgradeReducer.version +
    ticketPreparationReducer.version +
    dispatcherRunFactsReducer('version').version +
    openHarvestExecutionsReducer.version +
    forgeHealthReducer.version +
    repositoryAttentionReducer.version +
    dispatchSettingsReducer.version +
    harvestReducer.version +
    ticketSourceHealthReducer.version +
    autoMergeDefaultReducer.version +
    effectiveConfigReducer.version +
    sandboxStatesReducer.version +
    dispatchStatusReducer('version').version,
  initial: (): RepositoryReadAcc => ({
    compatibility: initialCompatibility(),
    presence: {},
    preparation: ticketPreparationReducer.initial(),
    upgrades: dispatchUpgradeReducer.initial(),
    recentRuns: [],
    openHarvest: openHarvestExecutionsReducer.initial(),
    attention: repositoryAttentionReducer.initial(),
    dismissedThrough: 0,
    failedAt: {},
    harvestSessions: [],
    harvestSessionEndings: {},
    harvestFailures: {},
    harvestVerdicts: {},
    harvestAuthorizations: {},
    latestHarvestResumedSeq: 0,
    harvestExecutionStarts: {},
    settings: dispatchSettingsReducer.initial(),
    harvest: harvestReducer.initial(),
    forgeHealth: forgeHealthReducer.initial(),
    ticketMigrations: ticketMigrationsReducer.initial(),
    health: ticketSourceHealthReducer.initial(),
    autoMerge: autoMergeDefaultReducer.initial(),
    config: effectiveConfigReducer.initial(),
    sandboxes: sandboxStatesReducer.initial(),
    status: dispatchStatusReducer('initial').initial(),
    publications: [],
  }),
  fold(acc: RepositoryReadAcc, events: readonly RepositoryEvent[]) {
    acc.preparation = ticketPreparationReducer.advance(acc.preparation, events)
    advanceCompatibility(acc.compatibility, events)
    acc.upgrades = dispatchUpgradeReducer.advance(acc.upgrades, events)
    acc.attention = repositoryAttentionReducer.advance(acc.attention, events)
    acc.openHarvest = openHarvestExecutionsReducer.advance(acc.openHarvest, events)
    acc.settings = dispatchSettingsReducer.advance(acc.settings, events)
    acc.harvest = harvestReducer.advance(acc.harvest, events)
    acc.forgeHealth = forgeHealthReducer.advance(acc.forgeHealth, events)
    acc.ticketMigrations = ticketMigrationsReducer.advance(acc.ticketMigrations, events)
    acc.health = ticketSourceHealthReducer.advance(acc.health, events)
    acc.autoMerge = autoMergeDefaultReducer.advance(acc.autoMerge, events)
    acc.config = effectiveConfigReducer.advance(acc.config, events)
    acc.sandboxes = sandboxStatesReducer.advance(acc.sandboxes, events)
    for (const event of projectEvents(events)) {
      if (event.type === 'change-presence.observed')
        acc.presence[event.payload.destination] = event.payload
      if (event.type === 'harvest.failed') {
        const key = JSON.stringify([event.payload.run, event.payload.step, event.payload.round])
        acc.harvestFailures[key] = {
          count: (acc.harvestFailures[key]?.count ?? 0) + 1,
          latest: event,
        }
      }
      if (event.type === 'harvest.review.verdict') {
        const key = JSON.stringify([event.payload.run, event.payload.round])
        acc.harvestVerdicts[key] = {
          first: acc.harvestVerdicts[key]?.first ?? event,
          latest: event,
        }
      }
      if (event.type === 'harvest.execution.started')
        acc.harvestExecutionStarts[String(event.seq)] = event.payload.execution
      if (event.type === 'harvest.execution.authorized')
        acc.harvestAuthorizations[JSON.stringify(event.payload.execution)] ??= event
      if (event.type === 'harvest.resumed') acc.latestHarvestResumedSeq = event.seq
      if (event.type === 'harvest.session.started' && event.payload.continuation) {
        const prior = acc.harvestSessions.find(
          (s) => s.session === event.payload.continuation!.predecessor,
        )
        if (prior) prior.status = 'ended'
      }
      if (event.type === 'harvest.session.started')
        acc.harvestSessions.push({
          run: event.payload.run,
          session: event.payload.session,
          role: event.payload.role,
          step: event.payload.step,
          round: event.payload.round,
          status: 'open',
          ...(event.payload.continuation ? { continuation: event.payload.continuation } : {}),
          ...(event.payload.stream === undefined ? {} : { stream: event.payload.stream }),
          streamStatus: event.payload.stream === undefined ? 'closed' : 'open',
        })
      if (event.type === 'harvest.session.ended' || event.type === 'harvest.session.suspended') {
        acc.harvestSessionEndings[JSON.stringify(event.payload.session)] ??= event.seq
        const session = acc.harvestSessions.findLast(
          (session) => session.session === event.payload.session && session.status === 'open',
        )
        if (session) {
          session.status = event.type === 'harvest.session.suspended' ? 'suspended' : 'ended'
          session.transcript = event.payload.transcript
          session.streamStatus = 'closed'
        }
      }
      if (event.type === 'harvest.resume-requested' && event.actor.kind === 'human')
        acc.pendingHumanResume = event.seq
      if (event.type === 'harvest.pause-requested') delete acc.pendingHumanResume
      if (event.type === 'harvest.resumed' && acc.pendingHumanResume !== undefined)
        acc.dismissedThrough = Math.max(acc.dismissedThrough, acc.pendingHumanResume)
      if (event.type === 'harvest.failed' && !event.payload.willRetry)
        acc.failedAt[JSON.stringify(event.payload.run)] = event.ts
      if (event.type === 'dispatcher.run-started') {
        acc.run = event.payload.run
        acc.status = dispatchStatusReducer(acc.run).initial()
      }
      if (acc.run) acc.status = dispatchStatusReducer(acc.run).advance(acc.status, [event])
      if (event.type === 'dispatcher.ticket-scan-completed') acc.scan = event.payload
      if (event.type === 'dispatcher.run-started') acc.latestRun = event.payload.run
      if (event.type === 'dispatcher.run-stopped') acc.latestStoppedRun = event.payload.run
      if (
        event.type.startsWith('dispatcher.') &&
        'run' in event.payload &&
        typeof event.payload.run === 'string'
      ) {
        const run = event.payload.run
        let entry = acc.recentRuns.find(([id]) => id === run)
        if (!entry) {
          entry = [run, {}]
          acc.recentRuns.push(entry)
        }
        foldDispatcherRunFact(entry[1], event)
        while (acc.recentRuns.length > RECENT_DISPATCH_RUN_LIMIT) {
          const index = acc.recentRuns.findIndex(
            ([id]) => id !== acc.latestRun && id !== acc.latestStoppedRun,
          )
          acc.recentRuns.splice(index, 1)
        }
      }
      if (event.type === 'orchestrator.sandbox.published') {
        acc.publications = acc.publications.filter(
          (prior) =>
            prior.payload.operator !== event.payload.operator ||
            prior.payload.branch !== event.payload.branch,
        )
        acc.publications.push(event)
      }
    }
  },
  finish: (acc: RepositoryReadAcc) => ({
    compatibility: structuredClone(acc.compatibility),
    presence: structuredClone(acc.presence),
    preparation: ticketPreparationReducer.finish(acc.preparation),
    upgrades: dispatchUpgradeReducer.finish(acc.upgrades),
    harvestFailures: structuredClone(acc.harvestFailures),
    harvestVerdicts: structuredClone(acc.harvestVerdicts),
    harvestAuthorizations: structuredClone(acc.harvestAuthorizations),
    harvestExecutionStarts: { ...acc.harvestExecutionStarts },
    latestHarvestResumedSeq: acc.latestHarvestResumedSeq,
    harvestSessionEndings: { ...acc.harvestSessionEndings },
    harvestSessions: structuredClone(acc.harvestSessions),
    attention: repositoryAttentionReducer.finish(acc.attention),
    dismissedThrough: acc.dismissedThrough,
    failedAt: { ...acc.failedAt },
    openHarvest: openHarvestExecutionsReducer.finish(acc.openHarvest),
    settings: dispatchSettingsReducer.finish(acc.settings),
    harvest: harvestReducer.finish(acc.harvest),
    forgeHealth: forgeHealthReducer.finish(acc.forgeHealth),
    ticketMigrations: ticketMigrationsReducer.finish(acc.ticketMigrations),
    health: ticketSourceHealthReducer.finish(acc.health),
    autoMerge: autoMergeDefaultReducer.finish(acc.autoMerge),
    config: effectiveConfigReducer.finish(acc.config),
    sandboxes: sandboxStatesReducer.finish(acc.sandboxes),
    status: acc.run ? dispatchStatusReducer(acc.run).finish(acc.status) : undefined,
    scan: acc.scan,
    recentRuns: structuredClone(acc.recentRuns),
    latestRun: acc.latestRun,
    latestStoppedRun: acc.latestStoppedRun,
    publications: structuredClone(acc.publications),
  }),
})

import type { IncrementalReducer } from './incremental'
/** Companion for an optional finished answer: absence is represented by an
 * omitted object field, never top-level undefined. */
export function optionalValue<A, E, V>(reducer: IncrementalReducer<A, E, V>) {
  return {
    ...reducer,
    finish: (acc: A) => ({ value: reducer.finish(acc) }),
    reduce: (events: readonly E[]) => ({ value: reducer.reduce(events) }),
  }
}

/** One run's correlation facts. History for unrelated runs never enters this value. */
export interface DispatcherRunFacts {
  runtime?: RepositoryEvent
  start?: RepositoryEvent
  latestStart?: RepositoryEvent
  stop?: RepositoryEvent
  tick?: RepositoryEvent
  completed?: RepositoryEvent
  boundary?: 'dispatcher.tick-started' | 'dispatcher.tick-completed' | 'dispatcher.tick-failed'
  stopRequest?: Extract<RepositoryEvent, { type: 'dispatcher.stop-requested' }>
}
export function dispatcherRunFactsReducer(run: string) {
  return defineReducer<DispatcherRunFacts, RepositoryEvent, DispatcherRunFacts>({
    version: 3,
    initial: () => ({}),
    fold(acc, events) {
      for (const event of projectEvents(events)) {
        if (!('run' in event.payload) || event.payload.run !== run) continue
        foldDispatcherRunFact(acc, event)
      }
    },
    finish: (acc) => structuredClone(acc),
  })
}

function foldDispatcherRunFact(acc: DispatcherRunFacts, event: RepositoryEvent): void {
  if (event.type === 'dispatcher.run-started') {
    acc.start ??= event
    acc.latestStart = event
  } else if (event.type === 'dispatcher.runtime-recorded') acc.runtime = event
  else if (event.type === 'dispatcher.run-stopped') acc.stop = event
  else if (event.type === 'dispatcher.stop-requested') acc.stopRequest ??= event
  else if (
    event.type === 'dispatcher.tick-started' ||
    event.type === 'dispatcher.tick-completed' ||
    event.type === 'dispatcher.tick-failed'
  ) {
    acc.boundary = event.type
    if (event.type !== 'dispatcher.tick-started') acc.tick = event
    if (event.type === 'dispatcher.tick-completed') acc.completed = event
  }
}
