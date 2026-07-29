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

  test('lands over non-overlapping tracked, staged, and untracked work without cleaning it', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'index-only.txt'), 'index base\n')
    await git(f.root, 'add', 'index-only.txt')
    await git(f.root, 'commit', '-m', 'advance base with index-only path')
    const pr = await f.forge.openPr({
      workspacePath: f.workspace,
      head: f.head,
      base: 'main',
      title: 'carry operator work',
      body: '',
    })
    await writeFile(join(f.root, 'shared.txt'), 'operator edit\n')
    await writeFile(join(f.root, 'index-only.txt'), 'staged operator edit\n')
    await git(f.root, 'add', 'index-only.txt')
    await writeFile(join(f.root, 'scratch.txt'), 'operator scratch\n')

    expect(await f.forge.setAutoMerge(f.workspace, pr.number, true)).toEqual({
      kind: 'ungated',
      headSha: pr.headSha,
    })
    await f.forge.squashMerge(f.workspace, pr.number, pr.headSha)
    const landed = await git(f.root, 'rev-parse', 'main')
    expect(await f.forge.getPrState(f.root, pr.number)).toEqual({ state: 'merged', sha: landed })
    expect(await Bun.file(join(f.root, 'shared.txt')).text()).toBe('operator edit\n')
    expect(await Bun.file(join(f.root, 'index-only.txt')).text()).toBe('staged operator edit\n')
    expect(await Bun.file(join(f.root, 'scratch.txt')).text()).toBe('operator scratch\n')
    expect(await git(f.root, 'status', '--porcelain')).toContain('M shared.txt')
    expect(await git(f.root, 'status', '--porcelain')).toContain('M  index-only.txt')
    expect(await git(f.root, 'status', '--porcelain')).toContain('?? scratch.txt')
    expect(await git(f.root, 'diff', '--cached', '--', 'index-only.txt')).toContain(
      'staged operator edit',
    )
    expect(await git(f.root, 'diff', '--cached', '--', 'feature.txt')).toBe('')
    expect(await git(f.root, 'diff', '--', 'feature.txt')).toBe('')
    expect(await Bun.file(join(f.root, 'feature.txt')).text()).toBe('feature\n')
  })

  test('tracked and untracked landing collisions defer with a path and retry after cleanup', async () => {
    for (const collision of ['tracked', 'untracked'] as const) {
      const f = await fixture()
      if (collision === 'tracked') {
        await writeFile(join(f.workspace, 'shared.txt'), 'landed shared\n')
        await git(f.workspace, 'add', 'shared.txt')
      } else {
        await writeFile(join(f.workspace, 'added.txt'), 'landed add\n')
        await git(f.workspace, 'add', 'added.txt')
      }
      await git(f.workspace, 'commit', '-m', `${collision} collision landing`)
      const pr = await f.forge.openPr({
        workspacePath: f.workspace,
        head: f.head,
        base: 'main',
        title: `${collision} collision`,
        body: '',
      })
      const before = await git(f.root, 'rev-parse', 'main')
      const path = collision === 'tracked' ? 'shared.txt' : 'added.txt'
      await writeFile(join(f.root, path), 'operator work\n')

      const first = await f.forge.setAutoMerge(f.workspace, pr.number, true)
      expect(first.kind).toBe('deferred')
      if (first.kind !== 'deferred') throw new Error('expected checkout deferral')
      expect(first.reason).toMatchObject({ code: 'local-base-checkout-dirty' })
      expect(first.reason?.detail).toContain(path)
      expect(await f.forge.setAutoMerge(f.workspace, pr.number, true)).toEqual(first)
      expect(await git(f.root, 'rev-parse', 'main')).toBe(before)
      expect(await Bun.file(join(f.root, path)).text()).toBe('operator work\n')

      if (collision === 'tracked') await git(f.root, 'checkout', '--', path)
      else await rm(join(f.root, path))
      const candidate = await f.forge.setAutoMerge(f.workspace, pr.number, true)
      expect(candidate).toEqual({ kind: 'ungated', headSha: pr.headSha })
      await f.forge.squashMerge(f.workspace, pr.number, pr.headSha)
      const landed = await git(f.root, 'rev-parse', 'main')
      expect(await f.forge.getPrState(f.root, pr.number)).toEqual({ state: 'merged', sha: landed })
      expect(await Bun.file(join(f.root, path)).text()).toBe(
        collision === 'tracked' ? 'landed shared\n' : 'landed add\n',
      )
      expect(await git(f.root, 'show', '-s', '--format=%P', landed)).toBe(before)
      expect(await git(f.root, 'rev-list', '--count', `${before}..main`)).toBe('1')
    }
  })

  test('a later observation repairs the post-ref crash window while preserving unrelated dirt', async () => {
    const f = await fixture()
    const pr = await f.forge.openPr({
      workspacePath: f.workspace,
      head: f.head,
      base: 'main',
      title: 'crash repair',
      body: '',
    })
    await writeFile(join(f.root, 'shared.txt'), 'operator edit\n')
    let failUpdate = true
    const crashing = new LocalGitForge({
      exec: async (cmd, opts) => {
        if (failUpdate && cmd[0] === 'git' && cmd[1] === 'read-tree' && !cmd.includes('-n')) {
          failUpdate = false
          return { stdout: '', stderr: 'simulated crash boundary', exitCode: 1 }
        }
        return bunExec(cmd, opts)
      },
    })
    await crashing.squashMerge(f.workspace, pr.number, pr.headSha)
    expect(await git(f.root, 'status', '--porcelain')).toContain('shared.txt')

    const state = await new LocalGitForge().getPrState(f.root, pr.number)
    expect(state.state).toBe('merged')
    expect(await Bun.file(join(f.root, 'shared.txt')).text()).toBe('operator edit\n')
    expect(await Bun.file(join(f.root, 'feature.txt')).text()).toBe('feature\n')
  })

  test('post-ref repair waits on a new collision and setAutoMerge reports the recorded transition', async () => {
    const f = await fixture()
    const pr = await f.forge.openPr({
      workspacePath: f.workspace,
      head: f.head,
      base: 'main',
      title: 'blocked crash repair',
      body: '',
    })
    let injectCollision = true
    const racing = new LocalGitForge({
      exec: async (cmd, opts) => {
        if (injectCollision && cmd[0] === 'git' && cmd[1] === 'read-tree' && !cmd.includes('-n')) {
          injectCollision = false
          await writeFile(join(f.root, 'feature.txt'), 'operator collision\n')
        }
        return bunExec(cmd, opts)
      },
    })
    await racing.squashMerge(f.workspace, pr.number, pr.headSha)

    expect(await racing.getPrState(f.root, pr.number)).toEqual({ state: 'open', mergeable: true })
    const deferred = await racing.setAutoMerge(f.root, pr.number, true)
    expect(deferred.kind).toBe('deferred')
    if (deferred.kind !== 'deferred') throw new Error('expected checkout deferral')
    expect(deferred.reason?.detail).toContain('feature.txt')
    expect(await Bun.file(join(f.root, 'feature.txt')).text()).toBe('operator collision\n')

    await rm(join(f.root, 'feature.txt'))
    const landed = await git(f.root, 'rev-parse', 'main')
    expect(await racing.getPrState(f.root, pr.number)).toEqual({ state: 'merged', sha: landed })
    expect(await Bun.file(join(f.root, 'feature.txt')).text()).toBe('feature\n')
  })
})
