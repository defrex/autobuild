import type { RepositoryEvent } from '../events/repository'
import { defineReducer } from './incremental'
export type Handoff = Extract<RepositoryEvent, { type: 'dispatcher.handoff-started' }>['payload']
export interface DispatchUpgradeState {
  runs: Record<
    string,
    {
      detected?: Extract<RepositoryEvent, { type: 'dispatcher.upgrade-detected' }>
      failure?: Extract<RepositoryEvent, { type: 'dispatcher.upgrade-failed' }>
      handoff?: Extract<RepositoryEvent, { type: 'dispatcher.handoff-started' }>
      completed?: Extract<RepositoryEvent, { type: 'dispatcher.handoff-completed' }>
    }
  >
}
export const dispatchUpgradeReducer = defineReducer<
  DispatchUpgradeState,
  RepositoryEvent,
  DispatchUpgradeState
>({
  version: 1,
  initial: () => ({ runs: {} }),
  fold(acc, events) {
    for (const event of events) {
      if (
        event.type !== 'dispatcher.upgrade-detected' &&
        event.type !== 'dispatcher.upgrade-failed' &&
        event.type !== 'dispatcher.handoff-started' &&
        event.type !== 'dispatcher.handoff-completed'
      )
        continue
      acc.runs[event.payload.run] ??= {}
      const state = acc.runs[event.payload.run]!
      switch (event.type) {
        case 'dispatcher.upgrade-detected':
          state.detected = event
          state.failure = undefined
          break
        case 'dispatcher.upgrade-failed':
          state.failure = event
          break
        case 'dispatcher.handoff-started':
          state.handoff = event
          state.failure = undefined
          break
        case 'dispatcher.handoff-completed':
          if (state.handoff?.payload.correlation === event.payload.correlation)
            state.completed = event
          break
      }
    }
  },
  finish: (acc) => structuredClone(acc),
})
