import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Exec } from '../ports/workspace/git-worktree'
import { spawnExec } from '../ports/workspace/git-worktree'
import { resolveMainRepo, resolveRepoState, resolveRepoStatePaths } from './repo-state'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await spawnExec(['git', ...args], { cwd })
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout)
}

describe('resolveMainRepo', () => {
  test('uses the top level when the Git and common directories are equal', async () => {
    const exec: Exec = async (cmd, opts) => {
      expect(cmd).toEqual([
        'git',
        'rev-parse',
        '--path-format=absolute',
        '--git-dir',
        '--git-common-dir',
        '--show-toplevel',
      ])
      expect(opts.cwd).toBe('/worktree')
      return {
        stdout: '/main/repo/.git\n/main/repo/.git\n/main/repo\n',
        stderr: '',
        exitCode: 0,
      }
    }
    expect(await resolveMainRepo('/worktree', exec)).toBe('/main/repo')
  })

  test('falls back to the resolved target when Git is unavailable', async () => {
    const exec: Exec = async () => {
      throw new Error('git unavailable')
    }
    expect(await resolveMainRepo('./plain-directory', exec)).toBe(resolve('./plain-directory'))
  })

  test('returns the main checkout from both a checkout and a linked worktree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ab-repo-state-'))
    cleanup.push(root)
    const main = join(root, 'main')
    const linked = join(root, 'linked')
    await git(root, 'init', '-b', 'main', main)
    await git(main, 'config', 'user.email', 'test@example.com')
    await git(main, 'config', 'user.name', 'Test')
    await Bun.write(join(main, 'README.md'), 'fixture\n')
    await git(main, 'add', 'README.md')
    await git(main, 'commit', '-m', 'fixture')
    await git(main, 'worktree', 'add', '-b', 'linked', linked)

    const canonicalMain = await realpath(main)
    expect(await resolveMainRepo(main, spawnExec)).toBe(canonicalMain)
    expect(await resolveMainRepo(linked, spawnExec)).toBe(canonicalMain)
  })

  test('keeps sibling submodule checkouts as distinct repository roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ab-repo-state-submodule-'))
    cleanup.push(root)
    const child = join(root, 'child-origin')
    const parent = join(root, 'parent')

    await git(root, 'init', '-b', 'main', child)
    await git(child, 'config', 'user.email', 'test@example.com')
    await git(child, 'config', 'user.name', 'Test')
    await Bun.write(join(child, 'README.md'), 'child\n')
    await git(child, 'add', 'README.md')
    await git(child, 'commit', '-m', 'child fixture')

    await git(root, 'init', '-b', 'main', parent)
    await git(parent, 'config', 'user.email', 'test@example.com')
    await git(parent, 'config', 'user.name', 'Test')
    await Bun.write(join(parent, 'README.md'), 'parent\n')
    await git(parent, 'add', 'README.md')
    await git(parent, 'commit', '-m', 'parent fixture')
    await git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'sub-a')
    await git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'sub-b')

    const subA = await realpath(join(parent, 'sub-a'))
    const subB = await realpath(join(parent, 'sub-b'))
    expect(await resolveMainRepo(subA, spawnExec)).toBe(subA)
    expect(await resolveMainRepo(subB, spawnExec)).toBe(subB)
    expect(subA).not.toBe(subB)
  })
})

describe('resolveRepoStatePaths', () => {
  const repo = '/code/example'

  test('defaults every local path beneath the repository state root', () => {
    expect(resolveRepoStatePaths({ repo })).toEqual({
      repo,
      defaultLocalRoot: '/code/example/.autobuild',
      storeRef: '/code/example/.autobuild',
      localStateRoot: '/code/example/.autobuild',
      worktreeRoot: '/code/example/.autobuild/worktrees',
    })
  })

  test('normalizes relative and absolute local overrides and moves worktrees', () => {
    expect(resolveRepoStatePaths({ repo, storeRef: 'state/../state' })).toMatchObject({
      storeRef: '/code/example/state',
      worktreeRoot: '/code/example/state/worktrees',
    })
    expect(resolveRepoStatePaths({ repo, storeRef: '/var/lib/ab' })).toMatchObject({
      storeRef: '/var/lib/ab',
      worktreeRoot: '/var/lib/ab/worktrees',
    })
  })

  test('preserves remote URLs and keeps their worktrees repository-local', () => {
    expect(resolveRepoStatePaths({ repo, storeRef: 'https://store.example/api' })).toMatchObject({
      storeRef: 'https://store.example/api',
      worktreeRoot: '/code/example/.autobuild/worktrees',
    })
  })

  test('uses nonblank flag over environment over default', () => {
    expect(
      resolveRepoStatePaths({ repo, storeRef: 'flag', envStore: 'environment' }).storeRef,
    ).toBe('/code/example/flag')
    expect(resolveRepoStatePaths({ repo, envStore: 'environment' }).storeRef).toBe(
      '/code/example/environment',
    )
    expect(resolveRepoStatePaths({ repo, storeRef: '', envStore: 'environment' }).storeRef).toBe(
      '/code/example/environment',
    )
    expect(resolveRepoStatePaths({ repo, storeRef: '  ', envStore: '' })).toMatchObject({
      storeRef: '/code/example/.autobuild',
      localStateRoot: '/code/example/.autobuild',
      worktreeRoot: '/code/example/.autobuild/worktrees',
    })
  })
})

test('resolveRepoState selects paths after resolving repository identity', async () => {
  const exec: Exec = async (cmd) =>
    cmd[1] === 'rev-parse'
      ? {
          stdout: '/main/repo/.git/worktrees/linked\n/main/repo/.git\n/linked\n',
          stderr: '',
          exitCode: 0,
        }
      : {
          stdout: 'worktree /main/repo\0HEAD abc\0branch refs/heads/main\0\0',
          stderr: '',
          exitCode: 0,
        }
  expect(
    await resolveRepoState({
      targetRepo: '/linked',
      exec,
      envStore: 'shared-state',
    }),
  ).toMatchObject({
    repo: '/main/repo',
    storeRef: '/main/repo/shared-state',
    worktreeRoot: '/main/repo/shared-state/worktrees',
  })
})
