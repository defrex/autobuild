import type { Config } from '../config/schema'
import { reduceBuild } from '../kernel/reducer'
import {
  changeBlockers,
  createTicket,
  moveTicket,
  requireTicket,
  ticketListCriteria,
  updateTicket,
} from '../ports/tickets/operations'
import type { DependencyState, Ticket, TicketSource, TicketUpdate } from '../ports/types'
import type { BuildStore } from '../store/types'
import { effectiveConfig, OperatorQueryError } from './query'

export interface OperatorTicketContext {
  teamKey: string
  claimedState?: string
  createState?: string
}

export interface OperatorTicketBackend {
  sourceFor(context: OperatorTicketContext): TicketSource | Promise<TicketSource>
  statesFor(context: OperatorTicketContext, source: TicketSource): string[] | Promise<string[]>
}

export interface OperatorTicketQueue {
  states: string[]
  tickets: Ticket[]
  diagnostics: string[]
  criteria: { state?: string; labels?: string[] }
}

export interface OperatorTicketBuild {
  slug: string
  status: string
  updatedAt: string
  link: string
}

export interface OperatorTicketDetail {
  ticket: Ticket
  blockers: DependencyState[]
  build: OperatorTicketBuild | null
}

function contextFor(config: Config, repo: string): OperatorTicketContext {
  const tickets = config.tickets
  if (tickets.teamKey === undefined) {
    throw new OperatorQueryError(
      'effective-config-unavailable',
      `effective config unavailable for repository "${repo}": [tickets].teamKey is required for hosted ticket access`,
    )
  }
  return {
    teamKey: tickets.teamKey,
    ...(tickets.claimedState !== undefined ? { claimedState: tickets.claimedState } : {}),
    ...(tickets.createState !== undefined ? { createState: tickets.createState } : {}),
  }
}

export async function openOperatorTickets(opts: {
  store: BuildStore
  repo: string
  backend: OperatorTicketBackend
}): Promise<{ config: Config; context: OperatorTicketContext; source: TicketSource }> {
  const { config } = await effectiveConfig(opts.store, opts.repo)
  const context = contextFor(config, opts.repo)
  return { config, context, source: await opts.backend.sourceFor(context) }
}

export async function listOperatorTickets(opts: {
  store: BuildStore
  repo: string
  backend: OperatorTicketBackend
  state?: string
  labels?: string[]
}): Promise<OperatorTicketQueue> {
  const { config, context, source } = await openOperatorTickets(opts)
  const criteria = ticketListCriteria(config, {
    ...(opts.state !== undefined ? { state: opts.state } : {}),
    ...(opts.labels !== undefined ? { labels: opts.labels } : {}),
  })
  const [listing, states] = await Promise.all([
    source.listReady(criteria),
    opts.backend.statesFor(context, source),
  ])
  return { states, tickets: listing.tickets, diagnostics: listing.diagnostics, criteria }
}

async function matchingBuild(
  store: BuildStore,
  repo: string,
  id: string,
): Promise<OperatorTicketBuild | null> {
  const matches = (await store.listBuilds()).filter(
    (record) => record.repo === repo && record.ticket?.id === id,
  )
  const projected = await Promise.all(
    matches.map(async (record) => ({
      record,
      state: reduceBuild(await store.getEvents(record.slug)),
    })),
  )
  projected.sort((a, b) => {
    const aActive = a.state.status !== 'done' && a.state.status !== 'aborted'
    const bActive = b.state.status !== 'done' && b.state.status !== 'aborted'
    if (aActive !== bActive) return aActive ? -1 : 1
    return b.record.updatedAt.localeCompare(a.record.updatedAt)
  })
  const found = projected[0]
  return found
    ? {
        slug: found.record.slug,
        status: found.state.status,
        updatedAt: found.record.updatedAt,
        link: `#build-${encodeURIComponent(found.record.slug)}`,
      }
    : null
}

export async function getOperatorTicket(opts: {
  store: BuildStore
  repo: string
  backend: OperatorTicketBackend
  id: string
}): Promise<OperatorTicketDetail> {
  const { source } = await openOperatorTickets(opts)
  const ticket = await requireTicket(source, opts.id)
  const blockers = await source.dependencyStates(ticket.blockedBy ?? [])
  return { ticket, blockers, build: await matchingBuild(opts.store, opts.repo, opts.id) }
}

export async function mutateOperatorTicket(opts: {
  store: BuildStore
  repo: string
  backend: OperatorTicketBackend
  operation:
    | {
        kind: 'create'
        title: string
        body: string
        labels?: string[]
        state?: string
        blockedBy?: string[]
      }
    | { kind: 'update'; id: string; patch: TicketUpdate }
    | { kind: 'move'; id: string; state: string }
    | { kind: 'block' | 'unblock'; id: string; blockerIds: string[] }
}): Promise<OperatorTicketDetail> {
  const { source } = await openOperatorTickets(opts)
  const operation = opts.operation
  if (operation.kind === 'update') await requireTicket(source, operation.id)
  const ticket =
    operation.kind === 'create'
      ? await createTicket(source, operation)
      : operation.kind === 'update'
        ? (await updateTicket(source, operation.id, operation.patch))!
        : operation.kind === 'move'
          ? await moveTicket(source, operation.id, operation.state)
          : await changeBlockers(source, operation.id, operation.blockerIds, operation.kind)
  const blockers = await source.dependencyStates(ticket.blockedBy ?? [])
  return { ticket, blockers, build: await matchingBuild(opts.store, opts.repo, ticket.ref.id) }
}
