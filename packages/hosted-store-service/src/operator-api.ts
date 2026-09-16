// The operator API's client face (the server half is ./operator-server).
// Re-exports the request schemas and view types the web app and dispatcher
// consume alongside the client, so hosted consumers need only this subpath.
export { OperatorApiClient, OperatorApiError } from './operator-client'
export type { DownloadedArtifact, OperatorApiClientOptions } from './operator-client'
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
} from '@defrex/autobuild/operator'
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
} from '@defrex/autobuild/operator'
export type {
  BuildListScope,
  OperatorBuildView,
  OperatorDashboardSnapshot,
} from '@defrex/autobuild/operator'
