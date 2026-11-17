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
  /** The latest pre-publication wait-resume fast-forward. */
  advanced?: EventPayload<'restack.advanced'>
  advancedAt?: number
  reconcileAttempt?: number
  initialVerification?: boolean
  gates: Record<string, EventPayload<'restack.completed'>>
}
export function advanceLeafRestack(state: LeafRestackState, events: readonly AbEvent[]) {
  for (const event of events) {
    // Advisory dispatcher bookkeeping is not lifecycle activity.
    if (event.type !== 'target.distance' && event.type !== 'pipeline.settled')
      state.activityAt = event.ts
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
      case 'publication.candidate-retired':
        if (event.payload.operation === 'restack' && state.active?.id === event.payload.id) {
          state.active = { ...state.active, id: event.payload.replacementId }
          delete state.replay
          delete state.intent
        }
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
          // A resume restack conflicts before any verification on the new
          // base, like a verify-entry one: post-reconcile policy cannot skip.
          state.initialVerification =
            state.active.trigger === 'verify-entry' || state.active.trigger === 'wait-resume'
        } else state.initialVerification = false
        break
      case 'reconcile.superseded':
        if (event.payload.restackId !== undefined && event.payload.restackId === state.active?.id) {
          delete state.active
          delete state.replay
          delete state.intent
          delete state.reconcileAttempt
        }
        break
      case 'restack.advanced':
        state.advanced = event.payload
        state.advancedAt = event.seq
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
/** The target base the leaf's last restack moved it onto: the newer of the
 * last completed restack and the last wait-resume fast-forward, else the
 * provisioned base. Without `restack.advanced` this is exactly
 * `completed?.targetBase ?? initialBase`. */
export function leafRestackedBase(
  state: Pick<
    LeafRestackState,
    'completed' | 'completedAt' | 'advanced' | 'advancedAt' | 'initialBase'
  >,
): string | undefined {
  if (state.advanced !== undefined && (state.advancedAt ?? 0) > (state.completedAt ?? 0))
    return state.advanced.to
  return state.completed?.targetBase ?? state.initialBase
}

/** The base a leaf's published work currently sits on: the last reconcile's
 * base when it is newer than the last restack completion, else
 * `leafRestackedBase`. Shared by target observation and the wait-resume
 * restack decision so the two cannot drift. */
export function leafBaseInUse(log: {
  restack: LeafRestackState
  lastReconcileCompleted?: { completedSeq: number; baseSha: string }
}): string | undefined {
  const reconcile = log.lastReconcileCompleted
  return reconcile &&
    reconcile.completedSeq > Math.max(log.restack.completedAt ?? 0, log.restack.advancedAt ?? 0)
    ? reconcile.baseSha
    : leafRestackedBase(log.restack)
}

export const leafRestackReducer = defineReducer<LeafRestackState, AbEvent, LeafRestackState>({
  version: 10,
  initial: () => ({ gates: {} }),
  fold: advanceLeafRestack,
  finish: (state) => structuredClone(state),
})
