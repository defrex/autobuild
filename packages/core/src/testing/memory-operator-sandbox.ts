/**
 * An IO-free operator-sandbox provider double for unit tests: it implements
 * only what `createOperatorSandboxService` touches (`name`,
 * `orchestratorSandbox`, `sandboxPublication`) and records every command,
 * file and push in memory. `FakeWorkspaceProvider` spawns processes and
 * touches the filesystem, so tests under the unit IO guard use this instead.
 */
import type { WorkspaceProvider, WorkspacePublication } from '../ports/types'
import type {
  OperatorSandboxExecution,
  SandboxCommandResult,
  SandboxEnvironmentIdentity,
} from '../ports/workspace/operator-sandbox'

/** The base head every fresh provision reports. */
export const MEMORY_SANDBOX_BASE_SHA = '0'.repeat(40)
/** The checkout head `git rev-parse` reports, a descendant of the base. */
export const MEMORY_SANDBOX_HEAD_SHA = '1'.repeat(40)

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
}

function scripted(command: string): SandboxCommandResult {
  if (command.startsWith('git rev-parse'))
    return { exitCode: 0, stdout: `${MEMORY_SANDBOX_HEAD_SHA}\n`, stderr: '' }
  if (command.startsWith('git status --porcelain')) return { exitCode: 0, stdout: '', stderr: '' }
  if (command.startsWith('git merge-base --is-ancestor'))
    return { exitCode: 0, stdout: '', stderr: '' }
  return { exitCode: 0, stdout: command, stderr: '' }
}

export function memoryOperatorSandbox(name = 'memory-sandbox'): MemoryOperatorSandbox {
  const commands: MemoryOperatorSandbox['commands'] = []
  const pushes: MemoryOperatorSandbox['pushes'] = []
  const releases: MemoryOperatorSandbox['releases'] = []
  const files = new Map<string, Uint8Array>()
  const started = new Map<string, SandboxCommandResult>()

  const identity = (input: { repo: string; operator: string }): SandboxEnvironmentIdentity => ({
    provider: name,
    environmentId: `${name}:${input.repo}:${input.operator}`,
    workspacePath: '/checkout',
  })

  const orchestratorSandbox: OperatorSandboxExecution = {
    async describe(input) {
      return identity(input)
    },
    async ensure(input) {
      return { ...identity(input), baseSha: MEMORY_SANDBOX_BASE_SHA }
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

  return { provider, commands, pushes, releases, files }
}
