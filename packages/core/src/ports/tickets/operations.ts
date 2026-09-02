import type { Config } from '../../config/schema'
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
  return ticket
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
  return ticket
}

export function ticketListCriteria(
  config: Config,
  filters: { state?: string; labels?: string[] },
): { state?: string; labels?: string[] } {
  return filters.state === undefined && filters.labels === undefined
    ? readyCriteria(config)
    : filters
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
  const blockedBy = await knownBlockers(
    source,
    input.blockedBy ?? [],
    options.blockerErrorPrefix ?? '',
    options.blockerErrorSuffix ?? '',
  )
  const draft: TicketDraft = {
    title: input.title,
    body: input.body,
    ...(input.labels !== undefined ? { labels: [...input.labels] } : {}),
    ...(blockedBy.length > 0 ? { blockedBy } : {}),
  }
  try {
    return input.state === undefined
      ? await source.create(draft)
      : await source.create(draft, { state: input.state })
  } catch (error) {
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
): Promise<Ticket | null> {
  try {
    await source.update(id, patch)
  } catch (error) {
    throw new TicketOperationError(
      'refusal',
      error instanceof Error ? error.message : String(error),
    )
  }
  return readAfter ? requirePostMutationTicket(source, id, 'the update') : null
}

export async function moveTicket(source: TicketSource, id: string, state: string): Promise<Ticket> {
  await requireTicket(source, id)
  try {
    await source.transition(id, state)
  } catch (error) {
    throw new TicketOperationError(
      'refusal',
      error instanceof Error ? error.message : String(error),
    )
  }
  return requirePostMutationTicket(source, id, 'the move')
}

export async function changeBlockers(
  source: TicketSource,
  id: string,
  blockerIds: string[],
  operation: 'block' | 'unblock',
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
    for (const blockerId of ids) {
      if (operation === 'block') await source.addBlocker(id, blockerId)
      else await source.removeBlocker(id, blockerId)
    }
  } catch (error) {
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
