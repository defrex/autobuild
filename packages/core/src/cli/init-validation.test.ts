import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import type { NetworkPolicy } from '@vercel/sandbox'
import { DISPATCHER } from '../events/envelope'
import type { AgentRunner } from '../ports/types'
import type { RuntimeRegistry } from '../ports/runner/runtime'
import { spawnExec, type Exec } from '../ports/workspace/git-worktree'
import { builtinWorkspaceProviderCapabilities } from '../ports/workspace/builtin-capabilities'
import {
  validateVercelSandbox,
  type VercelSandboxFacade,
  type VercelSnapshotInfo,
  type VercelSandboxHandle,
} from '../ports/workspace/vercel-sandbox'
import { openLocalStore } from '../store/local/store'
import { loadConfig } from '../config/load'
import type { BuildStore } from '../store/types'
import {
  createReadinessRedactor,
  runGuestReadinessProbe,
  validateInitReadiness,
  type GuestProbeReport,
  type InitValidationReport,
} from './init-validation'
import { runCli } from './main'

// The test file lives at packages/core/src/cli/, so four levels up is the
// repository root — resolving the real probe from here keeps the suite
// runnable from any working directory (see bin-ab.test.ts for the same idiom).
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const runner: AgentRunner = {
  name: 'fake',
  start: async () => {
    throw new Error('not used')
  },
  continue: async () => {
    throw new Error('not used')
  },
  end: async () => {
    throw new Error('not used')
  },
}

async function committedLocalRepo(prefix: string): Promise<{ repo: string; config: string }> {
  const repo = await mkdtemp(join(tmpdir(), prefix))
  roots.push(repo)
  const config = `baseBranch = "main"
[commands]
[roles.default]
runtime = "fake"
[tickets]
source = "file"
readyState = "ready"
`
  await writeFile(join(repo, 'autobuild.toml'), config)
  await writeFile(join(repo, '.gitignore'), '.autobuild/\n')
  for (const command of [
    ['git', 'init', '-b', 'main'],
    ['git', 'config', 'user.email', 'test@example.com'],
    ['git', 'config', 'user.name', 'Test'],
    ['git', 'add', 'autobuild.toml', '.gitignore'],
    ['git', 'commit', '-m', 'setup'],
  ]) {
    const result = await spawnExec(command, { cwd: repo })
    expect(result.exitCode, result.stderr).toBe(0)
  }
  return { repo, config }
}

const usableRuntime: RuntimeRegistry = {
  fake: { runner, servesModels: [], initUsable: async () => ({ usable: true, reason: 'ready' }) },
}

const REAL_OPERATION_TIMEOUT_MS = 15_000
const REAL_SCENARIO_TIMEOUT_MS = 45_000
const REAL_TEST_TIMEOUT_MS = 60_000
const FAKE_TEST_TIMEOUT_MS = 2_000

interface DeadlineOptions {
  operationMs: number
  scenarioMs: number
}

class OperationTracker {
  private activeOperation = 'no operation active'
  private activeAbort: ((reason: Error) => void) | undefined
  private readonly operationTimers = new Set<ReturnType<typeof setTimeout>>()
  private scenarioTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(private readonly options: DeadlineOptions) {}

  async run<T>(
    label: string,
    operation: () => Promise<T>,
    abort?: (reason: Error) => void,
  ): Promise<T> {
    const previous = this.activeOperation
    const previousAbort = this.activeAbort
    this.activeOperation = label
    this.activeAbort = abort
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(
          `${label} exceeded ${this.options.operationMs}ms operation deadline`,
        )
        abort?.(error)
        reject(error)
      }, this.options.operationMs)
      this.operationTimers.add(timer)
    })
    try {
      return await Promise.race([operation(), deadline])
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer)
        this.operationTimers.delete(timer)
      }
      this.activeOperation = previous
      this.activeAbort = previousAbort
    }
  }

  exec(base: Exec): Exec {
    return async (command, options) => {
      const label =
        command[0] === 'sh' && command[1] === '-c'
          ? `setup: sh -c ${command[2]}`
          : command.join(' ')
      const controller = new AbortController()
      const relayAbort = () =>
        controller.abort(options.signal?.reason ?? new Error(`${label} cancelled`))
      if (options.signal?.aborted) relayAbort()
      else options.signal?.addEventListener('abort', relayAbort, { once: true })
      try {
        return await this.run(
          label,
          () => base(command, { ...options, signal: controller.signal }),
          (reason) => controller.abort(reason),
        )
      } finally {
        options.signal?.removeEventListener('abort', relayAbort)
      }
    }
  }

  async scenario<T>(body: () => Promise<T>): Promise<T> {
    const guard = new Promise<never>((_, reject) => {
      this.scenarioTimer = setTimeout(() => {
        const error = new Error(
          `scenario exceeded ${this.options.scenarioMs}ms while ${this.activeOperation}`,
        )
        this.activeAbort?.(error)
        reject(error)
      }, this.options.scenarioMs)
    })
    try {
      return await Promise.race([body(), guard])
    } finally {
      this.dispose()
    }
  }

  private dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.scenarioTimer !== undefined) clearTimeout(this.scenarioTimer)
    for (const timer of this.operationTimers) clearTimeout(timer)
    this.operationTimers.clear()
  }
}

function withTrackedScenario<T>(
  options: DeadlineOptions,
  body: (tracker: OperationTracker) => Promise<T>,
) {
  const tracker = new OperationTracker(options)
  return tracker.scenario(() => body(tracker))
}

function realGitScenario<T>(body: (tracker: OperationTracker) => Promise<T>): Promise<T> {
  expect(REAL_OPERATION_TIMEOUT_MS).toBeLessThan(REAL_SCENARIO_TIMEOUT_MS)
  expect(REAL_SCENARIO_TIMEOUT_MS).toBeLessThan(REAL_TEST_TIMEOUT_MS)
  return withTrackedScenario(
    { operationMs: REAL_OPERATION_TIMEOUT_MS, scenarioMs: REAL_SCENARIO_TIMEOUT_MS },
    body,
  )
}

async function detachedReadinessFixture(
  tracker: OperationTracker,
  config = `baseBranch = "main"
[commands]
setup = "printf ready > setup-marker"
[roles.default]
runtime = "fake"
[tickets]
source = "file"
readyState = "ready"
`,
): Promise<{ repo: string; config: string; exec: Exec }> {
  const repo = await mkdtemp(join(tmpdir(), 'ab-local-readiness-'))
  roots.push(repo)
  await writeFile(join(repo, 'autobuild.toml'), config)
  const exec = tracker.exec(spawnExec)
  for (const command of [
    ['git', 'init', '-b', 'main'],
    ['git', 'config', 'user.email', 'test@example.com'],
    ['git', 'config', 'user.name', 'Test'],
    ['git', 'add', 'autobuild.toml'],
    ['git', 'commit', '-m', 'setup'],
  ]) {
    const result = await exec(command, { cwd: repo })
    expect(result.exitCode, result.stderr).toBe(0)
  }
  return { repo, config, exec }
}

async function expectSingleWorktree(repo: string, exec: Exec): Promise<void> {
  const worktrees = await exec(['git', 'worktree', 'list', '--porcelain'], { cwd: repo })
  expect(worktrees.stdout.match(/^worktree /gm)).toHaveLength(1)
}

interface TreeEntry {
  kind: 'directory' | 'file'
  size: number
  mtimeMs: number
  bytes?: string
}

async function snapshotTree(root: string): Promise<Record<string, TreeEntry>> {
  const snapshot: Record<string, TreeEntry> = {}
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const entryPath = join(path, entry.name)
      const metadata = await stat(entryPath)
      const key = relative(root, entryPath)
      if (entry.isDirectory()) {
        snapshot[key] = { kind: 'directory', size: metadata.size, mtimeMs: metadata.mtimeMs }
        await visit(entryPath)
      } else {
        snapshot[key] = {
          kind: 'file',
          size: metadata.size,
          mtimeMs: metadata.mtimeMs,
          bytes: Buffer.from(await readFile(entryPath)).toString('hex'),
        }
      }
    }
  }
  await visit(root)
  return snapshot
}

function readOnlyStore(calls: string[]): BuildStore {
  return new Proxy(
    {
      listBuilds: async () => {
        calls.push('listBuilds')
        return []
      },
      close: async () => {
        calls.push('close')
      },
    },
    {
      get(target, property) {
        if (property in target) return target[property as keyof typeof target]
        return () => {
          throw new Error(`unexpected Store write/read: ${String(property)}`)
        }
      },
    },
  ) as unknown as BuildStore
}

