import { temporaryDirectories as ownTempDirectories } from './testing/temp-directories'
import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureRuntimeIdentity } from './runtime-identity'

const mkdtemp = ownTempDirectories(afterEach)

test('source identity is captured once and missing metadata is harmless', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ab-identity-'))
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  try {
    expect(captureRuntimeIdentity(root).commit).toBe('unknown')
    git('init')
    git(
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'first',
    )
    const nested = join(root, 'installed-package')
    await mkdir(nested)
    expect(captureRuntimeIdentity(nested).commit).toBe('unknown')
    const captured = captureRuntimeIdentity(root)
    expect(captured.commit).toBe(git('rev-parse', 'HEAD'))
    git(
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'second',
    )
    const recaptured = captureRuntimeIdentity(root)
    expect(recaptured.version).toBe(captured.version)
    expect(recaptured.commit).not.toBe(captured.commit)
    expect(captured.commit).not.toBe(git('rev-parse', 'HEAD'))
    await rm(join(root, '.git'), { recursive: true, force: true })
    await writeFile(join(root, 'package.json'), JSON.stringify({ gitHead: 'a'.repeat(40) }))
    expect(captureRuntimeIdentity(root).commit).toBe('a'.repeat(40))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('source worktrees and symlinks retain ownership; packages validate gitHead', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ab-identity-paths-'))
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  try {
    git('init')
    git(
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'initial',
    )
    const worktree = join(root, 'worktree')
    git('worktree', 'add', '--detach', worktree)
    expect(captureRuntimeIdentity(worktree).source).toEqual({ kind: 'source', location: worktree })
    const link = join(root, 'link')
    const { symlink } = await import('node:fs/promises')
    await symlink(worktree, link)
    expect(captureRuntimeIdentity(link)).toEqual(captureRuntimeIdentity(worktree))
    const nested = join(root, 'node_modules', 'autobuild')
    await mkdir(nested, { recursive: true })
    for (const gitHead of [undefined, '', 'a'.repeat(41), 'invalid']) {
      await writeFile(join(nested, 'package.json'), JSON.stringify({ gitHead }))
      expect(captureRuntimeIdentity(nested)).toMatchObject({
        commit: 'unknown',
        source: { kind: 'package', location: nested },
      })
    }
    await writeFile(join(nested, 'package.json'), JSON.stringify({ gitHead: 'b'.repeat(40) }))
    expect(captureRuntimeIdentity(nested).commit).toBe('b'.repeat(40))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
