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
export { abDispatch } from '../cli/dispatch'
export { abWatch } from '../cli/watch'
export { abTicket, type TicketSourceFactory } from '../cli/ticket'
export { createTerminalModeController } from '../cli/terminal-restore'
export { abBuildControl, type BuildControlAction } from '../cli/build-control'
export { abBulkControl } from '../cli/bulk-control'
export { createTicketSource } from '../ports/tickets/create'
export { createOperatorSandboxService } from '../operator/sandbox'
export { parseConfig } from '../config/load'
export { spawnExec, type Exec } from '../ports/workspace/git-worktree'
export { readEventsWithWait } from '../store/streams/wait'
export { textContent } from '../store/types'
export {
  CONFIG_TOML,
  happyHandlers,
  makeHarness,
  readyTicket,
  typesOf,
  type E2eHarness,
} from '../integration/harness'
