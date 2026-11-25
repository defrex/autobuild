/**
 * An IO-free operator-sandbox provider double for unit tests: it implements
 * only what `createOperatorSandboxService` touches (`name`,
 * `orchestratorSandbox`, `sandboxPublication`) and records every command,
 * file and push in memory. `FakeWorkspaceProvider` spawns processes and
 * touches the filesystem, so tests under the unit IO guard use this instead.
 *
 * Lifecycle: `immediate` provisioning (the default) makes `open` return
 * `ready` at once; `deferred` returns `provisioning`/`resuming` plus a
 * `settled` promise the test resolves through `complete`. Environment state
 * (existence, recorded base head, failure) lives in the double itself, the
 * analogue of the local providers' on-disk marker, so a second service over
 * the same double sees it without the first service's promise. No timers.
 */
import type { WorkspaceProvider, WorkspacePublication } from '../ports/types'
import type {
  OperatorSandboxExecution,
  SandboxCommandResult,
  SandboxEnvironmentIdentity,
  SandboxProviderStatus,
  SandboxProvisionStage,
  SandboxRefreshResult,
} from '../ports/workspace/operator-sandbox'

/** The base head every fresh provision reports by default. */
export const MEMORY_SANDBOX_BASE_SHA = '0'.repeat(40)
/** The checkout head `git rev-parse` reports, a descendant of the base. */
export const MEMORY_SANDBOX_HEAD_SHA = '1'.repeat(40)

export interface MemoryOperatorSandboxOptions {
  provisioning?: 'immediate' | 'deferred'
  /** `close`/`release` of a deferred in-flight attempt resolve it `ready`
   * instead of cancelling it: setup finished just before the abort. */
  completeBeforeClose?: boolean
  /** `false` models a provider without the lifecycle: `lifecycleSupported`
   * is false and `ensure` plus every lifecycle method throws if called. */
  lifecycle?: boolean
}

export interface MemoryOperatorSandbox {
  provider: WorkspaceProvider
  /** Every exec/start, in order, with the environment it ran in. */
  readonly commands: { environmentId: string; command: string }[]
  /** Every published commit, in order. */
  readonly pushes: { ref: string; sha: string; branch: string }[]
  /** Every release, in order. */
  readonly releases: { operator: string; environmentId: string }[]
  /** Checkout files, keyed by `<environmentId>\0<path>`. */
  readonly files: Map<string, Uint8Array>
  /** Every `open` call, in order. */
  readonly opened: { environmentId: string }[]
  /** Every `close` call, in order. */
  readonly closed: { environmentId: string }[]
  /** Every `refresh` call, in order. */
  readonly refreshes: { environmentId: string }[]
  /** Environments whose in-flight attempt `close`/`release` cancelled. */
  readonly cancelled: string[]
  /** Calls to `ensure` (the service must make none). */
  readonly ensureCalls: string[]
  /** Settle the latest non-cancelled in-flight attempt. A no-op when none
   * is in flight (a late completion of a cancelled attempt). */
  complete(
    result: 'ready' | { stage: SandboxProvisionStage; message: string },
    baseSha?: string,
  ): void
  /** The next `refresh` result; defaults to a fast-forward. */
  refreshResult: SandboxRefreshResult
}

interface Attempt {
  environmentId: string
  kind: 'provision' | 'resume'
  resolve: (status: SandboxProviderStatus) => void
  promise: Promise<SandboxProviderStatus>
  done: boolean
}

function scripted(command: string): SandboxCommandResult {
  if (command.startsWith('git rev-parse'))
    return { exitCode: 0, stdout: `${MEMORY_SANDBOX_HEAD_SHA}\n`, stderr: '' }
  if (command.startsWith('git status --porcelain')) return { exitCode: 0, stdout: '', stderr: '' }
  if (command.startsWith('git merge-base --is-ancestor'))
    return { exitCode: 0, stdout: '', stderr: '' }
  return { exitCode: 0, stdout: command, stderr: '' }
}

