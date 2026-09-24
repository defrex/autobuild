import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeWorkspaceProviderContract } from './contract'
import { FakeWorkspaceProvider } from './fake'

const OPTS = { repo: '/repos/origin', baseBranch: 'main', branch: 'ab/fix-login' }

describeWorkspaceProviderContract('FakeWorkspaceProvider', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'ab-fake-workspace-contract-'))
  const repo = join(tmp, 'source')
  const root = join(tmp, 'workspaces')
  const fixture = { relativePath: 'source-fixture.txt', content: 'selected source tree\n' }
  await mkdir(repo, { recursive: true })
  await writeFile(join(repo, fixture.relativePath), fixture.content)
  return {
    provider: new FakeWorkspaceProvider({
      root,
      base: { source: 'remote', sha: 'contract-base-sha' },
    }),
    provision: { repo, baseBranch: 'main', branch: 'ab/contract-workspace' },
    expectedBase: { source: 'remote', sha: 'contract-base-sha' },
    fixture,
    cleanup: () => rm(tmp, { recursive: true, force: true }),
  }
})

describe('FakeWorkspaceProvider', () => {
  test('provision returns <root>/<branch> with ref === path and journals', async () => {
    const provider = new FakeWorkspaceProvider({ root: '/ws', mode: 'logical' })
    const handle = await provider.provision(OPTS)
    expect(handle).toEqual({
      provider: 'fake',
      ref: '/ws/ab/fix-login',
      path: '/ws/ab/fix-login',
      branch: 'ab/fix-login',
      base: { source: 'remote', sha: 'fake-base-sha' },
    })
    expect(provider.provisions).toEqual([OPTS])
    expect(provider.isActive(handle.ref)).toBe(true)
  })

  test('logical provision stays idempotent without touching the filesystem', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'ab-fake-workspace-logical-'))
    const root = join(tmp, 'workspaces')
    const provider = new FakeWorkspaceProvider({ root, mode: 'logical' })
    try {
      const first = await provider.provision({
        ...OPTS,
        repo: join(tmp, 'nonexistent-source'),
      })
      const second = await provider.provision({
        ...OPTS,
        repo: join(tmp, 'nonexistent-source'),
      })
      expect(second).toEqual({
        ...first,
        base: { source: 'existing', sha: 'fake-base-sha' },
      })
      expect(provider.provisions).toHaveLength(2)
      expect(existsSync(root)).toBe(false)
      expect(existsSync(first.path)).toBe(false)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  test('configured fallback evidence is returned and the branch head survives release', async () => {
    const provider = new FakeWorkspaceProvider({
      root: '/ws',
      mode: 'logical',
      base: {
        source: 'local',
        sha: 'local-sha',
        remoteError: 'origin unavailable',
      },
    })
    const first = await provider.provision(OPTS)
    expect(first.base).toEqual({
      source: 'local',
      sha: 'local-sha',
      remoteError: 'origin unavailable',
    })

    provider.setBranchHead(OPTS.branch, 'implemented-sha')
    await provider.release(first)
    const resumed = await provider.provision(OPTS)
    expect(resumed.base).toEqual({
      source: 'existing',
      sha: 'implemented-sha',
    })
  })

  test('filesystem reprovision repairs stale active bookkeeping without releasing the branch', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'ab-fake-workspace-recovery-'))
    const repo = join(tmp, 'source')
    const root = join(tmp, 'workspaces')
    const fixture = join(repo, 'source-fixture.txt')
    await mkdir(repo, { recursive: true })
    await writeFile(fixture, 'source tree\n')
    const provider = new FakeWorkspaceProvider({ root })
    const opts = { ...OPTS, repo }

    try {
      const first = await provider.provision(opts)
      const inProgress = join(first.path, 'in-progress.txt')
      await writeFile(inProgress, 'keep while intact\n')
      provider.setBranchHead(opts.branch, 'implemented-sha')

      const intact = await provider.provision(opts)
      expect(intact.base).toEqual({
        source: 'existing',
        sha: 'implemented-sha',
      })
      expect(await readFile(inProgress, 'utf8')).toBe('keep while intact\n')

      const provisionsBeforeRecovery = provider.provisions.length
      await rm(first.path, { recursive: true, force: true })
      const recovered = await provider.provision(opts)

      expect(recovered.path).toBe(first.path)
      expect((await stat(recovered.path)).isDirectory()).toBe(true)
      expect(await readFile(join(recovered.path, 'source-fixture.txt'), 'utf8')).toBe(
        'source tree\n',
      )
      await writeFile(join(recovered.path, 'write-probe.txt'), 'writable\n')
      expect(recovered.base).toEqual({
        source: 'existing',
        sha: 'implemented-sha',
      })
      expect(provider.isActive(recovered.ref)).toBe(true)
      expect(provider.provisions).toHaveLength(provisionsBeforeRecovery + 1)
      expect(provider.provisions.at(-1)).toEqual(opts)
      expect(provider.releases).toEqual([])
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  test('release journals and is idempotent', async () => {
    const provider = new FakeWorkspaceProvider({ root: '/ws', mode: 'logical' })
    const handle = await provider.provision(OPTS)
    await provider.release(handle)
    expect(provider.isActive(handle.ref)).toBe(false)
    // Releasing again (or releasing something never provisioned) is a no-op.
    await provider.release(handle)
    expect(provider.releases).toHaveLength(2)
  })

  test('setFailure makes the named operation throw until cleared', async () => {
    const provider = new FakeWorkspaceProvider({ root: '/ws', mode: 'logical' })
    provider.setFailure('provision', new Error('disk full'))
    await expect(provider.provision(OPTS)).rejects.toThrow('disk full')
    expect(provider.provisions).toEqual([]) // failed calls are not journaled

    provider.setFailure('provision', null)
    const handle = await provider.provision(OPTS)

    provider.setFailure('release', new Error('locked'))
    await expect(provider.release(handle)).rejects.toThrow('locked')
    expect(provider.releases).toEqual([])
    expect(provider.isActive(handle.ref)).toBe(true)
  })

  test('the build-path publication discriminator is untouched; the sandbox seam exists', () => {
    const provider = new FakeWorkspaceProvider({ root: '/ws', mode: 'logical' })
    // `publication` is the dispatcher's remote-workspace discriminator: it
    // must stay absent on the fake so dispatcher-test builds classify local.
    expect((provider as unknown as { publication?: unknown }).publication).toBeUndefined()
    expect(provider.sandboxPublication).toBeDefined()
  })
})

