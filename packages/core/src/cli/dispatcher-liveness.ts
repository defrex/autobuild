import type { RepositoryEvent } from '../events/repository'
import type { BuildStore } from '../store/types'
import { projectDispatcherLiveness } from '../kernel/dispatcher-liveness'

/** Bounded first; a later yielding invocation can hide the owner's identity or
 * an earlier stop. Only this correlation query falls back to full history. */
export async function readDispatcherLiveness(
  store: BuildStore,
  repo: string,
  now = new Date(),
  subset?: RepositoryEvent[],
) {
  const record = await store.getRepo(repo)
  let events = record === null ? [] : (subset ?? (await store.getRepoStateEvents(repo)))
  if (
    record &&
    ((record.lease &&
      !events.some(
        (e) => e.type === 'dispatcher.run-started' && e.payload.run === record.lease!.holder,
      )) ||
      (events.some((e) => e.type === 'dispatcher.run-started') &&
        !events.some((e) => e.type === 'dispatcher.run-stopped')))
  ) {
    events = await store.getRepoEvents(repo)
  }
  return { record, events, dispatcher: projectDispatcherLiveness(record, events, now) }
}
