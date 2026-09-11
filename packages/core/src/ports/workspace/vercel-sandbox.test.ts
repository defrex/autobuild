import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NetworkPolicy } from '@vercel/sandbox'
import { parse as parseToml } from 'smol-toml'
import { spawnExec, type Exec } from './git-worktree'
import { HARVEST_RUNNER_OPTIONS_ENV } from './harvest-execution'
import {
  VERCEL_AUTOBUILD_PATH,
  VERCEL_BUN_BIN_PATH,
  VERCEL_BUN_EXECUTABLE,
  VERCEL_BUN_PREFIX,
  VERCEL_BUN_VERSION,
  VERCEL_DISTRIBUTION_VERSION_MARKER,
  VERCEL_LIFETIME_MARGIN_MS,
  VERCEL_PROVISIONED_MARKER,
  VERCEL_WORKSPACE_PATH,
  VercelSandboxProvider,
  harvestSandboxName,
  isMissingVercelSandbox,
  vercelOidcTokenScope,
  vercelSdkCredentials,
  packageAutobuildDistribution,
  sourceCheckoutPath,
  type VercelSandboxFacade,
  type VercelSandboxHandle,
  type VercelSnapshotInfo,
} from './vercel-sandbox'

const SHA = 'a'.repeat(40)

class FakeSandbox implements VercelSandboxHandle {
  readonly name = 'sandbox'
  cwd: string | undefined
  readonly commands: Array<Record<string, unknown>> = []
  readonly policies: NetworkPolicy[] = []
  readonly policySignals: Array<AbortSignal | undefined> = []
  readonly killSignals: Array<AbortSignal | undefined> = []
  writes: Array<{ path: string; content: Uint8Array }> = []
  stops = 0
  stopFailures = 0
  deletes = 0
  remainAfterDelete = false
  deleteFailure: Error | undefined
  failPush = false
  failRestore = false
  failSetupCommand: string | undefined
  failCommand: ((params: Record<string, unknown>) => boolean) | undefined
  failureStdout = ''
  failureStderr = ''
  provisioned = false
  /** Simulated content of the guest's `.distribution-version` marker;
   * `undefined` models an unreadable or absent marker (legacy guest). */
  distributionVersion: string | undefined
  /** When set, reading the marker returns this instead of the written value,
   * modeling a silent write/extraction failure. */
  markerReadback: string | undefined
  detachedWait: (params?: { signal?: AbortSignal }) => Promise<{ exitCode: number }> =
    async () => ({
      exitCode: 0,
    })
  /** Session status reported to `observe`; undefined models an SDK without it. */
  sessionStatus: VercelSandboxHandle['sessionStatus'] = 'running'
  /** Epoch-ms session expiry reported to `observe`; undefined models a facade
   * without the getter or with no running session (unbounded behavior). */
  sessionExpiresAt: number | undefined
  /** Recorded detached commands by id, for `getCommand` re-observation. */
  readonly detachedCommands = new Map<string, { exitCode: number | null }>()
  getCommandCalls = 0
  /** Automatic snapshots the environment has accumulated; a session stop
   * creates one, exactly as the provider's SDK contract describes. */
  readonly snapshots: VercelSnapshotInfo[] = []

  currentSession() {
    return { sessionId: 'session-1' }
  }

  async getCommand(cmdId: string, _opts?: { signal?: AbortSignal }) {
    this.getCommandCalls += 1
    const command = this.detachedCommands.get(cmdId)
    if (command === undefined) {
      throw Object.assign(new Error('command not found'), { response: { status: 404 } })
    }
    return command
  }

