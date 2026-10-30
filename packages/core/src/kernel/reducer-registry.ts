import { ticketPreparationReducer } from './ticket-preparation'
import { ticketMigrationsReducer } from './ticket-migrations'
import { dispatchUpgradeReducer } from './dispatch-upgrade'
import { forgeHealthReducer } from './forge-health'
import { decodeStoredEvent } from '../events/compatibility'
import { nodeRestackReducer } from './node-restack-state'
import { leafRestackReducer } from './leaf-restack-state'
import { terminalGuardReducer } from './terminal-guard'
import { repositoryAttentionReducer } from './repository-attention'
import {
  dispatcherRunFactsReducer,
  buildStreamSeedReducer,
  buildReadFactsReducer,
  repositoryReadFactsReducer,
  optionalValue,
} from './read-facts'
import { validateAccumulator, encodeReducerValue } from '../store/reducer-value-validation'
import {
  effectiveConfigReducer,
  buildDelegationReducer,
  harvestDelegationReducer,
} from './service-facts'
import { phaseSchema } from '../ontology'
import { z } from 'zod'
import { dispatchPlacementReducer } from './dispatch-placement'
import type { ValueCatalogEntry } from '../store/reducer-values'
import { dispatchFrontendReducer } from '../cli/dispatch-repository-feed'
import { executionNoProgressReducer } from '../processes/execution-no-progress'
import { summaryBoundaryReducer, summaryRequestsReducer } from './pr-summary'
import { dispatchFailureBudgetReducer } from '../processes/dispatch-failure-budget'
import { ticketSourceHealthReducer } from './ticket-source-health'
/**
 * Every incremental reducer, with its published version and the whole-array
 * functions it backs. `reducer-registry.test.ts` snapshots the versions and
 * the accumulator shapes, and scans `kernel/`, `store/` and `processes/` so a
 * new event-array projection must be registered here or excluded with a reason.
 */
import { recordedBaseShaReducer } from '../config/pipeline-source'
import { openWorkspaceReducer } from '../processes/build-execution-state'
import {
  phaseFailuresReducer,
  publishedBranchHeadReducer,
  setupStreakReducer,
  verifyDiffBaseReducer,
} from '../processes/build-runner'
import {
  baseBranchReducer,
  openBuildWorkspaceReducer,
  provisionMarkerReducer,
  recoveryCheckpointReducer,
} from '../processes/dispatcher-selectors'
import {
  lastExecutionOutcomeReducer,
  openExecutionReducer,
} from '../processes/execution-settlement'
import { openHarvestExecutionsReducer } from '../processes/harvest-execution-state'
import { infrastructureFailureResetReducer } from '../processes/infrastructure-failure-budget'
import { publicationStateReducer } from '../processes/publication-state'
import { sandboxStatesReducer } from '../processes/sandbox-state'
import { openTickReducer } from '../processes/tick-state'
import { dashboardFactsReducer } from '../cli/dashboard/facts'
import { buildDigestReducer } from '../store/digest'
import { journalViewReducer, repositoryStateEventsReducer } from '../store/repo-state-events'
import { sessionReducer } from '../store/session-reducer'
import { pinnedAssetsReducer } from '../store/ticket-assets'
import { autoMergeDefaultReducer } from './auto-merge-default'
import { currentDeferralObservationReducer } from './auto-merge'
import { dispatchSettingsReducer } from './dispatch-settings'
import { dispatchStatusReducer } from './dispatch-status'
import { harvestReducer } from './harvest'
import type { IncrementalReducer } from './incremental'
import { logIndexReducer } from './log-index'
import {
  currentPrAttachmentsReducer,
  frozenPrImageHostReducer,
  hostedPrAttachmentsReducer,
  pendingPrAttachmentReclaimsReducer,
} from './pr-attachments'
import { buildReducer } from './reducer'

export interface RegisteredReducer {
  valueRead: ValueCatalogEntry | { excluded: string }
  // biome-ignore lint/suspicious/noExplicitAny: the registry is heterogeneous
  reducer: IncrementalReducer<any, any, any>
  /** The whole-array functions (or private methods) this reducer backs. */
  covers: readonly string[]
}

/** Parameterized reducers are registered with representative arguments; the
 * accumulator shape does not depend on them. */
