// Client half of the hosted ticket source (SPEC §13): the TicketSource a
// local CLI drives against a hosted deployment. The HTTP server half ships
// in `@defrex/autobuild-hosted-store-service`.
export { HostedTicketSource } from './remote'
export type { HostedTicketFetch, HostedTicketSourceOptions } from './remote'
export {
  HOSTED_TICKET_OPERATIONS,
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