  async runCommand(params: Record<string, unknown>) {
    this.commands.push(params)
    if (this.failCommand?.(params))
      return {
        exitCode: 1,
        stdout: async () => this.failureStdout,
        stderr: async () => this.failureStderr,
      }
    if (params.cmd === 'cat') {
      const content = this.markerReadback ?? this.distributionVersion
      if ((params.args as string[])?.[0] === VERCEL_DISTRIBUTION_VERSION_MARKER) {
        if (content === undefined) return { exitCode: 1 }
        return { exitCode: 0, stdout: async () => content }
      }
    }
    if (
      params.cmd === 'sh' &&
      (params.args as string[])?.[1] === 'printf %s "$1" > "$2"' &&
      (params.args as string[])?.[4] === VERCEL_DISTRIBUTION_VERSION_MARKER
    ) {
      this.distributionVersion = (params.args as string[])![3] as string
      return { exitCode: 0 }
    }
    if (params.cmd === 'test') return { exitCode: this.provisioned ? 0 : 1 }
    if (params.cmd === this.failSetupCommand) return { exitCode: 1 }
    if (params.cmd === 'touch') this.provisioned = true
    if (params.detached === true) {
      const cmdId = `cmd-${this.commands.length}`
      this.detachedCommands.set(cmdId, { exitCode: null })
      return {
        exitCode: null,
        cmdId,
        wait: (waitParams?: { signal?: AbortSignal }) => {
          if (waitParams?.signal?.aborted === true) {
            return Promise.reject(waitParams.signal.reason ?? new Error('aborted'))
          }
          return this.detachedWait(waitParams).then((result) => {
            this.detachedCommands.set(cmdId, { exitCode: result.exitCode })
            return result
          })
        },
        kill: async (_signal?: 'SIGTERM' | 'SIGKILL', opts?: { abortSignal?: AbortSignal }) => {
          this.killSignals.push(opts?.abortSignal)
        },
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
  stopTimeouts = 0
  async stop() {
    this.stops += 1
    if (this.stopTimeouts > 0) {
      this.stopTimeouts -= 1
      throw Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' })
    }
    if (this.stopFailures > 0) {
      this.stopFailures -= 1
      throw new Error('sandbox stop failed')
    }
    this.snapshots.push({
      id: `snap-${this.stops}`,
      sourceSessionId: 'session-1',
      status: 'created',
    })
  }
  async delete() {
    this.deletes += 1
    if (this.deleteFailure !== undefined) throw this.deleteFailure
  }
  async update(params: { networkPolicy: NetworkPolicy }, opts?: { signal?: AbortSignal }) {
    this.policies.push(params.networkPolicy)
    this.policySignals.push(opts?.signal)
    const isPublicationPolicy = JSON.stringify(params.networkPolicy).includes('git-receive-pack')
    if (this.failRestore && !isPublicationPolicy) throw new Error('restore failed')
  }
}

function runtimeReferenceFixtures() {
  return [
    {
      runtime: 'pi',
      references: ['role "implement" primary'],
      models: [],
      usesRuntimeDefaultModel: true,
    },
    {
      runtime: 'plugin',
      references: ['role "plan" alternate[0]'],
      models: [],
      usesRuntimeDefaultModel: true,
    },
  ]
}

function harness(
  options: {
    publishedSha?: string | null
    existingSha?: string | null
    provisionRuntimes?: boolean
    runtimeReferences?: () => ReturnType<typeof runtimeReferenceFixtures>
    provisioning?: Array<{ name: string; command: string }>
    /** The session cwd the fake reports; undefined models an SDK without one. */
    cwd?: string
    /** Overrides the facade's get; e.g. to model an unreachable provider. */
    facadeGet?: () => Promise<VercelSandboxHandle | null>
    /** The archive fetch rejects after its first success (models an origin-mode
     * release fetch failing during a reuse-path refresh). */
    failArchiveAfterFirst?: boolean
    /** Forces the guest's version-marker readback to return this value. */
    markerReadback?: string
    /** Optional snapshot-expiry bound threaded to creation. */
    snapshotExpirationSeconds?: number
  } = {},
) {
  const sandbox = new FakeSandbox()
  sandbox.cwd = options.cwd
  if (options.markerReadback !== undefined) sandbox.markerReadback = options.markerReadback
  let archiveFetches = 0
  let buildBranchLookups = 0
  let createInput: Record<string, unknown> | undefined
  let created = false
  let creates = 0
  /** Snapshot rows keyed by the exact environment name the purge uses. */
  const snapshotLists = new Map<string, VercelSnapshotInfo[]>()
  const facade: VercelSandboxFacade = {
    get:
      options.facadeGet ??
      (async () =>
        created && (sandbox.deletes === 0 || sandbox.remainAfterDelete) ? sandbox : null),
    create: async (input) => {
      created = true
      creates += 1
      createInput = input
      snapshotLists.set(input.name, sandbox.snapshots)
      return sandbox
    },
    listSnapshots: async (name) => [...(snapshotLists.get(name) ?? [])],
    deleteSnapshot: async (id) => {
      for (const list of snapshotLists.values()) {
        const index = list.findIndex((snapshot) => snapshot.id === id)
        if (index !== -1) {
          list.splice(index, 1)
          return
        }
      }
      throw new Error(`snapshot ${id} not found`)
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
          : buildBranch && buildBranchLookups === 1
            ? (options.existingSha ?? null)
            : buildBranch
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
      ...(options.snapshotExpirationSeconds === undefined
        ? {}
        : { snapshotExpirationSeconds: options.snapshotExpirationSeconds }),
      failoverRegions: [],
      environmentVariables: ['ANTHROPIC_API_KEY'],
      provisioning: options.provisioning ?? [],
      ...(options.provisionRuntimes
        ? {
            runtimeProvisioning: {
              plugin: { install: 'install-plugin@abc123', preflight: 'plugin --version 1.2.3' },
              pi: { install: 'install-pi@0.84.4', preflight: 'pi --version 0.84.4' },
            },
          }
        : {}),
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
    packageArchive: async () => {
      archiveFetches += 1
      if (options.failArchiveAfterFirst === true && archiveFetches > 1) {
        throw new Error('archive fetch failed')
      }
      return new Uint8Array([1, 2, 3])
    },
    distributionVersion: async () => '1.2.3',
    runtimeReferences:
      options.runtimeReferences ?? (options.provisionRuntimes ? runtimeReferenceFixtures() : []),
  })
  return {
    provider,
    sandbox,
    facade,
    get createInput() {
      return createInput
    },
    get creates() {
      return creates
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

    const npmInstall = h.sandbox.commands.findIndex((command) => command.cmd === 'npm')
    const verification = h.sandbox.commands.findIndex(
      (command) =>
        command.cmd === VERCEL_BUN_EXECUTABLE &&
        (command.args as string[] | undefined)?.[0] === '--version',
    )
    const distributionInstall = h.sandbox.commands.findIndex(
      (command) =>
        command.cmd === VERCEL_BUN_EXECUTABLE &&
        (command.args as string[] | undefined)?.[0] === 'install',
    )
    const marker = h.sandbox.commands.findIndex((command) => command.cmd === 'touch')
    expect(h.sandbox.commands[npmInstall]).toEqual({
      cmd: 'npm',
      args: ['install', '--prefix', VERCEL_BUN_PREFIX, '--no-save', `bun@${VERCEL_BUN_VERSION}`],
    })
    expect(npmInstall).toBeGreaterThan(-1)
    expect(verification).toBeGreaterThan(npmInstall)
    expect(distributionInstall).toBeGreaterThan(verification)
    expect(marker).toBeGreaterThan(distributionInstall)
    const repositoryBootstrap = h.sandbox.commands.find(
      (command) => command.cmd === 'sh' && command.cwd === VERCEL_WORKSPACE_PATH,
    )
    expect(repositoryBootstrap).toBeDefined()
    expect((repositoryBootstrap!.args as string[])[1]).toContain(
      `${VERCEL_BUN_EXECUTABLE} install --frozen-lockfile`,
    )
  })

  test('runs named provisioning serially as root between Bun verification and bootstrap', async () => {
    const steps = [
      { name: 'packages', command: 'apt-get update && apt-get install -y chromium' },
      { name: 'browser smoke', command: './scripts/browser-smoke.sh' },
    ]
    const h = harness({ provisioning: steps })
    await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })

    const system = h.sandbox.commands.filter(
      (command) => command.cmd === 'sh' && command.sudo === true,
    )
    expect(system).toEqual(
      steps.map((step) => ({
        cmd: 'sh',
        args: ['-c', step.command],
        cwd: VERCEL_WORKSPACE_PATH,
        sudo: true,
      })),
    )
    const verification = h.sandbox.commands.findIndex(
      (command) =>
        command.cmd === VERCEL_BUN_EXECUTABLE &&
        (command.args as string[] | undefined)?.[0] === '--version',
    )
    const firstSystem = h.sandbox.commands.indexOf(system[0]!)
    const distribution = h.sandbox.commands.findIndex(
      (command) => command.cmd === 'mkdir' && command.cwd !== VERCEL_WORKSPACE_PATH,
    )
    expect(firstSystem).toBeGreaterThan(verification)
    expect(distribution).toBeGreaterThan(firstSystem)
  })

  test('reuses a completed sandbox without rerunning declared provisioning', async () => {
    const h = harness({
      provisioning: [{ name: 'browser packages', command: 'install browser packages' }],
    })
    const first = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    const commandCount = h.sandbox.commands.length
    const provisioningCount = h.sandbox.commands.filter(
      (command) => command.cmd === 'sh' && command.sudo === true,
    ).length

    const reused = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })

    expect(reused.ref).toBe(first.ref)
    expect(h.creates).toBe(1)
    expect(h.sandbox.writes).toHaveLength(1)
    // The matching version marker is read and nothing else runs: no archive
    // fetch, no reinstall, no declared provisioning.
    expect(h.sandbox.commands.slice(commandCount)).toEqual([
      { cmd: 'test', args: ['-f', VERCEL_PROVISIONED_MARKER] },
      {
        cmd: 'cat',
        args: [VERCEL_DISTRIBUTION_VERSION_MARKER],
        signal: expect.any(AbortSignal),
      },
    ])
    expect(h.sandbox.distributionVersion).toBe('1.2.3')
    expect(
      h.sandbox.commands.filter((command) => command.cmd === 'sh' && command.sudo === true),
    ).toHaveLength(provisioningCount)

    const execution = await h.provider.buildExecution.start({
      slug: 'remote-build',
      storeRef: 'https://store.example.test',
      instance: 'i-reused',
      workspaceRef: reused.ref,
    })
    expect(await execution.completion).toEqual({ exitCode: 0 })
    await h.provider.release(reused)
    expect(h.sandbox.deletes).toBe(1)
  })

  test('reinstalls the distribution on a reused sandbox whose marker version is older', async () => {
    const h = harness()
    const first = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    // The resumed guest predates the current distribution (e.g. legacy 0.6.0
    // guest vs an upgraded dispatcher's 1.2.3).
    h.sandbox.distributionVersion = '0.6.0'
    const commandsBefore = h.sandbox.commands.length
    const writesBefore = h.sandbox.writes.length

    const reused = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })

    expect(reused.ref).toBe(first.ref)
    expect(h.creates).toBe(1)
    expect(h.sandbox.deletes).toBe(0)
    expect(h.sandbox.writes).toHaveLength(writesBefore + 1)
    const refreshed = h.sandbox.commands.slice(commandsBefore)
    expect(refreshed.map((command) => command.cmd)).toEqual([
      'test',
      'cat',
      'mkdir',
      'tar',
      VERCEL_BUN_EXECUTABLE,
      'sh',
      'cat',
    ])
    expect(h.sandbox.distributionVersion as string | undefined).toBe('1.2.3')
    // No declared provisioning and no runtime work re-ran for the refresh.
    expect(h.sandbox.commands.slice(commandsBefore).some((command) => command.sudo === true)).toBe(
      false,
    )
  })

  test('reinstalls the distribution on a legacy reused sandbox without a version marker', async () => {
    const h = harness()
    const first = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    // Model a guest provisioned before the marker existed.
    h.sandbox.distributionVersion = undefined
    const commandsBefore = h.sandbox.commands.length

    const reused = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })

    expect(reused.ref).toBe(first.ref)
    expect(h.creates).toBe(1)
    expect(h.sandbox.deletes).toBe(0)
    expect(h.sandbox.writes).toHaveLength(2)
    expect(h.sandbox.commands.slice(commandsBefore).map((command) => command.cmd)).toEqual([
      'test',
      'cat',
      'mkdir',
      'tar',
      VERCEL_BUN_EXECUTABLE,
      'sh',
      'cat',
    ])
    expect(h.sandbox.distributionVersion as string | undefined).toBe('1.2.3')
  })

  test('a failed distribution refresh deletes the reused sandbox and launches no execution', async () => {
    const h = harness({ failArchiveAfterFirst: true })
    const first = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    h.sandbox.distributionVersion = '0.6.0'

    await expect(
      h.provider.provision({ repo: '/repo', baseBranch: 'main', branch: 'ab/remote-build' }),
    ).rejects.toThrow(/archive fetch failed/)
    expect(h.sandbox.deletes).toBe(1)
    expect(h.sandbox.commands.some((command) => command.detached === true)).toBe(false)

    // The deleted environment is not adopted by a later execution start.
    await expect(
      h.provider.buildExecution.start({
        slug: 'remote-build',
        storeRef: 'https://store.example.test',
        instance: 'i-refresh-failed',
        workspaceRef: first.ref,
      }),
    ).rejects.toThrow(/no longer exists/)
  })

  test('fresh provisioning records the resolved version and a readback mismatch deletes the sandbox', async () => {
    const mismatch = harness({ markerReadback: 'corrupted' })
    await expect(
      mismatch.provider.provision({
        repo: '/repo',
        baseBranch: 'main',
        branch: 'ab/remote-build',
      }),
    ).rejects.toThrow(
      /distribution version marker readback mismatch.*wrote "1\.2\.3" but read "corrupted"/s,
    )
    expect(mismatch.sandbox.deletes).toBe(1)
    expect(mismatch.sandbox.provisioned).toBe(false)
    expect(mismatch.sandbox.commands.some((command) => command.detached === true)).toBe(false)

    const h = harness()
    await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    expect(h.sandbox.distributionVersion).toBe('1.2.3')
  })

  test('retains provisioning output and remediation while deleting an unready sandbox', async () => {
    const h = harness({
      provisioning: [
        { name: 'packages', command: 'install browser' },
        { name: 'browser smoke', command: 'run browser smoke' },
      ],
    })
    h.sandbox.failCommand = (command) =>
      command.cmd === 'sh' && (command.args as string[] | undefined)?.[1] === 'run browser smoke'
    h.sandbox.failureStdout = 'server started\n'
    h.sandbox.failureStderr = 'chromium missing\n'

    await expect(
      h.provider.provision({ repo: '/repo', baseBranch: 'main', branch: 'ab/remote-build' }),
    ).rejects.toThrow(
      /browser smoke[\s\S]*exit status: 1[\s\S]*server started[\s\S]*chromium missing[\s\S]*ab init --validate/,
    )
    expect(h.sandbox.deletes).toBe(1)
    expect(h.sandbox.provisioned).toBe(false)
    expect(h.sandbox.commands.some((command) => command.cmd === 'mkdir')).toBe(false)
    expect(h.sandbox.commands.some((command) => command.detached === true)).toBe(false)
  })

  test('moves the checkout from the session cwd the image actually uses', async () => {
    const universal = harness({ cwd: '/vercel' })
    await universal.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    expect(universal.sandbox.commands[0]).toMatchObject({
      cmd: 'sh',
      args: [
        '-c',
        expect.stringContaining('mkdir -p'),
        'relocate',
        '/vercel/app',
        VERCEL_WORKSPACE_PATH,
      ],
    })

    const legacy = harness()
    await legacy.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    expect(legacy.sandbox.commands[0]).toMatchObject({
      cmd: 'sh',
      args: [
        '-c',
        expect.stringContaining('mv "$1" "$2"'),
        'relocate',
        '/vercel/sandbox/app',
        VERCEL_WORKSPACE_PATH,
      ],
    })

    expect(sourceCheckoutPath({ cwd: '/vercel/sandbox/' } as VercelSandboxHandle, 'app')).toBe(
      '/vercel/sandbox/app',
    )
    expect(sourceCheckoutPath({ cwd: '  ' } as VercelSandboxHandle, 'app')).toBe(
      '/vercel/sandbox/app',
    )
  })

  test('uses generation-scoped names and the supplied checkpoint when the branch is absent', async () => {
    const h = harness()
    await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
      revision: 'b'.repeat(40),
      generation: 2,
    })
    expect(h.createInput?.name).toMatch(/^autobuild-remote-build-g2-/)
    expect((h.createInput!.source as { revision: string }).revision).toBe('b'.repeat(40))
    expect(h.createInput?.signal).toBeInstanceOf(AbortSignal)
  })

  test('prefers the authoritative remote build head over an older supplied checkpoint', async () => {
    const remoteHead = 'c'.repeat(40)
    const h = harness({ existingSha: remoteHead })
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
      revision: 'b'.repeat(40),
      generation: 3,
    })
    expect((h.createInput!.source as { revision: string }).revision).toBe(remoteHead)
    expect(workspace.base).toEqual({ source: 'existing', sha: remoteHead })
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
      listSnapshots: async () => [],
      deleteSnapshot: async () => {},
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
    expect(first.provisioned).toBe(false)
    // Recovery cleanup stops before deleting and confirming absence.
    expect(first.stops).toBe(1)

    const workspace = await provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    expect(workspace.provider).toBe('vercel-sandbox')
    expect(creates).toBe(2)
    expect(second.provisioned).toBe(true)
    expect(second.stops).toBe(1)
    expect(second.commands.map((command) => command.cmd)).toEqual([
      'sh',
      'git',
      'git',
      'git',
      'git',
      'git',
      'npm',
      VERCEL_BUN_EXECUTABLE,
      'mkdir',
      'tar',
      VERCEL_BUN_EXECUTABLE,
      'sh',
      'cat',
      'sh',
      'touch',
    ])
  })

  test('retains setup and cleanup diagnostics when deleting a partial sandbox fails', async () => {
    const h = harness()
    const cleanupError = new Error('sandbox delete failed')
    h.sandbox.failSetupCommand = 'tar'
    h.sandbox.deleteFailure = cleanupError

    let rejection: unknown
    try {
      await h.provider.provision({
        repo: '/repo',
        baseBranch: 'main',
        branch: 'ab/remote-build',
      })
    } catch (error) {
      rejection = error
    }

    expect(rejection).toBeInstanceOf(AggregateError)
    const aggregate = rejection as AggregateError
    expect(aggregate.errors).toHaveLength(2)
    expect(aggregate.errors[0]).toBeInstanceOf(Error)
    expect((aggregate.errors[0] as Error).message).toContain('tar exited 1')
    expect(aggregate.errors[1]).toBeInstanceOf(Error)
    expect((aggregate.errors[1] as Error).message).toContain(
      'cleanup outcome is unknown and remains retryable: sandbox delete failed',
    )
    expect((aggregate.errors[1] as Error).cause).toBe(cleanupError)
    expect(h.sandbox.deletes).toBe(1)
    expect(h.sandbox.provisioned).toBe(false)
  })

  test('reports Bun provisioning failure, deletes the partial sandbox, and never marks or launches it', async () => {
    const h = harness()
    h.sandbox.failCommand = (command) => command.cmd === 'npm'

    await expect(
      h.provider.provision({ repo: '/repo', baseBranch: 'main', branch: 'ab/remote-build' }),
    ).rejects.toThrow(/could not provision Bun 1\.4\.0.*universal managed image/)
    expect(h.sandbox.deletes).toBe(1)
    expect(h.sandbox.provisioned).toBe(false)
    expect(h.sandbox.commands.some((command) => command.cmd === 'touch')).toBe(false)
    expect(h.sandbox.commands.some((command) => command.detached === true)).toBe(false)
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
        listSnapshots: async () => [],
        deleteSnapshot: async () => {},
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

  test('installs and preflights every referenced runtime before the marker and preflights again before launch', async () => {
    const h = harness({ provisionRuntimes: true })
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    const runtimeCommands = h.sandbox.commands.filter(
      (command) =>
        command.cmd === 'sh' &&
        [
          'install-plugin@abc123',
          'plugin --version 1.2.3',
          'install-pi@0.84.4',
          'pi --version 0.84.4',
        ].includes((command.args as string[])[1]!),
    )
    expect(runtimeCommands.map((command) => (command.args as string[])[1])).toEqual([
      'install-pi@0.84.4',
      'pi --version 0.84.4',
      'install-plugin@abc123',
      'plugin --version 1.2.3',
    ])
    expect(runtimeCommands.every((command) => command.cwd === VERCEL_WORKSPACE_PATH)).toBe(true)
    expect(
      runtimeCommands.every(
        (command) => (command.env as Record<string, string>).ANTHROPIC_API_KEY === 'runtime-secret',
      ),
    ).toBe(true)
    expect(JSON.stringify(runtimeCommands)).not.toContain('forge-secret')
    expect(JSON.stringify(runtimeCommands)).not.toContain('provider-secret')
    expect(JSON.stringify(runtimeCommands)).not.toContain('never-copy')
    const marker = h.sandbox.commands.findIndex((command) => command.cmd === 'touch')
    expect(marker).toBeGreaterThan(h.sandbox.commands.indexOf(runtimeCommands.at(-1)!))

    await h.provider.buildExecution.start({
      slug: 'remote-build',
      storeRef: 'https://store.example.test',
      instance: 'i-runtime-preflight',
      workspaceRef: workspace.ref,
    })
    const commands = h.sandbox.commands
    const detached = commands.findIndex((command) => command.detached === true)
    expect((commands[detached - 2]!.args as string[])[1]).toBe('pi --version 0.84.4')
    expect((commands[detached - 1]!.args as string[])[1]).toBe('plugin --version 1.2.3')
  })

  test('a repeated runtime preflight failure prevents the detached child', async () => {
    const h = harness({ provisionRuntimes: true })
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    h.sandbox.failCommand = (command) =>
      command.cmd === 'sh' && (command.args as string[])[1] === 'pi --version 0.84.4'
    await expect(
      h.provider.buildExecution.start({
        slug: 'remote-build',
        storeRef: 'https://store.example.test',
        instance: 'i-failed-runtime-preflight',
        workspaceRef: workspace.ref,
      }),
    ).rejects.toThrow(/runtime "pi" preflight failed.*role "implement" primary/)
    expect(h.sandbox.commands.some((command) => command.detached === true)).toBe(false)
  })

  test('runner preflight reads runtime references updated after provisioning', async () => {
    let references = runtimeReferenceFixtures().filter((group) => group.runtime === 'pi')
    const h = harness({
      provisionRuntimes: true,
      runtimeReferences: () => references,
    })
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    references = runtimeReferenceFixtures().filter((group) => group.runtime === 'plugin')
    h.sandbox.failCommand = (command) =>
      command.cmd === 'sh' && (command.args as string[])[1] === 'plugin --version 1.2.3'

    await expect(
      h.provider.buildExecution.start({
        slug: 'remote-build',
        storeRef: 'https://store.example.test',
        instance: 'i-hot-runtime-preflight',
        workspaceRef: workspace.ref,
      }),
    ).rejects.toThrow(/runtime "plugin" preflight failed.*role "plan" alternate\[0\]/)
    expect(h.sandbox.commands.some((command) => command.detached === true)).toBe(false)
  })

  test('missing provisioning remediation round-trips exotic runtime names as TOML keys', async () => {
    const cases = [
      ['pi', 'pi'],
      ['plugin.runtime', '"plugin.runtime"'],
      ['plugin"runtime', '"plugin\\"runtime"'],
      ['plugin\\runtime', '"plugin\\\\runtime"'],
      ['plugin\u0001runtime', '"plugin\\u0001runtime"'],
      ['plugin\u007fruntime', '"plugin\\u007Fruntime"'],
      ['插件', '"\\u63D2\\u4EF6"'],
      ['plugin😀', '"plugin\\U0001F600"'],
    ] as const

    for (const [runtime, renderedKey] of cases) {
      // Direct construction deliberately bypasses schema cross-validation so this
      // defensive bootstrap branch remains covered without claiming production reachability.
      const h = harness({
        runtimeReferences: () => [
          {
            runtime,
            references: ['role "plan" primary'],
            models: [],
            usesRuntimeDefaultModel: true,
          },
        ],
      })
      let rejection: unknown
      try {
        await h.provider.provision({
          repo: '/repo',
          baseBranch: 'main',
          branch: 'ab/remote-build',
        })
      } catch (error) {
        rejection = error
      }
      expect(rejection).toBeInstanceOf(Error)
      const header = (rejection as Error).message.match(
        /add (\[workspace\.config\.runtimeProvisioning\..+?\]) with/,
      )?.[1]

      expect(header, `missing remediation header for ${JSON.stringify(runtime)}`).toBe(
        `[workspace.config.runtimeProvisioning.${renderedKey}]`,
      )
      const parsed = parseToml(header!) as {
        workspace: { config: { runtimeProvisioning: Record<string, unknown> } }
      }
      expect(Object.keys(parsed.workspace.config.runtimeProvisioning)).toEqual([runtime])
      expect(h.sandbox.provisioned).toBe(false)
      expect(h.sandbox.deletes).toBe(1)
      expect(h.sandbox.commands.some((command) => command.cmd === 'touch')).toBe(false)
      expect(h.sandbox.commands.some((command) => command.detached === true)).toBe(false)
    }
  })

  test('runtime failure redacts an allowlisted secret while preserving provisioning context', async () => {
    const h = harness({ provisionRuntimes: true })
    h.sandbox.failCommand = (command) =>
      command.cmd === 'sh' && (command.args as string[])[1] === 'plugin --version 1.2.3'
    h.sandbox.failureStderr =
      'plugin registry denied credential runtime-secret; manifest unavailable'

    let rejection: unknown
    try {
      await h.provider.provision({
        repo: '/repo',
        baseBranch: 'main',
        branch: 'ab/remote-build',
      })
    } catch (error) {
      rejection = error
    }

    expect(rejection).toBeInstanceOf(Error)
    const message = (rejection as Error).message
    const failedCommand = h.sandbox.commands.find((command) => h.sandbox.failCommand?.(command))
    expect(failedCommand).toBeDefined()
    expect((failedCommand!.env as Record<string, string>).ANTHROPIC_API_KEY).toBe('runtime-secret')
    expect(message).not.toContain('runtime-secret')
    expect(message).toContain('[REDACTED]')
    expect(message).toContain('plugin registry denied credential')
    expect(message).toContain('manifest unavailable')
    expect(message).toContain('runtime "plugin" preflight failed')
    expect(message).toContain('role "plan" alternate[0]')
    expect(message).toContain('workspace.config.runtimeProvisioning.plugin.preflight')
    expect(h.sandbox.provisioned).toBe(false)
    expect(h.sandbox.deletes).toBe(1)
    expect(h.sandbox.commands.some((command) => command.cmd === 'touch')).toBe(false)
    expect(h.sandbox.commands.some((command) => command.detached === true)).toBe(false)
  })

  test('runtime failure names the route and field, creates no marker, and deletes the sandbox', async () => {
    const h = harness({ provisionRuntimes: true })
    h.sandbox.failCommand = (command) =>
      command.cmd === 'sh' && (command.args as string[])[1] === 'plugin --version 1.2.3'
    await expect(
      h.provider.provision({ repo: '/repo', baseBranch: 'main', branch: 'ab/remote-build' }),
    ).rejects.toThrow(
      /runtime "plugin" preflight failed.*role "plan" alternate\[0\].*runtimeProvisioning\.plugin\.preflight/,
    )
    expect(h.sandbox.provisioned).toBe(false)
    expect(h.sandbox.deletes).toBe(1)
    expect(h.sandbox.commands.some((command) => command.detached === true)).toBe(false)
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
    const launch = h.sandbox.commands.find((command) => command.detached === true)!
    expect(handle.identity).toEqual({
      provider: 'vercel-sandbox',
      workspaceRef: workspace.ref,
      environmentId: 'sandbox',
      sessionId: 'session-1',
      commandId: `cmd-${h.sandbox.commands.indexOf(launch) + 1}`,
    })
    expect(await handle.completion).toEqual({ exitCode: 0 })
    const env = launch.env as Record<string, string>
    expect(env.ANTHROPIC_API_KEY).toBe('runtime-secret')
    expect(env.AB_TOKEN).toBe('scoped-store-token')
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.VERCEL_TOKEN).toBeUndefined()
    expect(env.UNDECLARED_SECRET).toBeUndefined()
    expect(JSON.parse(env.AB_BUILD_RUNNER_OPTIONS!).supervision).toEqual({ kind: 'environment' })
    expect(h.sandbox.policySignals).toHaveLength(1)
    expect(h.sandbox.policySignals[0]).toBeInstanceOf(AbortSignal)
    expect(launch).toMatchObject({
      cmd: 'sh',
      args: [
        '-c',
        `PATH=${VERCEL_BUN_BIN_PATH}:$PATH exec ${VERCEL_BUN_EXECUTABLE} ${VERCEL_AUTOBUILD_PATH}/bin/ab-build-runner.ts`,
      ],
      cwd: VERCEL_WORKSPACE_PATH,
    })
    const launchIndex = h.sandbox.commands.indexOf(launch)
    expect(h.sandbox.commands[launchIndex - 1]).toEqual({
      cmd: VERCEL_BUN_EXECUTABLE,
      args: ['--version'],
    })
    await h.provider.release(workspace)
    expect(h.sandbox.deletes).toBe(1)
  })

  test('bounds the command kill acknowledgement during graceful stop', async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    h.sandbox.detachedWait = () => new Promise(() => undefined)
    const execution = await h.provider.buildExecution.start({
      slug: 'remote-build',
      storeRef: 'https://store.example.test',
      instance: 'i-bounded-kill',
      workspaceRef: workspace.ref,
    })

    expect(await execution.stop()).toEqual({ outcome: 'confirmed' })
    expect(h.sandbox.killSignals).toHaveLength(1)
    expect(h.sandbox.killSignals[0]).toBeInstanceOf(AbortSignal)
  })

  test('release deletes a sandbox whose stop times out and still proves absence', async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    h.sandbox.stopTimeouts = 1
    await h.provider.release(workspace)
    expect(h.sandbox.deletes).toBe(1)
  })

  test('re-issues an interrupted wait long-poll until the detached runner exits', async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    let waits = 0
    h.sandbox.detachedWait = async () => {
      waits += 1
      if (waits < 3) {
        throw Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' })
      }
      return { exitCode: 0 }
    }
    const execution = await h.provider.buildExecution.start({
      slug: 'remote-build',
      storeRef: 'https://store.example.test',
      instance: 'i-long-poll',
      workspaceRef: workspace.ref,
    })

    expect(await execution.completion).toEqual({ exitCode: 0 })
    expect(waits).toBe(3)
  })

  test('observes a recorded execution from provider state within two bounded round trips', async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    // Hold the wait open so the detached command stays provably running.
    h.sandbox.detachedWait = () => new Promise(() => undefined)
    const execution = await h.provider.buildExecution.start({
      slug: 'remote-build',
      storeRef: 'https://store.example.test',
      instance: 'i-observe',
      workspaceRef: workspace.ref,
    })
    const identity = execution.identity!
    expect(identity.commandId).toBeDefined()

    // A registered command with a null exit code is still running.
    await expect(h.provider.buildExecution.observe!(identity)).resolves.toEqual({
      state: 'running',
    })
    expect(h.sandbox.getCommandCalls).toBe(1)

    // A non-null exit code is a proved end carrying that code.
    h.sandbox.detachedCommands.set(identity.commandId!, { exitCode: 7 })
    await expect(h.provider.buildExecution.observe!(identity)).resolves.toEqual({
      state: 'ended',
      exitCode: 7,
    })
    expect(h.sandbox.getCommandCalls).toBe(2)
  })

  test('observes lost executions: stopped session, a resumed session 404, and an absent sandbox', async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    h.sandbox.detachedWait = () => new Promise(() => undefined)
    const execution = await h.provider.buildExecution.start({
      slug: 'remote-build',
      storeRef: 'https://store.example.test',
      instance: 'i-observe-lost',
      workspaceRef: workspace.ref,
    })
    const identity = execution.identity!

    // A session that is no longer running proves the execution cannot be
    // observed, even before re-fetching the command.
    h.sandbox.sessionStatus = 'stopped'
    await expect(h.provider.buildExecution.observe!(identity)).resolves.toEqual({ state: 'lost' })
    expect(h.sandbox.getCommandCalls).toBe(0)
    h.sandbox.sessionStatus = 'running'

    // A command the current (resumed) session no longer knows 404s: lost.
    h.sandbox.detachedCommands.delete(identity.commandId!)
    await expect(h.provider.buildExecution.observe!(identity)).resolves.toEqual({ state: 'lost' })

    // A sandbox the facade can no longer resolve at all is lost.
    await h.sandbox.delete()
    await expect(h.provider.buildExecution.observe!(identity)).resolves.toEqual({ state: 'lost' })
  })

  test('observe stops re-issuing polls once the environment lifetime plus margin has passed', async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    h.sandbox.detachedWait = () => new Promise(() => undefined)
    const execution = await h.provider.buildExecution.start({
      slug: 'remote-build',
      storeRef: 'https://store.example.test',
      instance: 'i-observe-expired',
      workspaceRef: workspace.ref,
    })
    const identity = execution.identity!

    // Past session expiry plus the stop/snapshot margin the environment
    // itself is gone: the observation fails naming it instead of issuing
    // another long-poll that would end in a generic transport timeout.
    const expiredAt = Date.now() - VERCEL_LIFETIME_MARGIN_MS - 1000
    h.sandbox.sessionExpiresAt = expiredAt
    await expect(h.provider.buildExecution.observe!(identity)).rejects.toThrow(
      /cannot still be running[\s\S]*expired[\s\S]*session expiry/s,
    )
    await expect(h.provider.buildExecution.observe!(identity)).rejects.toThrow(
      identity.environmentId!,
    )
    expect(h.sandbox.getCommandCalls).toBe(0)

    // Just before the bound the alive normal path is unchanged: the poll is
    // issued and a null exit code still reports running.
    h.sandbox.sessionExpiresAt = Date.now() + VERCEL_LIFETIME_MARGIN_MS + 60_000
    await expect(h.provider.buildExecution.observe!(identity)).resolves.toEqual({
      state: 'running',
    })
    expect(h.sandbox.getCommandCalls).toBe(1)
  })

  test('observe keeps the unbounded behavior when the facade carries no session expiry', async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    h.sandbox.detachedWait = () => new Promise(() => undefined)
    const execution = await h.provider.buildExecution.start({
      slug: 'remote-build',
      storeRef: 'https://store.example.test',
      instance: 'i-observe-no-expiry',
      workspaceRef: workspace.ref,
    })
    expect(h.sandbox.sessionExpiresAt).toBeUndefined()
    await expect(h.provider.buildExecution.observe!(execution.identity!)).resolves.toEqual({
      state: 'running',
    })
    expect(h.sandbox.getCommandCalls).toBe(1)
  })

  test('an execution without a recorded command id cannot be re-observed', async () => {
    const h = harness()
    await expect(
      h.provider.buildExecution.observe!({
        provider: 'vercel-sandbox',
        workspaceRef: 'never-provisioned',
      }),
    ).rejects.toThrow(/no recorded command id/)
  })

  test('unresolvable provider errors propagate from observe — callers treat them as running', async () => {
    const h = harness({
      facadeGet: async (): Promise<VercelSandboxHandle | null> => {
        throw new Error('provider unreachable')
      },
    })
    await expect(
      h.provider.buildExecution.observe!({
        provider: 'vercel-sandbox',
        workspaceRef: 'unreachable',
        commandId: 'cmd-1',
      }),
    ).rejects.toThrow('provider unreachable')
  })

  test('detach resolves the wait without touching the guest and publication still refuses', async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    // The fake long-poll rejects with the abort reason, honouring the widened
    // wait signature: a detached wait is abort, not failure.
    h.sandbox.detachedWait = (params?: { signal?: AbortSignal }) =>
      new Promise<never>((_, reject) => {
        params?.signal?.addEventListener('abort', () => {
          reject(params.signal!.reason ?? new Error('aborted'))
        })
      })
    const execution = await h.provider.buildExecution.start({
      slug: 'remote-build',
      storeRef: 'https://store.example.test',
      instance: 'i-detach',
      workspaceRef: workspace.ref,
    })
    const completion = execution.completion
    // Provisioning itself stops the setup shell once; only a stop beyond that
    // baseline would be the completion chain tearing the guest down.
    const stopsBeforeDetach = h.sandbox.stops
    const deletesBeforeDetach = h.sandbox.deletes
    await execution.detach()

    // The abandoned completion chain resolves without an error and never
    // stops, kills, or deletes the guest the next supervisor is supervising.
    await expect(completion).resolves.toEqual({ exitCode: null })
    expect(h.sandbox.killSignals).toHaveLength(0)
    expect(h.sandbox.stops).toBe(stopsBeforeDetach)
    expect(h.sandbox.deletes).toBe(deletesBeforeDetach)

    // The execution is still provider-live: publication remains forbidden.
    await expect(
      h.provider.publication.publish({ ref: workspace.ref, sha: SHA, branch: 'ab/remote-build' }),
    ).rejects.toThrow(/publication is forbidden until sandbox execution teardown is confirmed/)
  })

  test('a non-transient wait failure still rejects the completion', async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    h.sandbox.detachedWait = async () => {
      throw new Error('Status code 404 is not ok: session not found')
    }
    const execution = await h.provider.buildExecution.start({
      slug: 'remote-build',
      storeRef: 'https://store.example.test',
      instance: 'i-real-failure',
      workspaceRef: workspace.ref,
    })

    await expect(execution.completion).rejects.toThrow('404')
  })

  test('fails preflight closed when provisioned Bun is missing and does not start a child', async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    h.sandbox.failCommand = (command) =>
      command.cmd === VERCEL_BUN_EXECUTABLE &&
      (command.args as string[] | undefined)?.[0] === '--version'

    await expect(
      h.provider.buildExecution.start({
        slug: 'remote-build',
        storeRef: 'https://store.example.test',
        instance: 'i-missing-bun',
        workspaceRef: workspace.ref,
      }),
    ).rejects.toThrow(/Bun 1\.4\.0 preflight failed.*release and reprovision/)
    expect(h.sandbox.commands.filter((command) => command.detached === true)).toHaveLength(0)
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
    await expect(
      h.provider.publication.publish({ ref: workspace.ref, sha: SHA, branch: workspace.branch }),
    ).rejects.toThrow(/teardown is confirmed/)

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

  test('reap rejects unknown deletion, then safely retries and becomes an absence no-op', async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    h.sandbox.remainAfterDelete = true
    await expect(h.provider.recovery.reap(workspace)).rejects.toThrow(
      /still exists after delete acknowledgement/,
    )
    h.sandbox.remainAfterDelete = false
    // The rejected reap already purged before its delete was refused; the
    // absent re-applies stay empty no-ops.
    expect(await h.provider.recovery.reap(workspace)).toEqual({
      outcome: 'absent',
      snapshots: { outcome: 'confirmed', deleted: 0 },
    })
    expect(await h.provider.recovery.reap(workspace)).toEqual({
      outcome: 'absent',
      snapshots: { outcome: 'confirmed', deleted: 0 },
    })
  })

  test('creation binds the one-snapshot retention bound', async () => {
    const h = harness()
    await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    expect(h.createInput?.keepLastSnapshots).toEqual({ count: 1, deleteEvicted: true })
  })

  test('creation maps snapshotExpirationSeconds to SDK milliseconds and omits it when unset', async () => {
    const set = harness({ snapshotExpirationSeconds: 86_400 })
    await set.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    expect(set.createInput?.snapshotExpiration).toBe(86_400_000)

    const unset = harness()
    await unset.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    // The key must be absent entirely: the SDK reads `0` as "no expiration".
    expect(unset.createInput?.snapshotExpiration).toBeUndefined()
    expect('snapshotExpiration' in (unset.createInput ?? {})).toBe(false)
  })

  test('reap purges every live snapshot under the exact environment name and never touches dead rows', async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    // Snapshots left by earlier sessions of the same environment, plus dead
    // rows that hold no storage.
    h.sandbox.snapshots.push(
      { id: 'snap-older', sourceSessionId: 'session-0', status: 'created' },
      { id: 'snap-dead', sourceSessionId: 'session-0', status: 'deleted' },
      { id: 'snap-failed', sourceSessionId: 'session-0', status: 'failed' },
    )
    const stopSnapshots = h.sandbox.snapshots.filter(
      (snapshot) => snapshot.status === 'created',
    ).length
    expect(stopSnapshots).toBe(2)

    const outcome = await h.provider.recovery.reap(workspace)
    // The reap's own stop also materializes a snapshot; the purge removes
    // every storage-holding row under the exact name.
    expect(outcome).toEqual({
      outcome: 'confirmed',
      snapshots: { outcome: 'confirmed', deleted: 3 },
    })
    // Only the storage-holding rows were purged.
    expect(h.sandbox.snapshots.map((snapshot) => snapshot.id).sort()).toEqual([
      'snap-dead',
      'snap-failed',
    ])
  })

  test('reap on an absent environment still purges its leftover snapshots', async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    // Fence a reap so the provider drops its session handle, then make the
    // environment vanish out-of-band with snapshots left behind.
    h.sandbox.remainAfterDelete = true
    await expect(h.provider.recovery.reap(workspace)).rejects.toThrow(
      /still exists after delete acknowledgement/,
    )
    h.sandbox.remainAfterDelete = false
    h.sandbox.snapshots.push({
      id: 'snap-orphan',
      sourceSessionId: 'session-9',
      status: 'created',
    })

    const outcome = await h.provider.recovery.reap(workspace)
    expect(outcome).toEqual({
      outcome: 'absent',
      snapshots: { outcome: 'confirmed', deleted: 1 },
    })
    // An absent environment is never stopped or deleted again.
    expect(h.sandbox.deletes).toBe(1)
    expect(h.sandbox.snapshots).toEqual([])
  })

  test('a snapshot purge failure rejects reap as retryable and a retry completes', async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    const originalDelete = h.facade.deleteSnapshot.bind(h.facade)
    h.facade.deleteSnapshot = async () => {
      throw new Error('snapshot delete denied')
    }

    await expect(h.provider.recovery.reap(workspace)).rejects.toThrow(
      /cleanup outcome is unknown and remains retryable: snapshot purge for .* is unconfirmed: snapshot delete denied/,
    )
    // The purge runs before the sandbox delete, so the retry converges.
    expect(h.sandbox.deletes).toBe(0)

    h.facade.deleteSnapshot = originalDelete
    const outcome = await h.provider.recovery.reap(workspace)
    expect(outcome.outcome).toBe('confirmed')
    expect(outcome.snapshots.outcome).toBe('confirmed')
    expect(outcome.snapshots.deleted).toBeGreaterThan(0)
    expect(h.sandbox.deletes).toBe(1)
    expect(h.sandbox.snapshots).toEqual([])
  })

  test('reap retains an interrupted stop for a later confirmed retry', async () => {
    const h = harness()
    const workspace = await h.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    h.sandbox.stopFailures = 1
    await expect(h.provider.recovery.reap(workspace)).rejects.toThrow(/outcome is unknown/)
    expect(h.sandbox.deletes).toBe(0)
    const retry = await h.provider.recovery.reap(workspace)
    expect(retry.outcome).toBe('confirmed')
    expect(retry.snapshots.outcome).toBe('confirmed')
    expect(h.sandbox.deletes).toBe(1)
  })

  test('observes an exact durable branch head without requiring the old sandbox', async () => {
    const landed = harness({ publishedSha: SHA })
    const workspace = await landed.provider.provision({
      repo: '/repo',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    await landed.provider.recovery.reap(workspace)
    expect(
      await landed.provider.publication.isPublished({ sha: SHA, branch: workspace.branch }),
    ).toBe(true)
    expect(
      await landed.provider.publication.isPublished({
        sha: 'b'.repeat(40),
        branch: workspace.branch,
      }),
    ).toBe(false)
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
    expect(h.sandbox.policySignals).toHaveLength(2)
    expect(h.sandbox.policySignals.every((signal) => signal instanceof AbortSignal)).toBe(true)
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

    const commandsBeforeRestart = restore.sandbox.commands.length
    await expect(
      restore.provider.buildExecution.start({
        slug: 'remote-build',
        storeRef: 'https://store.example.test',
        instance: 'i-stale-policy',
        workspaceRef: restoreWorkspace.ref,
      }),
    ).rejects.toThrow(/restore failed/)
    expect(restore.sandbox.commands).toHaveLength(commandsBeforeRestart)
    restore.sandbox.failRestore = false
    const safeRetry = await restore.provider.buildExecution.start({
      slug: 'remote-build',
      storeRef: 'https://store.example.test',
      instance: 'i-safe-policy',
      workspaceRef: restoreWorkspace.ref,
    })
    expect(await safeRetry.completion).toEqual({ exitCode: 0 })
    expect(JSON.stringify(restore.sandbox.policies.at(-1))).not.toContain('git-receive-pack')

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
    ).rejects.toThrow(/teardown is confirmed/)
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
            listSnapshots: async () => [],
            deleteSnapshot: async () => {},
          },
        }),
    ).toThrow(/HTTPS BuildStore/)
  })
})

