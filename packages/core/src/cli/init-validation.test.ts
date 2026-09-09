import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import type { NetworkPolicy } from '@vercel/sandbox'
import type { AgentRunner } from '../ports/types'
import type { RuntimeRegistry } from '../ports/runner/runtime'
import { spawnExec, type Exec } from '../ports/workspace/git-worktree'
import {
  validateVercelSandbox,
  type VercelSandboxFacade,
  type VercelSandboxHandle,
} from '../ports/workspace/vercel-sandbox'
import type { BuildStore } from '../store/types'
import {
  createReadinessRedactor,
  runGuestReadinessProbe,
  validateInitReadiness,
  type InitValidationReport,
} from './init-validation'
import { runCli } from './main'

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
    expect(details).toContain('install/authenticate')
    expect(details).toContain('Store URL')
  })

  test('private probe transports a structured failure with exit zero', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ab-probe-crash-'))
    roots.push(repo)
    await writeFile(join(repo, 'autobuild.toml'), 'not valid toml =')
    const result = await spawnExec(['bun', join(process.cwd(), 'bin', 'ab-init-probe.ts')], {
      cwd: repo,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('AB_INIT_READINESS_V1=')
    expect(result.stdout).toContain('"status":"fail"')
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
    const commands: Array<{ cmd: string; env?: Record<string, string> }> = []
    let deletes = 0
    const sandbox: VercelSandboxHandle = {
      name: 'fresh-random-sandbox',
      runCommand: async (params) => {
        commands.push({ cmd: params.cmd, ...(params.env === undefined ? {} : { env: params.env }) })
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
      stop: async () => {},
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
        failoverRegions: [],
        environmentVariables: ['MODEL_API_KEY'],
      },
      env: { MODEL_API_KEY: 'secret-model' },
      storeRef: 'https://store.example',
      storeToken: 'store-secret',
      repo: '/repo',
      baseBranch: 'main',
      facade,
      exec,
      packageArchive: async () => new Uint8Array(),
    })

    expect(result.revision).toBe(sha)
    expect(deletes).toBe(1)
    expect(freshInput).not.toHaveProperty('name')
    expect(freshInput).toMatchObject({
      image: 'vercel/sandbox/universal:latest',
      resources: { vcpus: 2 },
    })
    expect(commands.find((command) => command.env !== undefined)?.env).toEqual({
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

  test('deletes the sandbox before reporting malformed remote probe output', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ab-malformed-remote-'))
    roots.push(repo)
    const config = `baseBranch = "main"
forge = "github"
[workspace]
provider = "vercel-sandbox"
[workspace.config]
timeoutSeconds = 600
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

  test('validates and removes a detached local worktree without changing config bytes', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ab-local-readiness-'))
    roots.push(repo)
    const config = `baseBranch = "main"
[commands]
setup = "printf ready > setup-marker"
[roles.default]
runtime = "fake"
[tickets]
source = "file"
readyState = "ready"
`
    await writeFile(join(repo, 'autobuild.toml'), config)
    for (const command of [
      ['git', 'init', '-b', 'main'],
      ['git', 'config', 'user.email', 'test@example.com'],
      ['git', 'config', 'user.name', 'Test'],
      ['git', 'add', 'autobuild.toml'],
      ['git', 'commit', '-m', 'setup'],
    ]) {
      const result = await spawnExec(command, { cwd: repo })
      expect(result.exitCode, result.stderr).toBe(0)
    }
    const calls: string[] = []
    const report = await validateInitReadiness({
      targetRepo: repo,
      env: {},
      exec: spawnExec,
      runtimes: {
        fake: {
          runner,
          servesModels: [],
          initUsable: async ({ cwd }) => ({
            usable: (await readFile(join(cwd, 'setup-marker'), 'utf8')) === 'ready',
            reason: 'ready',
          }),
        },
      },
      openStore: () => readOnlyStore(calls),
    })
    expect(report.exitCode).toBe(0)
    expect(await readFile(join(repo, 'autobuild.toml'), 'utf8')).toBe(config)
    const worktrees = await spawnExec(['git', 'worktree', 'list', '--porcelain'], { cwd: repo })
    expect(worktrees.stdout.match(/^worktree /gm)).toHaveLength(1)
    expect(calls).toEqual(['listBuilds', 'close'])

    const changed = `${config}# local-only edit\n`
    await writeFile(join(repo, 'autobuild.toml'), changed)
    await expect(
      validateInitReadiness({
        targetRepo: repo,
        env: {},
        exec: spawnExec,
        runtimes: {
          fake: { runner, servesModels: [], initUsable: async () => true },
        },
        openStore: () => readOnlyStore([]),
      }),
    ).rejects.toThrow('differs from committed main')
    expect(await readFile(join(repo, 'autobuild.toml'), 'utf8')).toBe(changed)
    const afterFailure = await spawnExec(['git', 'worktree', 'list', '--porcelain'], { cwd: repo })
    expect(afterFailure.stdout.match(/^worktree /gm)).toHaveLength(1)

    await writeFile(join(repo, 'autobuild.toml'), config)
    const cleanupFailExec: Exec = async (command, options) => {
      const result = await spawnExec(command, options)
      return command.includes('remove')
        ? { ...result, exitCode: 1, stderr: 'simulated cleanup denial' }
        : result
    }
    await expect(
      validateInitReadiness({
        targetRepo: repo,
        env: {},
        exec: cleanupFailExec,
        runtimes: {
          fake: { runner, servesModels: [], initUsable: async () => true },
        },
        openStore: () => readOnlyStore([]),
      }),
    ).rejects.toThrow('simulated cleanup denial')
    const afterCleanupFailure = await spawnExec(['git', 'worktree', 'list', '--porcelain'], {
      cwd: repo,
    })
    expect(afterCleanupFailure.stdout.match(/^worktree /gm)).toHaveLength(1)

    const slowConfig = config.replace('setup = "printf ready > setup-marker"', 'setup = "sleep 10"')
    await writeFile(join(repo, 'autobuild.toml'), slowConfig)
    await spawnExec(['git', 'add', 'autobuild.toml'], { cwd: repo })
    await spawnExec(['git', 'commit', '-m', 'slow setup'], { cwd: repo })
    const controller = new AbortController()
    const cancellingExec: Exec = async (command, options) => {
      if (command[0] === 'sh') setTimeout(() => controller.abort(new Error('local cancelled')), 10)
      return spawnExec(command, options)
    }
    await expect(
      validateInitReadiness({
        targetRepo: repo,
        env: {},
        exec: cancellingExec,
        signal: controller.signal,
        runtimes: {
          fake: { runner, servesModels: [], initUsable: async () => true },
        },
        openStore: () => readOnlyStore([]),
      }),
    ).rejects.toThrow('local cancelled')
    const afterCancellation = await spawnExec(['git', 'worktree', 'list', '--porcelain'], {
      cwd: repo,
    })
    expect(afterCancellation.stdout.match(/^worktree /gm)).toHaveLength(1)
  })

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
})
