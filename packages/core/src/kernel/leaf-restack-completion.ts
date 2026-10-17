import { readBuildFacts } from '../store/reduced-reads'
import type { BuildStore } from '../store/types'
import { KERNEL } from '../events/envelope'
import { reconcileHead } from './reconcile-head'

/** Link successful resolver publication back to its owning automatic replay. */
export async function completeAutomaticReconcile(store: BuildStore, slug: string) {
  const facts = (await readBuildFacts(store, slug)).value
  const transaction = facts.log.restack.active
  if (transaction === undefined) return
  const completion = facts.reconcileHistory.findLast((e) => e.type === 'reconcile.completed')
  if (
    completion?.type !== 'reconcile.completed' ||
    !('rewriteId' in completion.payload) ||
    completion.payload.rewriteId !== facts.reconcileTransaction?.id ||
    facts.reconcileTransaction.restackId !== transaction.id
  )
    return
  await store.append(slug, {
    actor: KERNEL,
    type: 'restack.completed',
    payload: { ...transaction, cycle: completion.seq, headSha: reconcileHead(completion.payload) },
  })
}