describe('VercelSandboxProvider origin mode (no checkout)', () => {
  const SHA = 'a'.repeat(40)
  const BASE_SHA = 'b'.repeat(40)

  /** Origin-mode harness: injected origin/remoteBranchHead seams and an exec
   * that THROWS on any host command — proving the provider never shells git
   * on the host when the seams are present. */
  function originHarness(
    options: { remoteBranches?: Record<string, string>; postPushHead?: boolean } = {},
  ) {
    const branches = new Map(Object.entries(options.remoteBranches ?? {}))
    const sandbox = new FakeSandbox()
    let createInput: Record<string, unknown> | undefined
    const facade: VercelSandboxFacade = {
      get: async () => sandbox,
      create: async (input) => {
        createInput = input as Record<string, unknown>
        return sandbox
      },
      listSnapshots: async () => [],
      deleteSnapshot: async () => {},
    }
    const throwingExec: Exec = async (cmd) => {
      throw new Error(`host exec must not run in origin mode: ${cmd.join(' ')}`)
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
      repo: '/this/checkout/does/not/exist',
      facade,
      exec: throwingExec,
      packageArchive: async () => new Uint8Array([1, 2, 3]),
      origin: async () => 'https://github.com/acme/app',
      remoteBranchHead: async (branch) =>
        branches.get(branch) ??
        (options.postPushHead !== false &&
        branch === 'ab/remote-build' &&
        sandbox.commands.some((command) => (command.args as string[])?.includes('push'))
          ? SHA
          : undefined),
    })
    return {
      provider,
      sandbox,
      createInput: () => createInput as { source: { url: string; revision: string } },
    }
  }

  test('provisions from the injected origin and remote branch heads with no host exec', async () => {
    const h = originHarness({ remoteBranches: { main: BASE_SHA } })
    const workspace = await h.provider.provision({
      repo: '/not/a/checkout',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    expect(workspace.provider).toBe('vercel-sandbox')
    expect(workspace.base).toEqual({ source: 'remote', sha: BASE_SHA })
    // The sandbox source pins the injected origin's https spelling.
    expect(h.createInput().source.url).toBe('https://github.com/acme/app.git')
    expect(h.createInput().source.revision).toBe(BASE_SHA)
  })

  test('reuses an existing build branch head before falling back to the base branch', async () => {
    const h = originHarness({ remoteBranches: { main: BASE_SHA, 'ab/remote-build': SHA } })
    const workspace = await h.provider.provision({
      repo: '/not/a/checkout',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    expect(workspace.base).toEqual({ source: 'existing', sha: SHA })
  })

  test('the full publish path, including its post-push verification, runs without host git', async () => {
    // The seam only starts reporting the build branch after the guest's push
    // command ran — exactly what the real forge-backed reader observes once
    // the guest lands the branch.
    const h = originHarness({ remoteBranches: { main: BASE_SHA } })
    const workspace = await h.provider.provision({
      repo: '/not/a/checkout',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    expect(await h.provider.publication.isPublished({ sha: SHA, branch: workspace.branch })).toBe(
      false,
    )
    await h.provider.publication.publish({ ref: workspace.ref, sha: SHA, branch: workspace.branch })
    expect(await h.provider.publication.isPublished({ sha: SHA, branch: workspace.branch })).toBe(
      true,
    )
  })

  test('a publication whose seam never shows the head still fails closed', async () => {
    const h = originHarness({ remoteBranches: { main: BASE_SHA }, postPushHead: false })
    const workspace = await h.provider.provision({
      repo: '/not/a/checkout',
      baseBranch: 'main',
      branch: 'ab/remote-build',
    })
    // The guest push "succeeds" but the seam keeps reporting the branch
    // absent — the verification must reject, never assume.
    await expect(
      h.provider.publication.publish({ ref: workspace.ref, sha: SHA, branch: workspace.branch }),
    ).rejects.toThrow(/published head \(missing\) did not match/)
  })
})

describe('VercelSandboxProvider harvestExecution', () => {
  const ORIGIN = 'https://github.com/acme/app.git'
  const HARVEST_NAME = harvestSandboxName(ORIGIN)
  /** The fake handle's provider-native name, which is what the SDK reports on
   * the returned sandbox and what identity/envelope stamp. */
  const LAUNCH_NAME = 'sandbox'

  test('provisions a fresh disposable environment from the remote base head and launches the guest runner', async () => {
    const h = harness({ provisionRuntimes: true })
    const handle = await h.provider.harvestExecution.start({
      storeRef: 'https://store.example.test',
      repo: ORIGIN,
      instance: 'host-harvest-i1',
      baseBranch: 'main',
      leaseHolder: 'host-dispatch-i0',
      workspaceRef: HARVEST_NAME,
    })

    // One named disposable environment, provisioned from the remote base head
    // with the build shape (persistent, same image/resources/timeout/snapshots).
    expect(h.creates).toBe(1)
    expect(h.createInput).toMatchObject({
      name: HARVEST_NAME,
      source: { type: 'git', url: ORIGIN, revision: SHA },
      persistent: true,
      networkPolicy: 'allow-all',
      keepLastSnapshots: { count: 1, deleteEvicted: true },
    })
    expect((h.createInput!.timeout as number) / 1000).toBe(2700)

    // Fresh provisioning chain, in the build order.
    const commands = h.sandbox.commands
    const labels = commands.map((command) =>
      command.cmd === 'sh'
        ? `sh:${((command.args as string[])[1] ?? '').slice(0, 24)}`
        : command.cmd,
    )
    expect(
      commands.some(
        (command) =>
          command.cmd === 'sh' && String((command.args as string[])[1]).includes('mv "$1" "$2"'),
      ),
    ).toBe(true)
    expect(labels.indexOf('npm')).toBeGreaterThan(
      commands.findIndex(
        (command) => command.cmd === 'sh' && (command.args as string[]).includes('relocate'),
      ),
    )
    expect(labels.lastIndexOf('touch')).toBeGreaterThan(labels.indexOf('npm'))
    expect(h.sandbox.provisioned).toBe(true)
    // Runtime runtimes were INSTALLED on the fresh path (not preflight only).
    const runtimeInstalls = commands.filter(
      (command) =>
        command.cmd === 'sh' &&
        ['install-pi@0.84.4', 'install-plugin@abc123'].includes(
          (command.args as string[])[1] ?? '',
        ),
    )
    expect(runtimeInstalls).toHaveLength(2)
    expect(runtimeInstalls[0]!.cwd).toBe(VERCEL_WORKSPACE_PATH)

    // Launch: one detached ab-harvest-runner command carrying the envelope.
    const detached = commands.filter((command) => command.detached === true)
    expect(detached).toHaveLength(1)
    expect(String((detached[0]!.args as string[])[1])).toContain('bin/ab-harvest-runner.ts')
    expect(detached[0]!.cwd).toBe(VERCEL_WORKSPACE_PATH)
    const env = detached[0]!.env as Record<string, string>
    expect(env.AB_STORE).toBe('https://store.example.test')
    expect(env.AB_TOKEN).toBe('scoped-store-token')
    expect(env.ANTHROPIC_API_KEY).toBe('runtime-secret')
    expect(JSON.stringify(env)).not.toContain('forge-secret')
    expect(JSON.stringify(env)).not.toContain('never-copy')
    expect(env[HARVEST_RUNNER_OPTIONS_ENV]).toBeDefined()
    expect(JSON.parse(env[HARVEST_RUNNER_OPTIONS_ENV]!)).toEqual({
      storeRef: 'https://store.example.test',
      repo: ORIGIN,
      instance: 'host-harvest-i1',
      baseBranch: 'main',
      leaseHolder: 'host-dispatch-i0',
      workspaceRef: HARVEST_NAME,
      supervision: { kind: 'environment' },
      environment: {
        provider: 'vercel-sandbox',
        environmentId: LAUNCH_NAME,
        sessionId: 'session-1',
      },
    })

    // Supervision identity mirrors the build path.
    expect(handle.supervision).toBe('environment')
    expect(handle.identity).toMatchObject({
      provider: 'vercel-sandbox',
      workspaceRef: HARVEST_NAME,
      environmentId: LAUNCH_NAME,
      sessionId: 'session-1',
    })
    expect(handle.identity?.commandId).toMatch(/^cmd-/)

    // Completion stops the environment; release reaps with a proven snapshot purge.
    expect(await handle.completion).toEqual({ exitCode: 0 })
    const reap = await h.provider.recovery.reap({
      provider: 'vercel-sandbox',
      ref: HARVEST_NAME,
      path: VERCEL_WORKSPACE_PATH,
      branch: 'main',
    })
    expect(reap.outcome).toBe('confirmed')
    expect(reap.snapshots.outcome).toBe('confirmed')
    expect(reap.snapshots.deleted ?? 0).toBeGreaterThan(0)
    expect(h.sandbox.deletes).toBe(1)
    expect(await h.facade.listSnapshots(HARVEST_NAME)).toEqual([])
  })

  test('stops and reuses a marked harvest environment without re-provisioning', async () => {
    const h = harness({ provisionRuntimes: true })
    const first = await h.provider.harvestExecution.start({
      storeRef: 'https://store.example.test',
      repo: ORIGIN,
      instance: 'host-harvest-i1',
      baseBranch: 'main',
    })
    expect(await first.completion).toEqual({ exitCode: 0 })

    const commandsBefore = h.sandbox.commands.length
    const second = await h.provider.harvestExecution.start({
      storeRef: 'https://store.example.test',
      repo: ORIGIN,
      instance: 'host-harvest-i2',
      baseBranch: 'main',
    })
    expect(h.creates).toBe(1)
    expect(h.sandbox.deletes).toBe(0)
    expect(h.sandbox.provisioned).toBe(true)
    const since = h.sandbox.commands.slice(commandsBefore)
    // Marker read, distribution version read, policy reassert, preflights,
    // then the launch — no provisioning chain re-ran.
    expect(since[0]!.cmd).toBe('test')
    expect(since.some((command) => command.sudo === true)).toBe(false)
    expect(since.filter((command) => command.detached === true)).toHaveLength(1)
    expect(await second.completion).toEqual({ exitCode: 0 })
    const envelope = JSON.parse(
      (since.find((command) => command.detached === true)!.env as Record<string, string>)[
        HARVEST_RUNNER_OPTIONS_ENV
      ] as string,
    )
    expect(envelope.instance).toBe('host-harvest-i2')
    expect(envelope.supervision).toEqual({ kind: 'environment' })
  })

  test('deletes and recreates an unmarked leftover harvest environment', async () => {
    const leftover = new FakeSandbox()
    leftover.cwd = '/vercel/sandbox'
    const h = harness({ facadeGet: async () => leftover })
    await h.provider.harvestExecution.start({
      storeRef: 'https://store.example.test',
      repo: ORIGIN,
      instance: 'host-harvest-i1',
      baseBranch: 'main',
    })
    // The crashed/legacy attempt was deleted before the fresh create.
    expect(leftover.deletes).toBe(1)
    expect(h.creates).toBe(1)
    expect(h.sandbox.provisioned).toBe(true)
  })

  test('a second start while one harvest execution is live is refused', async () => {
    const h = harness()
    let resolveWait: ((result: { exitCode: number }) => void) | undefined
    h.sandbox.detachedWait = () =>
      new Promise((resolve) => {
        resolveWait = resolve
      })
    const first = await h.provider.harvestExecution.start({
      storeRef: 'https://store.example.test',
      repo: ORIGIN,
      instance: 'host-harvest-i1',
      baseBranch: 'main',
    })
    await expect(
      h.provider.harvestExecution.start({
        storeRef: 'https://store.example.test',
        repo: ORIGIN,
        instance: 'host-harvest-i2',
        baseBranch: 'main',
      }),
    ).rejects.toThrow(/already has a live execution/)
    resolveWait!({ exitCode: 0 })
    expect(await first.completion).toEqual({ exitCode: 0 })
  })

  test('observe maps provider state to running, ended, lost, and refuses missing command ids', async () => {
    const h = harness()
    let resolveWait: ((result: { exitCode: number }) => void) | undefined
    h.sandbox.detachedWait = () =>
      new Promise((resolve) => {
        resolveWait = resolve
      })
    const execution = await h.provider.harvestExecution.start({
      storeRef: 'https://store.example.test',
      repo: ORIGIN,
      instance: 'host-harvest-i1',
      baseBranch: 'main',
    })
    const identity = execution.identity!
    // A running detached command is running.
    expect(await h.provider.harvestExecution.observe!(identity)).toEqual({ state: 'running' })
    // A non-null command exit code is ended with that code.
    h.sandbox.detachedCommands.set(identity.commandId!, { exitCode: 3 })
    expect(await h.provider.harvestExecution.observe!(identity)).toEqual({
      state: 'ended',
      exitCode: 3,
    })
    // A command the session no longer knows is lost.
    expect(
      await h.provider.harvestExecution.observe!({ ...identity, commandId: 'cmd-missing' }),
    ).toEqual({ state: 'lost' })
    // A stopped session is lost.
    h.sandbox.sessionStatus = 'stopped'
    expect(await h.provider.harvestExecution.observe!(identity)).toEqual({ state: 'lost' })
    // An identity without a command id is refused, never silently skipped.
    await expect(
      h.provider.harvestExecution.observe!({ provider: 'vercel-sandbox', workspaceRef: 'x' }),
    ).rejects.toThrow(/no recorded command id/)
    resolveWait!({ exitCode: 0 })
    await execution.completion
  })

  test('observe reports lost when the harvest environment is gone', async () => {
    const h = harness({ facadeGet: async () => null })
    expect(
      await h.provider.harvestExecution.observe!({
        provider: 'vercel-sandbox',
        workspaceRef: HARVEST_NAME,
        environmentId: HARVEST_NAME,
        commandId: 'cmd-1',
      }),
    ).toEqual({ state: 'lost' })
  })

  test('a missing remote base branch refuses to provision', async () => {
    const h = harness()
    await expect(
      h.provider.harvestExecution.start({
        storeRef: 'https://store.example.test',
        repo: ORIGIN,
        instance: 'host-harvest-i1',
        baseBranch: 'nope',
      }),
    ).rejects.toThrow(/remote base nope does not exist/)
    expect(h.creates).toBe(0)
  })
})

describe('vercelSdkCredentials', () => {
  const oidc = (claims: Record<string, unknown>): string =>
    `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`

  test('an OIDC token is passed explicitly with the team and project from its claims', () => {
    const token = oidc({ owner_id: 'team_123', project_id: 'prj_456', exp: 1 })
    expect(vercelOidcTokenScope(token)).toEqual({ teamId: 'team_123', projectId: 'prj_456' })
    // The token wins over a durable token in the same environment, and the
    // SDK receives all three fields so it never consults the process env.
    expect(
      vercelSdkCredentials({
        VERCEL_OIDC_TOKEN: token,
        VERCEL_TOKEN: 'durable',
        VERCEL_TEAM_ID: 'other-team',
        VERCEL_PROJECT_ID: 'other-project',
      }),
    ).toEqual({ token, teamId: 'team_123', projectId: 'prj_456' })
  })

  test('an OIDC token whose claims cannot be read is left to the SDK', () => {
    expect(vercelOidcTokenScope('not-a-jwt')).toBeNull()
    expect(
      vercelOidcTokenScope(`a.${Buffer.from('{"sub":"x"}').toString('base64url')}.c`),
    ).toBeNull()
    expect(vercelOidcTokenScope('a.!!!.c')).toBeNull()
    expect(vercelSdkCredentials({ VERCEL_OIDC_TOKEN: 'not-a-jwt' })).toEqual({})
  })

  test('durable credentials require all three variables', () => {
    expect(
      vercelSdkCredentials({ VERCEL_TOKEN: 't', VERCEL_TEAM_ID: 'team', VERCEL_PROJECT_ID: 'prj' }),
    ).toEqual({ token: 't', teamId: 'team', projectId: 'prj' })
    expect(() => vercelSdkCredentials({ VERCEL_TOKEN: 't', VERCEL_TEAM_ID: 'team' })).toThrow(
      /requires VERCEL_OIDC_TOKEN or VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID/,
    )
  })
})
