import type { AbEvent } from '../events/catalog'
import type { EventPayload } from '../events/payloads'
import { defineReducer } from './incremental'

/** JSONB persistence does not preserve object key order. These diagnostics
 * are identified by their observed fields, never by serialized object bytes. */
export function sameParentRejection(
  previous: EventPayload<'node.parent-rejected'> | undefined,
  next: EventPayload<'node.parent-rejected'>,
): boolean {
  return (
    previous?.revision === next.revision &&
    previous.target === next.target &&
    previous.reason === next.reason
  )
}

/** Reservations outlive writer leases and disposable replay workspaces. A new
 * holder resumes these immutable inputs before admitting another operation. */
export interface NodeRestackState {
  requests?: Record<string, EventPayload<'node.restack-requested'>>
  targetRewrite?: EventPayload<'target.rewritten'>
  distance?: EventPayload<'node.parent-distance'>
  parentRequest?: EventPayload<'node.parent-requested'>
  parentChange?: EventPayload<'node.parent-accepted'>
  parentReplay?: string
  parentPr?: string
  parentRejection?: EventPayload<'node.parent-rejected'>
  contributionBoundaries?: Record<string, string>
  droppedIdentities?: string[]
  foreignAliases?: Record<string, string>
  contribution?: EventPayload<'node.contribution-recorded'>
  observedParent?: EventPayload<'target.moved'>
  reservedSeq?: number
  contributionBase?: string
  active?: EventPayload<'node.writer-reserved'>
  items: EventPayload<'node.item-replayed'>[]
  prepared?: EventPayload<'node.item-prepared'>
  conflict?: EventPayload<'node.item-conflicted'>
  intent?: EventPayload<'node.publish-intended'>
  rewritten?: EventPayload<'node.rewritten'>
  inventory?: EventPayload<'node.inventory'>
}
export function advanceNodeRestack(state: NodeRestackState, events: readonly AbEvent[]) {
  for (const event of events) {
    switch (event.type) {
      case 'node.restack-requested':
        state.requests ??= {}
        state.requests[event.payload.id] = event.payload
        break
      case 'node.restack-satisfied':
        if (state.requests) delete state.requests[event.payload.id]
        break
      case 'node.parent-distance':
        state.distance = event.payload
        break
      case 'node.parent-requested':
        state.parentRequest = event.payload
        break
      case 'node.parent-accepted':
        delete state.targetRewrite
        state.parentChange = event.payload
        delete state.parentRequest
        delete state.parentReplay
        delete state.parentPr
        delete state.parentRejection
        delete state.distance
        delete state.observedParent
        break
      case 'node.parent-cancelled':
        if (state.parentRequest?.id === event.payload.id) delete state.parentRequest
        break
      case 'node.parent-rejection-cleared':
        delete state.parentRejection
        break
      case 'node.parent-rejected':
        state.parentRejection = event.payload
        break
      case 'node.parent-pr-retargeted':
        state.parentPr = event.payload.id
        break
      case 'node.parent-completed':
        if (state.parentChange?.id === event.payload.id) delete state.parentChange
        break
      case 'target.rewritten':
        state.targetRewrite = event.payload
        break
      case 'target.rewrite-cleared':
        if (
          event.payload.lineage &&
          state.observedParent?.branch === event.payload.branch &&
          state.observedParent.sha === event.payload.sha
        )
          state.observedParent.lineage = event.payload.lineage
        delete state.targetRewrite
        break
      case 'target.moved':
        delete state.targetRewrite
        if (state.contributionBase !== undefined) state.observedParent = event.payload
        break
      case 'node.opened':
        state.contributionBase ??= event.payload.sha
        state.contributionBoundaries ??= {}
        state.contributionBoundaries[event.payload.sha] = event.payload.sha
        break
      case 'node.writer-reserved':
        if (state.active) throw new Error('node writer already reserved')
        state.reservedSeq = event.seq
        state.active = event.payload
        state.contributionBoundaries ??= {}
        state.contributionBoundaries[event.payload.expected] = event.payload.oldBase
        state.items = []
        break
      case 'node.item-prepared':
        if (event.payload.id !== state.active?.id || event.payload.index !== state.items.length)
          throw new Error('node item is not the next reserved change')
        if (event.payload.index >= state.active.changes.length)
          throw new Error('node item is outside the reserved contribution')
        if (event.payload.base !== (state.items.at(-1)?.head ?? state.active.parent))
          throw new Error('node item has an invalid replay prefix')
        state.prepared = event.payload
        break
      case 'node.item-conflicted':
        if (
          event.payload.id !== state.prepared?.id ||
          event.payload.index !== state.prepared.index ||
          event.payload.base !== state.prepared.base
        )
          throw new Error('node conflict does not match the prepared change')
        state.conflict = event.payload
        break
      case 'node.item-replayed':
        // A resolver can finish after its reservation was settled or after
        // another item advanced. Retain the fact without reviving that work
        // or making the append-only stream impossible to reduce.
        if (event.payload.id !== state.active?.id || event.payload.index < state.items.length) break
        if (
          event.payload.id !== state.prepared?.id ||
          event.payload.index !== state.prepared.index ||
          event.payload.base !== state.prepared.base
        )
          throw new Error('node receipt does not match the prepared change')
        if (event.payload.dropped && event.payload.head !== event.payload.base)
          throw new Error('dropped node change moved the replay prefix')
        state.items.push(event.payload)
        delete state.prepared
        delete state.conflict
        break
      case 'node.publish-intended':
        if (
          event.payload.id !== state.active?.id ||
          state.prepared ||
          state.items.length !== state.active.changes.length
        )
          throw new Error('node publication requires the complete replay')
        if (event.payload.head !== (state.items.at(-1)?.head ?? state.active.parent))
          throw new Error('node publication does not match the retained prefix')
        state.intent = event.payload
        break
      case 'node.rewritten':
        if (
          event.payload.id !== state.intent?.id ||
          event.payload.head !== state.intent.head ||
          event.payload.previous !== state.active?.expected
        )
          throw new Error('node rewrite does not match its publication intent')
        state.contributionBoundaries ??= {}
        state.contributionBoundaries[event.payload.head] =
          state.active.operation === 'restack'
            ? state.active.parent
            : (state.contributionBase ?? state.active.oldBase)
        // A confirmed guarded write establishes aliases even if overtaken
        // before readback. It cannot promote the active contribution base.
        if (state.active.operation === 'restack') {
          state.foreignAliases ??= {}
          const dropped = new Set(state.droppedIdentities ?? [])
          for (const item of state.items) {
            const change = state.active.changes[item.index]
            if (change && item.dropped)
              dropped.add(
                change.build === undefined
                  ? `foreign:${state.foreignAliases[change.sha] ?? change.sha}`
                  : `build:${change.build}`,
              )
            if (change && change.build === undefined && !item.dropped)
              state.foreignAliases[item.head] = state.foreignAliases[change.sha] ?? change.sha
          }
          state.droppedIdentities = [...dropped].sort()
        }
        state.rewritten = event.payload
        break
      case 'node.writer-settled':
        if (event.payload.id !== state.active?.id)
          throw new Error('unknown node writer reservation')
        if (event.payload.outcome === 'completed') {
          if (!state.rewritten) throw new Error('node completion requires a confirmed rewrite')
          if (state.active.operation === 'restack') {
            if (state.parentChange) state.parentReplay = state.parentChange.id
            // Coverage is frozen in the reservation. Settlement atomically
            // acknowledges it, even if the process dies before audit receipts.
            for (const id of state.active.requests ?? [])
              if (state.requests) delete state.requests[id]
            state.contributionBase = state.active.parent
            delete state.distance
          }
        }
        delete state.active
        delete state.prepared
        delete state.conflict
        delete state.intent
        delete state.rewritten
        state.items = []
        break
      case 'node.contribution-recorded':
        state.contribution = event.payload
        break
      case 'node.inventory':
        if (state.contributionBase !== undefined) {
          state.contributionBoundaries ??= {}
          state.contributionBoundaries[event.payload.head] =
            event.payload.base ??
            (state.active?.operation === 'restack' && state.rewritten?.head === event.payload.head
              ? state.active.parent
              : state.contributionBase)
        }
        state.inventory = event.payload
        break
    }
  }
}
export const nodeRestackReducer = defineReducer<NodeRestackState, AbEvent, NodeRestackState>({
  version: 9,
  initial: () => ({ items: [] }),
  fold: advanceNodeRestack,
  finish: (state) => structuredClone(state),
})
