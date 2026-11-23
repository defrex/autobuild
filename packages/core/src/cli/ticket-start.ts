import type { TicketStartPriority } from '../events/repository'
import { cancelTicketStart, requestTicketStart } from '../operator/ticket-start'
import type { TicketSource } from '../ports/types'
import { buildControlUser } from './build-control'
import { withSessionlessStore, type SessionlessStoreOpts } from './store-opening'

/** `ab start <ticket-id> [--priority manual|urgent|normal] [--cancel]`: record
 * or cancel a durable request that the running dispatcher start one ticket,
 * even while intake is off. */
export async function abTicketStart(
  opts: SessionlessStoreOpts & {
    id: string
    cancel?: boolean
    priority?: TicketStartPriority
    json?: boolean
    stdout: (line: string) => void
    ticketSource: () => Promise<TicketSource>
  },
): Promise<void> {
  if (['AB_BUILD', 'AB_SESSION', 'AB_HARVEST'].some((name) => opts.env[name]?.trim()))
    throw new Error('ab start requires an operator outside a build or harvest session')
  if (!opts.id.trim()) throw new Error('a ticket id is required')
  if (opts.cancel && opts.priority !== undefined)
    throw new Error('ab start: --priority applies to a request, not to --cancel')
  const source = await opts.ticketSource()
  await withSessionlessStore(opts, async ({ store, repo }) => {
    const control = { store, repo, source, id: opts.id, user: buildControlUser(opts.env) }
    if (opts.cancel) {
      const result = await cancelTicketStart(control)
      opts.stdout(
        opts.json
          ? JSON.stringify(result)
          : result.cancelled
            ? `start request for ${result.ticket.id} cancelled`
            : `no pending start request for ${opts.id}`,
      )
      return
    }
    const result = await requestTicketStart({
      ...control,
      ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
    })
    opts.stdout(
      opts.json
        ? JSON.stringify(result)
        : result.updated
          ? `start request for ${result.ticket.id} now ${result.priority} priority (request ${result.request})`
          : result.existing
            ? `start request for ${result.ticket.id} already pending at ${result.priority} priority since ${result.requestedAt}`
            : `start requested for ${result.ticket.id} at ${result.priority} priority (request ${result.request}); the dispatcher claims it on its next tick with a free slot in its tier, even while intake is off`,
    )
  })
}
