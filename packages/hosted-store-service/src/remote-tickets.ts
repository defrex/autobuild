// The hosted ticket-source server (the client half lives in core's
// `@defrex/autobuild/hosted-tickets`), plus the protocol and ticket sources
// the deployment composes.
export { createTicketServer } from './ticket-server'
export type { TicketServerOptions } from './ticket-server'
export { HostedTicketSource, LinearTicketSource } from '@defrex/autobuild/hosted-tickets'
export type { HostedTicketFetch, HostedTicketSourceOptions } from '@defrex/autobuild/hosted-tickets'
export {
  HOSTED_TICKET_OPERATIONS,
  hostedTicketContextSchema,
  hostedTicketRequestSchemas,
} from '@defrex/autobuild/hosted-tickets'
export type {
  HostedTicketContext,
  HostedTicketOperation,
} from '@defrex/autobuild/hosted-tickets'
