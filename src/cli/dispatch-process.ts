import { fileURLToPath } from 'node:url'
import { DISPATCHER } from '../events/envelope'
import type { RepositoryEvent } from '../events/repository'
import type { BuildStore } from '../store/types'

export const DISPATCH_CHILD_OPTIONS_ENV = 'AB_DISPATCH_CHILD_OPTIONS'
const DEFAULT_STOP_TIMEOUT_MS = 5_000

export interface DispatchChildOptions {
  targetRepo: string
  storeRef: string
  run: string
  once: boolean
  intervalMs?: number
}

export type DispatchChildOutcome = 'normal' | 'abnormal' | 'forced'

export interface DispatchChildResult {
  outcome: DispatchChildOutcome
  exitCode: number
  signal?: string
  error?: string
}

export interface DispatchChildHandle {
  completed: Promise<DispatchChildResult>
  stop(): Promise<void>
}

export interface DispatchSubprocess {
  exited: Promise<number>
  exitCode: number | null
  signalCode: string | number | null
  kill(signal: 'SIGINT' | 'SIGKILL'): void
}

export interface DispatchProcessHook {
  close(): void
}

export const DISPATCH_KERNEL_SIGNALS = [
  'SIGINT',
  'SIGHUP',
  'SIGQUIT',
  'SIGTERM',
] as const satisfies readonly NodeJS.Signals[]

type DispatchKernelSignal = (typeof DISPATCH_KERNEL_SIGNALS)[number]

export interface DispatchKernelSignalBoundary {
  on(signal: DispatchKernelSignal, listener: () => void): unknown
  removeListener(signal: DispatchKernelSignal, listener: () => void): unknown
}

/** Keep graceful handlers active until the kernel has actually drained. Using
 * one-shot handlers would expose the child to the default disposition on a
 * repeated Ctrl-C while it is still crossing an unsafe claim boundary. */
export function installDispatchKernelSignalHandlers(
  onStop: () => void,
  boundary: DispatchKernelSignalBoundary = process,
): DispatchProcessHook {
  for (const signal of DISPATCH_KERNEL_SIGNALS) boundary.on(signal, onStop)
  let closed = false
  return {
    close(): void {
      if (closed) return
      closed = true
      for (const signal of DISPATCH_KERNEL_SIGNALS) boundary.removeListener(signal, onStop)
    },
  }
}

export interface DispatchParentWatchDeps {
  intervalMs?: number
  currentParentPid?: () => number
  isAlive?: (pid: number) => boolean
}

/** A private kernel must never become a detached daemon if its terminal-owning
 * parent is killed directly rather than through the foreground process group.
 * Polling is deliberately local process liveness, not an operational IPC
 * channel; shutdown still converges through the normal AbortSignal boundary. */
export function watchDispatchParent(
  parentPid: number,
  onParentExit: () => void,
  deps: DispatchParentWatchDeps = {},
): DispatchProcessHook {
  const currentParentPid = deps.currentParentPid ?? (() => process.ppid)
  const isAlive =
    deps.isAlive ??
    ((pid: number): boolean => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    })
  let closed = false
  let timer: ReturnType<typeof setInterval>
  const close = (): void => {
    if (closed) return
    closed = true
    clearInterval(timer)
  }
  timer = setInterval(() => {
    if (currentParentPid() === parentPid && isAlive(parentPid)) return
    close()
    onParentExit()
  }, deps.intervalMs ?? 100)
  timer.unref?.()
  return { close }
}

export interface DispatchChildSupervisorDeps {
  store: BuildStore
  repo: string
  run: string
  env: Record<string, string | undefined>
  options: DispatchChildOptions
  stopTimeoutMs?: number
  entrypoint?: string
  /** Injectable process seam for lifecycle and timeout tests. */
  spawn?: (input: {
    entrypoint: string
    cwd: string
    env: Record<string, string>
  }) => DispatchSubprocess
}

function hasOpenTick(events: readonly RepositoryEvent[], run: string): boolean {
  const boundary = events.findLast(
    (event) =>
      'run' in event.payload &&
      event.payload.run === run &&
      (event.type === 'dispatcher.tick-started' ||
        event.type === 'dispatcher.tick-completed' ||
        event.type === 'dispatcher.tick-failed'),
  )
  return boundary?.type === 'dispatcher.tick-started'
}

