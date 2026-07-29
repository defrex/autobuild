import { expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseConfig } from '../config/load'
import { DISPATCHER, KERNEL, humanActor } from '../events/envelope'
import { sequentialIds } from '../ids'
import { reduceBuild } from '../kernel/reducer'
import { FakeForge } from '../ports/forge/fake'
import { FakeTicketSource } from '../ports/tickets/fake'
import { GitWorktreeProvider, spawnExec } from '../ports/workspace/git-worktree'
import { Dispatcher } from '../processes/dispatcher'
import { MemoryBuildStore } from '../store/memory'
import { manualClock } from '../testing/fixed'

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await spawnExec(['git', ...args], { cwd })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

test('abort cleanup removes a real worktree and exact local/remote refs while preserving merged PR state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ab-abort-integration-'))
  const repo = join(root, 'repo')
  const remote = join(root, 'remote.git')
  const worktreeRoot = join(root, 'worktrees')
  const branch = 'ab/abort-real-git'
  const slug = 'abort-real-git'
  try {
    await Bun.$`git init -b main ${repo}`.quiet()
    await git(repo, 'config', 'user.name', 'Autobuild Test')
    await git(repo, 'config', 'user.email', 'autobuild@example.invalid')
    await Bun.write(join(repo, 'README.md'), 'base\n')
    await git(repo, 'add', 'README.md')
    await git(repo, 'commit', '-m', 'base')
    await Bun.$`git init --bare ${remote}`.quiet()
    await git(repo, 'remote', 'add', 'origin', remote)
    await git(repo, 'push', '-u', 'origin', 'main')

    const workspaces = new GitWorktreeProvider({ root: worktreeRoot })
    const workspace = await workspaces.provision({ repo, baseBranch: 'main', branch })
    await Bun.write(join(workspace.path, 'change.txt'), 'abort me\n')
    await git(workspace.path, 'add', 'change.txt')
    await git(workspace.path, 'commit', '-m', 'build work')
    await git(workspace.path, 'push', '-u', 'origin', `HEAD:refs/heads/${branch}`)

    const clock = manualClock()
    const store = new MemoryBuildStore({ clock })
    const ticket = {
      ref: { source: 'fake', id: 'T-real-abort', title: 'Real abort cleanup' },
      title: 'Real abort cleanup',
      body: '## Acceptance criteria\n- clean up\n\n## Out of scope\n- other refs',
      state: 'In Progress',
      labels: ['keep'],
    }
    const tickets = new FakeTicketSource([ticket])
    const forge = new FakeForge()
    forge.deleteBranch = async (workspacePath, exactBranch) => {
      await git(workspacePath, 'check-ref-format', `refs/heads/${exactBranch}`)
      const probe = await spawnExec(
        ['git', 'ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${exactBranch}`],
        { cwd: workspacePath },
      )
      if (probe.exitCode === 2) return
      if (probe.exitCode !== 0) throw new Error(probe.stderr || probe.stdout)
      await git(workspacePath, 'push', 'origin', '--delete', exactBranch)
    }

    await store.createBuild({ slug, repo, ticket: ticket.ref, branch })
    await store.append(slug, {
      actor: DISPATCHER,
      type: 'build.created',
      payload: { ticket: ticket.ref, repo, baseBranch: 'main' },
    })
    await store.append(slug, {
      actor: DISPATCHER,
      type: 'workspace.provisioned',
      payload: {
        provider: workspace.provider,
        ref: workspace.ref,
        path: workspace.path,
        branch,
        base: workspace.base,
      },
    })
    await store.append(slug, {
      actor: DISPATCHER,
      type: 'spec.imported',
      payload: { artifact: { kind: 'spec', rev: 0 }, ticket: ticket.ref },
    })
    await store.append(slug, {
      actor: KERNEL,
      type: 'runner.attached',
      payload: { instance: 'runner', host: 'integration' },
    })
    await store.append(slug, {
      actor: KERNEL,
      type: 'finalize.completed',
      payload: {
        pr: { number: 1, url: 'fake://pr/1', headSha: await git(repo, 'rev-parse', branch) },
      },
    })
    forge.setPrState(1, { state: 'merged', sha: 'merged-sha-preserved' })
    await store.append(slug, {
      actor: humanActor('integration-operator'),
      type: 'build.abort-requested',
      payload: { reason: 'stop after merge race' },
    })
    await store.append(slug, { actor: KERNEL, type: 'build.aborted', payload: {} })

    const dispatcher = new Dispatcher({
      store,
      tickets,
      workspaces,
      forge,
      config: parseConfig('[tickets]\nsource = "file"\nreadyState = "Ready"\n'),
      repo,
      exec: spawnExec,
      launchRunner: async () => 'scheduled',
      ids: sequentialIds(),
      clock,
    })
    const report = await dispatcher.tick()
    expect(report.abandoned).toBe(1)
    expect(report.janitorFailed).toBe(0)

    expect(await exists(workspace.path)).toBe(false)
    expect(
      (await spawnExec(['git', 'show-ref', '--verify', `refs/heads/${branch}`], { cwd: repo }))
        .exitCode,
    ).not.toBe(0)
    expect(await git(repo, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`)).toBe('')
    const events = await store.getEvents(slug)
    expect(events.find((event) => event.type === 'pr.merged')?.payload).toEqual({
      sha: 'merged-sha-preserved',
    })
    expect(reduceBuild(events)).toMatchObject({ status: 'done', outcome: 'abandoned' })
    await expect(forge.getPrState(repo, 1)).resolves.toEqual({
      state: 'merged',
      sha: 'merged-sha-preserved',
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
