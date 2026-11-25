// Client half of the hosted ticket source (SPEC §13): the TicketSource a
// local CLI drives against a hosted deployment. The HTTP server half ships
// in `@defrex/autobuild-hosted-store-service`.
export { HostedTicketPagingError, HostedTicketSource, hostedTicketPolicy } from './remote'
export type { HostedTicketFetch, HostedTicketSourceOptions } from './remote'
export {
  HOSTED_TICKET_OPERATIONS,
  TICKET_TREE_HEADER,
  TICKET_TREE_CAPABILITY,
  TICKET_COMMENTS_HEADER,
  TICKET_COMMENTS_CAPABILITY,
  TICKET_ISSUE_LINKS_HEADER,
  TICKET_ISSUE_LINKS_CAPABILITY,
  TICKET_PRIORITY_HEADER,
  TICKET_PRIORITY_CAPABILITY,
  TICKET_DEPENDENCY_STATE_HEADER,
  TICKET_DEPENDENCY_STATE_CAPABILITY,
  TICKET_POLICY_ROLES_HEADER,
  TICKET_POLICY_ROLES_CAPABILITY,
  TICKET_POLICY_CREATE_LABELS_HEADER,
  TICKET_POLICY_CREATE_LABELS_CAPABILITY,
  TICKET_TARGETING_HEADER,
  TICKET_TARGETING_CAPABILITY,
  TICKET_TARGETING_PROBE_NODE,
  TICKET_PAGING_HEADER,
  TICKET_PAGING_CAPABILITY,
  ticketPageWireSchema,
  TICKET_SEARCH_HEADER,
  TICKET_SEARCH_CAPABILITY,
  ticketSearchPageWireSchema,
  hostedTicketContextSchema,
  hostedTicketRequestSchemas,
  TICKET_REVISIONS_HEADER,
  TICKET_REVISIONS_CAPABILITY,
} from './remote-protocol'
export type { HostedTicketContext, HostedTicketOperation } from './remote-protocol'

export {
  searchTerms,
  searchTickets,
  TicketSearchCursorInvalid,
  TicketSearchUnsupported,
} from './search'

export {
  TicketRevisionConflict,
  TicketRevisionUnsupported,
  mutateTicketIfRevision,
} from './revision'
export { TicketIssueLinksUnsupported, refuseUnsupportedIssueLinks } from './issue-links'
export {
  TicketPriorityUnsupported,
  refuseUnsupportedPriority,
  withoutUnsupportedPriority,
  ticketPriority,
  urgentFirst,
  type TicketPriority,
} from './priority'
export { TicketAssigneesUnsupported } from './assignees'

export {
  hostedTicketPolicySchema,
  projectTicketPolicy,
  publishedTicketPolicy,
  type HostedTicketPolicy,
} from './remote-protocol'
export { ticketLifecycle } from './lifecycle'

export {
  matchStateNames,
  orderStates,
  resolveState,
  validateStateName,
  validateStatePurpose,
} from './states'

export { hostedRequestedIds, MAX_TICKET_NUMBER } from './requested-id'
