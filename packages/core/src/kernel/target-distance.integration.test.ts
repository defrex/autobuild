import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnExec } from '../ports/workspace/git-worktree'
import { sampleTargetDistance } from './target-distance'

const target = { branch: 'main', sha: 'a'.repeat(40), buildBranch: 'ab/work', exec: spawnExec }

test('real diverged Git history counts target-only commits using local unpublished head', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ab-distance-'))
  const git = async (...args: string[]) => {
    const result = await spawnExec(['git', ...args], { cwd })
    if (result.exitCode) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  try {
    await git('init', '-b', 'main')
    await git('config', 'user.name', 'Test')
    await git('config', 'user.email', 'test@example.test')
    await git('commit', '--allow-empty', '-m', 'base')
    await git('branch', 'ab/work')
    await git('commit', '--allow-empty', '-m', 'target one')
    await git('commit', '--allow-empty', '-m', 'target two')
    const sha = await git('rev-parse', 'main')
    await git('checkout', 'ab/work')
    await git('commit', '--allow-empty', '-m', 'work one')
    const head = await git('rev-parse', 'HEAD')
    const sample = await sampleTargetDistance({ ...target, sha, localPath: cwd, forge: {} })
    expect(sample).toEqual({ branch: 'main', sha, head, count: 2 })
    await git('merge', '--no-edit', 'main')
    expect((await sampleTargetDistance({ ...target, sha, localPath: cwd, forge: {} })).count).toBe(
      0,
    )
    await expect(
      sampleTargetDistance({ ...target, buildBranch: 'missing', sha, localPath: cwd, forge: {} }),
    ).rejects.toThrow()
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
