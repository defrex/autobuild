import { currentTicketRef, readTicketMigrations, resolveTicketRef } from './ticket-migrations'
import { randomUUID } from 'node:crypto'
import { DISPATCHER } from '../events/envelope'
import type { EventPayload } from '../events/payloads'
import type { Ticket, TicketSource, TicketUpdate } from '../ports/types'
import { requireTicket, TicketOperationError, updateTicket } from '../ports/tickets/operations'
import {
  TicketRevisionConflict,
  TicketRevisionUnsupported,
  checkTicketRevision,
} from '../ports/tickets/revision'
import { validateTicketTree } from '../ports/tickets/tree'
import { readBuildFacts } from '../store/reduced-reads'
import type { BuildRecord, BuildStore } from '../store/types'
import type { BuildState } from './reducer'

type Parent = EventPayload<'node.parent-requested'>['next']
export type ParentContext = {
  store: BuildStore
  source: TicketSource
  repo: string
  root: string
  configuredSource?: string
  supportsRetarget: () => Promise<boolean>
}
function refuse(message: string): never {
  throw new TicketOperationError('refusal', message)
}
export async function newestTicketBuild(ctx: ParentContext, ticket: Ticket) {
  const candidates = await ctx.store.listBuildsForRepo(ctx.repo)
  if (!candidates.length) return undefined
  const migrations = await readTicketMigrations(ctx.store, ctx.repo)
  const matches: BuildRecord[] = []
  for (const build of candidates) {
    if (!build.ticket) continue
    let ref = build.ticket
    try {
      ref = resolveTicketRef(
        migrations,
        build.ticket,
        ctx.source.name === 'database' && ctx.configuredSource === 'hosted'
          ? 'hosted'
          : ctx.source.name,
        build.slug,
      )
    } catch {
      continue
    }
    if (
      ref.id === ticket.ref.id ||
      (ctx.configuredSource === 'hosted' &&
        (await ctx.source.get(ref.id))?.ref.id === ticket.ref.id)
    )
      matches.push(build)
  }
  matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.slug.localeCompare(a.slug))
  if (matches[0] && matches[1]?.createdAt === matches[0].createdAt)
    refuse(`ticket ${ticket.ref.id} has ambiguous build generations`)
  return matches[0]
}
export function nodeParentBusy(state: BuildState): string | undefined {
  if (
    state.status === 'aborted' ||
    state.status === 'done' ||
    state.prState === 'merged' ||
    state.prState === 'closed'
  )
    return 'node is no longer open'
  if (state.pendingCommands.some((c) => c.command === 'abort')) return 'node is closing'
  if (state.integration?.intent && !state.integration.landing) return 'node is merging'
  if (state.nodeRestack?.active?.operation === 'landing') return 'node has a reserved child merge'
  return undefined
}
export async function validateNodeParent(
  ctx: ParentContext,
  record: BuildRecord,
  ticket: Ticket,
): Promise<Parent> {
  if ((await newestTicketBuild(ctx, ticket))?.slug !== record.slug)
    refuse('source node generation changed')
  const state = (await readBuildFacts(ctx.store, record.slug)).value.state
  const busy = nodeParentBusy(state)
  if (busy) refuse(busy)
  if (!state.nodeOpened) refuse('node is not yet open')
  if (!(await ctx.supportsRetarget()))
    refuse('forge does not support node PR retargeting; upgrade the plugin')
  await validateTicketTree(ctx.source, ticket.ref.id, { target: ticket.target ?? null })
  let parent: Parent = { target: null, branch: ctx.root }
  if (ticket.target !== undefined) {
    const targetTicket = await requireTicket(ctx.source, ticket.target)
    const target = await newestTicketBuild(ctx, targetTicket)
    if (!target) refuse(`target node ${ticket.target} is not yet claimed`)
    const destination = (await readBuildFacts(ctx.store, target.slug)).value.state
    const reason = nodeParentBusy(destination)
    if (reason || destination.kind !== 'node' || !destination.nodeOpened || !target.branch)
      refuse(`target node ${ticket.target}: ${reason ?? 'is not an open node'}`)
    parent = { target: { ticket: targetTicket.ref, build: target.slug }, branch: target.branch! }
  }
  // Pending intents count as edges too. Repeating this before acceptance closes
  // opposite-move races even when their provider writes finish in reverse order.
  const visited = new Set<string>()
  const walk = async (slug: string, path: Set<string>): Promise<void> => {
    if (path.has(slug)) refuse('parent change would create an effective or pending cycle')
    if (visited.has(slug)) return
    const ancestor = (await readBuildFacts(ctx.store, slug)).value.state
    const nextPath = new Set([...path, slug])
    // Both edges matter: a request to leave an ancestor does not remove its
    // current relationship until acceptance. Never borrow that future move.
    for (const edge of new Set([
      ancestor.target?.build,
      ancestor.nodeRestack?.parentRequest?.next.target?.build,
    ]))
      if (edge) await walk(edge, nextPath)
    visited.add(slug)
  }
  if (parent.target) await walk(parent.target.build, new Set([record.slug]))
  return parent
}

