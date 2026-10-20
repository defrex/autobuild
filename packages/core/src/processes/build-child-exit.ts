import { DEFAULT_PROCESS_GROUP_STOP_TIMEOUT_MS } from './process-group'
import type { ProcessGroupReaperOptions } from './process-group-reaper'
import { launchProcessGroupReaper, processGroupReaperOptions } from './process-group-reaper'

interface ParentWatch {
  close(): void
}

export interface BuildChildExitCoordinatorOptions {
  groupId: number
  stopTimeoutMs?: number
  launchReaper?: (options: ProcessGroupReaperOptions) => number
  exit?: (code: number) => void
  retryDelayMs?: number
}

/**
 * Transfers teardown ownership before a build-child leader exits. Every
 * terminal path shares this coordinator so signal/watchdog races preserve the
 * first exit intent and create exactly one detached group reaper.
 */
export class BuildChildExitCoordinator {
  private readonly reaperOptions: ProcessGroupReaperOptions
  private readonly launchReaper: (options: ProcessGroupReaperOptions) => number
  private readonly exit: (code: number) => void
  private readonly retryDelayMs: number
  private parentWatch: ParentWatch | undefined
  private parentWatchClosed = false
  private intendedExitCode: number | undefined
  private retry: ReturnType<typeof setTimeout> | undefined
  private handedOff = false

  constructor(options: BuildChildExitCoordinatorOptions) {
    this.reaperOptions =
      options.stopTimeoutMs === undefined
        ? processGroupReaperOptions(options.groupId)
        : { groupId: options.groupId, stopTimeoutMs: options.stopTimeoutMs }
    this.launchReaper = options.launchReaper ?? launchProcessGroupReaper
    this.exit = options.exit ?? process.exit
    this.retryDelayMs = options.retryDelayMs ?? 10
  }

  setParentWatch(parentWatch: ParentWatch): void {
    this.parentWatch = parentWatch
    if (this.intendedExitCode !== undefined) this.closeParentWatch()
  }

  terminate(exitCode: number, remainingStopMs?: number): void {
    if (this.intendedExitCode === undefined) {
      this.intendedExitCode = exitCode
      if (remainingStopMs !== undefined)
        this.reaperOptions.stopTimeoutMs = Math.min(
          this.reaperOptions.stopTimeoutMs,
          Math.max(0, remainingStopMs),
        )
    }
    if (this.handedOff) return

    this.closeParentWatch()
    this.tryHandoff()
  }

  private closeParentWatch(): void {
    if (this.parentWatch === undefined || this.parentWatchClosed) return
    this.parentWatchClosed = true
    this.parentWatch.close()
  }

  private tryHandoff(): void {
    if (this.handedOff || this.retry !== undefined) return
    try {
      this.launchReaper(this.reaperOptions)
    } catch {
      // Do not let the leader disappear while detached ownership is absent.
      // A referenced retry keeps natural completion alive until spawn succeeds.
      this.retry = setTimeout(() => {
        this.retry = undefined
        this.tryHandoff()
      }, this.retryDelayMs)
      return
    }

    this.handedOff = true
    this.exit(this.intendedExitCode!)
  }
}

/** Shares the original process-group stop deadline with agent persistence.
 * A repeated signal never restarts the deadline or bypasses the first intent. */
export class BuildChildShutdown {
  private readonly controller = new AbortController()
  private deadline: number | undefined
  private exitCode: number | undefined
  private cancel: (() => void) | undefined
  constructor(
    private readonly terminal: BuildChildExitCoordinator,
    private readonly now: () => number = Date.now,
    private readonly schedule: (callback: () => void, delay: number) => () => void = (
      callback,
      delay,
    ) => {
      const timer = setTimeout(callback, delay)
      return () => clearTimeout(timer)
    },
  ) {}
  get signal(): AbortSignal {
    return this.controller.signal
  }
  request(exitCode: number): void {
    if (this.controller.signal.aborted) return
    this.exitCode = exitCode
    this.deadline = this.now() + DEFAULT_PROCESS_GROUP_STOP_TIMEOUT_MS
    this.cancel = this.schedule(
      () => this.finish(exitCode),
      DEFAULT_PROCESS_GROUP_STOP_TIMEOUT_MS - 1_000,
    )
    this.controller.abort(new Error('dispatcher shutdown'))
  }
  finish(exitCode: number): void {
    this.cancel?.()
    this.terminal.terminate(
      this.exitCode ?? exitCode,
      this.deadline === undefined ? undefined : Math.max(0, this.deadline - this.now()),
    )
  }
}