export function memoryOperatorSandbox(
  name = 'memory-sandbox',
  opts: MemoryOperatorSandboxOptions = {},
): MemoryOperatorSandbox {
  const deferred = opts.provisioning === 'deferred'
  const lifecycle = opts.lifecycle !== false
  const commands: MemoryOperatorSandbox['commands'] = []
  const pushes: MemoryOperatorSandbox['pushes'] = []
  const releases: MemoryOperatorSandbox['releases'] = []
  const opened: MemoryOperatorSandbox['opened'] = []
  const closed: MemoryOperatorSandbox['closed'] = []
  const refreshes: MemoryOperatorSandbox['refreshes'] = []
  const cancelled: string[] = []
  const ensureCalls: string[] = []
  const files = new Map<string, Uint8Array>()
  const started = new Map<string, SandboxCommandResult>()
  /** Provisioned environments: their recorded base head and whether closed. */
  const environments = new Map<string, { baseSha: string; stopped: boolean }>()
  const failures = new Map<string, { stage: SandboxProvisionStage; message: string }>()
  const inflight = new Map<string, Attempt>()
  const attempts: Attempt[] = []

  const identity = (input: { repo: string; operator: string }): SandboxEnvironmentIdentity => ({
    provider: name,
    environmentId: `${name}:${input.repo}:${input.operator}`,
    workspacePath: '/checkout',
  })
  const ready = (
    handle: SandboxEnvironmentIdentity,
    kind?: 'provision' | 'resume',
  ): SandboxProviderStatus => {
    const env = environments.get(handle.environmentId)
    return {
      state: 'ready',
      handle: { ...handle, ...(env !== undefined ? { baseSha: env.baseSha } : {}) },
      headSha: MEMORY_SANDBOX_HEAD_SHA,
      ...(kind !== undefined ? { kind } : {}),
    }
  }
  const settle = (attempt: Attempt, status: SandboxProviderStatus): void => {
    if (attempt.done) return
    attempt.done = true
    if (inflight.get(attempt.environmentId) === attempt) inflight.delete(attempt.environmentId)
    attempt.resolve(status)
  }
  const finish = (
    attempt: Attempt,
    handle: SandboxEnvironmentIdentity,
    result: 'ready' | { stage: SandboxProvisionStage; message: string },
    baseSha = MEMORY_SANDBOX_BASE_SHA,
  ): void => {
    if (result === 'ready') {
      const existing = environments.get(attempt.environmentId)
      environments.set(attempt.environmentId, {
        baseSha: attempt.kind === 'resume' && existing !== undefined ? existing.baseSha : baseSha,
        stopped: false,
      })
      settle(attempt, ready(handle, attempt.kind))
    } else {
      failures.set(attempt.environmentId, result)
      settle(attempt, { state: 'failed', failure: result })
    }
  }
  /** Cancel (or, with `completeBeforeClose`, complete) an in-flight attempt. */
  const stopAttempt = (handle: SandboxEnvironmentIdentity): SandboxProviderStatus | undefined => {
    const attempt = inflight.get(handle.environmentId)
    if (attempt === undefined) return undefined
    if (opts.completeBeforeClose === true) {
      finish(attempt, handle, 'ready')
      return ready(handle, attempt.kind)
    }
    cancelled.push(handle.environmentId)
    const status: SandboxProviderStatus = { state: 'absent', cancelled: true }
    settle(attempt, status)
    return status
  }
  const disabled = (operation: string): never => {
    throw new Error(`memory operator sandbox has no lifecycle; ${operation} must not be called`)
  }
  const byEnvironment = (environmentId: string): SandboxEnvironmentIdentity => ({
    provider: name,
    environmentId,
    workspacePath: '/checkout',
  })

  const orchestratorSandbox: OperatorSandboxExecution = {
    lifecycleSupported: lifecycle,
    async describe(input) {
      return identity(input)
    },
    async ensure(input) {
      ensureCalls.push(identity(input).environmentId)
      if (!lifecycle) disabled('ensure')
      return { ...identity(input), baseSha: MEMORY_SANDBOX_BASE_SHA }
    },
    async open(input) {
      if (!lifecycle) disabled('open')
      const handle = identity(input)
      opened.push({ environmentId: handle.environmentId })
      const current = inflight.get(handle.environmentId)
      if (current !== undefined) {
        return {
          status: {
            state: current.kind === 'resume' ? 'resuming' : 'provisioning',
            kind: current.kind,
          },
          settled: current.promise,
        }
      }
      const env = environments.get(handle.environmentId)
      const kind = env !== undefined ? 'resume' : 'provision'
      failures.delete(handle.environmentId)
      if (!deferred) {
        if (env === undefined) {
          environments.set(handle.environmentId, {
            baseSha: MEMORY_SANDBOX_BASE_SHA,
            stopped: false,
          })
        } else {
          env.stopped = false
        }
        return { status: ready(handle, kind) }
      }
      if (env !== undefined && !env.stopped) return { status: ready(handle, 'resume') }
      let resolve!: (status: SandboxProviderStatus) => void
      const promise = new Promise<SandboxProviderStatus>((r) => {
        resolve = r
      })
      const attempt: Attempt = {
        environmentId: handle.environmentId,
        kind,
        resolve,
        promise,
        done: false,
      }
      inflight.set(handle.environmentId, attempt)
      attempts.push(attempt)
      return {
        status: { state: kind === 'resume' ? 'resuming' : 'provisioning', kind },
        settled: promise,
      }
    },
    async status(input) {
      if (!lifecycle) disabled('status')
      const handle = identity(input)
      const current = inflight.get(handle.environmentId)
      if (current !== undefined)
        return { state: current.kind === 'resume' ? 'resuming' : 'provisioning' }
      const failure = failures.get(handle.environmentId)
      if (failure !== undefined) return { state: 'failed', failure }
      const env = environments.get(handle.environmentId)
      if (env === undefined) return { state: 'absent' }
      if (env.stopped) return { state: 'stopped' }
      return ready(handle)
    },
    async close(input) {
      if (!lifecycle) disabled('close')
      closed.push({ environmentId: input.environmentId })
      const handle = byEnvironment(input.environmentId)
      const attempt = stopAttempt(handle)
      const env = environments.get(input.environmentId)
      if (env !== undefined) env.stopped = true
      return {
        outcome: env !== undefined ? 'closed' : 'absent',
        ...(attempt !== undefined ? { attempt } : {}),
      }
    },
    async refresh(handle) {
      if (!lifecycle) disabled('refresh')
      refreshes.push({ environmentId: handle.environmentId })
      return sandbox.refreshResult
    },
    async exec(handle, request) {
      commands.push({ environmentId: handle.environmentId, command: request.command })
      return scripted(request.command)
    },
    async start(handle, request) {
      commands.push({ environmentId: handle.environmentId, command: request.command })
      const commandId = `cmd-${commands.length}`
      started.set(commandId, scripted(request.command))
      return { commandId }
    },
    async wait(_handle, input) {
      const result = started.get(input.commandId)
      return result === undefined
        ? { state: 'exited', exitCode: 127, stdout: '', stderr: 'unknown command id' }
        : { state: 'exited', ...result }
    },
    async readFile(handle, path) {
      const content = files.get(`${handle.environmentId}\0${path}`)
      if (content === undefined) throw new Error(`no such file: ${path}`)
      return content
    },
    async writeFile(handle, path, content) {
      files.set(`${handle.environmentId}\0${path}`, content)
    },
    async stop() {
      return { outcome: 'unsupported' }
    },
    async release(input) {
      releases.push({ operator: input.operator, environmentId: input.environmentId })
      const attempt = inflight.get(input.environmentId)
      if (attempt !== undefined) {
        cancelled.push(input.environmentId)
        settle(attempt, { state: 'absent', cancelled: true })
      }
      environments.delete(input.environmentId)
      failures.delete(input.environmentId)
      for (const key of [...files.keys()])
        if (key.startsWith(`${input.environmentId}\0`)) files.delete(key)
      return { snapshots: { outcome: 'confirmed', deleted: 0 } }
    },
  }

  const sandboxPublication: WorkspacePublication = {
    async isPublished(input) {
      return pushes.some((push) => push.sha === input.sha && push.branch === input.branch)
    },
    async publish(input) {
      pushes.push({ ...input })
    },
  }

  const provider: WorkspaceProvider = {
    name,
    orchestratorSandbox,
    sandboxPublication,
    async provision() {
      throw new Error('memory operator sandbox provider does not provision build workspaces')
    },
    async release() {
      throw new Error('memory operator sandbox provider does not release build workspaces')
    },
  }

  const sandbox: MemoryOperatorSandbox = {
    provider,
    commands,
    pushes,
    releases,
    files,
    opened,
    closed,
    refreshes,
    cancelled,
    ensureCalls,
    refreshResult: {
      outcome: 'refreshed',
      headSha: '2'.repeat(40),
      baseSha: '2'.repeat(40),
      previousHeadSha: MEMORY_SANDBOX_HEAD_SHA,
    },
    complete(result, baseSha) {
      const attempt = attempts.filter((candidate) => !candidate.done).at(-1)
      if (attempt === undefined) return
      finish(attempt, byEnvironment(attempt.environmentId), result, baseSha)
    },
  }
  return sandbox
}
