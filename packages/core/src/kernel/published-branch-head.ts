/**
 * The branch head kernel plumbing last published. Pure so the reducer
 * registry can register it without importing process code.
 */
import type { AbEvent } from '../events/catalog'
import { defineReducer } from './incremental'
import { reconcileHead, reconcileRewriteHead } from './reconcile-head'

/** Latest event-checkpointed branch head that kernel plumbing published;
 * undefined while the build has none. */
export const publishedBranchHeadReducer = defineReducer<
  { head?: string },
  AbEvent,
  string | undefined
>({
  identity: 'publishedBranchHead',
  initial: () => ({}),
  fold(acc, events) {
    for (const event of events) {
      if (event.type === 'implement.completed') {
        acc.head = event.payload.commits.head
      } else if (event.type === 'restack.rewritten' || event.type === 'restack.completed') {
        acc.head =
          event.type === 'restack.rewritten'
            ? (event.payload.observedHead ?? event.payload.headSha)
            : event.payload.headSha
      } else if (event.type === 'reconcile.rewritten') {
        acc.head = reconcileRewriteHead(event.payload)
      } else if (event.type === 'reconcile.completed') {
        acc.head = reconcileHead(event.payload)
      } else if (
        event.type === 'wait.requested' &&
        event.payload.publication?.settlement === 'published'
      ) {
        acc.head = event.payload.publication.sha
      } else if (event.type === 'wait.published') {
        acc.head = event.payload.sha
      } else if (
        event.type === 'finalize.step-completed' &&
        event.payload.ok &&
        event.payload.headSha !== undefined
      ) {
        acc.head = event.payload.headSha
      }
    }
  },
  finish: (acc) => acc.head,
})

/** Latest event-checkpointed branch head that kernel plumbing published. */
export function selectPublishedBranchHead(events: readonly AbEvent[]): string {
  const head = publishedBranchHeadReducer.reduce(events)
  if (head === undefined) {
    throw new Error(
      'finalize publication requires a prior implement.completed, reconcile.completed, ' +
        'or successful finalize publication head, but this build has none',
    )
  }
  return head
}
