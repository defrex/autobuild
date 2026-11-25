import { temporaryDirectories as ownTempDirectories } from '../../testing/temp-directories'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeWorkspaceProviderContract } from './contract'
import { FakeWorkspaceProvider } from './fake'

const mkdtemp = ownTempDirectories(afterEach)

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
  // Logical-mode behavior is covered in fake.test.ts; the shared contract
  // above checks the rematerialized directory, fixture and writability.
  test('filesystem reprovision repairs stale active bookkeeping without releasing the branch', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'ab-fake-workspace-recovery-'))
    const repo = join(tmp, 'source')
    const root = join(tmp, 'workspaces')
    await mkdir(repo, { recursive: true })
    await writeFile(join(repo, 'source-fixture.txt'), 'source tree\n')
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

  test('baseSha is present on a fresh identity, absent on reuse, and refreshed after reset', async () => {
    const fresh = await sandbox()
    expect(fresh.baseSha).toMatch(/^[0-9a-f]{40}$/)
    const reused = await sandbox()
    expect(reused.baseSha).toBeUndefined()
    expect(reused.environmentId).toBe(fresh.environmentId)

    await provider.orchestratorSandbox.release({
      repo: source,
      operator: 'ops',
      environmentId: fresh.environmentId,
    })
    const reset = await sandbox()
    expect(reset.baseSha).toMatch(/^[0-9a-f]{40}$/)
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

  test('lifecycle: open settles ready, close keeps the checkout, refresh fast-forwards from a git source (#1223)', async () => {
    await git(source, ['init', '-q', '-b', 'main'])
    await git(source, ['config', 'user.email', 't@t.invalid'])
    await git(source, ['config', 'user.name', 't'])
    await git(source, ['add', '-A'])
    await git(source, ['commit', '-q', '-m', 'seed'])
    const opened = await provider.orchestratorSandbox.open({
      repo: source,
      operator: 'ops',
      baseBranch: 'main',
    })
    expect(opened.status.state).toBe('provisioning')
    const ready = await opened.settled!
    expect(ready.state).toBe('ready')
    const handle = ready.handle!
    expect(
      await provider.orchestratorSandbox.close({
        repo: source,
        operator: 'ops',
        environmentId: handle.environmentId,
      }),
    ).toEqual({ outcome: 'closed' })
    await writeFile(join(source, 'next.txt'), 'next\n')
    await git(source, ['add', '-A'])
    await git(source, ['commit', '-q', '-m', 'advance'])
    const advanced = (await git(source, ['rev-parse', 'refs/heads/main'])).stdout.trim()
    expect(
      await provider.orchestratorSandbox.refresh(handle, { repo: source, baseBranch: 'main' }),
    ).toMatchObject({
      outcome: 'refreshed',
      headSha: advanced,
      baseSha: advanced,
    })
  })

  test('lifecycle: close cancels a hanging setup and removes the copied checkout (#1223)', async () => {
    const hanging = new FakeWorkspaceProvider({
      sandboxRoot: join(tmp, 'sandboxes-hang'),
      sandboxSetupCommand: 'exec sleep 60',
      envSource: { PATH: process.env.PATH ?? '' },
    })
    const opened = await hanging.orchestratorSandbox.open({
      repo: source,
      operator: 'ops',
      baseBranch: 'main',
    })
    const identity = await hanging.orchestratorSandbox.describe({ repo: source, operator: 'ops' })
    for (let i = 0; i < 200 && hanging.sandboxExecEnvironments.length === 0; i++)
      await Bun.sleep(25)
    const started = Date.now()
    const closed = await hanging.orchestratorSandbox.close({
      repo: source,
      operator: 'ops',
      environmentId: identity.environmentId,
    })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(closed.attempt).toEqual({ state: 'absent', cancelled: true })
    expect(await opened.settled!).toEqual({ state: 'absent', cancelled: true })
    expect(await Bun.file(join(identity.workspacePath, 'README.md')).exists()).toBe(false)
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