function trackedRuntime(tracker: OperationTracker): RuntimeRegistry {
  return {
    fake: {
      runner,
      servesModels: [],
      initUsable: () =>
        tracker.run('runtime fake usability probe', async () => ({
          usable: true,
          reason: 'ready',
        })),
    },
  }
}

function trackedReadOnlyStore(tracker: OperationTracker, calls: string[]): BuildStore {
  const store = readOnlyStore(calls)
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'listBuilds')
        return () => tracker.run('Store listBuilds', () => target.listBuilds())
      if (property === 'close') return () => tracker.run('Store close', () => target.close())
      return Reflect.get(target, property, receiver)
    },
  })
}

const completeVercelPreflightEnv: Record<string, string | undefined> = {
  AB_STORE: 'https://store.example',
  AB_TOKEN: 'store-token',
  GITHUB_TOKEN: 'push-token',
  VERCEL_TOKEN: 'vercel-token',
  VERCEL_TEAM_ID: 'team-id',
  VERCEL_PROJECT_ID: 'project-id',
}

async function vercelPreflightFixture(forge = 'github') {
  const repo = await mkdtemp(join(tmpdir(), 'ab-vercel-preflight-'))
  roots.push(repo)
  await writeFile(
    join(repo, 'autobuild.toml'),
    `baseBranch = "main"
forge = "${forge}"
[workspace]
provider = "vercel-sandbox"
[workspace.config]
timeoutSeconds = 600
[workspace.config.runtimeProvisioning.fake]
install = "true"
preflight = "true"
[commands]
[roles.default]
runtime = "fake"
[tickets]
source = "file"
readyState = "ready"
`,
  )

  const reached = { repositoryResolution: 0, remoteGit: 0, sandbox: 0, packageArchive: 0 }
  const exec: Exec = async (command) => {
    if (command.includes('--show-toplevel')) {
      reached.repositoryResolution += 1
      return { stdout: '', stderr: 'not a Git repository', exitCode: 128 }
    }
    reached.remoteGit += 1
    throw new Error(`remote Git validation must not run: ${command.join(' ')}`)
  }
  const vercelFacade: VercelSandboxFacade = {
    get: async () => {
      reached.sandbox += 1
      throw new Error('Vercel validation must not run')
    },
    create: async () => {
      reached.sandbox += 1
      throw new Error('Vercel validation must not run')
    },
    createFresh: async () => {
      reached.sandbox += 1
      throw new Error('Vercel validation must not run')
    },
    listSnapshots: async () => [],
    deleteSnapshot: async () => {},
  }
  const packageArchive = async () => {
    reached.packageArchive += 1
    throw new Error('package validation must not run')
  }
  const expectValidationNotReached = () => {
    expect(reached).toEqual({
      repositoryResolution: 1,
      remoteGit: 0,
      sandbox: 0,
      packageArchive: 0,
    })
  }

  return { repo, exec, vercelFacade, packageArchive, expectValidationNotReached }
}

