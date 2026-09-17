// Core's operator surface: the tool registry behind `ab mcp`, the CLI-facing
// control/query/tickets/requests primitives, and the operator wire protocol.
// The operator HTTP server and client ship in
// `@defrex/autobuild-hosted-store-service` (see its `operator-api` subpath).
export {
  answerRequestSchema,
  buildControlRequestSchema,
  buildListScopeSchema,
  bulkControlRequestSchema,
  harvestControlRequestSchema,
  operatorErrorSchema,
  sessionApprovalRequestSchema,
  sessionCreateRequestSchema,
  sessionMessageRequestSchema,
  sessionWakeRequestSchema,
  settingRequestSchema,
  ticketBlockerRequestSchema,
  ticketCreateRequestSchema,
  ticketMoveRequestSchema,
  ticketUpdateRequestSchema,
} from './protocol'
export type {
  OperatorAnswerRequest,
  OperatorBuildControlRequest,
  OperatorErrorBody,
  OperatorSessionApprovalRequest,
  OperatorSessionCreateRequest,
  OperatorSessionMessageRequest,
  OperatorSessionWakeRequest,
  OperatorTicketBlockerRequest,
  OperatorTicketCreateRequest,
  OperatorTicketMoveRequest,
  OperatorTicketUpdateRequest,
} from './protocol'
export type {
  BuildListScope,
  OperatorBuildView,
  OperatorDashboardSnapshot,
} from './query'
export {
  controlHarvestRun,
  OperatorControlError,
  setRepositorySetting,
  toggleHarvestGate,
  toggleRepositorySetting,
} from './control'
export {
  getHarvestStatus,
  getOperatorBuild,
  getOperatorDashboard,
  getRepositoryStatus,
  listOperatorBuilds,
  OperatorQueryError,
} from './query'
export {
  OPERATOR_NOTES_ARTIFACT,
  TOOLS,
  attributed,
  buildRegistry,
  RegistryError,
} from './registry'
export type {
  OperatorToolRegistry,
  RegistryErrorReason,
  RegistryOptions,
  ToolApproval,
  ToolContext,
  ToolEntry,
  ToolFailureBody,
  ToolHandler,
} from './registry'
export { OPERATOR_TOOL_ANNOTATIONS } from './annotations'
export type { OperatorToolName, ToolAnnotationsTableEntry } from './annotations'
export type { RouteRefusal } from './requests'
export { RouteRefusalError } from './requests'
export type {
  OperatorTicketBackend,
  OperatorTicketBuild,
  OperatorTicketContext,
  OperatorTicketDetail,
  OperatorTicketQueue,
} from './tickets'
export {
  getOperatorTicket,
  listOperatorTickets,
  mutateOperatorTicket,
} from './tickets'
export type { OperatorSandboxService } from './sandbox'
export * from './presentation'

/**
 * Hosted operator-server composition. The moved server (in
 * `@defrex/autobuild-hosted-store-service`) builds its routes from these core
 * primitives; they are re-exported here so the hosted package needs no core
 * internals. Deliberately not a general public API — do not grow it for
 * core-internal convenience.
 */
export {
  BuildControlError,
  controlBuild,
  type BuildControlAction,
  type BuildControlResult,
} from '../cli/build-control'
export {
  BulkWalkError,
  bulkControlRepository,
  type BulkControlSummary,
} from '../cli/bulk-control'
export { effectiveStatus } from '../cli/dashboard/model'
export { reduceBuild } from '../kernel/reducer'
export { TicketOperationError } from '../ports/tickets/operations'
export { humanActor, type Via } from '../events/envelope'
export type { HarvestStatusView } from '../cli/harvest'
export type { RepositoryStatus } from '../cli/repository-status'
export type { BuildSummary } from '../cli/status'
export type { SessionRecord } from '../store/types'
