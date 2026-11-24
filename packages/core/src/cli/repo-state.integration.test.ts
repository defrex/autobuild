import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Exec } from '../ports/workspace/git-worktree'
import { spawnExec } from '../ports/workspace/git-worktree'
import { resolveMainRepo, resolveRepoState } from './repo-state'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await spawnExec(['git', ...args], { cwd })
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout)
}

describe('resolveMainRepo', () => {
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

test('resolveRepoState selects paths after resolving repository identity', async () => {
  const exec: Exec = async (cmd) => {
    if (cmd[1] === 'rev-parse') {
      return {
        stdout: '/main/repo/.git/worktrees/linked\n/main/repo/.git\n/linked\n',
        stderr: '',
        exitCode: 0,
      }
    }
    if (cmd[1] === 'worktree') {
      return {
        stdout: 'worktree /main/repo\0HEAD abc\0branch refs/heads/main\0\0',
        stderr: '',
        exitCode: 0,
      }
    }
    expect(cmd).toEqual(['git', 'remote', 'get-url', 'origin'])
    return { stdout: 'git@github.com:acme/app.git\n', stderr: '', exitCode: 0 }
  }
  const state = await resolveRepoState({
    targetRepo: '/linked',
    exec,
    envStore: 'shared-state',
  })
  expect(state).toMatchObject({
    // Identity is the normalized origin, not the checkout path.
    repo: 'https://github.com/acme/app',
    checkout: '/main/repo',
    storeRef: '/main/repo/shared-state',
    worktreeRoot: '/main/repo/shared-state/worktrees',
  })
})

test('resolveRepoState falls back to the resolved checkout path when the checkout has no origin', async () => {
  const exec: Exec = async (cmd) => {
    if (cmd[1] === 'rev-parse') {
      return {
        stdout: '/main/repo/.git\n/main/repo/.git\n/main/repo\n',
        stderr: '',
        exitCode: 0,
      }
    }
    // `git remote get-url origin` fails: no origin remote.
    return { stdout: '', stderr: "error: No such remote 'origin'\n", exitCode: 2 }
  }
  const state = await resolveRepoState({ targetRepo: '/main/repo', exec })
  expect(state.repo).toBe('/main/repo')
  expect(state.checkout).toBe('/main/repo')
})

test('resolveRepoState resolves one identity for two checkouts of one repository', async () => {
  const origins: Record<string, string> = {
    '/host/checkout': 'git@github.com:acme/app.git\n',
    '/guest/checkout': 'https://github.com/acme/app\n',
  }
  const exec: Exec = async (cmd, opts) => {
    if (cmd[1] === 'rev-parse') {
      const cwd = opts.cwd
      return { stdout: `${cwd}/.git\n${cwd}/.git\n${cwd}\n`, stderr: '', exitCode: 0 }
    }
    const origin: string | undefined = origins[opts.cwd ?? '']
    return {
      stdout: origin ?? '',
      stderr: '',
      exitCode: origin !== undefined ? 0 : 2,
    }
  }
  const host = await resolveRepoState({ targetRepo: '/host/checkout', exec })
  const guest = await resolveRepoState({ targetRepo: '/guest/checkout', exec })
  expect(host.repo).toBe('https://github.com/acme/app')
  expect(guest.repo).toBe('https://github.com/acme/app')
  expect(host.checkout).toBe('/host/checkout')
  expect(guest.checkout).toBe('/guest/checkout')
})
