import { ticketLifecycle } from '../ports/tickets/lifecycle'
/** Adapt an already-constructed ticket source to the registry backend without
 * reading a checkout's configuration. Lifecycle names come from the same
 * effective configuration used to construct that source. */
import type { Config } from '../config/schema'
import type { OperatorTicketBackend, OperatorTicketContext } from './tickets'
import type { TicketSource } from '../ports/types'

export function ticketBackendFromSource(options: {
  source: TicketSource
  config: Config
}): OperatorTicketBackend {
  return {
    sourceFor: (_context: OperatorTicketContext) => options.source,
    statesFor: async (_context: OperatorTicketContext, source: TicketSource): Promise<string[]> => {
      if (source.listStates) return (await source.listStates()).map((s) => s.name)
      const tickets = options.config.tickets
      const lifecycle = ticketLifecycle(tickets)
      const states =
        tickets.source === 'hosted'
          ? Object.values(lifecycle)
          : [
              lifecycle.triage,
              tickets.readyState,
              tickets.createState,
              tickets.claimedState,
              tickets.doneState,
              lifecycle.proposal,
            ].filter(
              (state): state is string => typeof state === 'string' && state.trim().length > 0,
            )
      return [...new Set(states)]
    },
  }
}
