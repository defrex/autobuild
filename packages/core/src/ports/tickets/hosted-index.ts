// Client half of the hosted ticket source (SPEC §13): the TicketSource a
// local CLI drives against a hosted deployment. The HTTP server half ships
// in `@defrex/autobuild-hosted-store-service`.
export { HostedTicketSource, hostedTicketPolicy } from './remote'
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
  hostedTicketContextSchema,
  hostedTicketRequestSchemas,
  TICKET_REVISIONS_HEADER,
  TICKET_REVISIONS_CAPABILITY,
} from './remote-protocol'
export type { HostedTicketContext, HostedTicketOperation } from './remote-protocol'

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
