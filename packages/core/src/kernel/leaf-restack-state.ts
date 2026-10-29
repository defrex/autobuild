import type { AbEvent } from '../events/catalog'
import type { EventPayload } from '../events/payloads'
import { defineReducer } from './incremental'

export interface LeafRestackState {
  activityAt?: string
  initialBase?: string
  postStepAt?: number
  completedAt?: number
  finalizedAt?: number
  target?: EventPayload<'target.moved'> & { seq: number }
  targetRewrite?: EventPayload<'target.rewritten'>
  distance?: EventPayload<'target.distance'>
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
    if (event.type !== 'target.distance') state.activityAt = event.ts
    switch (event.type) {
      case 'workspace.provisioned':
        state.initialBase ??= event.payload.base.sha
        break
      case 'finalize.completed':
        state.finalizedAt = event.seq
        break
      case 'node.parent-accepted':
        delete state.targetRewrite
        delete state.distance
        delete state.target
        break
      case 'pr.opened':
        if (state.distance?.head !== event.payload.pr.headSha) delete state.distance
        break
      case 'implement.completed':
        if (state.distance?.head !== event.payload.commits.head) delete state.distance
        break
      case 'restack.rewritten':
      case 'reconcile.rewritten':
        delete state.distance
        break
      case 'finalize.step-completed':
        if (
          event.payload.ok &&
          event.payload.headSha &&
          state.distance?.head !== event.payload.headSha
        )
          delete state.distance
        if (event.payload.ok && event.payload.headSha !== undefined) state.postStepAt = event.seq
        break
      case 'target.distance':
        state.distance = event.payload
        break
      case 'target.rewritten':
        state.targetRewrite = event.payload
        break
      case 'target.rewrite-cleared':
        if (
          event.payload.lineage &&
          state.target?.branch === event.payload.branch &&
          state.target.sha === event.payload.sha
        )
          state.target.lineage = event.payload.lineage
        delete state.targetRewrite
        break
      case 'target.moved':
        delete state.targetRewrite
        delete state.distance
        state.target = { seq: event.seq, ...event.payload }
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
        if (state.distance?.head !== event.payload.headSha) delete state.distance
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
  version: 7,
  initial: () => ({ gates: {} }),
  fold: advanceLeafRestack,
  finish: (state) => structuredClone(state),
})
