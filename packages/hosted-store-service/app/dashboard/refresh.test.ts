import { expect, test } from 'bun:test'
import type { OperatorDashboardSnapshot } from '@defrex/autobuild-hosted-store-service/operator-api'
import {
  createDashboardRefresher,
  POLL_INTERVAL_MS,
  SNAPSHOT_TIMEOUT_MESSAGE,
  SNAPSHOT_TIMEOUT_MS,
} from './refresh'

type TimerHandle = ReturnType<typeof setTimeout>

/** A manual clock: `setTimeout` records work, `advance` fires it in due order. */
class TimerQueue {
  private nextId = 1
  private timers = new Map<number, { at: number; run: () => void }>()
  now = 0

  readonly setTimeout = (handler: () => void, delay = 0): TimerHandle => {
    const id = this.nextId++
    this.timers.set(id, { at: this.now + delay, run: handler })
    return id as unknown as TimerHandle
  }

  readonly clearTimeout = (handle: TimerHandle): void => {
    this.timers.delete(handle as unknown as number)
  }

  advance(ms: number): void {
    const target = this.now + ms
    while (true) {
      let due: number | undefined
      let at = Number.POSITIVE_INFINITY
      for (const [id, timer] of this.timers) {
        if (timer.at < at) {
          at = timer.at
          due = id
        }
      }
      if (due === undefined || at > target) break
      this.now = at
      const timer = this.timers.get(due)!
      this.timers.delete(due)
      timer.run()
    }
    this.now = target
  }
}

function snapshot(generatedAt: string): OperatorDashboardSnapshot {
  return {
    generatedAt,
    model: { repo: 'repo', builds: [] },
    settingsHeader: {},
  } as unknown as OperatorDashboardSnapshot
}

interface Call {
  repo: string
  signal: AbortSignal
  resolve: (value: OperatorDashboardSnapshot) => void
  reject: (error: unknown) => void
}

function fetchHarness() {
  const calls: Call[] = []
  const fetch = (repo: string, signal: AbortSignal): Promise<OperatorDashboardSnapshot> =>
    new Promise((resolve, reject) => {
      calls.push({ repo, signal, resolve, reject })
      signal.addEventListener('abort', () => reject(new Error('aborted')))
    })
  return { calls, fetch }
}

function harness(options: { visible?: () => boolean } = {}) {
  const timers = new TimerQueue()
  const snapshots: OperatorDashboardSnapshot[] = []
  const errors: string[] = []
  const pendingChanges: boolean[] = []
  const fetches = fetchHarness()
  const refresher = createDashboardRefresher({
    fetch: fetches.fetch,
    visible: options.visible ?? (() => true),
    onSnapshot: (snap) => snapshots.push(snap),
    onError: (message) => errors.push(message),
    onPendingChange: (pending) => pendingChanges.push(pending),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  })
  return {
    timers,
    snapshots,
    errors,
    pendingChanges,
    calls: fetches.calls,
    refresher,
    generated: () => snapshots.map((snap) => snap.generatedAt),
  }
}

