/**
 * Public testing entry point: the deterministic doubles, CLI entry points,
 * and the end-to-end harness that out-of-tree packages' tests build against
 * (the hosted store-service suite is the in-repo consumer). Production code
 * never imports from here — it is test-facing surface, like plugin-sdk's
 * fakes, just CLI-shaped.
 */
// The plugin-sdk's contract suites, fakes, and memory stores are the shared
// testing vocabulary; re-export so `@defrex/autobuild/testing` is one import.
export * from '../plugin-sdk'
export { manualClock, steppingClock } from './fixed'
export { agentActor, DISPATCHER, KERNEL, humanActor, type Via } from '../events/envelope'
export { EventValidationError } from '../events/catalog'
export type { EscalationSource } from '../ontology'
export { abDispatch, type DispatchOpts } from '../cli/dispatch'
// CLI entry points for the hosted-dispatcher integration test: programmatic
// `ab` invocation and its environment resolution.
export { resolveCliEnv } from '../cli/env'
export { runCli } from '../cli/main'
// Deterministic id doubles for the hosted-dispatcher integration test.
export { randomUuids, sequentialIds, type IdSource } from '../ids'
export { abWatch } from '../cli/watch'
export { abTicket, type TicketSourceFactory } from '../cli/ticket'
export { createTerminalModeController } from '../cli/terminal-restore'
export { abBuildControl, type BuildControlAction } from '../cli/build-control'
export { abBulkControl } from '../cli/bulk-control'
export { createTicketSource } from '../ports/tickets/create'
export { createOperatorSandboxService } from '../operator/sandbox'
export { parseConfig } from '../config/load'
export { spawnExec, type Exec } from '../ports/workspace/git-worktree'
// Durable guest-launch state readers + the in-process guest runner for the
// hosted-dispatcher integration test's GuestExecution double, which supervises
// a real BuildRunner exactly as a real sandbox execution would.
export {
  BUILD_EFFECTIVE_CONFIG_ARTIFACT,
  diagnosticArtifact,
  parseEffectiveBuildConfig,
  selectOpenWorkspace,
} from '../processes/build-execution-state'
export {
  BuildRunner,
  LeaseHeldError,
  SetupFailureError,
} from '../processes/build-runner'
export { readEventsWithWait } from '../store/streams/wait'
export { textContent } from '../store/types'
export {
  CONFIG_TOML,
  GIT_ID,
  git,
  happyHandlers,
  makeHarness,
  readyTicket,
  typesOf,
  writeFileIn,
  type Cli,
  type E2eHarness,
  type SkillHandlers,
} from '../scenarios/harness'

// Harvest lifecycle and CLI seams for delegated-credential integration tests.
export { HarvestRunner } from '../processes/harvest-runner'
export { resolveHarvestCliEnv } from '../cli/env'
export { buildHarvestContext, submitHarvestProposals, submitHarvestVerdict } from '../cli/harvest'
export { abConnect, abDisconnect } from '../cli/connect'
export { ProjectCredentials } from '../cli/project-credentials'

export { dispatchReadBudget } from './dispatch-read-budget'

export {
  catalogSkewReadBudget,
  reducedReadBudget,
  countHistoricalRows,
  type ReducedReadCosts,
} from './reduced-read-budget'

export { gitRewrite } from '../ports/forge/git-rewrite'

export { newerFact, seedNewerMemoryFact, NEWER_EVENT_TYPE } from './newer-writer'
export { READ_CATALOG_IDENTITY, catalogIdentity } from '../events/compatibility'
export { readBuildFacts, readBuildStreamSeed, readRepositoryFacts } from '../store/reduced-reads'
export { deferMixedVersion } from '../kernel/mixed-version'

export { guardForge } from '../kernel/guarded-forge'

// Node verification delivery seam exercised by the hosted authorization suite.
export { buildContext } from '../cli/context'
export { scopeLocalStoreToPhaseSession } from '../store/phase-session'
export {
  prepareNodeVerificationContext,
  NODE_VERIFICATION_CONTEXT,
} from '../kernel/node-verification-context'

export { temporaryDirectories, temporaryOriginScratch } from './temp-directories'
