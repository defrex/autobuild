import type { Config } from '../config/schema'
import { reduceBuild } from '../kernel/reducer'
import {
  changeBlockers,
  createTicket,
  moveTicket,
  requireTicket,
  updateTicket,
} from '../ports/tickets/operations'
import type { DependencyState, Ticket, TicketSource, TicketUpdate } from '../ports/types'
import type { BuildStore } from '../store/types'
import { ticketLifecycle } from '../ports/tickets/lifecycle'
import { effectiveConfig } from './query'

export interface OperatorTicketContext {
  repo: string
  tickets: Config['tickets']
  teamKey: string
  claimedState?: string
  createState?: string
}

export interface OperatorTicketBackend {
  contextFor?(repo: string): Promise<OperatorTicketContext>
  sourceFor(context: OperatorTicketContext): TicketSource | Promise<TicketSource>
  statesFor(context: OperatorTicketContext, source: TicketSource): string[] | Promise<string[]>
}

export interface OperatorTicketQueue {
  states: string[]
  tickets: Ticket[]
  diagnostics: string[]
  criteria: { state?: string; labels?: string[] }
  /** Effective repository lifecycle names; clients must not invent provider states. */
  triageState: string
  readyState: string
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
  return {
    repo,
    tickets,
    teamKey: tickets.teamKey ?? '',
    ...(tickets.claimedState !== undefined ? { claimedState: tickets.claimedState } : {}),
    ...(tickets.createState !== undefined ? { createState: tickets.createState } : {}),
  }
}

export async function openOperatorTickets(opts: {
  store: BuildStore
  repo: string
  backend: OperatorTicketBackend
}): Promise<{ context: OperatorTicketContext; source: TicketSource }> {
  const context = opts.backend.contextFor
    ? await opts.backend.contextFor(opts.repo)
    : contextFor((await effectiveConfig(opts.store, opts.repo)).config, opts.repo)
  return { context, source: await opts.backend.sourceFor(context) }
}

export async function listOperatorTickets(opts: {
  store: BuildStore
  repo: string
  backend: OperatorTicketBackend
  state?: string
  labels?: string[]
}): Promise<OperatorTicketQueue> {
  const { context, source } = await openOperatorTickets(opts)
  const triageState = ticketLifecycle(context.tickets).triage
  const readyState = context.tickets.readyState
  // The operator surface is a grooming queue. Unlike the CLI's ticket list,
  // labels narrow the default state instead of replacing its lifecycle gate.
  const criteria = {
    state: opts.state ?? triageState,
    ...(opts.labels !== undefined ? { labels: opts.labels } : {}),
  }
  const [listing, states] = await Promise.all([
    source.listReady(criteria),
    opts.backend.statesFor(context, source),
  ])
  return {
    states,
    tickets: listing.tickets,
    diagnostics: listing.diagnostics,
    criteria,
    triageState,
    readyState,
  }
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
    | { kind: 'update'; id: string; patch: TicketUpdate; expectedRevision?: string }
    | { kind: 'move'; id: string; state: string; expectedRevision?: string }
    | { kind: 'block' | 'unblock'; id: string; blockerIds: string[]; expectedRevision?: string }
}): Promise<OperatorTicketDetail> {
  const { source } = await openOperatorTickets(opts)
  const operation = opts.operation
  if (operation.kind === 'update') await requireTicket(source, operation.id)
  const ticket =
    operation.kind === 'create'
      ? await createTicket(source, operation)
      : operation.kind === 'update'
        ? (await updateTicket(
            source,
            operation.id,
            operation.patch,
            true,
            operation.expectedRevision,
          ))!
        : operation.kind === 'move'
          ? await moveTicket(source, operation.id, operation.state, operation.expectedRevision)
          : await changeBlockers(
              source,
              operation.id,
              operation.blockerIds,
              operation.kind,
              operation.expectedRevision,
            )
  const blockers = await source.dependencyStates(ticket.blockedBy ?? [])
  return { ticket, blockers, build: await matchingBuild(opts.store, opts.repo, ticket.ref.id) }
}