function defaultSpawn(input: {
  entrypoint: string
  cwd: string
  env: Record<string, string>
}): DispatchSubprocess {
  return Bun.spawn([process.execPath, input.entrypoint], {
    cwd: input.cwd,
    env: input.env,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  })
}

/** Spawn and reap the private kernel. Changing operational state never crosses
 * this boundary: options are immutable launch identity and all live facts and
 * commands use BuildStore. */
export function superviseDispatchChild(deps: DispatchChildSupervisorDeps): DispatchChildHandle {
  const entrypoint =
    deps.entrypoint ?? fileURLToPath(new URL('../../bin/ab-dispatch-kernel.ts', import.meta.url))
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(deps.env)) if (value !== undefined) env[key] = value
  env[DISPATCH_CHILD_OPTIONS_ENV] = JSON.stringify(deps.options)
  const child = (deps.spawn ?? defaultSpawn)({ entrypoint, cwd: deps.repo, env })

  let stopping = false
  let forced = false
  let stopPromise: Promise<void> | undefined
  // This is the sole supervisor writer of a missing stop fact. `stop()` only
  // chooses/awaits process termination, avoiding check-then-append races.
  const completed = child.exited.then(async (exitCode): Promise<DispatchChildResult> => {
    const processSignal = child.signalCode === null ? undefined : String(child.signalCode)
    const events = await deps.store.getRepoEvents(deps.repo)
    const recorded = events.findLast(
      (event) => event.type === 'dispatcher.run-stopped' && event.payload.run === deps.run,
    )
    if (recorded?.type === 'dispatcher.run-stopped') {
      const signal = processSignal ?? recorded.payload.signal
      return {
        outcome: recorded.payload.outcome,
        exitCode,
        ...(signal !== undefined ? { signal } : {}),
        ...(recorded.payload.error !== undefined ? { error: recorded.payload.error } : {}),
      }
    }

    const outcome: DispatchChildOutcome = forced
      ? 'forced'
      : stopping && exitCode === 0 && processSignal === undefined
        ? 'normal'
        : 'abnormal'
    const error =
      outcome === 'abnormal'
        ? `kernel process exited with status ${exitCode}${
            processSignal !== undefined ? ` (signal ${processSignal})` : ''
          }`
        : undefined
    await deps.store.appendRepo(deps.repo, {
      actor: DISPATCHER,
      type: 'dispatcher.run-stopped',
      payload: {
        run: deps.run,
        outcome,
        exitCode,
        ...(processSignal !== undefined ? { signal: processSignal } : {}),
        ...(error !== undefined ? { error } : {}),
      },
    })
    return {
      outcome,
      exitCode,
      ...(processSignal !== undefined ? { signal: processSignal } : {}),
      ...(error !== undefined ? { error } : {}),
    }
  })

  return {
    completed,
    stop(): Promise<void> {
      if (stopPromise !== undefined) return stopPromise
      stopPromise = (async () => {
        if (child.exitCode !== null) return
        stopping = true
        child.kill('SIGINT')
        const timeout = deps.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS
        const stopped = await Promise.race([
          child.exited.then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), timeout)),
        ])
        if (stopped || child.exitCode !== null) return

        // A dispatcher tick may hold an external ticket claim before its build
        // record exists. Killing that turn can make the ticket disappear from
        // Ready with no durable build to recover. Let an open tick reach its
        // normal boundary; all non-tick work is lease-backed/recoverable and a
        // child stuck there is safe to terminate.
        const events = await deps.store.getRepoEvents(deps.repo)
        // The child may have exited while the asynchronous journal read was in
        // flight. Re-check at the force boundary so evidence never claims a
        // SIGKILL that was not actually sent.
        if (child.exitCode !== null) return
        if (hasOpenTick(events, deps.run)) {
          await child.exited
          return
        }

        forced = true
        child.kill('SIGKILL')
        await child.exited
      })()
      return stopPromise
    },
  }
}
