import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeForgeContract, type ForgeContractFactory } from './contract'
import { bunExec } from './github'
import { LocalGitForge } from './local-git'

const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr}`)
  return stdout.trim()
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ab-local-forge-test-'))
  roots.push(root)
  await git(root, 'init', '-b', 'main')
  await git(root, 'config', 'user.name', 'Autobuild Test')
  await git(root, 'config', 'user.email', 'autobuild@example.test')
  await writeFile(join(root, 'shared.txt'), 'base\n')
  await git(root, 'add', 'shared.txt')
  await git(root, 'commit', '-m', 'initial')
  const head = `ab/contract-${crypto.randomUUID()}`
  const workspace = `${root}-build`
  roots.push(workspace)
  await git(root, 'worktree', 'add', '-b', head, workspace, 'main')
  await writeFile(join(workspace, 'feature.txt'), 'feature\n')
  await git(workspace, 'add', 'feature.txt')
  await git(workspace, 'commit', '-m', 'feature')
  return { root, workspace, head, forge: new LocalGitForge() }
}

const localContractFactory: ForgeContractFactory = async () => {
  const f = await fixture()
  return {
    forge: f.forge,
    nativeAutoMerge: false,
    workspacePath: f.workspace,
    head: f.head,
    base: 'main',
    title: `Local contract ${crypto.randomUUID()}`,
    body: 'Offline local forge contract body',
    controls: {
      remoteHead: async (branch) => git(f.workspace, 'rev-parse', `refs/heads/${branch}`),
      prepareMergeable: async () => {},
      closePr: async () => {
        await git(f.root, 'update-ref', '-d', `refs/heads/${f.head}`)
      },
      makeConflict: async () => {
        await writeFile(join(f.workspace, 'shared.txt'), 'feature conflict\n')
        await git(f.workspace, 'add', 'shared.txt')
        await git(f.workspace, 'commit', '-m', 'feature conflict')
        await writeFile(join(f.root, 'shared.txt'), 'base conflict\n')
        await git(f.root, 'add', 'shared.txt')
        await git(f.root, 'commit', '-m', 'base conflict')
      },
      advanceHead: async () => {
        await writeFile(join(f.workspace, `advance-${crypto.randomUUID()}.txt`), 'advanced\n')
        await git(f.workspace, 'add', '.')
        await git(f.workspace, 'commit', '-m', 'advance head')
        return git(f.workspace, 'rev-parse', 'HEAD')
      },
      nativeAutoMergeEnabled: async () => false,
      commentExists: async (number, body) => {
        const blob = await git(f.root, 'rev-parse', `refs/autobuild/local-git/prs/${number}`)
        const source = await git(f.root, 'cat-file', 'blob', blob)
        return (JSON.parse(source) as { comments: string[] }).comments.includes(body)
      },
      mergeSha: async () => git(f.root, 'rev-parse', 'main'),
      trackPr: () => {},
    },
    cleanup: async () => {
      await rm(f.workspace, { recursive: true, force: true })
      await rm(f.root, { recursive: true, force: true })
    },
  }
}

describeForgeContract('LocalGitForge', localContractFactory)

describe('LocalGitForge', () => {
  test('persists records across instances, snapshots local base, and lands exact squash content', async () => {
    const f = await fixture()
    const description = '# Local landing\n\nExact body for the squash commit.\n'
    await f.forge.pushBranch(f.workspace, f.head)
    const pr = await f.forge.openPr({
      workspacePath: f.workspace,
      head: f.head,
      base: 'main',
      title: 'Local landing',
      body: 'Exact body for the squash commit.',
      mergeMessage: description,
    })
    expect(pr.url).toBe(`refs/heads/${f.head}`)
    expect(await git(f.root, 'remote', '-v')).toBe('')

    const fresh = new LocalGitForge()
    expect(
      await fresh.openPr({
        workspacePath: f.root,
        head: f.head,
        base: 'main',
        title: 'retry',
        body: 'retry',
      }),
    ).toEqual(pr)

    const snapshot = await fresh.snapshotBase({
      workspacePath: f.workspace,
      base: 'main',
      destinationRef: 'refs/autobuild/test/base',
    })
    expect(await git(f.root, 'rev-parse', 'refs/autobuild/test/base')).toBe(snapshot)

    const candidate = await fresh.setAutoMerge(f.workspace, pr.number, true)
    expect(candidate).toEqual({ kind: 'ungated', headSha: pr.headSha })
    await fresh.squashMerge(f.workspace, pr.number, pr.headSha)
    const landed = await git(f.root, 'rev-parse', 'main')
    expect(await fresh.getPrState(f.root, pr.number)).toEqual({ state: 'merged', sha: landed })
    expect(await git(f.root, 'show', '-s', '--format=%P', landed)).toBe(snapshot)
    expect(await git(f.root, 'show', '-s', '--format=%B', landed)).toBe(description.trimEnd())
    expect(await git(f.root, 'status', '--porcelain')).toBe('')
    expect(await git(f.root, 'rev-parse', `refs/heads/${f.head}`)).toBe(pr.headSha)
  })

  test('compatible base advances remain mergeable and conflicting advances do not', async () => {
    const compatible = await fixture()
    const pr = await compatible.forge.openPr({
      workspacePath: compatible.workspace,
      head: compatible.head,
      base: 'main',
      title: 'compatible',
      body: '',
    })
    await writeFile(join(compatible.root, 'base-only.txt'), 'base advance\n')
    await git(compatible.root, 'add', '.')
    await git(compatible.root, 'commit', '-m', 'compatible base advance')
    expect(await compatible.forge.getPrState(compatible.root, pr.number)).toEqual({
      state: 'open',
      mergeable: true,
    })

    const conflict = await fixture()
    await writeFile(join(conflict.workspace, 'shared.txt'), 'head\n')
    await git(conflict.workspace, 'add', '.')
    await git(conflict.workspace, 'commit', '-m', 'head side')
    const conflictPr = await conflict.forge.openPr({
      workspacePath: conflict.workspace,
      head: conflict.head,
      base: 'main',
      title: 'conflict',
      body: '',
    })
    await writeFile(join(conflict.root, 'shared.txt'), 'base\nchanged\n')
    await git(conflict.root, 'add', '.')
    await git(conflict.root, 'commit', '-m', 'base side')
    expect(await conflict.forge.getPrState(conflict.root, conflictPr.number)).toEqual({
      state: 'open',
      mergeable: false,
    })
  })

  test('a later observation repairs a crash after moving a checked-out base ref', async () => {
    const f = await fixture()
    const pr = await f.forge.openPr({
      workspacePath: f.workspace,
      head: f.head,
      base: 'main',
      title: 'crash repair',
      body: '',
    })
    let failReset = true
    const crashing = new LocalGitForge({
      exec: async (cmd, opts) => {
        if (failReset && cmd[0] === 'git' && cmd[1] === 'reset') {
          failReset = false
          return { stdout: '', stderr: 'simulated crash boundary', exitCode: 1 }
        }
        return bunExec(cmd, opts)
      },
    })
    await expect(crashing.squashMerge(f.workspace, pr.number, pr.headSha)).rejects.toThrow(
      'simulated crash boundary',
    )
    expect(await git(f.root, 'status', '--porcelain')).not.toBe('')

    const state = await new LocalGitForge().getPrState(f.root, pr.number)
    expect(state.state).toBe('merged')
    expect(await git(f.root, 'status', '--porcelain')).toBe('')
  })

  test('refuses a dirty checked-out base without moving it', async () => {
    const f = await fixture()
    const pr = await f.forge.openPr({
      workspacePath: f.workspace,
      head: f.head,
      base: 'main',
      title: 'dirty guard',
      body: '',
    })
    const before = await git(f.root, 'rev-parse', 'main')
    await writeFile(join(f.root, 'dirty.txt'), 'operator work\n')
    await expect(f.forge.squashMerge(f.workspace, pr.number, pr.headSha)).rejects.toThrow('dirty')
    expect(await git(f.root, 'rev-parse', 'main')).toBe(before)
  })
})
