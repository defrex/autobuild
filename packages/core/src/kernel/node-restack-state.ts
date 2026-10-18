import type { AbEvent } from '../events/catalog'
import type { EventPayload } from '../events/payloads'
import { defineReducer } from './incremental'

/** Reservations outlive writer leases and disposable replay workspaces. A new
 * holder resumes these immutable inputs before admitting another operation. */
export interface NodeRestackState {
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
      case 'target.moved':
        if (state.contributionBase !== undefined) state.observedParent = event.payload
        break
      case 'node.opened':
        state.contributionBase ??= event.payload.sha
        break
      case 'node.writer-reserved':
        if (state.active) throw new Error('node writer already reserved')
        state.reservedSeq = event.seq
        state.active = event.payload
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
        state.rewritten = event.payload
        break
      case 'node.writer-settled':
        if (event.payload.id !== state.active?.id)
          throw new Error('unknown node writer reservation')
        if (event.payload.outcome === 'completed') {
          if (!state.rewritten) throw new Error('node completion requires a confirmed rewrite')
          if (state.active.operation === 'restack') state.contributionBase = state.active.parent
        }
        delete state.active
        delete state.prepared
        delete state.conflict
        delete state.intent
        delete state.rewritten
        state.items = []
        break
      case 'node.inventory':
        state.inventory = event.payload
        break
    }
  }
}
export const nodeRestackReducer = defineReducer<NodeRestackState, AbEvent, NodeRestackState>({
  version: 2,
  initial: () => ({ items: [] }),
  fold: advanceNodeRestack,
  finish: (state) => structuredClone(state),
})