describe('init readiness probe', () => {
  test('runs setup before the selected runtime and performs only a Store read', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ab-readiness-test-'))
    roots.push(repo)
    await writeFile(
      join(repo, 'autobuild.toml'),
      `baseBranch = "main"
[commands]
setup = "printf ready > setup-marker"
[roles.default]
runtime = "fake"
[tickets]
source = "file"
readyState = "ready"
`,
    )
    const calls: string[] = []
    const runtimes: RuntimeRegistry = {
      fake: {
        runner,
        servesModels: [],
        initUsable: async ({ cwd }) => {
          expect(await readFile(join(cwd, 'setup-marker'), 'utf8')).toBe('ready')
          calls.push('runtime')
          return { usable: true, reason: 'authenticated' }
        },
      },
    }
    const report = await runGuestReadinessProbe({
      repo,
      env: { AB_STORE: 'https://store.example', API_KEY: 'distinct-secret' },
      runtimes,
      openStore: () => readOnlyStore(calls),
    })

    expect(report.checks.every((check) => check.status === 'pass')).toBe(true)
    expect(calls).toEqual(['runtime', 'listBuilds', 'close'])
  })

  test('surfaces a guest-unresolvable configured plugin in the check detail without failing readiness', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ab-readiness-plugin-skip-'))
    roots.push(repo)
    // Deliberately not the real plugin name: the impossible specifier must
    // resolve from neither the repository root nor the installation root
    // regardless of workspace layout.
    await writeFile(
      join(repo, 'autobuild.toml'),
      `plugins = ["@defrex/autobuild-definitely-not-a-plugin"]
[commands]
[roles.default]
runtime = "fake"
[tickets]
source = "file"
readyState = "ready"
`,
    )
    const calls: string[] = []
    const notices: string[] = []
    const originalError = console.error
    console.error = (line: unknown) => {
      notices.push(String(line))
    }
    let report: GuestProbeReport
    try {
      report = await runGuestReadinessProbe({
        repo,
        env: { AB_STORE: 'https://store.example' },
        runtimes: {
          fake: {
            runner,
            servesModels: [],
            initUsable: async () => {
              calls.push('runtime')
              return { usable: true, reason: 'authenticated' }
            },
          },
        },
        openStore: () => readOnlyStore(calls),
      })
    } finally {
      console.error = originalError
    }
    const plugins = report.checks.find((check) => check.name === 'configuration and plugins')
    // The skip is deliberate, not a failure: the check stays pass but names
    // the missing module (the loader's own notice text) and the sanctioned
    // remediation — make the package resolvable from the repository.
    expect(plugins?.status).toBe('pass')
    expect(plugins?.detail).toContain('@defrex/autobuild-definitely-not-a-plugin')
    expect(plugins?.detail).toContain('could not be resolved from')
    expect(plugins?.detail).toContain('guests never construct workspace providers')
    expect(plugins?.detail).toContain(
      "add the package to the repository's dependencies so it resolves from the repository install during commands.setup",
    )
    // stderr notice parity with loadPlugins.
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('@defrex/autobuild-definitely-not-a-plugin')
    // The skip is non-fatal: the runtime probe and the Store read still run.
    expect(calls).toEqual(['runtime', 'listBuilds', 'close'])
  })

  test('keeps a repo-path plugin resolution failure fail-closed in the guest probe', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ab-readiness-plugin-fail-'))
    roots.push(repo)
    await writeFile(
      join(repo, 'autobuild.toml'),
      `plugins = ["./absent-plugin.ts"]
[commands]
[roles.default]
runtime = "fake"
[tickets]
source = "file"
readyState = "ready"
`,
    )
    const report = await runGuestReadinessProbe({
      repo,
      env: { AB_STORE: 'https://store.example' },
      runtimes: usableRuntime,
      openStore: () => readOnlyStore([]),
    })
    // loadPlugins' fail-closed precedence is preserved: the probe stops at
    // the plugin failure and renders the loader's error with the existing
    // remediation; the runtime probe never runs.
    expect(report.checks.map((check) => check.name)).toEqual([
      'repository setup',
      'configuration and plugins',
    ])
    const plugins = report.checks.find((check) => check.name === 'configuration and plugins')
    expect(plugins?.status).toBe('fail')
    expect(plugins?.detail).toContain('absent-plugin.ts')
    expect(plugins?.detail).toContain('could not be resolved from repository')
    expect(plugins?.detail).toContain(
      'install or correct the configured plugin in this environment',
    )
  })

  test('keeps the transitional registration skip out of the guest probe detail', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ab-readiness-plugin-regskip-'))
    roots.push(repo)
    // The real plugin resolves from this repository's root devDependency and
    // is then registration-skipped against the builtin vercel-sandbox
    // provider — the documented transitional arrangement, so the check detail
    // must stay exactly as it was before the skip-surfacing change.
    await writeFile(
      join(repo, 'autobuild.toml'),
      `plugins = ["@defrex/autobuild-vercel-sandbox"]
[commands]
[roles.default]
runtime = "fake"
[tickets]
source = "file"
readyState = "ready"
`,
    )
    const notices: string[] = []
    const originalError = console.error
    console.error = (line: unknown) => {
      notices.push(String(line))
    }
    let report: GuestProbeReport
    try {
      report = await runGuestReadinessProbe({
        repo,
        env: { AB_STORE: 'https://store.example' },
        runtimes: usableRuntime,
        openStore: () => readOnlyStore([]),
      })
    } finally {
      console.error = originalError
    }
    const plugins = report.checks.find((check) => check.name === 'configuration and plugins')
    expect(plugins?.status).toBe('pass')
    expect(plugins?.detail).toBe('1 configured plugin(s) loaded')
    // The registration skip still announces itself on stderr, as before.
    expect(notices.join('\n')).toContain('the builtin keeps serving')
  })

  test('probes both explicit and registry-default models selected on the same runtime', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ab-readiness-models-'))
    roots.push(repo)
    await writeFile(
      join(repo, 'autobuild.toml'),
      `[commands]
[roles.default]
runtime = "fake"
[roles.plan]
model = "gateway/explicit"
[tickets]
source = "file"
readyState = "ready"
`,
    )
    let models: readonly string[] = []
    const report = await runGuestReadinessProbe({
      repo,
      env: { AB_STORE: 'https://store.example' },
      runtimes: {
        fake: {
          runner,
          servesModels: ['fake/', 'gateway/'],
          defaultModel: 'fake/default',
          initUsable: async (input) => {
            models = input.models
            return true
          },
        },
      },
      openStore: () => readOnlyStore([]),
    })
    expect(report.checks.every((check) => check.status === 'pass')).toBe(true)
    expect(models).toEqual(['fake/default', 'gateway/explicit'])
  })

  test('reports guest runtime authentication and unreachable Store remediation without secrets', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ab-readiness-failures-'))
    roots.push(repo)
    await writeFile(
      join(repo, 'autobuild.toml'),
      `baseBranch = "main"
[commands]
[roles.default]
runtime = "fake"
[tickets]
source = "file"
readyState = "ready"
`,
    )
    const report = await runGuestReadinessProbe({
      repo,
      env: { AB_STORE: 'https://store.example', MODEL_API_KEY: 'echo-secret' },
      runtimes: {
        fake: {
          runner,
          servesModels: [],
          initUsable: async () => ({
            usable: false,
            reason: 'authentication failed for echo-secret',
          }),
        },
      },
      openStore: () => {
        throw new Error('network unreachable with echo-secret')
      },
    })
    const details = report.checks.map((check) => check.detail).join('\n')
    expect(details).not.toContain('echo-secret')
    expect(details).toContain(
      'install/authenticate this runtime in the local validation environment',
    )
    expect(details).not.toContain('runtimeProvisioning')
    expect(details).toContain('Store URL')
  })

  test('reports Vercel runtime failures against provisioning and API credentials', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ab-readiness-vercel-runtime-'))
    roots.push(repo)
    await writeFile(
      join(repo, 'autobuild.toml'),
      `[workspace]
provider = "vercel-sandbox"
[workspace.config]
timeoutSeconds = 600
environmentVariables = ["MODEL_API_KEY"]
[workspace.config.runtimeProvisioning.fake]
install = "install-fake@1.0.0"
preflight = "fake --version"
[commands]
[roles.default]
runtime = "fake"
[tickets]
source = "file"
readyState = "ready"
`,
    )
    const report = await runGuestReadinessProbe({
      repo,
      env: { AB_STORE: 'https://store.example', MODEL_API_KEY: 'secret' },
      runtimes: {
        fake: {
          runner,
          servesModels: [],
          initUsable: async () => ({ usable: false, reason: 'not authenticated' }),
        },
      },
      openStore: () => readOnlyStore([]),
    })
    const details = report.checks.map((check) => check.detail).join('\n')
    expect(details).toContain('workspace.config.runtimeProvisioning.fake.preflight')
    expect(details).toContain('workspace.config.environmentVariables')
    expect(details).not.toContain('local validation environment')
  })

  test('redacts guestEnvNames-declared git credentials in readiness details (AUT-539)', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ab-readiness-git-env-redact-'))
    roots.push(repo)
    await writeFile(
      join(repo, 'autobuild.toml'),
      `[workspace]
provider = "vercel-sandbox"
[workspace.config]
timeoutSeconds = 600
environmentVariables = ["MODEL_API_KEY"]
gitUsernameEnv = "AB_GIT_READ_USER"
gitPasswordEnv = "AB_GIT_READ_PASSCODE"
[workspace.config.runtimeProvisioning.fake]
install = "install-fake@1.0.0"
preflight = "fake --version"
[commands]
[roles.default]
runtime = "fake"
[tickets]
source = "file"
readyState = "ready"
`,
    )
    // Both names deliberately avoid the redactor's name heuristic
    // (/(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH)/i), so any redaction of
    // their values is attributable to `guestEnvNames` feeding the redactor,
    // not the regex.
    const report = await runGuestReadinessProbe({
      repo,
      env: {
        AB_STORE: 'https://store.example',
        AB_GIT_READ_USER: 'git-user-42',
        AB_GIT_READ_PASSCODE: 'git-passcode-99',
      },
      runtimes: {
        fake: {
          runner,
          servesModels: [],
          initUsable: async () => ({
            usable: false,
            reason: 'clone failed for git-user-42 with git-passcode-99 (benign-context-marker)',
          }),
        },
      },
      openStore: () => readOnlyStore([]),
    })
    const details = report.checks.map((check) => check.detail).join('\n')
    expect(details).toContain('[REDACTED]')
    expect(details).not.toContain('git-user-42')
    expect(details).not.toContain('git-passcode-99')
    // The control proves redaction came from the declared names, not from
    // heuristic or whole-text suppression.
    expect(details).toContain('benign-context-marker')
  })

  test('private probe transports a structured failure with exit zero', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ab-probe-crash-'))
    roots.push(repo)
    await writeFile(join(repo, 'autobuild.toml'), 'not valid toml =')
    const result = await spawnExec(['bun', join(REPO_ROOT, 'bin', 'ab-init-probe.ts')], {
      cwd: repo,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('AB_INIT_READINESS_V1=')
    expect(result.stdout).toContain('"status":"fail"')
  })

  test('a missing probe path fails the spawn diagnosably', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ab-probe-missing-'))
    roots.push(repo)
    const result = await spawnExec(['bun', join(REPO_ROOT, 'bin', 'does-not-exist.ts')], {
      cwd: repo,
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.trim()).not.toBe('')
  })

  test('redacts nested error causes without hiding non-secret configuration', () => {
    const redact = createReadinessRedactor({
      API_KEY: 'distinct-secret',
      AB_STORE: 'https://store.example',
    })
    const error = new AggregateError(
      [new Error('runtime echoed distinct-secret')],
      'provider distinct-secret failed at https://store.example',
    )
    expect(redact(error)).toContain('[REDACTED]')
    expect(redact(error)).not.toContain('distinct-secret')
    expect(redact(error)).toContain('https://store.example')
  })

  test('fresh Vercel validation uses the remote SHA, exact guest env, and always deletes', async () => {
    const commands: Array<{
      cmd: string
      args?: string[]
      cwd?: string
      sudo?: boolean
      env?: Record<string, string>
    }> = []
    let deletes = 0
    const snapshots: VercelSnapshotInfo[] = []
    const deletedSnapshotIds: string[] = []
    const sandbox: VercelSandboxHandle = {
      getCommand: async () => ({ exitCode: null, wait: async () => ({ exitCode: 0 }) }),
      name: 'fresh-random-sandbox',
      runCommand: async (params) => {
        commands.push({
          cmd: params.cmd,
          ...(params.args === undefined ? {} : { args: params.args }),
          ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
          ...(params.sudo === undefined ? {} : { sudo: params.sudo }),
          ...(params.env === undefined ? {} : { env: params.env }),
        })
        const probe = params.args?.some((arg) => arg.includes('ab-init-probe'))
        return {
          exitCode: 0,
          wait: async () => ({ exitCode: 0 }),
          kill: async () => {},
          stdout: async () =>
            probe
              ? 'AB_INIT_READINESS_V1={"checks":[{"name":"ok","status":"pass","detail":"ready"}]}\n'
              : '',
          stderr: async () => '',
        }
      },
      writeFiles: async () => {},
      stop: async () => {
        // A session stop materializes an automatic snapshot.
        snapshots.push({
          id: `snap-${snapshots.length + 1}`,
          sourceSessionId: 'session-1',
          status: 'created',
        })
      },
      delete: async () => {
        deletes += 1
      },
      update: async (_params: { networkPolicy: NetworkPolicy }) => {},
    }
    let freshInput: Record<string, unknown> | undefined
    const facade: VercelSandboxFacade = {
      get: async () => null,
      create: async () => {
        throw new Error('named create must not be used')
      },
      createFresh: async (input) => {
        freshInput = input
        return sandbox
      },
      listSnapshots: async () => [...snapshots],
      deleteSnapshot: async (id) => {
        deletedSnapshotIds.push(id)
        const index = snapshots.findIndex((snapshot) => snapshot.id === id)
        if (index !== -1) snapshots.splice(index, 1)
      },
    }
    const sha = 'a'.repeat(40)
    const exec: Exec = async (command) => {
      if (command.includes('get-url'))
        return { stdout: 'https://github.com/acme/repo.git\n', stderr: '', exitCode: 0 }
      return { stdout: `${sha}\trefs/heads/main\n`, stderr: '', exitCode: 0 }
    }
    const result = await validateVercelSandbox({
      config: {
        image: 'vercel/sandbox/universal:latest',
        vcpus: 2,
        timeoutSeconds: 600,
        snapshotExpirationSeconds: 86_400,
        failoverRegions: [],
        environmentVariables: ['MODEL_API_KEY'],
        provisioning: [
          { name: 'browser packages', command: 'apt-get install -y chromium' },
          { name: 'browser smoke', command: './scripts/browser-smoke.sh' },
        ],
        runtimeProvisioning: {
          pi: { install: 'install-pi@0.84.4', preflight: 'pi --version 0.84.4' },
        },
      },
      env: { MODEL_API_KEY: 'secret-model' },
      storeRef: 'https://store.example',
      storeToken: 'store-secret',
      repo: '/repo',
      baseBranch: 'main',
      facade,
      exec,
      packageArchive: async () => new Uint8Array(),
      runtimeReferences: [
        {
          runtime: 'pi',
          references: ['role "plan" primary'],
          models: ['gateway/model'],
          usesRuntimeDefaultModel: false,
        },
      ],
    })

    expect(result.revision).toBe(sha)
    expect(result.provisioning).toEqual(['browser packages', 'browser smoke'])
    expect(commands.filter((command) => command.sudo === true)).toEqual([
      {
        cmd: 'sh',
        args: ['-c', 'apt-get install -y chromium'],
        cwd: '/vercel/sandbox/workspace',
        sudo: true,
      },
      {
        cmd: 'sh',
        args: ['-c', './scripts/browser-smoke.sh'],
        cwd: '/vercel/sandbox/workspace',
        sudo: true,
      },
    ])
    expect(deletes).toBe(1)
    expect(freshInput).not.toHaveProperty('name')
    expect(freshInput).toMatchObject({
      image: 'vercel/sandbox/universal:latest',
      resources: { vcpus: 2 },
      snapshotExpiration: 86_400_000,
      keepLastSnapshots: { count: 1, deleteEvicted: true },
    })
    // Release stopped first (one deterministic snapshot), purged it, deleted,
    // and the post-delete pass confirmed nothing else remained.
    expect(result.snapshotsDeleted).toBe(1)
    expect(deletedSnapshotIds).toHaveLength(1)
    expect(snapshots).toEqual([])
    expect(
      commands
        .filter((command) => command.cmd === 'sh')
        .map((command) => command.args?.[1])
        .filter((command) => command?.includes('pi')),
    ).toEqual(['install-pi@0.84.4', 'pi --version 0.84.4'])
    expect(
      commands.find((command) => command.args?.some((arg) => arg.includes('ab-init-probe')))?.env,
    ).toEqual({
      AB_STORE: 'https://store.example',
      AB_TOKEN: 'store-secret',
      MODEL_API_KEY: 'secret-model',
    })
  })

  test('rejects unsupported images before allocating a validation sandbox', async () => {
    let creates = 0
    await expect(
      validateVercelSandbox({
        config: {
          image: 'custom:v1',
          vcpus: 1,
          timeoutSeconds: 60,
          failoverRegions: [],
          environmentVariables: [],
        },
        env: {},
        storeRef: 'https://store.example',
        storeToken: 'token',
        repo: '/repo',
        baseBranch: 'main',
        facade: {
          get: async () => null,
          create: async () => {
            creates += 1
            throw new Error('must not allocate')
          },
          createFresh: async () => {
            creates += 1
            throw new Error('must not allocate')
          },
          listSnapshots: async () => [],
          deleteSnapshot: async () => {},
        },
      }),
    ).rejects.toThrow(/universal managed image/)
    expect(creates).toBe(0)
  })

  test('deletes and identifies the Vercel sandbox when cancellation interrupts bootstrap', async () => {
    const controller = new AbortController()
    let deletes = 0
    const seen: string[] = []
    const sandbox: VercelSandboxHandle = {
      getCommand: async () => ({ exitCode: null, wait: async () => ({ exitCode: 0 }) }),
      name: 'cancelled-sandbox',
      runCommand: async (params) => {
        expect(params.signal).toBe(controller.signal)
        controller.abort(new Error('operator cancelled'))
        throw controller.signal.reason
      },
      writeFiles: async () => {},
      stop: async () => {},
      delete: async () => {
        deletes += 1
      },
      update: async () => {},
    }
    const facade: VercelSandboxFacade = {
      get: async () => null,
      create: async () => sandbox,
      createFresh: async (input) => {
        expect(input.signal).toBe(controller.signal)
        return sandbox
      },
      listSnapshots: async () => [],
      deleteSnapshot: async () => {},
    }
    const exec: Exec = async (command) => ({
      stdout: command.includes('get-url')
        ? 'https://github.com/acme/repo.git\n'
        : `${'b'.repeat(40)}\trefs/heads/main\n`,
      stderr: '',
      exitCode: 0,
    })

    await expect(
      validateVercelSandbox({
        config: {
          image: 'vercel/sandbox/universal:latest',
          vcpus: 1,
          timeoutSeconds: 60,
          failoverRegions: [],
          environmentVariables: [],
        },
        env: {},
        storeRef: 'https://store.example',
        storeToken: 'token',
        repo: '/repo',
        baseBranch: 'main',
        facade,
        exec,
        signal: controller.signal,
        onSandbox: (name) => seen.push(name),
      }),
    ).rejects.toThrow('operator cancelled')
    expect(seen).toEqual(['cancelled-sandbox'])
    expect(deletes).toBe(1)
  })

  test('preserves validation and cleanup failures for manual Vercel remediation', async () => {
    const sandbox: VercelSandboxHandle = {
      getCommand: async () => ({ exitCode: null, wait: async () => ({ exitCode: 0 }) }),
      name: 'leaked-sandbox',
      runCommand: async () => ({ exitCode: 9 }),
      writeFiles: async () => {},
      stop: async () => {},
      delete: async () => {
        throw new Error('delete denied')
      },
      update: async () => {},
    }
    const facade: VercelSandboxFacade = {
      get: async () => null,
      create: async () => sandbox,
      createFresh: async () => sandbox,
      listSnapshots: async () => [],
      deleteSnapshot: async () => {},
    }
    const exec: Exec = async (command) => ({
      stdout: command.includes('get-url')
        ? 'https://github.com/acme/repo.git\n'
        : `${'c'.repeat(40)}\trefs/heads/main\n`,
      stderr: '',
      exitCode: 0,
    })
    let failure: unknown
    try {
      await validateVercelSandbox({
        config: {
          image: 'vercel/sandbox/universal:latest',
          vcpus: 1,
          timeoutSeconds: 60,
          failoverRegions: [],
          environmentVariables: [],
        },
        env: {},
        storeRef: 'https://store.example',
        storeToken: 'token',
        repo: '/repo',
        baseBranch: 'main',
        facade,
        exec,
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as Error).message).toContain('leaked-sandbox')
    expect((failure as AggregateError).errors.map(String).join(' ')).toContain('exited 9')
    expect((failure as AggregateError).errors.map(String).join(' ')).toContain('delete denied')
  })

  test('surfaces snapshot purge failure as manual release remediation', async () => {
    const sandbox: VercelSandboxHandle = {
      getCommand: async () => ({ exitCode: null, wait: async () => ({ exitCode: 0 }) }),
      name: 'snapshot-leak-sandbox',
      runCommand: async () => ({ exitCode: 0, stdout: async () => '', stderr: async () => '' }),
      writeFiles: async () => {},
      stop: async () => {},
      delete: async () => {},
      update: async () => {},
    }
    const stuck: VercelSnapshotInfo = {
      id: 'snap-stuck',
      sourceSessionId: 'session-1',
      status: 'created',
    }
    const facade: VercelSandboxFacade = {
      get: async () => null,
      create: async () => sandbox,
      createFresh: async () => sandbox,
      listSnapshots: async () => [{ ...stuck }],
      deleteSnapshot: async () => {
        throw new Error('snapshot delete denied')
      },
    }
    const exec: Exec = async (command) => ({
      stdout: command.includes('get-url')
        ? 'https://github.com/acme/repo.git\n'
        : `${'d'.repeat(40)}\trefs/heads/main\n`,
      stderr: '',
      exitCode: 0,
    })

    let failure: unknown
    try {
      await validateVercelSandbox({
        config: {
          image: 'vercel/sandbox/universal:latest',
          vcpus: 1,
          timeoutSeconds: 60,
          failoverRegions: [],
          environmentVariables: [],
        },
        env: {},
        storeRef: 'https://store.example',
        storeToken: 'token',
        repo: '/repo',
        baseBranch: 'main',
        facade,
        exec,
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(AggregateError)
    const aggregate = failure as AggregateError
    expect(aggregate.message).toContain('snapshot-leak-sandbox')
    expect(aggregate.message).toContain('snapshots remaining under its name')
    expect(aggregate.errors.map(String).join(' ')).toContain('snapshot delete denied')
  })

  test('rejects a non-GitHub forge with publication remediation before remote validation', async () => {
    const fixture = await vercelPreflightFixture('gitlab')

    await expect(
      validateInitReadiness({
        targetRepo: fixture.repo,
        env: { ...completeVercelPreflightEnv },
        exec: fixture.exec,
        vercelFacade: fixture.vercelFacade,
        packageArchive: fixture.packageArchive,
      }),
    ).rejects.toThrow(
      'vercel-sandbox supports forge = "github" only; configure GitHub publication before validating',
    )
    fixture.expectValidationNotReached()
  })

  test('rejects missing push-capable GitHub tokens before remote validation', async () => {
    const fixture = await vercelPreflightFixture()

    await expect(
      validateInitReadiness({
        targetRepo: fixture.repo,
        env: { ...completeVercelPreflightEnv, GITHUB_TOKEN: '', GH_TOKEN: undefined },
        exec: fixture.exec,
        vercelFacade: fixture.vercelFacade,
        packageArchive: fixture.packageArchive,
      }),
    ).rejects.toThrow('vercel-sandbox publication requires push-capable GITHUB_TOKEN or GH_TOKEN')
    fixture.expectValidationNotReached()
  })

  for (const missing of ['VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID'] as const) {
    test(`rejects an incomplete durable Vercel credential tuple without ${missing}`, async () => {
      const fixture = await vercelPreflightFixture()

      await expect(
        validateInitReadiness({
          targetRepo: fixture.repo,
          env: { ...completeVercelPreflightEnv, VERCEL_OIDC_TOKEN: '', [missing]: '' },
          exec: fixture.exec,
          vercelFacade: fixture.vercelFacade,
          packageArchive: fixture.packageArchive,
        }),
      ).rejects.toThrow(
        'Vercel authentication requires VERCEL_OIDC_TOKEN or the durable VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID set',
      )
      fixture.expectValidationNotReached()
    })
  }

  test('rejects a non-HTTPS Store before remote validation', async () => {
    const fixture = await vercelPreflightFixture()

    await expect(
      validateInitReadiness({
        targetRepo: fixture.repo,
        env: { ...completeVercelPreflightEnv, AB_STORE: 'http://store.example' },
        exec: fixture.exec,
        vercelFacade: fixture.vercelFacade,
        packageArchive: fixture.packageArchive,
      }),
    ).rejects.toThrow('vercel-sandbox requires AB_STORE to be an HTTPS URL reachable from Vercel')
    fixture.expectValidationNotReached()
  })

  test('redacts failed declared provisioning and deletes the disposable sandbox', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ab-provisioning-readiness-'))
    roots.push(repo)
    const secret = 'readiness-provision-secret'
    const config = `baseBranch = "main"
forge = "github"
[workspace]
provider = "vercel-sandbox"
[workspace.config]
timeoutSeconds = 600
environmentVariables = ["PROVISION_SECRET"]
provisioning = [{ name = "browser packages", command = "install browser packages" }]
[workspace.config.runtimeProvisioning.fake]
install = "install-fake@1.0.0"
preflight = "fake --version 1.0.0"
[commands]
[roles.default]
runtime = "fake"
[tickets]
source = "file"
readyState = "ready"
`
    await writeFile(join(repo, 'autobuild.toml'), config)

    let deletes = 0
    let available = true
    let packageArchives = 0
    const sandbox: VercelSandboxHandle = {
      getCommand: async () => ({ exitCode: null, wait: async () => ({ exitCode: 0 }) }),
      name: 'failed-provisioning-sandbox',
      runCommand: async (params) => {
        if (
          params.cmd === 'sh' &&
          params.sudo === true &&
          params.cwd === '/vercel/sandbox/workspace' &&
          params.args?.[1] === 'install browser packages'
        ) {
          return {
            exitCode: 23,
            stdout: async () => `download attempted with ${secret}`,
            stderr: async () => `registry rejected ${secret}`,
          }
        }
        return { exitCode: 0, stdout: async () => '', stderr: async () => '' }
      },
      writeFiles: async () => {},
      stop: async () => {},
      delete: async () => {
        deletes += 1
        available = false
      },
      update: async () => {},
    }
    const facade: VercelSandboxFacade = {
      get: async () => (available ? sandbox : null),
      create: async () => sandbox,
      createFresh: async () => sandbox,
      listSnapshots: async () => [],
      deleteSnapshot: async () => {},
    }
    const sha = 'e'.repeat(40)
    const exec: Exec = async (command) => {
      if (command.includes('--show-toplevel'))
        return { stdout: `${repo}\n`, stderr: '', exitCode: 0 }
      if (command.includes('get-url'))
        return { stdout: 'https://github.com/acme/repo.git\n', stderr: '', exitCode: 0 }
      if (command.includes('ls-remote'))
        return { stdout: `${sha}\trefs/heads/main\n`, stderr: '', exitCode: 0 }
      if (command.includes('show')) return { stdout: config, stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    }

    let failure: unknown
    try {
      await validateInitReadiness({
        targetRepo: repo,
        env: { ...completeVercelPreflightEnv, PROVISION_SECRET: secret },
        exec,
        vercelFacade: facade,
        packageArchive: async () => {
          packageArchives += 1
          return new Uint8Array()
        },
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(Error)
    const diagnostic = (failure as Error).message
    expect(diagnostic).toContain('browser packages')
    expect(diagnostic).toContain('exit status: 23')
    expect(diagnostic).toContain('[workspace.config].provisioning')
    expect(diagnostic).toContain('ab init --validate')
    expect(diagnostic).toContain('[REDACTED]')
    expect(diagnostic).not.toContain(secret)
    expect(deletes).toBe(1)
    expect(packageArchives).toBe(0)
    expect(await facade.get!('failed-provisioning-sandbox')).toBeNull()
  })

  test('deletes the sandbox before reporting malformed remote probe output', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ab-malformed-remote-'))
    roots.push(repo)
    const config = `baseBranch = "main"
forge = "github"
[workspace]
provider = "vercel-sandbox"
[workspace.config]
timeoutSeconds = 600
[workspace.config.runtimeProvisioning.fake]
install = "true"
preflight = "true"
[commands]
[roles.default]
runtime = "fake"
[tickets]
source = "file"
readyState = "ready"
`
    await writeFile(join(repo, 'autobuild.toml'), config)
    let deletes = 0
    const sandbox: VercelSandboxHandle = {
      getCommand: async () => ({ exitCode: null, wait: async () => ({ exitCode: 0 }) }),
      name: 'malformed-sandbox',
      runCommand: async (params) => {
        const probe = params.args?.some((arg) => arg.includes('ab-init-probe'))
        return {
          exitCode: 0,
          wait: async () => ({ exitCode: 0 }),
          kill: async () => {},
          stdout: async () => (probe ? 'not a readiness marker' : ''),
          stderr: async () => '',
        }
      },
      writeFiles: async () => {},
      stop: async () => {},
      delete: async () => {
        deletes += 1
      },
      update: async () => {},
    }
    const facade: VercelSandboxFacade = {
      get: async () => null,
      create: async () => sandbox,
      createFresh: async () => sandbox,
      listSnapshots: async () => [],
      deleteSnapshot: async () => {},
    }
    const sha = 'd'.repeat(40)
    const exec: Exec = async (command) => {
      if (command.includes('rev-parse')) return { stdout: '', stderr: '', exitCode: 1 }
      if (command.includes('get-url'))
        return { stdout: 'https://github.com/acme/repo.git\n', stderr: '', exitCode: 0 }
      if (command.includes('ls-remote'))
        return { stdout: `${sha}\trefs/heads/main\n`, stderr: '', exitCode: 0 }
      if (command.includes('show')) return { stdout: config, stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    await expect(
      validateInitReadiness({
        targetRepo: repo,
        env: {
          AB_STORE: 'https://store.example',
          AB_TOKEN: 'store-token',
          GITHUB_TOKEN: 'push-token',
          VERCEL_TOKEN: 'vercel-token',
          VERCEL_TEAM_ID: 'team-id',
          VERCEL_PROJECT_ID: 'project-id',
        },
        exec,
        vercelFacade: facade,
        packageArchive: async () => new Uint8Array(),
      }),
    ).rejects.toThrow('malformed-sandbox was deleted')
    expect(deletes).toBe(1)
  })

  test('reports an absent local Store without creating ignored repository state', async () => {
    const { repo } = await committedLocalRepo('ab-local-absent-')
    const output: string[] = []

    const report = await validateInitReadiness({
      targetRepo: repo,
      env: {},
      exec: spawnExec,
      runtimes: usableRuntime,
      stdout: (line) => output.push(line),
    })

    expect(report.exitCode).toBe(0)
    expect(report.checks.find((check) => check.name === 'BuildStore')).toMatchObject({
      status: 'absent',
    })
    expect(output.join('\n')).toContain('ABSENT BuildStore')
    expect(await stat(join(repo, '.autobuild')).catch(() => null)).toBeNull()
    for (const name of [
      'autobuild.sqlite',
      'autobuild.sqlite-wal',
      'autobuild.sqlite-shm',
      'blobs',
    ]) {
      expect(await stat(join(repo, '.autobuild', name)).catch(() => null)).toBeNull()
    }
  })

  test('inspects an existing local Store snapshot without changing source files or history', async () => {
    const { repo } = await committedLocalRepo('ab-local-existing-')
    const stateRoot = join(repo, '.autobuild')
    const store = openLocalStore(stateRoot)
    await store.createBuild({
      slug: 'seeded-build',
      repo,
      ticket: { source: 'file', id: 'T-1', title: 'Seeded ticket' },
      branch: 'ab/seeded-build',
    })
    await store.append('seeded-build', {
      actor: DISPATCHER,
      type: 'build.created',
      payload: {
        ticket: { source: 'file', id: 'T-1', title: 'Seeded ticket' },
        repo,
        baseBranch: 'main',
      },
    })
    await store.close()
    const checkpoint = new Database(join(stateRoot, 'autobuild.sqlite'))
    checkpoint.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    checkpoint.close()
    await rm(join(stateRoot, 'autobuild.sqlite-wal'), { force: true })
    await rm(join(stateRoot, 'autobuild.sqlite-shm'), { force: true })
    const before = await snapshotTree(stateRoot)

    const report = await validateInitReadiness({
      targetRepo: repo,
      env: {},
      exec: spawnExec,
      runtimes: usableRuntime,
    })

    expect(report.exitCode).toBe(0)
    expect(report.checks.find((check) => check.name === 'BuildStore')).toMatchObject({
      status: 'pass',
    })
    expect(report.checks.find((check) => check.name === 'BuildStore')?.detail).toContain(
      '1 readable build record(s)',
    )
    expect(await snapshotTree(stateRoot)).toEqual(before)
    expect(Object.keys(before)).not.toContain('autobuild.sqlite-wal')
    expect(Object.keys(before)).not.toContain('autobuild.sqlite-shm')
  })

  test('reads copied live WAL state while leaving source sidecars unchanged', async () => {
    const { repo } = await committedLocalRepo('ab-local-live-wal-')
    const stateRoot = join(repo, '.autobuild')
    const store = openLocalStore(stateRoot)
    const observer = openLocalStore(stateRoot)
    try {
      await store.createBuild({ slug: 'wal-build', repo, branch: 'ab/wal-build' })
      const before = await snapshotTree(stateRoot)
      expect(Object.keys(before)).toContain('autobuild.sqlite-wal')
      expect(Object.keys(before)).toContain('autobuild.sqlite-shm')

      const report = await validateInitReadiness({
        targetRepo: repo,
        env: {},
        exec: spawnExec,
        runtimes: usableRuntime,
      })

      expect(report.exitCode).toBe(0)
      expect(report.checks.find((check) => check.name === 'BuildStore')?.detail).toContain(
        '1 readable build record(s)',
      )
      expect(await snapshotTree(stateRoot)).toEqual(before)
    } finally {
      await store.close()
      await observer.close()
    }
  })

  test(
    'validates and removes a detached local worktree without changing config bytes',
    () =>
      realGitScenario(async (tracker) => {
        const { repo, config, exec } = await detachedReadinessFixture(tracker)
        const calls: string[] = []
        const report = await validateInitReadiness({
          targetRepo: repo,
          env: {},
          exec,
          runtimes: {
            fake: {
              runner,
              servesModels: [],
              initUsable: ({ cwd }) =>
                tracker.run('runtime fake usability probe', async () => ({
                  usable: (await readFile(join(cwd, 'setup-marker'), 'utf8')) === 'ready',
                  reason: 'ready',
                })),
            },
          },
          openStore: () => trackedReadOnlyStore(tracker, calls),
        })
        expect(report.exitCode).toBe(0)
        expect(await readFile(join(repo, 'autobuild.toml'), 'utf8')).toBe(config)
        await expectSingleWorktree(repo, exec)
        expect(calls).toEqual(['listBuilds', 'close'])
      }),
    REAL_TEST_TIMEOUT_MS,
  )

  test(
    'rejects dirty configuration and removes the detached local worktree',
    () =>
      realGitScenario(async (tracker) => {
        const { repo, config, exec } = await detachedReadinessFixture(tracker)
        const changed = `${config}# local-only edit\n`
        await writeFile(join(repo, 'autobuild.toml'), changed)
        await expect(
          validateInitReadiness({
            targetRepo: repo,
            env: {},
            exec,
            runtimes: usableRuntime,
            openStore: () => readOnlyStore([]),
          }),
        ).rejects.toThrow('differs from committed main')
        expect(await readFile(join(repo, 'autobuild.toml'), 'utf8')).toBe(changed)
        await expectSingleWorktree(repo, exec)
      }),
    REAL_TEST_TIMEOUT_MS,
  )

  test(
    'reports cleanup failure after removing the detached local worktree registration',
    () =>
      realGitScenario(async (tracker) => {
        const { repo, config } = await detachedReadinessFixture(tracker)
        const cleanupFailExec: Exec = async (command, options) => {
          const result = await spawnExec(command, options)
          return command.includes('remove')
            ? { ...result, exitCode: 1, stderr: 'simulated cleanup denial' }
            : result
        }
        const exec = tracker.exec(cleanupFailExec)
        await expect(
          validateInitReadiness({
            targetRepo: repo,
            env: {},
            exec,
            runtimes: trackedRuntime(tracker),
            openStore: () => trackedReadOnlyStore(tracker, []),
          }),
        ).rejects.toThrow('simulated cleanup denial')
        expect(await readFile(join(repo, 'autobuild.toml'), 'utf8')).toBe(config)
        await expectSingleWorktree(repo, exec)
      }),
    REAL_TEST_TIMEOUT_MS,
  )

  test(
    'cancels setup deterministically and removes the detached local worktree',
    () =>
      realGitScenario(async (tracker) => {
        const { repo, config } = await detachedReadinessFixture(tracker)
        const controller = new AbortController()
        let markSetupStarted: () => void = () => {}
        const setupStarted = new Promise<void>((resolve) => {
          markSetupStarted = resolve
        })
        const cancellationExec: Exec = (command, options) => {
          if (command[0] !== 'sh') return spawnExec(command, options)
          markSetupStarted()
          return new Promise((_, reject) => {
            const rejectCancellation = () =>
              reject(options.signal?.reason ?? new Error('setup cancelled'))
            if (options.signal?.aborted) rejectCancellation()
            else options.signal?.addEventListener('abort', rejectCancellation, { once: true })
          })
        }
        const exec = tracker.exec(cancellationExec)
        const validation = validateInitReadiness({
          targetRepo: repo,
          env: {},
          exec,
          signal: controller.signal,
          runtimes: usableRuntime,
          openStore: () => readOnlyStore([]),
        })
        await setupStarted
        controller.abort(new Error('local cancelled'))
        await expect(validation).rejects.toThrow('local cancelled')
        expect(await readFile(join(repo, 'autobuild.toml'), 'utf8')).toBe(config)
        await expectSingleWorktree(repo, exec)
      }),
    REAL_TEST_TIMEOUT_MS,
  )

  test(
    'operation deadlines identify stalled setup, runtime, Store, and cleanup seams',
    async () => {
      const never = () => new Promise<never>(() => {})
      for (const exercise of [
        (tracker: OperationTracker) => tracker.exec(async () => never())(['sh', '-c', 'setup'], {}),
        (tracker: OperationTracker) =>
          tracker.exec(async () => never())(['git', 'rev-parse', '--verify', 'main^{commit}'], {}),
        (tracker: OperationTracker) => tracker.run('runtime fake usability probe', never),
        (tracker: OperationTracker) => tracker.run('Store listBuilds', never),
        (tracker: OperationTracker) => tracker.run('Store close', never),
        (tracker: OperationTracker) =>
          tracker.exec(async () => never())(['git', 'worktree', 'remove', '--force', '/fake'], {}),
      ]) {
        await expect(
          withTrackedScenario({ operationMs: 20, scenarioMs: 200 }, exercise),
        ).rejects.toThrow(
          /(setup: sh -c setup|git rev-parse|runtime fake usability probe|Store (listBuilds|close)|git worktree remove).*20ms operation deadline/,
        )
      }
    },
    FAKE_TEST_TIMEOUT_MS,
  )

  // Jitter tolerance (obs_67ad494d): the original { operationMs: 30, scenarioMs: 55 }
  // gave the scenario guard only ~15ms of headroom over the ~40ms cumulative sleep
  // time, so a single slow scheduler tick under load pushed the breach into a
  // completed operation and the test failed (once during the record-a-pipeline
  // full-suite run; green on rerun, three isolated runs, and a subsequent
  // full-suite run with and without those changes). Binding timing invariant: the
  // scenario guard must beat op3's own operation deadline, i.e.
  // scenarioMs < 2 sleeps + operationMs (here 400 < 40 + 500, 140ms of margin),
  // otherwise op3 rejects with its operation-deadline message instead. The guard
  // now fires at 400ms with ~360ms of tolerance over the ~40ms of cumulative
  // sleeps, so jitter cannot move the breach into a completed operation; the
  // assertion still fails if the tracker misattributes the breach to one.
  test(
    'scenario deadline identifies the active operation after cumulative latency',
    () =>
      expect(
        withTrackedScenario({ operationMs: 500, scenarioMs: 400 }, async (tracker) => {
          await tracker.run('first bounded operation', () => Bun.sleep(20))
          await tracker.run('second bounded operation', () => Bun.sleep(20))
          await tracker.run('runtime fallback probe', () => new Promise<never>(() => {}))
        }),
      ).rejects.toThrow('scenario exceeded 400ms while runtime fallback probe'),
    FAKE_TEST_TIMEOUT_MS,
  )

  test('CLI routes --validate sessionlessly and rejects --force with it', async () => {
    const calls: string[] = []
    const result: InitValidationReport = {
      provider: 'git-worktree',
      context: 'local worktree',
      checks: [],
      exitCode: 0,
    }
    const deps = {
      workspacePath: '/repo',
      processEnv: {},
      stdout: () => {},
      stderr: (line: string) => calls.push(line),
      initValidation: async ({ targetRepo }: { targetRepo: string }) => {
        calls.push(targetRepo)
        return result
      },
    }
    expect(await runCli(['init', '/target', '--validate'], deps)).toBe(0)
    expect(calls).toEqual(['/target'])
    expect(await runCli(['init', '--force', '--validate'], deps)).toBe(1)
    expect(calls.at(-1)).toContain('cannot be combined')
  })

  test('rejects target-only OIDC before invoking the SDK-backed validation', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ab-target-env-'))
    roots.push(repo)
    await writeFile(join(repo, '.env'), 'VERCEL_OIDC_TOKEN=target-only\n')
    const errors: string[] = []
    let invoked = false
    const code = await runCli(['init', repo, '--validate'], {
      workspacePath: '/different-cwd',
      processEnv: {},
      stdout: () => {},
      stderr: (line) => errors.push(line),
      initValidation: async () => {
        invoked = true
        throw new Error('must not run')
      },
    })
    expect(code).toBe(1)
    expect(invoked).toBe(false)
    expect(errors.join('\n')).toContain('export it in the launcher environment')
  })

  test('a plugin-declared processEnvOnly variable present only in the dotenv-augmented env fails validation', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ab-plugin-process-env-'))
    roots.push(repo)
    await writeFile(
      join(repo, 'acme-plugin.ts'),
      `export default {
  name: 'acme',
  apiVersion: '^1.6.0',
  workspaceProviders: {
    acmebox: {
      factory: () => ({}),
      capabilities: {
        processEnvOnly: [
          {
            name: 'ACME_SECRET',
            message: 'ACME_SECRET must be exported in the launcher environment',
          },
        ],
      },
    },
  },
}\n`,
    )
    await writeFile(
      join(repo, 'autobuild.toml'),
      `baseBranch = "main"
plugins = ["./acme-plugin.ts"]
[workspace]
provider = "acmebox"
[commands]
[roles.default]
runtime = "fake"
[tickets]
source = "file"
readyState = "ready"
`,
    )

    // The dotenv-augmented env carries the variable, the raw launcher map does
    // not: the registry-aware check throws the declared message.
    await expect(
      validateInitReadiness({
        targetRepo: repo,
        env: { ACME_SECRET: 'only-in-env-file' },
        processEnv: {},
        exec: spawnExec,
      }),
    ).rejects.toThrow('ACME_SECRET must be exported in the launcher environment')

    // Exported in the launcher map, the check passes and validation proceeds
    // to the (expected) unsupported-provider failure instead.
    await expect(
      validateInitReadiness({
        targetRepo: repo,
        env: { ACME_SECRET: 'exported' },
        processEnv: { ACME_SECRET: 'exported' },
        exec: spawnExec,
      }),
    ).rejects.toThrow('workspace provider "acmebox" does not support init readiness validation')
  })

  test('the builtin processEnvOnly declaration message is byte-identical to the main.ts guard text', () => {
    const message =
      builtinWorkspaceProviderCapabilities('vercel-sandbox')?.processEnvOnly?.[0]?.message
    expect(message).toBe(
      'VERCEL_OIDC_TOKEN loaded only from the target .env is unavailable to the Vercel SDK; export it in the launcher environment or configure VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID',
    )
  })

  test('a plugin-declared supportedForges and requiredEnv validationMessage fail validation', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ab-plugin-forge-env-'))
    roots.push(repo)
    await writeFile(
      join(repo, 'acme-plugin.ts'),
      `export default {
  name: 'acme',
  apiVersion: '^1.6.0',
  workspaceProviders: {
    acmebox: {
      factory: () => ({}),
      capabilities: {
        supportedForges: ['gitlab'],
        forgeValidationMessage: 'acmebox requires the GitLab forge',
        requiredEnv: [
          {
            alternatives: [['ACME_TOKEN']],
            validationMessage: 'ACME_TOKEN must be set for acmebox',
          },
        ],
      },
    },
  },
}\n`,
    )
    const toml = (forge: string) => `baseBranch = "main"
forge = "${forge}"
plugins = ["./acme-plugin.ts"]
[workspace]
provider = "acmebox"
[commands]
[roles.default]
runtime = "fake"
[tickets]
source = "file"
readyState = "ready"
`
    await writeFile(join(repo, 'autobuild.toml'), toml('github'))

    // The declared forge list is honoured: the unsupported forge fails with
    // the declared message, not silently.
    await expect(
      validateInitReadiness({ targetRepo: repo, env: {}, exec: spawnExec }),
    ).rejects.toThrow('acmebox requires the GitLab forge')

    // With the declared forge satisfied, the declared required-environment
    // group's validationMessage fires when the variable is absent.
    await writeFile(join(repo, 'autobuild.toml'), toml('gitlab'))
    await expect(
      validateInitReadiness({ targetRepo: repo, env: {}, exec: spawnExec }),
    ).rejects.toThrow('ACME_TOKEN must be set for acmebox')

    // Both declarations satisfied, validation proceeds past the preflight to
    // the (expected) missing-readiness failure instead.
    await expect(
      validateInitReadiness({
        targetRepo: repo,
        env: { ACME_TOKEN: 'present' },
        exec: spawnExec,
      }),
    ).rejects.toThrow('workspace provider "acmebox" does not support init readiness validation')
  })

  test('a plugin-declared sandboxForbiddenEnv is enforced at the registry-aware init seam (AUT-536)', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ab-plugin-sandbox-forbidden-'))
    roots.push(repo)
    await writeFile(
      join(repo, 'acme-plugin.ts'),
      `export default {
  name: 'acme',
  apiVersion: '^1.6.0',
  workspaceProviders: {
    acmebox: {
      factory: () => ({}),
      capabilities: { sandboxForbiddenEnv: ['ACME_SECRET'] },
    },
  },
}\n`,
    )
    const toml = (sandbox: string) => `baseBranch = "main"
forge = "github"
plugins = ["./acme-plugin.ts"]
[workspace]
provider = "acmebox"
[commands]
[roles.default]
runtime = "fake"
[tickets]
source = "file"
readyState = "ready"
[orchestrator]
enabled = true
model = "test/mock"
[orchestrator.sandbox]
environmentVariables = ${sandbox}
`
    await writeFile(join(repo, 'autobuild.toml'), toml('["ACME_TOOL_CONFIG", "ACME_SECRET"]'))

    // Config-time enforcement alone would miss the declaration: plugins are
    // not loaded when config is parsed, so the plugin-declared forbidden name
    // parses cleanly.
    const config = await loadConfig(join(repo, 'autobuild.toml'))
    expect(config.orchestrator.sandbox.environmentVariables).toEqual([
      'ACME_TOOL_CONFIG',
      'ACME_SECRET',
    ])

    // The registry-aware seam refuses it after plugin load, with the verbatim
    // shared message (thrown through the redactor, which leaves it intact).
    await expect(
      validateInitReadiness({ targetRepo: repo, env: {}, exec: spawnExec }),
    ).rejects.toThrow(
      'environment variable "ACME_SECRET" is a store, forge, ticket-provider, model, or Vercel credential and may never be forwarded into an operator sandbox',
    )

    // A name outside the declared extras and the shared set still passes the
    // seam, mirroring the construction site's name union.
    await writeFile(join(repo, 'autobuild.toml'), toml('["ACME_TOOL_CONFIG"]'))
    await expect(
      validateInitReadiness({ targetRepo: repo, env: {}, exec: spawnExec }),
    ).rejects.toThrow('workspace provider "acmebox" does not support init readiness validation')

    // The gate matches the construction site's: with the orchestrator disabled
    // the declaration is not enforced and validation proceeds past the
    // preflight to the (expected) missing-readiness failure instead.
    const disabled = `baseBranch = "main"
forge = "github"
plugins = ["./acme-plugin.ts"]
[workspace]
provider = "acmebox"
[commands]
[roles.default]
runtime = "fake"
[tickets]
source = "file"
readyState = "ready"
`
    await writeFile(join(repo, 'autobuild.toml'), disabled)
    await expect(
      validateInitReadiness({ targetRepo: repo, env: {}, exec: spawnExec }),
    ).rejects.toThrow('workspace provider "acmebox" does not support init readiness validation')
  })

  test('a plugin-declared configSchema and guestEnvNames reach the readiness context (f_55ba7591)', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ab-plugin-readiness-ctx-'))
    roots.push(repo)
    await writeFile(
      join(repo, 'acme-plugin.ts'),
      `export default {
  name: 'acme',
  apiVersion: '^1.6.0',
  workspaceProviders: {
    acmebox: {
      factory: () => ({}),
      capabilities: {
        configSchema: {
          parse: (value) => {
            if (
              typeof value !== 'object' ||
              value === null ||
              typeof value.guestName !== 'string'
            ) {
              throw new Error('guestName must be a string')
            }
            return { guestName: value.guestName }
          },
          safeParse: function (value) {
            try {
              return { success: true, data: this.parse(value) }
            } catch (error) {
              return { success: false, error }
            }
          },
        },
        guestEnvNames: () => ['ACME_VAR'],
        validateReadiness: async (ctx) => ({
          provider: 'acmebox',
          context: 'remote',
          exitCode: 0,
          checks: [
            {
              name: 'context',
              status: 'pass',
              detail:
                'config=' + JSON.stringify(ctx.providerConfig) + ' env=' + ctx.env.ACME_VAR,
            },
          ],
        }),
      },
    },
  },
}\n`,
    )
    await writeFile(
      join(repo, 'autobuild.toml'),
      `baseBranch = "main"
plugins = ["./acme-plugin.ts"]
[workspace]
provider = "acmebox"
[workspace.config]
guestName = "acme-guest"
[commands]
[roles.default]
runtime = "fake"
[tickets]
source = "file"
readyState = "ready"
`,
    )

    // ACME_VAR deliberately avoids the TOKEN/KEY/SECRET naming heuristic: the
    // detail is only redacted when the declared guestEnvNames is honoured.
    const report = await validateInitReadiness({
      targetRepo: repo,
      env: { ACME_VAR: 'sekret-value-123' },
      exec: spawnExec,
    })
    expect(report.provider).toBe('acmebox')
    const detail = report.checks[0]?.detail ?? ''
    // The readiness context carried the provider config parsed with the
    // plugin's declared configSchema (not undefined).
    expect(detail).toContain('guestName')
    // And the declared guest env name redacted the secret value.
    expect(detail).toContain('[REDACTED]')
    expect(detail).not.toContain('sekret-value-123')
  })

  test('a plugin-declared configSchema that rejects the config fails validation', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ab-plugin-bad-config-'))
    roots.push(repo)
    await writeFile(
      join(repo, 'acme-plugin.ts'),
      `export default {
  name: 'acme',
  apiVersion: '^1.6.0',
  workspaceProviders: {
    acmebox: {
      factory: () => ({}),
      capabilities: {
        configSchema: {
          parse: () => {
            throw new Error('guestName must be a string')
          },
          safeParse: function () {
            try {
              this.parse()
            } catch (error) {
              return { success: false, error }
            }
            return { success: false, error: new Error('unreachable') }
          },
        },
      },
    },
  },
}\n`,
    )
    await writeFile(
      join(repo, 'autobuild.toml'),
      `baseBranch = "main"
plugins = ["./acme-plugin.ts"]
[workspace]
provider = "acmebox"
[workspace.config]
guestName = 7
[commands]
[roles.default]
runtime = "fake"
[tickets]
source = "file"
readyState = "ready"
`,
    )
    await expect(
      validateInitReadiness({ targetRepo: repo, env: {}, exec: spawnExec }),
    ).rejects.toThrow('guestName must be a string')
  })

  test('a plugin-declared guestEnvNames without a configSchema is still redacted (f_1ddf1415)', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ab-plugin-guest-names-only-'))
    roots.push(repo)
    await writeFile(
      join(repo, 'acme-plugin.ts'),
      `export default {
  name: 'acme',
  apiVersion: '^1.6.0',
  workspaceProviders: {
    acmebox: {
      factory: () => ({}),
      capabilities: {
        guestEnvNames: () => ['ACME_VAR'],
        validateReadiness: async (ctx) => ({
          provider: 'acmebox',
          context: 'remote',
          exitCode: 0,
          checks: [
            {
              name: 'context',
              status: 'pass',
              detail: 'config=' + JSON.stringify(ctx.providerConfig) + ' value=' + ctx.env.ACME_VAR,
            },
          ],
        }),
      },
    },
  },
}\n`,
    )
    await writeFile(
      join(repo, 'autobuild.toml'),
      `baseBranch = "main"
plugins = ["./acme-plugin.ts"]
[workspace]
provider = "acmebox"
[workspace.config]
region = "acme-region"
[commands]
[roles.default]
runtime = "fake"
[tickets]
source = "file"
readyState = "ready"
`,
    )

    // No configSchema is declared, so the readiness context's providerConfig
    // stays undefined — but the declared guest env name must still reach the
    // redactor (it is called with the raw [workspace.config]), or the value
    // leaks into the detail verbatim.
    const report = await validateInitReadiness({
      targetRepo: repo,
      env: { ACME_VAR: 'sekret-value-123' },
      exec: spawnExec,
    })
    expect(report.provider).toBe('acmebox')
    const detail = report.checks[0]?.detail ?? ''
    expect(detail).toContain('[REDACTED]')
    expect(detail).not.toContain('sekret-value-123')
  })
})
