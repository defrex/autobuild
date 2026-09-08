import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NetworkPolicy } from '@vercel/sandbox'
import { spawnExec, type Exec } from './git-worktree'
import {
  VERCEL_WORKSPACE_PATH,
  VercelSandboxProvider,
  isMissingVercelSandbox,
  packageAutobuildDistribution,
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
  stopFailures = 0
  deletes = 0
  failPush = false
  failRestore = false
  failSetupCommand: string | undefined
  provisioned = false
  detachedWait: () => Promise<{ exitCode: number }> = async () => ({ exitCode: 0 })

  async runCommand(params: Record<string, unknown>) {
    this.commands.push(params)
    if (params.cmd === 'test') return { exitCode: this.provisioned ? 0 : 1 }
    if (params.cmd === 'touch') this.provisioned = true
    if (params.cmd === this.failSetupCommand) return { exitCode: 1 }
    if (params.detached === true) {
      return {
        exitCode: null,
        wait: this.detachedWait,
        kill: async () => undefined,
      }
    }
    return {
      exitCode:
        params.cmd === 'git' && (params.args as string[])?.includes('--unset-all')
          ? 5
          : this.failPush && (params.args as string[])?.includes('push')
            ? 1
            : 0,
    }
  }
  async writeFiles(files: Array<{ path: string; content: Uint8Array }>) {
    this.writes.push(...files)
  }
  async stop() {
    this.stops += 1
    if (this.stopFailures > 0) {
      this.stopFailures -= 1
      throw new Error('sandbox stop failed')
    }
  }
  async delete() {
    this.deletes += 1
  }
  async update(params: { networkPolicy: NetworkPolicy }) {
    this.policies.push(params.networkPolicy)
    if (this.failRestore && this.policies.length === 2) throw new Error('restore failed')
  }
}

