import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnExec } from './git-worktree'
import { reconcileScratchViolations, scratchPathsTouchedInRange } from './phase-scratch'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(root: string, ...args: string[]): Promise<string> {
  const result = await spawnExec(['git', ...args], { cwd: root })
  if (result.exitCode !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ab-phase-scratch-'))
  roots.push(root)
  await git(root, 'init', '-q')
  await git(root, 'config', 'user.name', 'Test')
  await git(root, 'config', 'user.email', 'test@example.com')
  await writeFile(join(root, 'file.txt'), 'base\n')
  await git(root, 'add', 'file.txt')
  await git(root, 'commit', '-qm', 'base')
  return root
}

describe('phase scratch publication policy', () => {
  test('range collection retains a scratch change reverted by a later commit', async () => {
    const root = await repo()
    const base = await git(root, 'rev-parse', 'HEAD')
    await mkdir(join(root, '.ab'))
    await writeFile(join(root, '.ab/notes.md'), 'leak\n')
    await git(root, 'add', '-f', '.ab/notes.md')
    await git(root, 'commit', '-qm', 'leak')
    await git(root, 'rm', '-q', '.ab/notes.md')
    await git(root, 'commit', '-qm', 'revert leak')

    expect(await scratchPathsTouchedInRange(spawnExec, root, base, 'HEAD')).toEqual([
      '.ab/notes.md',
    ])
  })

  test('reconcile rejects only results different from every parent', async () => {
    const root = await repo()
    await mkdir(join(root, '.ab'))
    await writeFile(join(root, '.ab/notes.md'), 'ours\n')
    await git(root, 'add', '-f', '.ab/notes.md')
    await git(root, 'commit', '-qm', 'ours')
    const ours = await git(root, 'rev-parse', 'HEAD')
    await git(root, 'checkout', '-qb', 'other', 'HEAD~1')
    await mkdir(join(root, '.ab'))
    await writeFile(join(root, '.ab/notes.md'), 'theirs\n')
    await git(root, 'add', '-f', '.ab/notes.md')
    await git(root, 'commit', '-qm', 'theirs')
    const theirs = await git(root, 'rev-parse', 'HEAD')

    await git(root, 'checkout', '-q', '--detach', ours)
    await git(root, 'merge', '--no-commit', theirs).catch(() => '')
    await writeFile(join(root, '.ab/notes.md'), 'authored\n')
    await git(root, 'add', '.ab/notes.md')
    await git(root, 'commit', '-qm', 'merge authored')
    expect(await reconcileScratchViolations(spawnExec, root, 'HEAD', [ours, theirs])).toEqual([
      '.ab/notes.md',
    ])

    await git(root, 'checkout', '-q', '--detach', ours)
    await git(root, 'merge', '--no-commit', theirs).catch(() => '')
    await writeFile(join(root, '.ab/notes.md'), 'theirs\n')
    await git(root, 'add', '.ab/notes.md')
    await git(root, 'commit', '-qm', 'merge inherited')
    expect(await reconcileScratchViolations(spawnExec, root, 'HEAD', [ours, theirs])).toEqual([])
  })
})
