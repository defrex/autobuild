import type { AbEvent } from '../events/catalog'
import type { EventPayload } from '../events/payloads'
import { defineReducer } from './incremental'

export interface LeafRestackState {
  initialBase?: string
  postStepAt?: number
  completedAt?: number
  finalizedAt?: number
  target?: { seq: number; branch: string; sha: string }
  active?: EventPayload<'restack.prepared'>
  replay?: EventPayload<'restack.replayed'>
  intent?: EventPayload<'restack.publish-intended'>
  completed?: EventPayload<'restack.completed'>
  reconcileAttempt?: number
  initialVerification?: boolean
  gates: Record<string, EventPayload<'restack.completed'>>
}
export function advanceLeafRestack(state: LeafRestackState, events: readonly AbEvent[]) {
  for (const event of events) {
    switch (event.type) {
      case 'workspace.provisioned':
        state.initialBase ??= event.payload.base.sha
        break
      case 'finalize.completed':
        state.finalizedAt = event.seq
        break
      case 'node.parent-accepted':
        delete state.target
        break
      case 'target.moved':
        state.target = { seq: event.seq, ...event.payload }
        break
      case 'finalize.step-completed':
        if (event.payload.ok && event.payload.headSha !== undefined) state.postStepAt = event.seq
        break
      case 'restack.prepared':
        state.active = event.payload
        delete state.replay
        delete state.intent
        delete state.reconcileAttempt
        break
      case 'restack.replayed':
        if (event.payload.id === state.active?.id) state.replay = event.payload
        break
      case 'restack.publish-intended':
        if (event.payload.id === state.active?.id) state.intent = event.payload
        break
      case 'reconcile.started':
        if (state.active !== undefined && event.payload.restackId === state.active.id) {
          state.reconcileAttempt = event.payload.attempt
          state.initialVerification = state.active.trigger === 'verify-entry'
        } else state.initialVerification = false
        break
      case 'restack.completed':
        state.completedAt = event.seq
        state.completed = event.payload
        state.gates[String(event.payload.cycle)] = event.payload
        if (state.active?.id === event.payload.id) {
          delete state.active
          delete state.replay
          delete state.intent
        }
        break
    }
  }
}
export const leafRestackReducer = defineReducer<LeafRestackState, AbEvent, LeafRestackState>({
  version: 3,
  initial: () => ({ gates: {} }),
  fold: advanceLeafRestack,
  finish: (state) => structuredClone(state),
})
