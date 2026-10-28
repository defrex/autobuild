import type { Ticket, TicketDraft, TicketSource, TicketUpdate } from '../types'

export function normalizeTicket(ticket: Ticket, supported = true): Ticket {
  const { target, ...rest } = ticket
  return {
    ...rest,
    kind: supported ? (ticket.kind ?? 'work') : 'work',
    ...(supported && target !== undefined ? { target } : {}),
  }
}

export function refuseUnsupportedMetadata(
  source: TicketSource,
  patch: TicketDraft | TicketUpdate,
): void {
  if (!source.integrationTree && (patch.kind !== undefined || patch.target !== undefined))
    throw new Error(
      `${source.name} ticket source does not support kind/target writes; use a source with integrationTree support (file, Linear or hosted)`,
    )
}

/** Validate before any part of a mixed patch is written. Canonical refs close alias cycles. */
export async function validateTicketTree(
  source: Pick<TicketSource, 'name' | 'get' | 'listAll'>,
  id: string | undefined,
  patch: TicketDraft | TicketUpdate,
): Promise<string | null | undefined> {
  if (patch.kind !== undefined && patch.kind !== 'work' && patch.kind !== 'node')
    throw new Error('kind must be work or node')
  if (typeof patch.target === 'string' && !patch.target.trim())
    throw new Error('target must not be blank')
  const current = id === undefined ? null : await source.get(id)
  if (patch.kind === 'work' && current?.kind === 'node') {
    if (!source.listAll)
      throw new Error('source must enumerate all tickets to validate node demotion')
    const listing = await source.listAll()
    if (listing.diagnostics.length) throw new Error(listing.diagnostics.join('\n'))
    for (const child of listing.tickets) {
      if (child.target === undefined) continue
      const parent = await source.get(child.target)
      if (parent?.ref.id === current.ref.id && parent.ref.source === current.ref.source)
        throw new Error(
          `cannot change node ${current.ref.id} to work: ticket ${child.ref.id} targets it`,
        )
    }
  }
  if (patch.target === undefined || patch.target === null) return patch.target
  const seen = new Set<string>()
  if (current) seen.add(`${current.ref.source}:${current.ref.id}`)
  else if (id) seen.add(`${source.name}:${id}`)
  let next: string | undefined = patch.target
  let canonical: string | undefined
  while (next !== undefined) {
    const node: Ticket | null = await source.get(next)
    if (!node)
      throw new Error(`target ${next} does not exist in the configured ${source.name} source`)
    if (node.ref.source !== source.name) throw new Error(`target ${next} is in a different source`)
    if (node.kind !== 'node') throw new Error(`target ${next} is not a node`)
    const key = `${node.ref.source}:${node.ref.id}`
    if (seen.has(key))
      throw new Error(`target ${next} would create a cycle (or has a cyclic ancestor chain)`)
    seen.add(key)
    canonical ??= node.ref.id
    next = node.target
  }
  return canonical
}

/** Forward through an empty facade so frozen source properties do not constrain
 * proxy results. Methods and accessors still receive the original source. */
export function compatibleTicketSource(source: TicketSource): TicketSource {
  return new Proxy(Object.create(source) as TicketSource, {
    get(_facade, property) {
      const target = source
      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      if (property === 'get')
        return async (id: string) => {
          const ticket = await target.get(id)
          return ticket ? normalizeTicket(ticket, !!target.integrationTree) : null
        }
      if (property === 'listReady' || property === 'listAll' || property === 'listPage')
        return async (...args: unknown[]) => {
          const listing = await value.apply(target, args)
          return {
            ...listing,
            tickets: listing.tickets.map((ticket: Ticket) =>
              normalizeTicket(ticket, !!target.integrationTree),
            ),
          }
        }
      if (property === 'create')
        return async (draft: TicketDraft, ...args: unknown[]) => {
          refuseUnsupportedMetadata(target, draft)
          return normalizeTicket(await value.call(target, draft, ...args), !!target.integrationTree)
        }
      if (property === 'update')
        return async (id: string, patch: TicketUpdate) => {
          refuseUnsupportedMetadata(target, patch)
          return target.update(id, patch)
        }
      if (property === 'mutateIfRevision')
        return async (
          id: string,
          revision: string,
          mutation: Parameters<NonNullable<TicketSource['mutateIfRevision']>>[2],
        ) => {
          if (mutation.kind === 'update') refuseUnsupportedMetadata(target, mutation.patch)
          return value.call(target, id, revision, mutation)
        }
      return value.bind(target)
    },
  })
}

export interface TicketTreeEntry {
  ticket: Ticket
  children: TicketTreeEntry[]
}
export function projectTicketTree(
  tickets: Ticket[],
  root: string,
): { root: string; children: TicketTreeEntry[] } {
  const entries = new Map(
    tickets.map((ticket) => [
      ticket.ref.id,
      { ticket: normalizeTicket(ticket), children: [] as TicketTreeEntry[] },
    ]),
  )
  const children: TicketTreeEntry[] = []
  for (const entry of [...entries.values()].sort((a, b) =>
    a.ticket.ref.id.localeCompare(b.ticket.ref.id),
  )) {
    const seen = new Set([entry.ticket.ref.id])
    let target = entry.ticket.target
    while (target !== undefined) {
      if (seen.has(target)) throw new Error(`cyclic target graph at ${target}`)
      seen.add(target)
      const parent = entries.get(target)
      if (!parent) throw new Error(`orphan target ${target} on ${entry.ticket.ref.id}`)
      if (parent.ticket.kind !== 'node') throw new Error(`target ${target} is not a node`)
      target = parent.ticket.target
    }
    if (entry.ticket.target) entries.get(entry.ticket.target)!.children.push(entry)
    else children.push(entry)
  }
  return { root, children }
}
