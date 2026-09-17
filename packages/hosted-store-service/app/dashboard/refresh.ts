import type { OperatorDashboardSnapshot } from '@defrex/autobuild-hosted-store-service/operator-api'

/** The dashboard's steady poll cadence, measured from one settle to the next start. */
export const POLL_INTERVAL_MS = 2000
/** A snapshot that has not answered by this bound is aborted and reported. */
export const SNAPSHOT_TIMEOUT_MS = 30_000
export const SNAPSHOT_TIMEOUT_MESSAGE = 'dashboard snapshot timed out'

type TimerHandle = ReturnType<typeof globalThis.setTimeout>
type TimerScheduler = (handler: () => void, delay?: number) => TimerHandle
type TimerCanceller = (handle: TimerHandle) => void

export interface DashboardRefresherOptions {
  fetch: (repo: string, signal: AbortSignal) => Promise<OperatorDashboardSnapshot>
  /** Whether requests may start right now. The component supplies () => !document.hidden. */
  visible: () => boolean
  onSnapshot: (snapshot: OperatorDashboardSnapshot) => void
  onError: (message: string) => void
  /** Poll-clock pending state: true when a request is in flight. */
  onPendingChange: (pending: boolean) => void
  setTimeout?: TimerScheduler
  clearTimeout?: TimerCanceller
  intervalMs?: number
  timeoutMs?: number
}

export interface DashboardRefresher {
  setRepo(repo: string): void
  request(): Promise<void>
  onVisibilityChange(): void
  dispose(): void
}

interface Run {
  repo: string
  generation: number
  controller: AbortController
  timedOut: boolean
  timeoutTimer: TimerHandle | undefined
}

/**
 * Serializes the dashboard's snapshot refreshes. At most one request is in
 * flight; demands made while one is in flight coalesce into a single trailing
 * refresh that starts as soon as it settles; the next poll starts `intervalMs`
 * after each settle; every request is bounded by `timeoutMs`; and nothing new
 * starts while the document is hidden.
 *
 * Extracted from `DashboardClient` as a plain module (no React, no DOM) so the
 * schedule, coalescing, timeout, repository-switch, and visibility policy are
 * exercised directly under `bun:test` with an injected clock and fetch.
 */
export function createDashboardRefresher(options: DashboardRefresherOptions): DashboardRefresher {
  const fetchSnapshot = options.fetch
  const isVisible = options.visible
  const onSnapshot = options.onSnapshot
  const onError = options.onError
  const onPendingChange = options.onPendingChange
  const schedule = options.setTimeout ?? globalThis.setTimeout
  const cancel = options.clearTimeout ?? globalThis.clearTimeout
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS
  const timeoutMs = options.timeoutMs ?? SNAPSHOT_TIMEOUT_MS

  let repo = ''
  let disposed = false
  let pending = false
  /** A refresh is owed: a demand arrived while one was in flight. */
  let requested = false
  /** Bumped on every repository change so stale answers are discarded. */
  let generation = 0
  let inFlight: Run | undefined
  let pollTimer: TimerHandle | undefined
  /** Promises awaiting the refresh that satisfies their demand. */
  let waiters: Array<() => void> = []

  function reportPending(next: boolean): void {
    if (pending === next) return
    pending = next
    onPendingChange(next)
  }

  function clearPollTimer(): void {
    if (pollTimer !== undefined) {
      cancel(pollTimer)
      pollTimer = undefined
    }
  }

  function clearRunTimer(run: Run): void {
    if (run.timeoutTimer !== undefined) {
      cancel(run.timeoutTimer)
      run.timeoutTimer = undefined
    }
  }

  function resolveWaiters(): void {
    const outstanding = waiters
    waiters = []
    for (const resolve of outstanding) resolve()
  }

  function scheduleNext(): void {
    clearPollTimer()
    pollTimer = schedule(() => {
      pollTimer = undefined
      start()
    }, intervalMs)
  }

  function start(): void {
    if (disposed || !repo || !isVisible()) return
    if (inFlight) {
      requested = true
      return
    }
    clearPollTimer()
    const run: Run = {
      repo,
      generation,
      controller: new AbortController(),
      timedOut: false,
      timeoutTimer: undefined,
    }
    inFlight = run
    reportPending(true)
    run.timeoutTimer = schedule(() => {
      run.timedOut = true
      run.controller.abort()
    }, timeoutMs)
    void perform(run)
  }

  async function perform(run: Run): Promise<void> {
    try {
      const snapshot = await fetchSnapshot(run.repo, run.controller.signal)
      if (run.generation === generation && !disposed) onSnapshot(snapshot)
    } catch (cause) {
      if (run.controller.signal.aborted) {
        // Repository switches and disposal abort silently; a timeout reports.
        if (run.timedOut) onError(SNAPSHOT_TIMEOUT_MESSAGE)
      } else {
        onError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    settle(run)
  }

  function settle(run: Run): void {
    if (inFlight !== run) return
    clearRunTimer(run)
    inFlight = undefined
    reportPending(false)
    if (disposed) {
      resolveWaiters()
      return
    }
    if (!isVisible()) {
      requested = false
      resolveWaiters()
      return
    }
    if (requested) {
      requested = false
      // The trailing refresh satisfies the waiters; keep them until it settles.
      start()
      return
    }
    resolveWaiters()
    scheduleNext()
  }

  return {
    setRepo(next: string): void {
      if (disposed) return
      generation += 1
      repo = next
      requested = false
      clearPollTimer()
      const previous = inFlight
      if (previous) {
        inFlight = undefined
        clearRunTimer(previous)
        previous.controller.abort()
      }
      if (!repo || !isVisible()) {
        if (previous) {
          reportPending(false)
          resolveWaiters()
        }
        return
      }
      start()
    },

    request(): Promise<void> {
      if (disposed || !repo || !isVisible()) return Promise.resolve()
      if (inFlight) {
        requested = true
        return new Promise<void>((resolve) => waiters.push(resolve))
      }
      return new Promise<void>((resolve) => {
        waiters.push(resolve)
        start()
      })
    },

    onVisibilityChange(): void {
      if (disposed) return
      if (!isVisible()) {
        clearPollTimer()
        requested = false
        return
      }
      if (!repo) return
      if (inFlight) {
        requested = true
        return
      }
      clearPollTimer()
      start()
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      clearPollTimer()
      const previous = inFlight
      if (previous) {
        inFlight = undefined
        clearRunTimer(previous)
        previous.controller.abort()
        reportPending(false)
      }
      resolveWaiters()
    },
  }
}
