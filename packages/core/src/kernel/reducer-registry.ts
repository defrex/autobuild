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
import { buildDigestReducer } from '../store/digest'
import { repositoryStateEventsReducer } from '../store/repo-state-events'
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
  // biome-ignore lint/suspicious/noExplicitAny: the registry is heterogeneous
  reducer: IncrementalReducer<any, any, any>
  /** The whole-array functions (or private methods) this reducer backs. */
  covers: readonly string[]
}

/** Parameterized reducers are registered with representative arguments; the
 * accumulator shape does not depend on them. */
export const REDUCERS: Record<string, RegisteredReducer> = {
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
  openExecution: { reducer: openExecutionReducer, covers: ['openExecution'] },
  lastExecutionOutcome: { reducer: lastExecutionOutcomeReducer, covers: ['lastExecutionOutcome'] },
  openHarvestExecutions: {
    reducer: openHarvestExecutionsReducer,
    covers: ['openHarvestExecutions'],
  },
  openTick: { reducer: openTickReducer('run-a'), covers: ['hasOpenTick'] },
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
    covers: ['openBuildWorkspace', 'openWorkspace', 'forgeWorkspacePath'],
  },
  baseBranch: { reducer: baseBranchReducer, covers: ['baseBranchOf'] },
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
  autoMergeDefault: { reducer: autoMergeDefaultReducer, covers: ['latestAutoMergeDefault'] },
  pinnedAssets: { reducer: pinnedAssetsReducer, covers: ['findPinnedRevision'] },
}

/** Event-array functions that are deliberately not reducers, each with the
 * concrete reason. */
export const EXCLUDED: Record<string, string> = {
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
