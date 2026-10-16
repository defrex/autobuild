import { ticketLifecycle } from '../ports/tickets/lifecycle'
/**
 * A dispatcher ticket source as the registry's ticket backend (AUT-342):
 * the tick's turn runner takes an `OperatorToolRegistry`, and
 * `buildRegistry`'s ticket tools require an `OperatorTicketBackend` — but
 * the dispatcher's wiring holds a `TicketSource`, not a backend, and
 * `buildMcpTicketBackend` reads a checkout's autobuild.toml, which cannot
 * run in origin mode. This adapter hands the dispatcher's
 * already-constructed source straight through (it was built by
 * `createTicketSource` from the same effective `[tickets]` config the
 * `OperatorTicketContext` would derive, for the same repository) and derives
 * the workflow-state list from the effective config's lifecycle names.
 */
import type { Config } from '../config/schema'
import type { OperatorTicketBackend, OperatorTicketContext } from './tickets'
import type { TicketSource } from '../ports/types'

export function ticketBackendFromSource(options: {
  source: TicketSource
  config: Config
}): OperatorTicketBackend {
  return {
    sourceFor: (_context: OperatorTicketContext) => options.source,
    statesFor: (_context: OperatorTicketContext, _source: TicketSource): string[] => {
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