const REGISTERED: Record<string, Omit<RegisteredReducer, 'valueRead'>> = {
  ticketPreparation: { reducer: ticketPreparationReducer, covers: [] },
  ticketMigrations: { reducer: ticketMigrationsReducer, covers: [] },
  nodeRestack: { reducer: nodeRestackReducer, covers: ['advanceNodeRestack'] },
  leafRestack: { reducer: leafRestackReducer, covers: ['advanceLeafRestack'] },
  baseBranchValue: { reducer: optionalValue(baseBranchReducer), covers: [] },
  publishedBranchHeadValue: { reducer: optionalValue(publishedBranchHeadReducer), covers: [] },
  verifyDiffBaseValue: { reducer: optionalValue(verifyDiffBaseReducer), covers: [] },
  recordedBaseShaValue: { reducer: optionalValue(recordedBaseShaReducer), covers: [] },
  terminalGuard: {
    reducer: terminalGuardReducer({ phase: 'plan', round: 1, session: 'session' }),
    covers: [],
  },
  dispatcherRunFacts: { reducer: dispatcherRunFactsReducer('run-a'), covers: [] },
  dispatchUpgrade: { reducer: dispatchUpgradeReducer, covers: [] },
  repositoryAttention: { reducer: repositoryAttentionReducer, covers: [] },
  repositoryReadFacts: { reducer: repositoryReadFactsReducer, covers: [] },
  buildStreamSeed: { reducer: buildStreamSeedReducer, covers: [] },
  buildReadFacts: { reducer: buildReadFactsReducer, covers: [] },
  effectiveConfig: { reducer: effectiveConfigReducer, covers: [] },
  buildDelegation: { reducer: buildDelegationReducer, covers: [] },
  harvestDelegation: { reducer: harvestDelegationReducer, covers: [] },
  dispatchFrontend: { reducer: dispatchFrontendReducer, covers: [] },
  executionNoProgress: { reducer: executionNoProgressReducer, covers: [] },
  summaryBoundary: { reducer: summaryBoundaryReducer, covers: ['summaryBoundary'] },
  summaryRequests: { reducer: summaryRequestsReducer, covers: ['pendingSummaryRequests'] },
  ticketSourceHealth: { reducer: ticketSourceHealthReducer, covers: ['reduceTicketSourceHealth'] },
  build: { reducer: buildReducer, covers: ['reduceBuild'] },
  harvest: { reducer: harvestReducer, covers: ['reduceHarvest'] },
  dispatchSettings: { reducer: dispatchSettingsReducer, covers: ['reduceDispatchSettings'] },
  dispatchStatus: { reducer: dispatchStatusReducer('run-a'), covers: ['reduceDispatchStatus'] },
  session: { reducer: sessionReducer, covers: ['reduceSession'] },
  buildDigest: { reducer: buildDigestReducer, covers: ['reduceBuildDigest'] },
  sandboxStates: { reducer: sandboxStatesReducer, covers: ['sandboxStates'] },
  logIndex: { reducer: logIndexReducer, covers: ['indexLog'] },
  frozenPrImageHost: { reducer: frozenPrImageHostReducer, covers: ['frozenPrImageHost'] },
  currentPrAttachments: { reducer: currentPrAttachmentsReducer, covers: ['currentPrAttachments'] },
  hostedPrAttachments: { reducer: hostedPrAttachmentsReducer, covers: ['hostedPrAttachments'] },
  pendingPrAttachmentReclaims: {
    reducer: pendingPrAttachmentReclaimsReducer,
    covers: ['pendingPrAttachmentReclaims'],
  },
  publicationState: {
    reducer: publicationStateReducer,
    covers: [
      'publicationRequestCompleted',
      'publicationRequestSettled',
      'latestUncompletedPublicationRequest',
      'publicationLostRecorded',
      'abandonedPublicationPending',
      'publicationPending',
    ],
  },
  repositoryStateEvents: {
    reducer: repositoryStateEventsReducer,
    covers: ['projectRepositoryStateEvents'],
  },
  journalView: { reducer: journalViewReducer, covers: [] },
  openExecution: { reducer: openExecutionReducer, covers: ['openExecution'] },
  lastExecutionOutcome: { reducer: lastExecutionOutcomeReducer, covers: ['lastExecutionOutcome'] },
  openHarvestExecutions: {
    reducer: openHarvestExecutionsReducer,
    covers: ['openHarvestExecutions'],
  },
  openTick: { reducer: openTickReducer('run-a'), covers: ['hasOpenTick'] },
  dispatchFailureBudget: {
    reducer: dispatchFailureBudgetReducer(false),
    covers: ['dispatchFailureBudget'],
  },
  infrastructureFailureReset: {
    reducer: infrastructureFailureResetReducer,
    covers: ['infrastructureFailureResetSeq'],
  },
  openWorkspace: { reducer: openWorkspaceReducer, covers: ['selectOpenWorkspace'] },
  publishedBranchHead: {
    reducer: publishedBranchHeadReducer,
    covers: ['selectPublishedBranchHead'],
  },
  verifyDiffBase: { reducer: verifyDiffBaseReducer, covers: ['selectVerifyDiffBase'] },
  recordedBaseSha: { reducer: recordedBaseShaReducer, covers: [] },
  setupStreak: { reducer: setupStreakReducer, covers: ['setupStreak'] },
  phaseFailures: { reducer: phaseFailuresReducer('plan', 1), covers: ['phaseFailures'] },
  openBuildWorkspace: {
    reducer: openBuildWorkspaceReducer,
    covers: ['openBuildWorkspace'],
  },
  baseBranch: { reducer: baseBranchReducer, covers: [] },
  provisionMarker: { reducer: provisionMarkerReducer, covers: ['openProvisionMarker'] },
  recoveryCheckpoint: { reducer: recoveryCheckpointReducer, covers: ['recoveryCheckpoint'] },
  currentDeferralObservation: {
    reducer: currentDeferralObservationReducer,
    covers: [
      'currentDeferralObservation',
      'hasAutoMergeDeferralObservation',
      'currentAutoMergeDeferral',
    ],
  },
  dashboardFacts: {
    reducer: dashboardFactsReducer,
    covers: ['phaseIntervals', 'projectSessions'],
  },
  autoMergeDefault: { reducer: autoMergeDefaultReducer, covers: ['latestAutoMergeDefault'] },
  pinnedAssets: { reducer: pinnedAssetsReducer, covers: ['findPinnedRevision'] },
  forgeHealthValue: { reducer: optionalValue(forgeHealthReducer), covers: [] },
  dispatchPlacement: { reducer: dispatchPlacementReducer, covers: [] },
}

