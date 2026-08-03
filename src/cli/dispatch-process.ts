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

export interface DispatchChildResult {
  exitCode: number
  signal?: string
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
    const signal = child.signalCode === null ? undefined : String(child.signalCode)
    const events = await deps.store.getRepoEvents(deps.repo)
    const hasStop = events.some(
      (event) => event.type === 'dispatcher.run-stopped' && event.payload.run === deps.run,
    )
    if (!hasStop) {
      await deps.store.appendRepo(deps.repo, {
        actor: DISPATCHER,
        type: 'dispatcher.run-stopped',
        payload: {
          run: deps.run,
          outcome: forced ? 'forced' : stopping && exitCode === 0 ? 'normal' : 'abnormal',
          exitCode,
          ...(signal !== undefined ? { signal } : {}),
          ...(forced || stopping || exitCode === 0
            ? {}
            : { error: `kernel process exited with status ${exitCode}` }),
        },
      })
    }
    return { exitCode, ...(signal !== undefined ? { signal } : {}) }
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
