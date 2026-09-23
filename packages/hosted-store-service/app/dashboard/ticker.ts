/** The dashboard's one-second "now" cadence, mirroring `POLL_INTERVAL_MS` in `refresh.ts`. */
export const TICK_INTERVAL_MS = 1000

type TimerHandle = ReturnType<typeof globalThis.setInterval>
type TimerScheduler = (handler: () => void, delay?: number) => TimerHandle
type TimerCanceller = (handle: TimerHandle) => void

export interface NowTickerOptions {
  /** Whether the document is visible right now. The component supplies () => !document.hidden. */
  visible: () => boolean
  onTick: () => void
  setInterval?: TimerScheduler
  clearInterval?: TimerCanceller
  intervalMs?: number
}

export interface NowTicker {
  onVisibilityChange(): void
  dispose(): void
}

/**
 * Runs the dashboard's one-second now-ticker, pausing while the document is
 * hidden so a backgrounded tab is not woken every second for a render nobody
 * sees. On the hidden → visible transition it ticks once immediately — the
 * rendered timestamp is `Date.now()` at tick time, never accumulated state, so
 * the hidden gap cannot leave it stale — then resumes the steady cadence.
 *
 * Extracted from `DashboardClient` as a plain module (no React, no DOM) so the
 * pause/resume policy is exercised directly under `bun:test` with an injected
 * clock, the same seam as the snapshot refresher in `refresh.ts`.
 */
export function createNowTicker(options: NowTickerOptions): NowTicker {
  const isVisible = options.visible
  const onTick = options.onTick
  const schedule = options.setInterval ?? globalThis.setInterval
  const cancel = options.clearInterval ?? globalThis.clearInterval
  const intervalMs = options.intervalMs ?? TICK_INTERVAL_MS

  let disposed = false
  let tickTimer: TimerHandle | undefined

  function clearTickTimer(): void {
    if (tickTimer !== undefined) {
      cancel(tickTimer)
      tickTimer = undefined
    }
  }

  function resume(): void {
    clearTickTimer()
    onTick()
    tickTimer = schedule(onTick, intervalMs)
  }

  // Start while visible; stay dormant until visibility returns.
  if (isVisible()) tickTimer = schedule(onTick, intervalMs)

  return {
    onVisibilityChange(): void {
      if (disposed) return
      if (!isVisible()) {
        clearTickTimer()
        return
      }
      if (tickTimer !== undefined) return
      resume()
    },

    dispose(): void {
      disposed = true
      clearTickTimer()
    },
  }
}
