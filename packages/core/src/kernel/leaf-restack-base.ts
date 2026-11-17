// Pure base helpers, kept apart from the leaf restack reducer. The browser
// dashboard reaches `ticket-wait.ts` through `operator-presentation`, so this
// module must import only types: the reducer pulls in Bun-only code.
import type { LeafRestackState } from './leaf-restack-state'

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
