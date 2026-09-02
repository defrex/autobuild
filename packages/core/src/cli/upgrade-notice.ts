export const UPGRADE_NOTICE_INTERVAL_MS = 4 * 60 * 60 * 1_000
export const UPGRADE_NOTICE_DEADLINE_MS = 30_000

export type AvailableReleaseProbe = (signal: AbortSignal) => Promise<string | undefined>

export interface UpgradeNoticeTimer {
  clear(): void
  unref?(): void
}

export interface UpgradeNoticeScheduler {
  interval(callback: () => void, ms: number): UpgradeNoticeTimer
  timeout(callback: () => void, ms: number): UpgradeNoticeTimer
}

const productionScheduler: UpgradeNoticeScheduler = {
  interval(callback, ms) {
    const timer = setInterval(callback, ms)
    return {
      clear: () => clearInterval(timer),
      unref: () => timer.unref?.(),
    }
  },
  timeout(callback, ms) {
    const timer = setTimeout(callback, ms)
    return {
      clear: () => clearTimeout(timer),
      unref: () => timer.unref?.(),
    }
  },
}

export interface UpgradeNoticeOptions {
  probe: AvailableReleaseProbe
  onAvailable: (version: string) => void
  scheduler?: UpgradeNoticeScheduler
}

/** Run the dashboard's release courtesy in the background. The returned stop
 * function is synchronous and idempotent: teardown never joins a probe that
 * ignores cancellation. */
export function startUpgradeNotice(options: UpgradeNoticeOptions): () => void {
  const scheduler = options.scheduler ?? productionScheduler
  let stopped = false
  let current: AbortController | undefined

  const check = (): void => {
    if (stopped || current !== undefined) return
    const controller = new AbortController()
    current = controller
    let deadline: UpgradeNoticeTimer
    try {
      deadline = scheduler.timeout(() => {
        controller.abort()
        // A probe may ignore cancellation forever. Release the overlap guard at
        // the deadline so the next four-hour boundary can still try again.
        if (current === controller) current = undefined
      }, UPGRADE_NOTICE_DEADLINE_MS)
      deadline.unref?.()
    } catch {
      current = undefined
      return
    }

    void (async () => {
      try {
        const version = await options.probe(controller.signal)
        if (!stopped && !controller.signal.aborted && version !== undefined) {
          options.onAvailable(version)
        }
      } catch {
        // Upgrade discovery is a silent courtesy, never a dispatcher warning.
      } finally {
        deadline.clear()
        if (current === controller) current = undefined
      }
    })()
  }

  const cadence = scheduler.interval(check, UPGRADE_NOTICE_INTERVAL_MS)
  cadence.unref?.()
  check()

  return () => {
    if (stopped) return
    stopped = true
    cadence.clear()
    current?.abort()
    current = undefined
  }
}