/** Qualification concerns the existing finished contract, including absence. */
const valueExclusions: Record<string, string> = {
  dispatchFrontend: 'returns a list of raw repository journal events',
  journalView: 'returns a list of raw repository journal events',
  repositoryStateEvents: 'returns a list of raw repository journal events',
  session: 'consumes operator-session logs rather than build or repository events',
  publicationState: 'finished value contains executable selector functions',
  logIndex: 'finished value contains Maps and Sets',
  hostedPrAttachments: 'finished value is a Map',
  ...Object.fromEntries(
    [
      'summaryBoundary',
      'ticketSourceHealth',
      'frozenPrImageHost',
      'publishedBranchHead',
      'verifyDiffBase',
      'recordedBaseSha',
      'baseBranch',
      'provisionMarker',
      'recoveryCheckpoint',
    ].map((name) => [name, 'finished contract can return top-level undefined, which is not JSON']),
  ),
}
const repositoryValues = new Set([
  'dispatchPlacement',
  'ticketPreparation',
  'ticketMigrations',
  'forgeHealthValue',
  'repositoryReadFacts',
  'dispatchUpgrade',
  'dispatcherRunFacts',
  'repositoryAttention',
  'effectiveConfig',
  'harvestDelegation',
  'harvest',
  'dispatchSettings',
  'dispatchStatus',
  'sandboxStates',
  'openHarvestExecutions',
  'openTick',
  'autoMergeDefault',
])
const noArgs = z.object({}).strict()
const parameterized: Record<string, Pick<ValueCatalogEntry, 'args' | 'create'>> = {
  terminalGuard: {
    args: z
      .object({ phase: phaseSchema, round: z.number().int(), session: z.string().min(1) })
      .strict(),
    create: (args) => terminalGuardReducer(args),
  },
  dispatchStatus: {
    args: z.object({ run: z.string().min(1) }).strict(),
    create: ({ run }) => dispatchStatusReducer(run),
  },
  dispatcherRunFacts: {
    args: z.object({ run: z.string().min(1) }).strict(),
    create: ({ run }) => dispatcherRunFactsReducer(run),
  },
  openTick: {
    args: z.object({ run: z.string().min(1) }).strict(),
    create: ({ run }) => openTickReducer(run),
  },
  dispatchFailureBudget: {
    args: z.object({ infrastructureOwnsWorkspace: z.boolean() }).strict(),
    create: ({ infrastructureOwnsWorkspace }) =>
      dispatchFailureBudgetReducer(infrastructureOwnsWorkspace),
  },
  phaseFailures: {
    args: z.object({ phase: phaseSchema, round: z.number().int().nonnegative() }).strict(),
    create: ({ phase, round }) => phaseFailuresReducer(phase, round),
  },
}
export const REDUCERS: Record<string, RegisteredReducer> = Object.fromEntries(
  Object.entries(REGISTERED).map(([name, entry]) => [
    name,
    {
      ...entry,
      valueRead: valueExclusions[name]
        ? { excluded: valueExclusions[name] }
        : {
            scope: repositoryValues.has(name) ? 'repo' : 'build',
            args: parameterized[name]?.args ?? noArgs,
            validate: (state: unknown) => validateAccumulator(name, state),
            value: encodeReducerValue,
            adapt: (events: Parameters<ValueCatalogEntry['adapt']>[0]) =>
              name === 'buildDigest'
                ? events.map((event) => ({
                    ...(decodeStoredEvent(event) === null ? { rawUnknown: event } : {}),
                    type: event.type,
                    seq: event.seq,
                    ts: event.ts,
                    ...(event.payload !== null &&
                    typeof event.payload === 'object' &&
                    'hostedSeq' in event.payload
                      ? { hostedSeq: event.payload.hostedSeq }
                      : {}),
                    ...(event.type === 'integration.landed'
                      ? { auditRequested: !!event.payload.operation }
                      : {}),
                    ...(event.type === 'pr.merged' ? { mergedSha: event.payload.sha } : {}),
                    ...(event.type === 'node.contribution-recorded'
                      ? { nodeContribution: event.payload }
                      : {}),
                    ...(event.type === 'build.created' ? { kind: event.payload.kind } : {}),
                    ...(event.payload !== null &&
                    typeof event.payload === 'object' &&
                    'instance' in event.payload
                      ? { instance: event.payload.instance }
                      : {}),
                  }))
                : events,
            create: parameterized[name]?.create ?? (() => entry.reducer),
          },
    },
  ]),
)

