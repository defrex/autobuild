import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import type { NetworkPolicy } from '@vercel/sandbox'
import type { AgentRunner } from '../ports/types'
import type { RuntimeRegistry } from '../ports/runner/runtime'
import type { Exec } from '../ports/workspace/git-worktree'
import {
  validateVercelSandbox,
  type VercelSandboxFacade,
  type VercelSandboxHandle,
} from '../ports/workspace/vercel-sandbox'
import type { BuildStore } from '../store/types'
import {
  createReadinessRedactor,
  runGuestReadinessProbe,
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
        const probe =
          params.cmd === 'bun' && params.args?.some((arg) => arg.includes('ab-init-probe'))
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
        image: 'custom:v1',
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
    expect(freshInput).toMatchObject({ image: 'custom:v1', resources: { vcpus: 2 } })
    expect(commands.find((command) => command.env !== undefined)?.env).toEqual({
      AB_STORE: 'https://store.example',
      AB_TOKEN: 'store-secret',
      MODEL_API_KEY: 'secret-model',
    })
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
})