/** Let queued promise continuations run without advancing the manual clock. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

test('criterion 1: no second snapshot request starts while one is in flight', async () => {
  const h = harness()
  h.refresher.setRepo('repo')
  expect(h.calls).toHaveLength(1)

  h.timers.advance(POLL_INTERVAL_MS * 5)
  expect(h.calls).toHaveLength(1)

  const first = h.refresher.request()
  const second = h.refresher.request()
  expect(h.calls).toHaveLength(1)

  h.calls[0]!.resolve(snapshot('a'))
  await flush()
  expect(h.calls).toHaveLength(2)

  h.calls[1]!.resolve(snapshot('b'))
  await flush()
  await first
  await second
  expect(h.generated()).toEqual(['a', 'b'])
})

test('criterion 2: a snapshot that answers after the interval is rendered and unpends the clock', async () => {
  const h = harness()
  h.refresher.setRepo('repo')

  h.timers.advance(POLL_INTERVAL_MS + 1000)
  expect(h.calls).toHaveLength(1)

  h.calls[0]!.resolve(snapshot('late'))
  await flush()

  expect(h.generated()).toEqual(['late'])
  expect(h.pendingChanges).toEqual([true, false])
})

test('criterion 3: the next refresh starts intervalMs after a successful settle', async () => {
  const h = harness()
  h.refresher.setRepo('repo')
  h.calls[0]!.resolve(snapshot('a'))
  await flush()

  h.timers.advance(POLL_INTERVAL_MS - 1)
  expect(h.calls).toHaveLength(1)
  h.timers.advance(1)
  expect(h.calls).toHaveLength(2)
})

test('criterion 3: the next refresh starts intervalMs after a failed settle', async () => {
  const h = harness()
  h.refresher.setRepo('repo')
  h.calls[0]!.reject(new Error('snapshot failed'))
  await flush()
  expect(h.errors).toEqual(['snapshot failed'])

  h.timers.advance(POLL_INTERVAL_MS - 1)
  expect(h.calls).toHaveLength(1)
  h.timers.advance(1)
  expect(h.calls).toHaveLength(2)
})

test('criterion 4: demands during a refresh collapse into one trailing refresh', async () => {
  const h = harness()
  h.refresher.setRepo('repo')

  const demands = [h.refresher.request(), h.refresher.request(), h.refresher.request()]
  let resolved = 0
  for (const demand of demands) void demand.then(() => resolved++)
  expect(h.calls).toHaveLength(1)

  h.calls[0]!.resolve(snapshot('a'))
  await flush()
  expect(h.calls).toHaveLength(2)
  expect(resolved).toBe(0)

  h.calls[1]!.resolve(snapshot('b'))
  await flush()
  expect(resolved).toBe(3)
  expect(h.generated()).toEqual(['a', 'b'])
})

test('criterion 4: a demand while idle refreshes immediately with no interval wait', async () => {
  const h = harness()
  h.refresher.setRepo('repo')
  h.calls[0]!.resolve(snapshot('a'))
  await flush()

  const demand = h.refresher.request()
  expect(h.calls).toHaveLength(2)
  h.calls[1]!.resolve(snapshot('b'))
  await flush()
  await demand
  expect(h.generated()).toEqual(['a', 'b'])
})

test('criterion 5: a repository switch aborts the old request and renders only the new repo', async () => {
  const h = harness()
  h.refresher.setRepo('a')
  const previous = h.calls[0]!
  h.refresher.setRepo('b')

  expect(previous.signal.aborted).toBe(true)
  expect(h.calls).toHaveLength(2)
  expect(h.calls[1]!.repo).toBe('b')

  await flush()
  expect(h.generated()).toEqual([])
  expect(h.errors).toEqual([])

  h.calls[1]!.resolve(snapshot('b'))
  await flush()
  expect(h.generated()).toEqual(['b'])
})

test('criterion 5: dispose aborts silently and resolves outstanding demands', async () => {
  const h = harness()
  h.refresher.setRepo('repo')
  const demand = h.refresher.request()
  h.refresher.dispose()

  expect(h.calls[0]!.signal.aborted).toBe(true)
  await demand
  await flush()

  expect(h.generated()).toEqual([])
  expect(h.errors).toEqual([])
  expect(h.pendingChanges).toEqual([true, false])
})

test('criterion 6: a snapshot that never answers is aborted at the timeout and reported once', async () => {
  const h = harness()
  h.refresher.setRepo('repo')

  h.timers.advance(SNAPSHOT_TIMEOUT_MS - 1)
  expect(h.calls[0]!.signal.aborted).toBe(false)

  h.timers.advance(1)
  expect(h.calls[0]!.signal.aborted).toBe(true)
  await flush()

  expect(h.errors).toEqual([SNAPSHOT_TIMEOUT_MESSAGE])
  expect(h.pendingChanges).toEqual([true, false])

  h.timers.advance(POLL_INTERVAL_MS - 1)
  expect(h.calls).toHaveLength(1)
  h.timers.advance(1)
  expect(h.calls).toHaveLength(2)
})

test('criterion 6: a snapshot that answers before the timeout never reports one', async () => {
  const h = harness()
  h.refresher.setRepo('repo')

  h.timers.advance(SNAPSHOT_TIMEOUT_MS - 1)
  h.calls[0]!.resolve(snapshot('in time'))
  await flush()
  h.timers.advance(1)
  await flush()

  expect(h.errors).toEqual([])
  expect(h.generated()).toEqual(['in time'])
})

test('criterion 7: a hidden document starts no requests and a visible one refreshes immediately', async () => {
  let hidden = false
  const h = harness({ visible: () => !hidden })
  h.refresher.setRepo('repo')
  h.calls[0]!.resolve(snapshot('a'))
  await flush()

  hidden = true
  h.refresher.onVisibilityChange()
  h.timers.advance(POLL_INTERVAL_MS * 3)
  expect(h.calls).toHaveLength(1)

  const demand = h.refresher.request()
  await demand
  expect(h.calls).toHaveLength(1)

  hidden = false
  h.refresher.onVisibilityChange()
  expect(h.calls).toHaveLength(2)

  h.calls[1]!.resolve(snapshot('b'))
  await flush()
  h.timers.advance(POLL_INTERVAL_MS - 1)
  expect(h.calls).toHaveLength(2)
  h.timers.advance(1)
  expect(h.calls).toHaveLength(3)
})

test('criterion 7: an in-flight request may finish and render after the document hides', async () => {
  let hidden = false
  const h = harness({ visible: () => !hidden })
  h.refresher.setRepo('repo')

  hidden = true
  h.refresher.onVisibilityChange()
  h.calls[0]!.resolve(snapshot('while hidden'))
  await flush()

  expect(h.generated()).toEqual(['while hidden'])
  h.timers.advance(POLL_INTERVAL_MS * 3)
  expect(h.calls).toHaveLength(1)
})

test('criterion 7: becoming visible during an in-flight request runs a trailing refresh at settle', async () => {
  let hidden = false
  const h = harness({ visible: () => !hidden })
  h.refresher.setRepo('repo')

  hidden = true
  h.refresher.onVisibilityChange()
  hidden = false
  h.refresher.onVisibilityChange()

  h.calls[0]!.resolve(snapshot('a'))
  await flush()
  expect(h.calls).toHaveLength(2)

  h.calls[1]!.resolve(snapshot('b'))
  await flush()
  expect(h.generated()).toEqual(['a', 'b'])
})
