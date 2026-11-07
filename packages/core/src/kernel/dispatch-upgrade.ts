import type { RepositoryEvent } from '../events/repository'
import { defineReducer } from './incremental'
export type Handoff = Extract<RepositoryEvent, { type: 'dispatcher.target-prepared' }>['payload']
type Fact<T extends RepositoryEvent['type']> = Extract<RepositoryEvent, { type: T }>
export interface UpgradeRun {
  resolved?: Fact<'dispatcher.upgrade-target-resolved'>
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
  authoritativeRun?: string
  runs: Record<string, UpgradeRun>
  lineages: Record<string, string>
  rollbackIds: string[]
  lastRollback?: Fact<'dispatcher.runtime-rolled-back'>
  holds: Record<string, Fact<'dispatcher.runtime-rolled-back'>>
}
/**
 * Retention window for every map in the dispatch-upgrade state. The state is
 * read on every dispatch tick, dashboard poll and status read, so it must not
 * grow with the number of dispatcher generations. Every decision reads the
 * authoritative generation, its immediate predecessor, the run that just
 * started, a recently observed lease owner, or the newest handoffs, so recent
 * runs suffice. Eviction never drops the authoritative run, the run holding the
 * newest accepted handoff (each handoff captures every then-open remote
 * execution), or the three newest settled runs (status's latest earlier
 * outcome). Full history stays in the repository journal.
 */
export const UPGRADE_HISTORY_LIMIT = 16

/** The newest fact sequence recorded on a run, or -1 when it has none. */
export function upgradeRunRecency(run: UpgradeRun): number {
  return Math.max(
    -1,
    ...[
      run.resolved,
      run.detected,
      run.failure,
      run.prepared,
      run.request,
      run.handoff,
      run.released,
      run.takeover,
      run.completed,
    ].map((fact) => fact?.seq ?? -1),
  )
}

const settledSeq = (run: UpgradeRun) => (run.completed ?? run.failure)?.seq ?? -1
// Runs without an accepted handoff go first, then completed handoffs; runs
// still draining an accepted handoff go last.
const evictionTier = (run: UpgradeRun) => (!run.handoff ? 0 : run.completed ? 1 : 2)

function retainRuns(acc: DispatchUpgradeState, touched: string) {
  while (Object.keys(acc.runs).length > UPGRADE_HISTORY_LIMIT) {
    const entries = Object.entries(acc.runs)
    // The newest accepted handoff carries the remote captures authorization needs.
    let newestHandoff: string | undefined
    for (const [id, run] of entries)
      if (
        run.handoff &&
        (!newestHandoff || run.handoff.seq > acc.runs[newestHandoff]!.handoff!.seq)
      )
        newestHandoff = id
    // Status's latest earlier outcome excludes at most the current and
    // live-handoff runs, so the three newest settled runs always contain it.
    const settled = new Set(
      entries
        .filter(([, run]) => settledSeq(run) >= 0)
        .sort(([, a], [, b]) => settledSeq(b) - settledSeq(a))
        .slice(0, 3)
        .map(([id]) => id),
    )
    let victim: string | undefined
    let victimRank: [number, number] = [0, 0]
    for (const [id, run] of entries) {
      if (id === touched || id === acc.authoritativeRun || id === newestHandoff || settled.has(id))
        continue
      const rank: [number, number] = [evictionTier(run), upgradeRunRecency(run)]
      if (
        victim === undefined ||
        rank[0] < victimRank[0] ||
        (rank[0] === victimRank[0] &&
          (rank[1] < victimRank[1] || (rank[1] === victimRank[1] && id < victim)))
      ) {
        victim = id
        victimRank = rank
      }
    }
    delete acc.runs[victim!]
  }
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
  version: 7,
  initial: () => ({ runs: {}, holds: {}, lineages: {}, rollbackIds: [] }),
  fold(acc, events) {
    for (const event of events) {
      if (event.type === 'dispatcher.run-started' && event.payload.lineage) {
        const started = event.payload.run
        // Reinsert so key order is start order. Dispatch run ids are
        // non-integer strings (`<host>-dispatch-<id>`), so JavaScript keeps
        // insertion order; integer-like ids would only change which entry
        // goes first, not the bound.
        delete acc.lineages[started]
        acc.lineages[started] = event.payload.lineage
        for (const run of Object.keys(acc.lineages)) {
          if (Object.keys(acc.lineages).length <= UPGRADE_HISTORY_LIMIT) break
          if (run !== acc.authoritativeRun && run !== started) delete acc.lineages[run]
        }
      }
      // Starts and yielded ticks are not proof of repository authority.
      if (event.type === 'dispatcher.tick-started') acc.authoritativeRun = event.payload.run
      if (event.type === 'dispatcher.runtime-rolled-back') {
        if (acc.rollbackIds.includes(event.payload.correlation)) continue
        acc.rollbackIds.push(event.payload.correlation)
        // Duplicate appends happen only next to the original, so a recent
        // window of correlations still deduplicates them.
        while (acc.rollbackIds.length > UPGRADE_HISTORY_LIMIT) acc.rollbackIds.shift()
        acc.authoritativeRun = event.payload.run
        acc.lastRollback = event
        acc.holds[event.payload.lineage] = event
        const current = acc.lineages[acc.authoritativeRun]
        while (Object.keys(acc.holds).length > UPGRADE_HISTORY_LIMIT) {
          const oldest = Object.entries(acc.holds)
            .filter(([lineage]) => lineage !== current && lineage !== event.payload.lineage)
            .reduce((a, b) => (b[1].seq < a[1].seq ? b : a))
          delete acc.holds[oldest[0]]
        }
        continue
      }
      if (event.type === 'dispatcher.rollback-hold-cleared') {
        const hold = acc.holds[event.payload.lineage]
        if (
          hold?.payload.correlation === event.payload.correlation &&
          hold.payload.target.key !== event.payload.target.key
        )
          delete acc.holds[event.payload.lineage]
        continue
      }
      if (event.type !== 'dispatcher.upgrade-target-resolved' && !('correlation' in event.payload))
        continue
      if (!('run' in event.payload) || typeof event.payload.run !== 'string') continue
      const run = event.payload.run
      acc.runs[run] ??= { outstanding: {}, drained: 0, suspended: 0 }
      const state = acc.runs[run]!
      switch (event.type) {
        case 'dispatcher.upgrade-target-resolved':
          state.resolved = event
          break
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
          ) {
            state.takeover ??= event
            acc.authoritativeRun = event.payload.successor
          }
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
      retainRuns(acc, run)
    }
  },
  finish: (acc) => structuredClone(acc),
})