function harness(options: { publishedSha?: string | null } = {}) {
  const sandbox = new FakeSandbox()
  let buildBranchLookups = 0
  let createInput: Record<string, unknown> | undefined
  let created = false
  const facade: VercelSandboxFacade = {
    get: async () => (created && sandbox.deletes === 0 ? sandbox : null),
    create: async (input) => {
      created = true
      createInput = input
      return sandbox
    },
  }
  const exec: Exec = async (cmd) => {
    if (cmd.includes('get-url'))
      return { stdout: 'https://github.com/acme/app.git\n', stderr: '', exitCode: 0 }
    if (cmd.includes('ls-remote')) {
      const ref = cmd.at(-1)
      const buildBranch = ref === 'refs/heads/ab/remote-build'
      if (buildBranch) buildBranchLookups += 1
      const sha =
        ref === 'refs/heads/main'
          ? SHA
          : buildBranch && buildBranchLookups > 1
            ? options.publishedSha === undefined
              ? SHA
              : options.publishedSha
            : null
      return {
        stdout: sha === null ? '' : `${sha}\t${ref}\n`,
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
  test('packs, extracts, and production-installs the real distribution without lifecycle scripts', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'ab-vercel-package-'))
    const archivePath = join(tmp, 'autobuild.tgz')
    const extracted = join(tmp, 'autobuild')
    try {
      await writeFile(archivePath, await packageAutobuildDistribution())
      await mkdir(extracted)
      const unpacked = await spawnExec(
        ['tar', '-xzf', archivePath, '--strip-components=1', '-C', extracted],
        { cwd: tmp },
      )
      expect(unpacked).toMatchObject({ exitCode: 0, stderr: '' })
      const installed = await spawnExec(['bun', 'install', '--production', '--ignore-scripts'], {
        cwd: extracted,
      })
      expect(installed.exitCode).toBe(0)
      expect(installed.stderr).not.toContain('husky')
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  }, 120_000)

  test('classifies the real SDK not-found and stale-snapshot response shapes only', () => {
    expect(isMissingVercelSandbox({ response: { status: 404 } })).toBe(true)
    expect(
      isMissingVercelSandbox({
        response: { status: 410 },
        json: { error: { code: 'snapshot_not_found' } },
      }),
    ).toBe(true)
    expect(isMissingVercelSandbox({ response: { status: 410 } })).toBe(false)
    expect(isMissingVercelSandbox({ code: 'not_found' })).toBe(false)
  })

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

  test('deletes a partial setup so the next provisioning pass rematerializes cleanly', async () => {
    const first = new FakeSandbox()
    first.failSetupCommand = 'tar'
    const second = new FakeSandbox()
    let creates = 0
    const facade: VercelSandboxFacade = {
      get: async () => (creates === 1 && first.deletes === 0 ? first : null),
      create: async () => {
        creates += 1
        return creates === 1 ? first : second
      },
    }
    const exec: Exec = async (cmd) => {
      const ref = cmd.at(-1)
      if (cmd.includes('get-url'))
        return { stdout: 'https://github.com/acme/app.git\n', stderr: '', exitCode: 0 }
      return {
        stdout: ref === 'refs/heads/main' ? `${SHA}\t${ref}\n` : '',
        stderr: '',
        exitCode: 0,
      }
    }
    const provider = new VercelSandboxProvider({
      config: {
        image: 'vercel/sandbox/universal:latest',
        vcpus: 4,
        timeoutSeconds: 2700,
        failoverRegions: [],
        environmentVariables: [],
      },
      env: { GITHUB_TOKEN: 'forge-secret' },
      storeRef: 'https://store.example.test',
      storeToken: 'scoped-store-token',
      repo: '/repo',
      facade,
      exec,
      packageArchive: async () => new Uint8Array([1, 2, 3]),
    })

    await expect(
      provider.provision({ repo: '/repo', baseBranch: 'main', branch: 'ab/remote-build' }),
    ).rejects.toThrow(/tar exited 1/)
    expect(first.deletes).toBe(1)

    const workspace = await provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    expect(workspace.provider).toBe('vercel-sandbox')
    expect(creates).toBe(2)
    expect(second.provisioned).toBe(true)
  })

  test('discards an existing named sandbox without the completed setup marker', async () => {
    const incomplete = new FakeSandbox()
    const replacement = new FakeSandbox()
    let created = false
    const provider = new VercelSandboxProvider({
      config: {
        image: 'vercel/sandbox/universal:latest',
        vcpus: 4,
        timeoutSeconds: 2700,
        failoverRegions: [],
        environmentVariables: [],
      },
      env: { GITHUB_TOKEN: 'forge-secret' },
      storeRef: 'https://store.example.test',
      storeToken: 'scoped-store-token',
      repo: '/repo',
      facade: {
        get: async () => incomplete,
        create: async () => {
          created = true
          return replacement
        },
      },
      exec: async (cmd) => {
        const ref = cmd.at(-1)
        if (cmd.includes('get-url'))
          return { stdout: 'https://github.com/acme/app.git\n', stderr: '', exitCode: 0 }
        return {
          stdout: ref === 'refs/heads/main' ? `${SHA}\t${ref}\n` : '',
          stderr: '',
          exitCode: 0,
        }
      },
      packageArchive: async () => new Uint8Array([1]),
    })

    await provider.provision({ repo: '/repo', baseBranch: 'main', branch: 'ab/remote-build' })
    expect(incomplete.deletes).toBe(1)
    expect(created).toBe(true)
    expect(replacement.provisioned).toBe(true)
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

  test('a transient environment stop failure does not poison future starts or release', async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    h.sandbox.stopFailures = 1
    const failed = await h.provider.buildExecution.start({
      slug: 'remote-build',
      storeRef: 'https://store.example.test',
      instance: 'i-stop-fails',
      workspaceRef: workspace.ref,
    })
    await expect(failed.completion).rejects.toThrow(/sandbox stop failed/)

    const retried = await h.provider.buildExecution.start({
      slug: 'remote-build',
      storeRef: 'https://store.example.test',
      instance: 'i-stop-retry',
      workspaceRef: workspace.ref,
    })
    expect(await retried.completion).toEqual({ exitCode: 0 })
    await h.provider.release(workspace)
    expect(h.sandbox.deletes).toBe(1)

    const aborted = harness()
    const abortWorkspace = await aborted.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    aborted.sandbox.stopFailures = 1
    const abortExecution = await aborted.provider.buildExecution.start({
      slug: 'remote-build',
      storeRef: 'https://store.example.test',
      instance: 'i-stop-abort',
      workspaceRef: abortWorkspace.ref,
    })
    await expect(abortExecution.completion).rejects.toThrow(/sandbox stop failed/)
    await aborted.provider.release(abortWorkspace)
    expect(aborted.sandbox.deletes).toBe(1)
  })

  test('publishes only the exact SHA/branch under a temporary credential transform', async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    await h.provider.publication.publish({ ref: workspace.ref, sha: SHA, branch: workspace.branch })
    expect(h.sandbox.commands).toContainEqual({
      cmd: 'git',
      args: ['push', '--no-verify', 'origin', `${SHA}:refs/heads/ab/remote-build`],
      cwd: VERCEL_WORKSPACE_PATH,
    })
    expect(h.sandbox.policies).toHaveLength(2)
    const temporary = JSON.stringify(h.sandbox.policies[0])
    expect(temporary).toContain('git-receive-pack')
    expect(temporary).toContain(Buffer.from('x-access-token:forge-secret').toString('base64'))
    expect(JSON.stringify(h.sandbox.policies[1])).not.toContain('forge-secret')
  })

  test('restores the normal policy when push fails and rejects mismatched remote heads', async () => {
    const failed = harness()
    const workspace = await failed.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    failed.sandbox.failPush = true
    await expect(
      failed.provider.publication.publish({
        ref: workspace.ref,
        sha: SHA,
        branch: workspace.branch,
      }),
    ).rejects.toThrow(/git exited 1/)
    expect(failed.sandbox.policies).toHaveLength(2)

    const restore = harness()
    const restoreWorkspace = await restore.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    restore.sandbox.failRestore = true
    await expect(
      restore.provider.publication.publish({
        ref: restoreWorkspace.ref,
        sha: SHA,
        branch: restoreWorkspace.branch,
      }),
    ).rejects.toThrow(/restore failed/)
    expect(restore.sandbox.stops).toBe(3)

    const mismatch = harness({ publishedSha: 'b'.repeat(40) })
    const other = await mismatch.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    await expect(
      mismatch.provider.publication.publish({ ref: other.ref, sha: SHA, branch: other.branch }),
    ).rejects.toThrow(/did not match/)
    expect(mismatch.sandbox.policies).toHaveLength(2)
  })

  test('forbids publication while an environment execution remains live', async () => {
    const h = harness()
    h.sandbox.detachedWait = () => new Promise(() => undefined)
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    const execution = await h.provider.buildExecution.start({
      slug: 'remote-build',
      storeRef: 'https://store.example.test',
      instance: 'i-live',
      workspaceRef: workspace.ref,
    })
    await expect(
      h.provider.publication.publish({ ref: workspace.ref, sha: SHA, branch: workspace.branch }),
    ).rejects.toThrow(/execution is live/)
    await execution.stop()
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
