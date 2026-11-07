import { compatibleTicketSource, normalizeSourceTicket } from './tree'
import {
  normalizeIssueLinks,
  refuseUnsupportedIssueLinks,
  TicketIssueLinksUnsupported,
} from './issue-links'
import { refuseUnsupportedPriority, TicketPriorityUnsupported } from './priority'
import {
  mutateTicketIfRevision,
  TicketRevisionConflict,
  TicketRevisionUnsupported,
} from './revision'
import type { Config, TicketsConfig } from '../../config/schema'
import { holdsState, TICKET_MOVE_ROLES, ticketLifecycle, type TicketMoveRole } from './lifecycle'
import { readyCriteria } from '../../processes/dispatcher'
import type { Ticket, TicketDraft, TicketSource, TicketUpdate } from '../types'

/** Expected ticket-operation failures which operator transports may expose verbatim. */
export class TicketOperationError extends Error {
  constructor(
    readonly code: 'not-found' | 'refusal',
    message: string,
  ) {
    super(message)
    this.name = 'TicketOperationError'
  }
}

export function missingTicket(source: TicketSource, id: string): TicketOperationError {
  return new TicketOperationError(
    'not-found',
    `no ticket "${id}" in the configured ${source.name} ticket source — ticket ids are source-local`,
  )
}

export async function requireTicket(source: TicketSource, id: string): Promise<Ticket> {
  const ticket = await source.get(id)
  if (ticket === null) throw missingTicket(source, id)
  return normalizeSourceTicket(source, ticket)
}

export async function requirePostMutationTicket(
  source: TicketSource,
  id: string,
  operation: string,
): Promise<Ticket> {
  const ticket = await source.get(id)
  if (ticket === null) {
    throw new TicketOperationError(
      'refusal',
      `ticket "${id}" disappeared from the configured ${source.name} ticket source after ${operation}`,
    )
  }
  return normalizeSourceTicket(source, ticket)
}

export function ticketListCriteria(
  config: Config,
  filters: { state?: string; labels?: string[] },
): { state?: string; labels?: string[]; assignee?: string } {
  return filters.state === undefined && filters.labels === undefined
    ? readyCriteria(config)
    : filters
}

/** Typed failures operator transports map themselves rather than as a generic refusal. */
function passthrough(error: unknown): boolean {
  return (
    error instanceof TicketRevisionConflict ||
    error instanceof TicketRevisionUnsupported ||
    error instanceof TicketIssueLinksUnsupported ||
    error instanceof TicketPriorityUnsupported
  )
}

async function knownBlockers(
  source: TicketSource,
  blockerIds: string[],
  prefix: string,
  suffix = '',
): Promise<string[]> {
  const ids = [...new Set(blockerIds)]
  if (ids.length === 0) return ids
  const states = await source.dependencyStates(ids)
  const unknown = states.filter((state) => !state.exists).map((state) => state.id)
  if (unknown.length > 0) {
    throw new TicketOperationError(
      'not-found',
      `${prefix}no ticket ${unknown.map((id) => `"${id}"`).join(', ')} in the configured ${source.name} ticket source — blocker ids are source-local${suffix}`,
    )
  }
  return ids
}

