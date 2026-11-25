/**
 * The verify diff base: the durable commit a leaf build's verification
 * compares its HEAD against. Pure so `read-facts.ts` can fold it as a part
 * without importing process code.
 */
import type { AbEvent } from '../events/catalog'
import { defineReducer } from './incremental'

/** The environment variable through which a check command receives the verify diff base. */
export const VERIFY_BASE_ENV = 'AB_VERIFY_BASE'

/**
 * The durable tree against which a conditional verifier evaluates the
 * branch's current HEAD, or undefined until a `workspace.provisioned` exists.
 * The accumulator keeps the first provisioned base and the latest promoted
 * reconcile base separately, so the result is exact for any array order (a
 * promotion that precedes the provisioned fact in the array still wins).
 */
export const verifyDiffBaseReducer = defineReducer<
  { provisioned?: string; promoted?: string; pendingReconcileBase?: string },
  AbEvent,
  string | undefined
>({
  identity: 'verifyDiffBase',
  initial: () => ({}),
  fold(acc, events) {
    for (const event of events) {
      if (event.type === 'workspace.provisioned') {
        if (acc.provisioned === undefined) acc.provisioned = event.payload.base.sha
      } else if (event.type === 'restack.completed') {
        acc.promoted = event.payload.targetBase
      } else if (event.type === 'restack.advanced') {
        acc.promoted = event.payload.to
      } else if (
        event.type === 'target.rewrite-recovered' &&
        event.payload.recovery === 'reprovisioned'
      ) {
        acc.promoted = event.payload.sha
      } else if (event.type === 'reconcile.superseded') {
        // An abandoned occurrence's base never promotes.
        delete acc.pendingReconcileBase
      } else if (event.type === 'reconcile.started') {
        acc.pendingReconcileBase = event.payload.baseSha
      } else if (event.type === 'reconcile.completed') {
        if (acc.pendingReconcileBase !== undefined) acc.promoted = acc.pendingReconcileBase
        delete acc.pendingReconcileBase
      }
    }
  },
  finish: (acc) => (acc.provisioned === undefined ? undefined : (acc.promoted ?? acc.provisioned)),
})

/**
 * Select the durable tree against which a conditional verifier evaluates the
 * branch's current HEAD. The initial branch-cut SHA is authoritative until a
 * successful reconcile; each completed reconcile promotes the latest start's
 * refreshed base SHA. A dangling start is intentionally ignored.
 */
export function selectVerifyDiffBase(events: readonly AbEvent[]): string {
  const base = verifyDiffBaseReducer.reduce(events)
  if (base === undefined) {
    throw new Error(
      'conditional verify requires a workspace.provisioned base SHA, but this build has none',
    )
  }
  return base
}
