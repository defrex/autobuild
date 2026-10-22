import type { RepositoryEvent } from '../events/repository'
import { defineReducer } from './incremental'
export type Handoff = Extract<RepositoryEvent, { type: 'dispatcher.target-prepared' }>['payload']
type Fact<T extends RepositoryEvent['type']> = Extract<RepositoryEvent, { type: T }>
export interface UpgradeRun {
  detected?: Fact<'dispatcher.upgrade-detected'>
  failure?: Fact<'dispatcher.upgrade-failed'>
  prepared?: Fact<'dispatcher.target-prepared'>
  request?: Fact<'dispatcher.yield-requested'>
  handoff?: Fact<'dispatcher.handoff-started'>
  released?: Fact<'dispatcher.terminal-released'>
  takeover?: Fact<'dispatcher.takeover'>
  completed?: Fact<'dispatcher.handoff-completed'>
  deadline?: string
  outstanding: Record<string, string>
  drained: number
  suspended: number
}
export interface DispatchUpgradeState {
  runs: Record<string, UpgradeRun>
}
function same(a: Handoff, b: Handoff): boolean {
  return (
    a.correlation === b.correlation &&
    a.run === b.run &&
    a.lineage === b.lineage &&
    a.root === b.root &&
    a.cacheId === b.cacheId &&
    a.target.key === b.target.key &&
    JSON.stringify(a.from) === JSON.stringify(b.from) &&
    JSON.stringify(a.to) === JSON.stringify(b.to)
  )
}
export const dispatchUpgradeReducer = defineReducer<
  DispatchUpgradeState,
  RepositoryEvent,
  DispatchUpgradeState
>({
  version: 3,
  initial: () => ({ runs: {} }),
  fold(acc, events) {
    for (const event of events) {
      if (!('correlation' in event.payload) || !('run' in event.payload)) continue
      acc.runs[event.payload.run] ??= { outstanding: {}, drained: 0, suspended: 0 }
      const state = acc.runs[event.payload.run]!
      switch (event.type) {
        case 'dispatcher.upgrade-detected':
          state.detected = event
          break
        case 'dispatcher.upgrade-failed':
          if (state.handoff?.payload.correlation === event.payload.correlation) break
          state.failure = event
          if (state.request?.payload.correlation === event.payload.correlation)
            state.request = undefined
          break
        case 'dispatcher.target-prepared':
          if (state.handoff && !state.completed) break
          if (
            state.prepared?.payload.correlation === event.payload.correlation ||
            (state.request && !state.failure)
          )
            break
          state.prepared = event
          state.failure = undefined
          state.request = undefined
          break
        case 'dispatcher.yield-requested':
          if (
            state.failure ||
            state.request ||
            state.handoff ||
            !state.prepared ||
            !same(state.prepared.payload, event.payload)
          )
            break
          if (event.payload.successor === event.payload.run) break
          state.request = event
          break
        case 'dispatcher.handoff-started':
          if (state.handoff || (event.payload.mode && state.failure)) break
          // Historical handoffs predate the request protocol and mean cutover.
          if (
            event.payload.mode &&
            (!state.request ||
              !same(state.request.payload, event.payload) ||
              event.payload.successor !== state.request.payload.successor ||
              event.payload.mode !== state.request.payload.mode)
          )
            break
          state.handoff = event
          state.failure = undefined
          state.deadline = event.payload.deadline
          state.outstanding = Object.fromEntries(
            (event.payload.builds ?? []).map((b) => [b.slug, b.instance]),
          )
          break
        case 'dispatcher.terminal-released':
          if (state.handoff && same(state.handoff.payload, event.payload)) state.released ??= event
          break
        case 'dispatcher.takeover':
          if (
            state.released &&
            same(state.released.payload, event.payload) &&
            state.request?.payload.successor === event.payload.successor
          )
            state.takeover ??= event
          break
        case 'dispatcher.drain-deadline':
          if (!state.completed && state.handoff && same(state.handoff.payload, event.payload))
            state.deadline = event.payload.deadline
          break
        case 'dispatcher.drain-settled':
          if (
            !state.completed &&
            state.handoff &&
            same(state.handoff.payload, event.payload) &&
            state.outstanding[event.payload.slug] === event.payload.instance
          ) {
            delete state.outstanding[event.payload.slug]
            if (event.payload.outcome === 'drained') state.drained++
            if (event.payload.outcome === 'suspended') state.suspended++
          }
          break
        case 'dispatcher.handoff-completed':
          if (
            state.handoff &&
            same(state.handoff.payload, event.payload) &&
            Object.keys(state.outstanding).length === 0 &&
            (!state.request || state.request.payload.successor === event.payload.successor)
          )
            state.completed ??= event
          break
      }
    }
  },
  finish: (acc) => structuredClone(acc),
})
