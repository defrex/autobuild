import { describe, expect, test } from 'bun:test'
import type { NetworkPolicy } from '@vercel/sandbox'
import type { Exec } from './git-worktree'
import {
  VERCEL_WORKSPACE_PATH,
  VercelSandboxProvider,
  type VercelSandboxFacade,
  type VercelSandboxHandle,
} from './vercel-sandbox'

const SHA = 'a'.repeat(40)

class FakeSandbox implements VercelSandboxHandle {
  readonly name = 'sandbox'
  readonly commands: Array<Record<string, unknown>> = []
  readonly policies: NetworkPolicy[] = []
  writes: Array<{ path: string; content: Uint8Array }> = []
  stops = 0
  deletes = 0

  async runCommand(params: Record<string, unknown>) {
    this.commands.push(params)
    if (params.detached === true) {
      return {
        exitCode: null,
        wait: async () => ({ exitCode: 0 }),
        kill: async () => undefined,
      }
    }
    return {
      exitCode: params.cmd === 'git' && (params.args as string[])?.includes('--unset-all') ? 5 : 0,
    }
  }
  async writeFiles(files: Array<{ path: string; content: Uint8Array }>) {
    this.writes.push(...files)
  }
  async stop() {
    this.stops += 1
  }
  async delete() {
    this.deletes += 1
  }
  async update(params: { networkPolicy: NetworkPolicy }) {
    this.policies.push(params.networkPolicy)
  }
}

function harness() {
  const sandbox = new FakeSandbox()
  let createInput: Record<string, unknown> | undefined
  const facade: VercelSandboxFacade = {
    get: async () => null,
    create: async (input) => {
      createInput = input
      return sandbox
    },
  }
  const exec: Exec = async (cmd) => {
    if (cmd.includes('get-url'))
      return { stdout: 'https://github.com/acme/app.git\n', stderr: '', exitCode: 0 }
    if (cmd.includes('ls-remote')) {
      const ref = cmd.at(-1)
      return {
        stdout: ref === 'refs/heads/main' ? `${SHA}\t${ref}\n` : '',
        stderr: '',
        exitCode: 0,
      }
    }
    throw new Error(`unexpected host command: ${cmd.join(' ')}`)
  }
  const provider = new VercelSandboxProvider({
    config: {
      image: 'vercel/sandbox/universal:latest',
      vcpus: 4,
      timeoutSeconds: 2700,
      failoverRegions: [],
      environmentVariables: ['ANTHROPIC_API_KEY'],
    },
    env: {
      ANTHROPIC_API_KEY: 'runtime-secret',
      GITHUB_TOKEN: 'forge-secret',
      VERCEL_TOKEN: 'provider-secret',
      UNDECLARED_SECRET: 'never-copy',
    },
    storeRef: 'https://store.example.test',
    storeToken: 'scoped-store-token',
    repo: '/repo',
    facade,
    exec,
    packageArchive: async () => new Uint8Array([1, 2, 3]),
  })
  return {
    provider,
    sandbox,
    get createInput() {
      return createInput
    },
  }
}

describe('VercelSandboxProvider', () => {
  test('provisions from an exact authoritative revision and returns a remote-only location', async () => {
    const h = harness()
    const result = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    expect(result.path).toBe(VERCEL_WORKSPACE_PATH)
    expect(result.localPath).toBeUndefined()
    expect(result.base).toEqual({ source: 'remote', sha: SHA })
    expect((h.createInput!.source as { revision: string }).revision).toBe(SHA)
    expect(h.createInput!.timeout).toBe(2_700_000)
    expect(h.sandbox.commands).toContainEqual(
      expect.objectContaining({
        cmd: 'git',
        args: ['remote', 'set-url', 'origin', 'https://github.com/acme/app.git'],
        cwd: VERCEL_WORKSPACE_PATH,
      }),
    )
    expect(JSON.stringify(h.sandbox.commands)).not.toContain('forge-secret')
  })

  test('launches the environment-supervised child with only allowlisted and Store values', async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    const handle = await h.provider.buildExecution.start({
      slug: 'remote-build',
      storeRef: 'https://store.example.test',
      instance: 'i-1',
      workspaceRef: workspace.ref,
    })
    expect(await handle.completion).toEqual({ exitCode: 0 })
    const launch = h.sandbox.commands.find((command) => command.detached === true)!
    const env = launch.env as Record<string, string>
    expect(env.ANTHROPIC_API_KEY).toBe('runtime-secret')
    expect(env.AB_TOKEN).toBe('scoped-store-token')
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.VERCEL_TOKEN).toBeUndefined()
    expect(env.UNDECLARED_SECRET).toBeUndefined()
    expect(JSON.parse(env.AB_BUILD_RUNNER_OPTIONS!).supervision).toEqual({ kind: 'environment' })
    await h.provider.release(workspace)
    expect(h.sandbox.deletes).toBe(1)
  })

  test('fails closed for local Stores and missing scoped authority', () => {
    expect(
      () =>
        new VercelSandboxProvider({
          config: {
            image: 'x',
            vcpus: 1,
            timeoutSeconds: 60,
            failoverRegions: [],
            environmentVariables: [],
          },
          env: {},
          storeRef: '/tmp/store',
          storeToken: '',
          repo: '/repo',
          facade: {
            get: async () => null,
            create: async () => {
              throw new Error('unused')
            },
          },
        }),
    ).toThrow(/HTTPS BuildStore/)
  })
})
