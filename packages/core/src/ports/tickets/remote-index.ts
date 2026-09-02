export { HostedTicketSource } from './remote'
export type { HostedTicketFetch, HostedTicketSourceOptions } from './remote'
export { createTicketServer } from './remote-server'
export type { TicketServerOptions } from './remote-server'
export {
  HOSTED_TICKET_OPERATIONS,
  hostedTicketContextSchema,
  hostedTicketRequestSchemas,
} from './remote-protocol'
export type { HostedTicketContext, HostedTicketOperation } from './remote-protocol'
// The hosted service composes the already live-proven Linear adapter; provider
// credentials remain server-side.
export { LinearTicketSource } from './linear'