describe('FakeWorkspaceProvider operator sandbox (AUT-343 fake parity)', () => {
  let tmp: string
  let source: string
  let provider: FakeWorkspaceProvider

  const git = async (cwd: string, args: string[]) => {
    const proc = Bun.spawn(['git', ...args], {
      cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { exitCode: exitCode ?? -1, stdout, stderr }
  }

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'ab-fake-sandbox-'))
    source = join(tmp, 'source')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'README.md'), 'hello\n')
    provider = new FakeWorkspaceProvider({
      sandboxRoot: join(tmp, 'sandboxes'),
      envSource: { PATH: process.env.PATH ?? '' },
    })
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  const sandbox = async () =>
    provider.orchestratorSandbox.ensure({ repo: source, operator: 'ops', baseBranch: 'main' })

  test('a fresh provision yields a real git checkout hosting the three publish checks', async () => {
    const identity = await sandbox()
    const head = await git(identity.workspacePath, ['rev-parse', 'HEAD'])
    expect(head.exitCode).toBe(0)
    expect(head.stdout.trim()).toMatch(/^[0-9a-f]{40}$/)
    const status = await git(identity.workspacePath, ['status', '--porcelain'])
    expect(status.exitCode).toBe(0)
    // The provisioning marker is excluded in info/exclude, so the checkout
    // is clean for the publish service's untracked-inclusive dirty check.
    expect(status.stdout.trim()).toBe('')
    const base = await git(identity.workspacePath, ['rev-parse', 'refs/heads/main'])
    expect(base.exitCode).toBe(0)
    expect(base.stdout.trim()).toBe(head.stdout.trim())
  })

  test('baseSha is present on the fresh identity and absent on reuse', async () => {
    const fresh = await sandbox()
    expect(fresh.baseSha).toMatch(/^[0-9a-f]{40}$/)
    const reused = await sandbox()
    expect(reused.baseSha).toBeUndefined()
    expect(reused.environmentId).toBe(fresh.environmentId)
  })

  test('a git-repository source provisions with its base-branch head as baseSha', async () => {
    await git(source, ['init', '-q', '-b', 'main'])
    await git(source, ['config', 'user.email', 't@t.invalid'])
    await git(source, ['config', 'user.name', 't'])
    await writeFile(join(source, 'README.md'), 'repo source\n')
    await git(source, ['add', '-A'])
    await git(source, ['commit', '-q', '-m', 'seed'])
    const expected = (await git(source, ['rev-parse', 'refs/heads/main'])).stdout.trim()
    const identity = await sandbox()
    expect(identity.baseSha).toBe(expected)
    expect((await git(identity.workspacePath, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(expected)
  })

  test('reset re-provisions and refreshes baseSha', async () => {
    const first = await sandbox()
    await provider.orchestratorSandbox.release({
      repo: source,
      operator: 'ops',
      environmentId: first.environmentId,
    })
    const second = await sandbox()
    expect(second.baseSha).toMatch(/^[0-9a-f]{40}$/)
  })

  test('every recorded guest environment holds only PATH and forwarded names', async () => {
    const recording = new FakeWorkspaceProvider({
      sandboxRoot: join(tmp, 'sandboxes-fwd'),
      sandboxEnvironmentVariables: ['MY_TOOL_CONFIG'],
      sandboxSetupCommand: 'true',
      envSource: {
        PATH: process.env.PATH ?? '',
        MY_TOOL_CONFIG: 'tool-value',
        AB_TOKEN: 'host-secret',
      },
    })
    await recording.orchestratorSandbox.ensure({
      repo: source,
      operator: 'ops',
      baseBranch: 'main',
    })
    const identity = await recording.orchestratorSandbox.describe({
      repo: source,
      operator: 'ops',
    })
    await recording.orchestratorSandbox.exec(identity, { command: 'true' })
    const { commandId } = await recording.orchestratorSandbox.start(identity, {
      command: 'true',
    })
    await recording.orchestratorSandbox.wait(identity, { commandId, waitSeconds: 0 })
    expect(recording.sandboxExecEnvironments.length).toBeGreaterThanOrEqual(3)
    const ops = new Set(recording.sandboxExecEnvironments.map((entry) => entry.op))
    expect(ops).toEqual(new Set(['exec', 'start', 'setup']))
    for (const entry of recording.sandboxExecEnvironments) {
      expect(Object.keys(entry.env).sort()).toEqual(['MY_TOOL_CONFIG', 'PATH'])
      expect(entry.env.PATH).not.toBe('')
    }
  })

  test('sandboxPublication journals pushes, derives isPublished, ignores ref, fails on injection, refuses the base branch', async () => {
    const identity = await sandbox()
    const sha = (await git(identity.workspacePath, ['rev-parse', 'HEAD'])).stdout.trim()
    const publication = provider.sandboxPublication!
    expect(await publication.isPublished!({ sha, branch: 'ab/orch-ops-abc12345' })).toBe(false)
    await publication.publish({ ref: identity.environmentId, sha, branch: 'ab/orch-ops-abc12345' })
    expect(provider.publications).toEqual([
      { ref: identity.environmentId, sha, branch: 'ab/orch-ops-abc12345' },
    ])
    expect(
      await publication.isPublished!({
        ref: identity.environmentId,
        sha,
        branch: 'ab/orch-ops-abc12345',
      }),
    ).toBe(true)

    provider.setPublicationFailure(new Error('push refused'))
    await expect(
      publication.publish({ ref: identity.environmentId, sha, branch: 'ab/orch-ops-other999' }),
    ).rejects.toThrow('push refused')
    provider.setPublicationFailure(null)

    await expect(
      publication.publish({ ref: identity.environmentId, sha, branch: 'main' }),
    ).rejects.toThrow('base branch')
    expect(provider.publications).toHaveLength(1)
  })
})
