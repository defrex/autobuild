import { fileURLToPath } from 'node:url'
import { DISPATCHER } from '../events/envelope'
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

export interface DispatchChildSupervisorDeps {
  store: BuildStore
  repo: string
  run: string
  env: Record<string, string | undefined>
  options: DispatchChildOptions
  stopTimeoutMs?: number
  entrypoint?: string
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
  const child = Bun.spawn([process.execPath, entrypoint], {
    cwd: deps.repo,
    env,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  })

  let stopping = false
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
          outcome: stopping && exitCode === 0 ? 'normal' : 'abnormal',
          exitCode,
          ...(signal !== undefined ? { signal } : {}),
          ...(stopping || exitCode === 0
            ? {}
            : { error: `kernel process exited with status ${exitCode}` }),
        },
      })
    }
    return { exitCode, ...(signal !== undefined ? { signal } : {}) }
  })

  return {
    completed,
    async stop(): Promise<void> {
      if (child.exitCode !== null) return
      stopping = true
      child.kill('SIGINT')
      const timeout = deps.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS
      const stopped = await Promise.race([
        child.exited.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), timeout)),
      ])
      if (!stopped && child.exitCode === null) {
        child.kill('SIGKILL')
        await child.exited
        const events = await deps.store.getRepoEvents(deps.repo)
        if (
          !events.some(
            (event) => event.type === 'dispatcher.run-stopped' && event.payload.run === deps.run,
          )
        ) {
          await deps.store.appendRepo(deps.repo, {
            actor: DISPATCHER,
            type: 'dispatcher.run-stopped',
            payload: { run: deps.run, outcome: 'forced', signal: 'SIGKILL' },
          })
        }
      }
    },
  }
}