/** Reserve before writing the provider; only dispatcher observation activates
 * the effective parent. No caller is required to survive the provider call. */
export async function updateTicketTarget(
  ctx: ParentContext,
  id: string,
  patch: TicketUpdate,
  expectedRevision?: string,
): Promise<Ticket | null> {
  if (patch.target === undefined) return updateTicket(ctx.source, id, patch, true, expectedRevision)
  const ticket = await requireTicket(ctx.source, id)
  if (expectedRevision !== undefined) {
    if (!ctx.source.mutateIfRevision) throw new TicketRevisionUnsupported(ctx.source.name)
    checkTicketRevision(ticket, expectedRevision)
  }
  const desired = await validateTicketTree(ctx.source, id, patch)
  const record = await newestTicketBuild(ctx, ticket)
  const canonicalPatch = { ...patch, target: desired }
  if (!record) return updateTicket(ctx.source, id, canonicalPatch, true, expectedRevision)
  let state = (await readBuildFacts(ctx.store, record.slug)).value.state
  const active = state.status !== 'done' && state.status !== 'aborted'
  const frozenId = state.target
    ? (
        await currentTicketRef(
          ctx.store,
          ctx.repo,
          ctx.source.name === 'database' && ctx.configuredSource === 'hosted'
            ? 'hosted'
            : ctx.source.name,
          state.target.ticket,
          record.slug,
        )
      ).id
    : undefined
  const effective =
    frozenId === undefined ? undefined : ((await ctx.source.get(frozenId))?.ref.id ?? frozenId)
  if (state.kind !== 'node') {
    if (active && (desired ?? undefined) !== effective)
      refuse('changing a claimed work ticket target requires abort and re-dispatch')
    return updateTicket(ctx.source, id, canonicalPatch, true, expectedRevision)
  }
  if (
    (desired ?? undefined) === effective &&
    !state.nodeRestack?.parentRequest &&
    !state.nodeRestack?.parentChange
  )
    return updateTicket(ctx.source, id, canonicalPatch, true, expectedRevision)
  const holder = `parent-${randomUUID()}`
  if (!(await ctx.store.claimNodeWriter(record.slug, holder, 60_000)))
    refuse('node writer is busy; retry target change')
  try {
    state = (await readBuildFacts(ctx.store, record.slug)).value.state
    if (
      state.nodeRestack?.parentRequest ||
      state.nodeRestack?.parentChange ||
      state.nodeRestack?.active ||
      state.sessions.open.length
    )
      refuse('node has a pending operation; retry after it settles')
    const next = await validateNodeParent(ctx, record, { ...ticket, target: desired ?? undefined })
    const request = {
      id: holder,
      old: { target: state.target ?? null, branch: state.baseBranch! },
      next,
      revision: ticket.revision,
    }
    if (
      !(await ctx.store.appendIfCurrent(record.slug, state.lastSeq, {
        actor: DISPATCHER,
        type: 'node.parent-requested',
        payload: request,
      }))
    )
      refuse('node changed while reserving parent change; retry')
    // On ambiguous provider errors leave the request for readback. It fences
    // landing until the dispatcher confirms or cancels it from source state.
    try {
      return await updateTicket(ctx.source, id, canonicalPatch, true, expectedRevision)
    } catch (error) {
      if (error instanceof TicketRevisionConflict || error instanceof TicketRevisionUnsupported)
        await ctx.store.append(record.slug, {
          actor: DISPATCHER,
          type: 'node.parent-cancelled',
          payload: { id: request.id, reason: error.message },
        })
      throw error
    }
  } finally {
    await ctx.store.releaseNodeWriter(record.slug, holder)
  }
}
