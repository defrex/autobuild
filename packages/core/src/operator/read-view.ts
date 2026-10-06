/**
 * The operator read paths' repository view: every poll-driven route (dashboard,
 * repository and harvest status, build listings) derives its state from a
 * `RepoViewStore` cold-started from stored reducer snapshots and advanced with
 * delta reads, so a poll's event-row cost follows the events appended since the
 * last one, never the history, the open tabs, or the watchers.
 *
 * Passes are single-flight per `(store, repo)` within one serving process: at
 * most one pass runs at a time, and requests arriving while it runs join the
 * one trailing pass (each needs state at least as new as its arrival, which the
 * running pass cannot promise). That trailing pass restores from the snapshot
 * the previous pass persisted, so N concurrent pollers cost one delta read per
 * pass, not N. The coordination is scheduling inside this process; every datum
 * still comes from durable state, and a second serving process simply reads the
 * same delta once itself (duplicate reads are bounded by the process count).
 */
import { RepoViewStore } from '../processes/repo-view'
import type { BuildStore } from '../store/types'

/** What a request reads: the journal alone, or the builds beside it. */
export type OperatorViewNeed = 'journal' | 'builds'

interface Waiter {
  need: OperatorViewNeed
  run: (view: RepoViewStore) => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

interface Flight {
  running: boolean
  queue: Waiter[]
}

const flights = new WeakMap<BuildStore, Map<string, Flight>>()

function flightFor(store: BuildStore, repo: string): Flight {
  let byRepo = flights.get(store)
  if (byRepo === undefined) {
    byRepo = new Map()
    flights.set(store, byRepo)
  }
  let flight = byRepo.get(repo)
  if (flight === undefined) {
    flight = { running: false, queue: [] }
    byRepo.set(repo, flight)
  }
  return flight
}

async function pass(store: BuildStore, repo: string, waiters: Waiter[]): Promise<void> {
  const view = new RepoViewStore(store, { repo })
  try {
    if (waiters.some((waiter) => waiter.need === 'builds')) await view.refresh()
    else await view.startJournal()
  } catch (error) {
    for (const waiter of waiters) waiter.reject(error)
    return
  }
  await Promise.all(waiters.map((waiter) => waiter.run(view).then(waiter.resolve, waiter.reject)))
  // Leave the advanced state behind for the next pass (this process's or
  // another's). `held` also writes a settled build read for a listing. The
  // cache never fails a read.
  try {
    await view.persistSnapshots({ force: true, held: true })
  } catch {
    // A cache: the next pass retries.
  }
}

async function drain(store: BuildStore, repo: string, flight: Flight): Promise<void> {
  flight.running = true
  try {
    while (flight.queue.length > 0) {
      const waiters = flight.queue
      flight.queue = []
      await pass(store, repo, waiters)
    }
  } finally {
    flight.running = false
  }
}

/** Run `run` against a freshly advanced repository view. The view is only valid
 * inside `run`; the response must not hold it. */
export function withOperatorView<T>(
  store: BuildStore,
  repo: string,
  need: OperatorViewNeed,
  run: (view: RepoViewStore) => Promise<T>,
): Promise<T> {
  const flight = flightFor(store, repo)
  const result = new Promise<T>((resolve, reject) => {
    flight.queue.push({ need, run, resolve: resolve as (value: unknown) => void, reject })
  })
  if (!flight.running) void drain(store, repo, flight)
  return result
}
