import type { RepositoryEvent } from '../events/repository'
import { defineReducer } from '../kernel/incremental'

export const OPEN_TICK_REDUCER_VERSION = 1

/** Whether the dispatcher run's latest tick boundary (started, completed or
 * failed) is a `dispatcher.tick-started`. A factory because the run id is a
 * parameter of the projection; the accumulator holds only the last boundary
 * type seen for that run. */
export function openTickReducer(run: string) {
  return defineReducer<{ boundary?: string }, RepositoryEvent, boolean>({
    version: OPEN_TICK_REDUCER_VERSION,
    initial: () => ({}),
    fold(acc, events) {
      for (const event of events) {
        if (
          'run' in event.payload &&
          event.payload.run === run &&
          (event.type === 'dispatcher.tick-started' ||
            event.type === 'dispatcher.tick-completed' ||
            event.type === 'dispatcher.tick-failed')
        ) {
          acc.boundary = event.type
        }
      }
    },
    finish: (acc) => acc.boundary === 'dispatcher.tick-started',
  })
}

export function hasOpenTick(events: readonly RepositoryEvent[], run: string): boolean {
  return openTickReducer(run).reduce(events)
}
