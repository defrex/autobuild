import { bunRuntimeArguments } from './runtime-spawn'
import { spawnUsingRuntime } from './dispatch-runtime-use'
import { distributionRoot } from '../distribution'
import { readDispatcherRunFacts } from '../store/reduced-reads'
import { distributionPath } from '../distribution'
import { DISPATCHER } from '../events/envelope'
import type { BuildStore } from '../store/types'

export const DISPATCH_CHILD_OPTIONS_ENV = 'AB_DISPATCH_CHILD_OPTIONS'

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
  stop(signal?: string): Promise<void>
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
  onStop: (signal: DispatchKernelSignal) => void,
  boundary: DispatchKernelSignalBoundary = process,
): DispatchProcessHook {
  const listeners = DISPATCH_KERNEL_SIGNALS.map((signal) => ({
    signal,
    listener: () => onStop(signal),
  }))
  for (const { signal, listener } of listeners) boundary.on(signal, listener)
  let closed = false
  return {
    close(): void {
      if (closed) return
      closed = true
      for (const { signal, listener } of listeners) boundary.removeListener(signal, listener)
    },
  }
}

export { watchDispatchParent, type DispatchParentWatchDeps } from './dispatch-parent-watch'
export interface DispatchChildSupervisorDeps {
  store: BuildStore
  /** Repository identity (§12) — the Store journal key. */
  repo: string
  /** Process cwd for the spawned kernel; defaults to `repo` (checkout mode). */
  cwd?: string
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

function defaultSpawn(input: {
  entrypoint: string
  cwd: string
  env: Record<string, string>
}): DispatchSubprocess {
  const { child, release } = spawnUsingRuntime(distributionRoot(), () =>
    Bun.spawn(bunRuntimeArguments(input.entrypoint), {
      cwd: input.cwd,
      env: input.env,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    }),
  )
  void child.exited.finally(release)
  return child
}

/** Spawn and reap the private kernel. Changing operational state never crosses
 * this boundary: options are immutable launch identity and all live facts and
 * commands use BuildStore. */
export function superviseDispatchChild(deps: DispatchChildSupervisorDeps): DispatchChildHandle {
  const entrypoint = deps.entrypoint ?? distributionPath('bin', 'ab-dispatch-kernel.ts')
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(deps.env)) if (value !== undefined) env[key] = value
  delete env.AB_DISPATCH_GENERATION
  env[DISPATCH_CHILD_OPTIONS_ENV] = JSON.stringify(deps.options)
  const child = (deps.spawn ?? defaultSpawn)({ entrypoint, cwd: deps.cwd ?? deps.repo, env })

  let requestedSignal: string | undefined
  let stopping = false
  let stopPromise: Promise<void> | undefined
  // This is the sole supervisor writer of a missing stop fact. `stop()` only
  // chooses/awaits process termination, avoiding check-then-append races.
  const completed = child.exited.then(async (exitCode): Promise<DispatchChildResult> => {
    const processSignal = child.signalCode === null ? requestedSignal : String(child.signalCode)
    const recorded = (await readDispatcherRunFacts(deps.store, deps.repo, deps.run, false)).value
      .stop
    if (recorded?.type === 'dispatcher.run-stopped') {
      const signal = processSignal ?? recorded.payload.signal
      return {
        outcome: recorded.payload.outcome,
        exitCode,
        ...(signal !== undefined ? { signal } : {}),
        ...(recorded.payload.error !== undefined ? { error: recorded.payload.error } : {}),
      }
    }

    const outcome: DispatchChildOutcome =
      stopping && exitCode === 0 && child.signalCode === null ? 'normal' : 'abnormal'
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
    stop(signal?: string): Promise<void> {
      if (stopPromise !== undefined) return stopPromise
      stopPromise = (async () => {
        if (child.exitCode !== null) return
        stopping = true
        requestedSignal = signal
        if (signal !== undefined) {
          try {
            await deps.store.appendRepo(deps.repo, {
              actor: DISPATCHER,
              type: 'dispatcher.stop-requested',
              payload: { run: deps.run, signal },
            })
          } catch {
            // Signal delivery must survive a transient Store failure. The
            // kernel can still record its own abort reason after draining.
          }
        }
        child.kill('SIGINT')
        // The kernel owns local runner suspension and its durable writes.
        // Neither an elapsed deadline nor a closed claim tick proves those
        // writes finished. Keep graceful signal handlers installed while waiting.
        await child.exited
      })()
      return stopPromise
    },
  }
}
