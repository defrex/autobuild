// Pure base helpers, kept apart from the leaf restack reducer. The browser
// dashboard reaches `ticket-wait.ts` through `operator-presentation`, so this
// module must import only types: the reducer pulls in Bun-only code.
import type { LeafRestackState } from './leaf-restack-state'

/** The target base the leaf's last restack moved it onto: the newest of the
 * last completed restack, the last wait-resume fast-forward and the last
 * rewritten-target reprovision, else the provisioned base. Without
 * `restack.advanced` or a reprovision this is exactly
 * `completed?.targetBase ?? initialBase`. */
export function leafRestackedBase(
  state: Pick<
    LeafRestackState,
    | 'completed'
    | 'completedAt'
    | 'advanced'
    | 'advancedAt'
    | 'rebased'
    | 'rebasedAt'
    | 'initialBase'
  >,
): string | undefined {
  const completedAt = state.completedAt ?? 0
  const advancedAt = state.advanced === undefined ? 0 : (state.advancedAt ?? 0)
  const rebasedAt = state.rebased === undefined ? 0 : (state.rebasedAt ?? 0)
  if (rebasedAt > completedAt && rebasedAt > advancedAt) return state.rebased!.to
  if (advancedAt > completedAt) return state.advanced!.to
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
    reconcile.completedSeq >
      Math.max(
        log.restack.completedAt ?? 0,
        log.restack.advancedAt ?? 0,
        log.restack.rebasedAt ?? 0,
      )
    ? reconcile.baseSha
    : leafRestackedBase(log.restack)
}

/** The replay boundary an operator's accept-target opened: the accepted
 * fact's seq, or, while its unpublished local commits await their owner's
 * publishing completion, undefined until that completion is recorded. */
export function acceptedRewriteBoundary(log: {
  restack: Pick<LeafRestackState, 'rewriteWaiver'>
}): number | undefined {
  const waiver = log.restack.rewriteWaiver
  if (waiver === undefined) return undefined
  return waiver.pendingLocal === undefined ? waiver.seq : waiver.ownerCompletedAt
}
