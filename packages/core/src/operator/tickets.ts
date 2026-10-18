import { updateTicketTarget } from '../kernel/node-parent'
import { projectTicketTree, compatibleTicketSource } from '../ports/tickets/tree'
import { readBuildFacts } from '../store/reduced-reads'
import { samplePinnedAssets, preparePinnedAssets } from '../store/ticket-assets'
import type { TicketRef } from '../ontology'
import type { Config } from '../config/schema'
import {
  TicketOperationError,
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
  baseBranch?: string
  teamKey: string
  claimedState?: string
  createState?: string
}

export interface OperatorTicketBackend {
  supportsNodeRetarget?(context: OperatorTicketContext): Promise<boolean>

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
    baseBranch: config.baseBranch,
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
  return { context, source: compatibleTicketSource(await opts.backend.sourceFor(context)) }
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
  source: TicketSource,
  configuredSource: string,
): Promise<OperatorTicketBuild | null> {
  // The service's database adapter implements the externally named hosted source.
  const hosted =
    source.name === 'hosted' || (configuredSource === 'hosted' && source.name === 'database')
  const candidates = (await store.listBuilds()).filter(
    (record) =>
      record.repo === repo &&
      (record.ticket?.source === source.name || (hosted && record.ticket?.source === 'hosted')),
  )
  const matches = candidates.filter((record) => record.ticket!.id === id)
  // The service database store always projects current ids, even when there is
  // no matching build. Only a hosted client over an unprojected legacy store
  // needs fallback lookups; failure must not undo a mutation.
  if (matches.length === 0 && source.name === 'hosted') {
    const identities = new Map<string, string>()
    try {
      for (const record of candidates) {
        const raw = record.ticket!.id
        if (!identities.has(raw)) {
          const ticket = await source.get(raw)
          identities.set(raw, ticket?.ref.source === source.name ? ticket.ref.id : raw)
        }
        if (identities.get(raw) === id) matches.push(record)
      }
    } catch {
      // Build association is optional presentation; keep the successful ticket result.
    }
  }
  const projected = await Promise.all(
    matches.map(async (record) => ({
      record,
      state: (await readBuildFacts(store, record.slug)).value.state,
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
  const { source, context } = await openOperatorTickets(opts)
  const ticket = await requireTicket(source, opts.id)
  const blockers = await source.dependencyStates(ticket.blockedBy ?? [])
  return {
    ticket,
    blockers,
    build: await matchingBuild(
      opts.store,
      opts.repo,
      ticket.ref.id,
      source,
      context.tickets.source,
    ),
  }
}

export async function mutateOperatorTicket(opts: {
  store: BuildStore
  repo: string
  backend: OperatorTicketBackend
  operation:
    | {
        kind: 'create'
        ticketKind?: import('../ports/types').TicketKind
        target?: string | null
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
  const { source, context } = await openOperatorTickets(opts)
  const operation = opts.operation
  if (operation.kind === 'update') await requireTicket(source, operation.id)
  const ticket =
    operation.kind === 'create'
      ? await createTicket(source, { ...operation, kind: operation.ticketKind })
      : operation.kind === 'update'
        ? (await (operation.patch.target === undefined
            ? updateTicket(source, operation.id, operation.patch, true, operation.expectedRevision)
            : updateTicketTarget(
                {
                  store: opts.store,
                  repo: opts.repo,
                  source,
                  configuredSource: context.tickets.source,
                  root:
                    context.baseBranch ??
                    (
                      await effectiveConfig(opts.store, opts.repo)
                    ).config.baseBranch,
                  supportsRetarget: async () => {
                    if (opts.backend.supportsNodeRetarget)
                      return opts.backend.supportsNodeRetarget(context)
                    const config = (await effectiveConfig(opts.store, opts.repo)).config
                    return config.forge === 'github' || config.forge === 'local-git'
                  },
                },
                operation.id,
                operation.patch,
                operation.expectedRevision,
              )))!
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
  return {
    ticket,
    blockers,
    build: await matchingBuild(
      opts.store,
      opts.repo,
      ticket.ref.id,
      source,
      context.tickets.source,
    ),
  }
}

export async function prepareOperatorTicketAssets(opts: {
  store: BuildStore
  repo: string
  backend?: OperatorTicketBackend
  ref: TicketRef
}) {
  if (!opts.backend) {
    if (opts.ref.source !== 'hosted') return samplePinnedAssets(opts.store, opts.repo, opts.ref.id)
    throw new Error('ticket operator backend is not configured')
  }
  const { context, source } = await openOperatorTickets({ ...opts, backend: opts.backend })
  if (context.tickets.source !== opts.ref.source)
    throw new Error('build ticket source differs from configured source')
  return preparePinnedAssets(source, opts.store, opts.repo, opts.ref.id)
}

export async function listOperatorTicketStates(opts: {
  store: BuildStore
  repo: string
  backend: OperatorTicketBackend
}) {
  const { source } = await openOperatorTickets(opts)
  if (!source.listStates)
    throw new TicketOperationError('refusal', `state discovery is not supported by ${source.name}`)
  return source.listStates()
}

export async function createOperatorTicketState(opts: {
  store: BuildStore
  repo: string
  backend: OperatorTicketBackend
  name: string
  about?: string
}) {
  const { source } = await openOperatorTickets(opts)
  if (!source.addState)
    throw new TicketOperationError('refusal', `state creation is not supported by ${source.name}`)
  try {
    return await source.addState(opts.name, opts.about === undefined ? {} : { about: opts.about })
  } catch (error) {
    throw new TicketOperationError(
      'refusal',
      error instanceof Error ? error.message : String(error),
    )
  }
}

/** Exhaustive source tree, including resolved tickets and listing diagnostics. */
export async function readTicketTree(source: TicketSource, root: string) {
  source = compatibleTicketSource(source)
  if (!source.listAll)
    throw new Error(
      `${source.name} cannot enumerate all tickets; use a source with listAll support`,
    )
  const listing = await source.listAll()
  return { ...projectTicketTree(listing.tickets, root), diagnostics: listing.diagnostics }
}

export async function getOperatorTicketTree(opts: {
  store: BuildStore
  repo: string
  backend: OperatorTicketBackend
}) {
  const { context, source } = await openOperatorTickets(opts)
  if (!context.baseBranch) throw new Error('Repository base branch unavailable')
  return readTicketTree(source, context.baseBranch)
}