/** Event-array functions that are deliberately not reducers, each with the
 * concrete reason. */
export const EXCLUDED: Record<string, string> = {
  referencedGitTips:
    'Pure one-event Git tip extraction used by the persisted buildReadFacts fold; not a current-state replay.',
  continuePreparation:
    'Async Git/store effects resuming one durable replay transaction; not an event-only projection.',
  shouldPublishTick:
    'Publication decision over a new report and actual start time plus the bounded recorded journal; no event-only reduction can decide whether an unrecorded tick has effects.',
  projectDispatcherLiveness:
    'combines mutable repository lease metadata and an explicit clock with correlated facts; cannot be restored from an event-only snapshot',
  decideNext: 'a decision function over config; returns a Decision, not a state',
  harvestCreationsDuringReadyScan:
    'a derived query over two reduceHarvest states (before/after), which is already incremental',
  classifyHarvestOutcome: 'a decision over reduceHarvest state plus an input; returns a result',
  collectUnclaimedObservations:
    'composes reduceBuild/reduceHarvest over a store-shaped per-build map',
  unclaimedObservationCount: 'composes digests and reduceHarvest over store-shaped input',
  evaluateHarvestPressureFromDigests: 'a decision over digests and reduceHarvest state',
  evaluateHarvestPressureFromStore: 'async; reads the store',
  settleExecution: 'async; writes the store',
  settlePublicationBeforeRelease: 'async; writes the store',
  recordInfrastructureFailure: 'async; writes the store',
  ensureProvisionContinuation: 'async; reads and writes the store and provider',
  cleanupAborted: 'async; reads and writes the store and provider',
  cleanupDiscarded: 'async; reads and writes the store and provider',
  checkPr: 'async; forge and store',
  reapStaleWorkspace: 'async; provider and store',
  reclaimPrAttachments: 'async; forge and store',
  releaseWorkspace: 'async; provider and store',
  checkReconcileProgress: 'async; git and store',
  evaluateVerify: 'async; runs verify steps',
  reclaimSessionsAndAttach: 'async; store',
  refreshReconcileBase: 'async; git and store',
  repairEscalateGap: 'async; store',
  runAgentVerify: 'async; runs an agent',
  runFinalizeStep: 'async; runs a step',
  runPhase: 'async; runs an agent phase',
}
