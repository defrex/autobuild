import { afterEach, describe, expect, test } from 'bun:test'
import { readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { KERNEL } from '../events/envelope'
import { type Exec, spawnExec } from '../ports/workspace/git-worktree'
import { sampleBuildInput } from '../store/contract'
import { MemoryBuildStore } from '../store/memory'
import { readBuildFacts } from '../store/reduced-reads'
import { temporaryDirectories } from '../testing/temp-directories'
import {
  computeChangedPaths,
  computeResolutionPaths,
  HEAD_PATHS_PREVIEW,
  headPathsFor,
  readHeadPaths,
  recordHeadPaths,
} from './head-paths'

const temporary = temporaryDirectories(afterEach)

/** A scratch repository. `env` reaches every git process the fixture and the
 * returned `exec` start, overriding the runner's git config isolation. */
async function repository(env: Record<string, string> = {}) {
  const cwd = await temporary(join(tmpdir(), 'head-paths-'))
  const exec: Exec = (cmd, opts) => spawnExec(cmd, { ...opts, env: { ...opts.env, ...env } })
  const git = async (...args: string[]) => {
    const result = await exec(['git', ...args], { cwd })
    if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
    return result.stdout.trim()
  }
  const write = (path: string, content: string) => Bun.write(join(cwd, path), content)
  const commit = async (message: string) => {
    await git('add', '-A')
    await git('commit', '-q', '--allow-empty', '-m', message)
    return git('rev-parse', 'HEAD')
  }
  await git('init', '-q', '-b', 'main')
  await git('config', 'user.name', 'Test')
  await git('config', 'user.email', 'test@example.com')
  await git('config', 'commit.gpgsign', 'false')
  return { cwd, exec, git, write, commit }
}

describe('changed paths against real git', () => {
  test('renames count both paths, deletions count, destination-only changes do not', async () => {
    const { cwd, git, write, commit } = await repository()
    await write('a.txt', '1\n')
    await write('old.txt', 'rename me\n')
    await write('gone.txt', 'delete me\n')
    const base = await commit('base')
    await git('checkout', '-q', '-b', 'feature')
    await write('a.txt', '2\n')
    await git('mv', 'old.txt', 'new.txt')
    await git('rm', '-q', 'gone.txt')
    const head = await commit('feature')
    await git('checkout', '-q', 'main')
    await write('dest-only.txt', 'moved on\n')
    const destination = await commit('destination moves on')

    expect(await computeChangedPaths(spawnExec, cwd, { head, destination })).toEqual({
      mergeBase: base,
      paths: ['a.txt', 'gone.txt', 'new.txt', 'old.txt'],
    })
  })

  test('a head beyond the preview keeps every path in the artifact', async () => {
    const { cwd, git, write, commit } = await repository()
    await write('seed.txt', 'seed\n')
    const destination = await commit('base')
    await git('checkout', '-q', '-b', 'feature')
    const paths = Array.from({ length: 1001 }, (_, i) => `files/f${String(i).padStart(4, '0')}`)
    for (const path of paths) await write(path, `${path}\n`)
    const head = await commit('many files')

    const store = new MemoryBuildStore()
    await store.createBuild(sampleBuildInput('b'))
    await recordHeadPaths(
      { store, slug: 'b', exec: spawnExec, workspacePath: cwd, actor: KERNEL },
      { source: 'finalize', head, destination },
    )
    const answer = headPathsFor((await readBuildFacts(store, 'b')).value.state, head)
    if (!answer.recorded) throw new Error('expected a record')
    expect(answer.record.total).toBe(1001)
    expect(answer.record.preview).toHaveLength(HEAD_PATHS_PREVIEW)
    expect(answer.record.mergeBase).toBe(destination)
    expect((await readHeadPaths(store, 'b', answer.record)).paths).toEqual(paths)
  })
})

/** The finding's example: the change edits a and d; the destination edits a
 * (conflict) and b (arrives cleanly); the resolver settles a and also edits c. */
async function conflictedReplay(env?: Record<string, string>) {
  const repo = await repository(env)
  const { git, write, commit } = repo
  for (const name of ['a', 'b', 'c', 'd']) await write(`${name}.txt`, '1\n')
  const base = await commit('base')
  await git('checkout', '-q', '-b', 'change')
  await write('a.txt', 'change\n')
  await write('d.txt', 'change\n')
  const change = await commit('change')
  await git('checkout', '-q', 'main')
  await write('a.txt', 'destination\n')
  await write('b.txt', 'destination\n')
  const onto = await commit('destination')
  await git('checkout', '-q', '--detach', onto)
  await repo.exec(['git', 'cherry-pick', change], { cwd: repo.cwd })
  await write('a.txt', 'resolved\n')
  await write('c.txt', 'extra\n')
  await git('add', '-A')
  await git('-c', 'core.editor=true', 'cherry-pick', '--continue')
  const head = await git('rev-parse', 'HEAD')
  return { ...repo, base, change, onto, head }
}

for (const mergeBaseOption of [true, false]) {
  const label = mergeBaseOption ? 'merge-tree' : 'temporary worktree'
  describe(`reconcile resolution (${label})`, () => {
    test('counts resolved and extra files, not clean destination arrivals', async () => {
      const { cwd, base, change, onto, head } = await conflictedReplay()
      expect(
        await computeResolutionPaths(spawnExec, cwd, [{ change, parent: base, onto, head }], {
          mergeBaseOption,
        }),
      ).toEqual(['a.txt', 'c.txt'])
    })

    test('a clean replay without edits resolves nothing', async () => {
      const { cwd, git, write, commit } = await repository()
      await write('a.txt', '1\n')
      await write('b.txt', '1\n')
      const base = await commit('base')
      await git('checkout', '-q', '-b', 'change')
      await write('b.txt', 'change\n')
      const change = await commit('change')
      await git('checkout', '-q', 'main')
      await write('a.txt', 'destination\n')
      const onto = await commit('destination')
      await git('checkout', '-q', '--detach', onto)
      await git('cherry-pick', change)
      const head = await git('rev-parse', 'HEAD')
      expect(
        await computeResolutionPaths(spawnExec, cwd, [{ change, parent: base, onto, head }], {
          mergeBaseOption,
        }),
      ).toEqual([])
    })

    test('a merge-commit change replays against its mainline parent', async () => {
      const { cwd, git, write, commit } = await repository()
      await write('a.txt', '1\n')
      await write('c.txt', '1\n')
      await commit('base')
      await git('checkout', '-q', '-b', 'mainline')
      await write('d.txt', 'mainline\n')
      await commit('mainline')
      await git('checkout', '-q', '-b', 'side', 'main')
      await write('e.txt', 'side\n')
      await commit('side')
      await git('checkout', '-q', 'mainline')
      await git('merge', '-q', '--no-ff', '--no-edit', 'side')
      const change = await git('rev-parse', 'HEAD')
      await git('checkout', '-q', 'main')
      await write('a.txt', 'destination\n')
      const onto = await commit('destination')
      await git('checkout', '-q', '--detach', onto)
      await git('cherry-pick', '-m', '1', change)
      await write('c.txt', 'resolver edit\n')
      await git('commit', '-q', '--amend', '-a', '--no-edit')
      const head = await git('rev-parse', 'HEAD')
      expect(
        await computeResolutionPaths(
          spawnExec,
          cwd,
          [{ change, parent: `${change}^1`, mainline: 1, onto, head }],
          { mergeBaseOption },
        ),
      ).toEqual(['c.txt'])
    })
  })
}

test('the worktree fallback leaves the caller worktree and registry untouched', async () => {
  const { cwd, git, base, change, onto, head } = await conflictedReplay()
  // Leave a conflicted cherry-pick in progress in the caller's worktree.
  await git('checkout', '-q', '--detach', onto)
  await spawnExec(['git', 'cherry-pick', change], { cwd })
  const snapshot = async () => ({
    head: await git('rev-parse', 'HEAD'),
    status: await git('status', '--porcelain'),
    pick: await git('rev-parse', '--verify', 'CHERRY_PICK_HEAD'),
    worktrees: await git('worktree', 'list', '--porcelain'),
  })
  const before = await snapshot()
  expect(before.pick).toBe(change)
  expect(
    await computeResolutionPaths(spawnExec, cwd, [{ change, parent: base, onto, head }], {
      mergeBaseOption: false,
    }),
  ).toEqual(['a.txt', 'c.txt'])
  expect(await snapshot()).toEqual(before)
  expect(before.worktrees.split('\n').filter((line) => line.startsWith('worktree '))).toHaveLength(
    1,
  )
})

describe('a global rerere.autoupdate does not change the outcome', () => {
  async function hostile() {
    const directory = await temporary(join(tmpdir(), 'head-paths-rerere-'))
    const config = join(directory, 'gitconfig')
    await writeFile(
      config,
      '[rerere]\n\tenabled = true\n\tautoupdate = true\n[user]\n\tname = Test\n\temail = test@example.com\n',
    )
    const replay = await conflictedReplay({ GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' })
    // The hostile config was live: rerere recorded the resolution.
    const cache = await replay.git('rev-parse', '--git-path', 'rr-cache')
    expect(await readdir(isAbsolute(cache) ? cache : join(replay.cwd, cache))).not.toHaveLength(0)
    return replay
  }

  for (const mergeBaseOption of [true, false])
    test(`${mergeBaseOption ? 'merge-tree' : 'temporary worktree'} replay ignores recorded resolutions`, async () => {
      const { cwd, exec, base, change, onto, head } = await hostile()
      expect(
        await computeResolutionPaths(exec, cwd, [{ change, parent: base, onto, head }], {
          mergeBaseOption,
        }),
      ).toEqual(['a.txt', 'c.txt'])
    })
})