export async function createTicket(
  source: TicketSource,
  input: TicketDraft & { state?: string },
  options: { blockerErrorPrefix?: string; blockerErrorSuffix?: string } = {},
): Promise<Ticket> {
  refuseUnsupportedIssueLinks(source, input)
  refuseUnsupportedPriority(source, input)
  source = compatibleTicketSource(source)
  const blockedBy = await knownBlockers(
    source,
    input.blockedBy ?? [],
    options.blockerErrorPrefix ?? '',
    options.blockerErrorSuffix ?? '',
  )
  const draft: TicketDraft = {
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    ...(input.target !== undefined ? { target: input.target } : {}),
    title: input.title,
    body: input.body,
    ...(input.labels !== undefined ? { labels: [...input.labels] } : {}),
    ...(blockedBy.length > 0 ? { blockedBy } : {}),
    ...(input.issueLinks !== undefined
      ? { issueLinks: normalizeIssueLinks(input.issueLinks) }
      : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
  }
  try {
    return input.state === undefined
      ? await source.create(draft)
      : await source.create(draft, { state: input.state })
  } catch (error) {
    if (passthrough(error)) throw error
    throw new TicketOperationError(
      'refusal',
      error instanceof Error ? error.message : String(error),
    )
  }
}

export async function updateTicket(
  source: TicketSource,
  id: string,
  patch: TicketUpdate,
  readAfter = true,
  expectedRevision?: string,
): Promise<Ticket | null> {
  refuseUnsupportedIssueLinks(source, patch)
  refuseUnsupportedPriority(source, patch)
  source = compatibleTicketSource(source)
  try {
    if (expectedRevision !== undefined)
      await mutateTicketIfRevision(source, id, expectedRevision, { kind: 'update', patch })
    else await source.update(id, patch)
  } catch (error) {
    if (passthrough(error)) throw error
    throw new TicketOperationError(
      'refusal',
      error instanceof Error ? error.message : String(error),
    )
  }
  return readAfter ? requirePostMutationTicket(source, id, 'the update') : null
}

export async function moveTicket(
  source: TicketSource,
  id: string,
  state: string,
  expectedRevision?: string,
): Promise<Ticket> {
  await requireTicket(source, id)
  try {
    if (expectedRevision !== undefined)
      await mutateTicketIfRevision(source, id, expectedRevision, { kind: 'transition', state })
    else await source.transition(id, state)
  } catch (error) {
    if (passthrough(error)) throw error
    throw new TicketOperationError(
      'refusal',
      error instanceof Error ? error.message : String(error),
    )
  }
  return requirePostMutationTicket(source, id, 'the move')
}

const OPTIONAL_ROLE_KEYS = {
  backlog: {
    key: 'backlogState',
    holds: 'deferred work',
    recommended: 'backlog',
    about: 'Deferred on purpose; nothing dispatches from here',
  },
  rejected: {
    key: 'rejectedState',
    holds: 'declined work',
    recommended: 'rejected',
    about: 'Considered and declined; kept for the record',
  },
} as const

/** The native state a role names, or a refusal naming the key that configures
 * it. An unset optional role never falls back to a state sharing its name. */
export function roleStateName(tickets: TicketsConfig, role: string): string {
  if (!(TICKET_MOVE_ROLES as readonly string[]).includes(role)) {
    throw new TicketOperationError(
      'refusal',
      `unknown ticket role "${role}"; expected one of ${TICKET_MOVE_ROLES.join(', ')}`,
    )
  }
  const lifecycle = ticketLifecycle(tickets)
  if (role === 'triage' || role === 'ready') return lifecycle[role]
  const name = lifecycle[role as 'backlog' | 'rejected']
  if (name !== undefined) return name
  const { key, holds, recommended } = OPTIONAL_ROLE_KEYS[role as 'backlog' | 'rejected']
  throw new TicketOperationError(
    'refusal',
    `the ${role} role is not configured for this repository; set [tickets].${key} to the native state that holds ${holds} (recommended: "${recommended}")`,
  )
}

/** Move a ticket into a lifecycle role through this repository's [tickets]
 * names. A source that creates states gets a missing role state on first use. */
export async function moveTicketToRole(
  source: TicketSource,
  tickets: TicketsConfig,
  id: string,
  role: TicketMoveRole | string,
  expectedRevision?: string,
): Promise<Ticket> {
  let state = roleStateName(tickets, role)
  await requireTicket(source, id)
  if (source.listStates) {
    const known = (await source.listStates()).find((info) => holdsState(info.name, state))
    if (known !== undefined) state = known.name
    else if (source.addState) {
      const about =
        role === 'backlog' || role === 'rejected' ? OPTIONAL_ROLE_KEYS[role].about : undefined
      try {
        await source.addState(state, about === undefined ? {} : { about })
      } catch (error) {
        throw new TicketOperationError(
          'refusal',
          error instanceof Error ? error.message : String(error),
        )
      }
    }
  }
  return moveTicket(source, id, state, expectedRevision)
}

export async function changeBlockers(
  source: TicketSource,
  id: string,
  blockerIds: string[],
  operation: 'block' | 'unblock',
  expectedRevision?: string,
): Promise<Ticket> {
  await requireTicket(source, id)
  const ids = await knownBlockers(source, blockerIds, '')
  if (operation === 'block' && ids.includes(id)) {
    throw new TicketOperationError(
      'refusal',
      `ticket "${id}" in the configured ${source.name} ticket source cannot block itself`,
    )
  }
  try {
    if (expectedRevision !== undefined)
      await mutateTicketIfRevision(source, id, expectedRevision, {
        kind: 'blockers',
        operation,
        ids,
      })
    else
      for (const blockerId of ids) {
        if (operation === 'block') await source.addBlocker(id, blockerId)
        else await source.removeBlocker(id, blockerId)
      }
  } catch (error) {
    if (passthrough(error)) throw error
    throw new TicketOperationError(
      'refusal',
      error instanceof Error ? error.message : String(error),
    )
  }
  return requirePostMutationTicket(
    source,
    id,
    operation === 'block' ? 'adding blockers' : 'removing blockers',
  )
}
