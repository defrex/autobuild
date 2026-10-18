import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertSafeNodeReplay,
  nodeInventory,
  prepareNodeReplay,
  replayNodeChange,
  type NodeGit,
} from './node-restack'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const workspacePath = await mkdtemp(join(tmpdir(), 'node-replay-'))
  roots.push(workspacePath)
  const deps: NodeGit = {
    workspacePath,
    exec: async (args, options) => {
      const p = Bun.spawn(args, { cwd: options.cwd, stdout: 'pipe', stderr: 'pipe' })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ])
      return { stdout, stderr, exitCode }
    },
  }
  const git = async (...args: string[]) => {
    const r = await deps.exec(['git', ...args], { cwd: workspacePath })
    if (r.exitCode !== 0) throw new Error(r.stderr)
    return r.stdout.trim()
  }
  await git('init', '-b', 'main')
  await git('config', 'user.name', 'Test')
  await git('config', 'user.email', 'test@example.test')
  const commit = async (name: string, build?: string) => {
    await Bun.write(join(workspacePath, name), name)
    await git('add', name)
    await git('commit', '-m', build === undefined ? name : `${name}\n\nAutobuild-Build: ${build}`)
    return git('rev-parse', 'HEAD')
  }
  const base = await commit('initial')
  return { deps, git, commit, base }
}
test('replays oldest first, drops stable upstream identities and retains foreign empty changes', async () => {
  const { deps, git, commit, base } = await fixture()
  await git('checkout', '-b', 'ab-node/a')
  const first = await commit('one', 'one')
  const second = await commit('two', 'two')
  const foreign = await commit('foreign')
  await git('commit', '--allow-empty', '-m', 'empty foreign')
  const oldHead = await git('rev-parse', 'HEAD')
  await git('checkout', 'main')
  await commit('upstream')
  await git('cherry-pick', first)
  const parent = await git('rev-parse', 'HEAD')
  const input = await prepareNodeReplay(deps, { oldBase: base, oldHead, parent })
  expect(input.changes.map((item) => item.sha)).toEqual([first, second, foreign, oldHead])
  let head = parent
  const outcomes: string[] = []
  for (let index = 0; index < input.changes.length; index++) {
    const result = await replayNodeChange(deps, input, index, head)
    outcomes.push(result.kind)
    if (result.kind === 'conflict') throw new Error('unexpected conflict')
    head = result.head
  }
  expect(outcomes).toEqual(['dropped', 'replayed', 'replayed', 'replayed'])
  const inventory = await nodeInventory(deps, head, parent)
  expect(inventory.builds).toEqual(['one', 'two'])
  expect(inventory.foreign).toHaveLength(2)
  expect(await git('rev-parse', 'ab-node/a')).toBe(oldHead)
})
test('unsafe side identities refuse the entire replay without touching the public head', async () => {
  const { deps, git, commit, base } = await fixture()
  await git('checkout', '-b', 'side')
  await commit('side', 'missing-build')
  await git('checkout', '-b', 'ab-node/a', base)
  await commit('first', 'first')
  await git('merge', '--no-ff', 'side', '-m', 'foreign merge')
  const oldHead = await git('rev-parse', 'HEAD')
  const input = await prepareNodeReplay(deps, { oldBase: base, oldHead, parent: base })
  expect(() => assertSafeNodeReplay(input)).toThrow(
    `merge ${oldHead} would lose build identities missing-build`,
  )
  await expect(replayNodeChange(deps, input, 0, base)).rejects.toThrow('missing-build')
  expect(await git('rev-parse', 'HEAD')).toBe(oldHead)
  expect(await git('rev-parse', 'ab-node/a')).toBe(oldHead)
})
test('update-branch merges flatten to one foreign change with inherited identities', async () => {
  const { deps, git, commit, base } = await fixture()
  await git('checkout', '-b', 'ab-node/a')
  await commit('owned', 'owned')
  await git('checkout', 'main')
  await commit('upstream', 'upstream')
  const parent = await git('rev-parse', 'HEAD')
  await git('checkout', 'ab-node/a')
  await git('merge', '--no-ff', 'main', '-m', 'update branch')
  const oldHead = await git('rev-parse', 'HEAD')
  const input = await prepareNodeReplay(deps, { oldBase: base, oldHead, parent })
  assertSafeNodeReplay(input)
  expect(input.merges).toEqual([{ sha: oldHead, parent, identities: ['upstream'], missing: [] }])
  let head = parent
  for (let i = 0; i < input.changes.length; i++) {
    const result = await replayNodeChange(deps, input, i, head)
    if (result.kind === 'conflict') throw new Error('unexpected conflict')
    head = result.head
  }
  expect((await git('show', '-s', '--format=%P', head)).split(' ')).toHaveLength(1)
  expect((await nodeInventory(deps, head, parent)).builds).toEqual(['owned', 'upstream'])
  expect((await nodeInventory(deps, head, parent)).foreign).toEqual([head])
})
test('recursive contribution boundaries keep inherited foreign changes out of child inventory', async () => {
  const { deps, git, commit, base } = await fixture()
  await git('checkout', '-b', 'ab-node/a')
  const a = await commit('foreign-f')
  await git('checkout', '-b', 'ab-node/b')
  const b = await commit('foreign-g')
  await git('checkout', 'main')
  const parent = await commit('new-root')
  async function replay(oldBase: string, oldHead: string, parent: string) {
    const input = await prepareNodeReplay(deps, { oldBase, oldHead, parent })
    let head = parent
    for (let i = 0; i < input.changes.length; i++) {
      const result = await replayNodeChange(deps, input, i, head)
      if (result.kind === 'conflict') throw new Error('unexpected conflict')
      head = result.head
    }
    return head
  }
  const nextA = await replay(base, a, parent)
  const nextB = await replay(a, b, nextA)
  expect((await nodeInventory(deps, nextB, nextA)).foreign).toEqual([nextB])
  expect(await git('rev-list', '--count', `${nextA}..${nextB}`)).toBe('1')
  await git('checkout', 'main')
  const newer = await commit('newer-root')
  const lastA = await replay(parent, nextA, newer)
  const lastB = await replay(nextA, nextB, lastA)
  expect((await nodeInventory(deps, lastB, lastA)).foreign).toEqual([lastB])
  expect(await git('rev-list', '--count', `${newer}..${lastB}`)).toBe('2')
})

// The spec's side-history safety rule does not decide whether the merge's
// own valid identity survives its required classification as a foreign item.
test('identified foreign merge needs a decision even when every side identity is upstream', async () => {
  const { deps, git, commit, base } = await fixture()
  await git('checkout', '-b', 'ab-node/a')
  await commit('owned', 'owned')
  await git('checkout', 'main')
  await commit('upstream', 'upstream')
  const parent = await git('rev-parse', 'HEAD')
  await git('checkout', 'ab-node/a')
  await git('merge', '--no-ff', 'main', '-m', 'update branch\n\nAutobuild-Build: merge-build')
  const oldHead = await git('rev-parse', 'HEAD')
  const input = await prepareNodeReplay(deps, { oldBase: base, oldHead, parent })
  expect(input.merges[0]?.missing).toEqual([])
  expect(input.merges[0]?.build).toBe('merge-build')
  await expect(replayNodeChange(deps, input, 0, parent)).rejects.toThrow(
    'foreign merge classification requires operator guidance',
  )
  expect(await git('rev-parse', 'ab-node/a')).toBe(oldHead)
  expect(await git('rev-parse', 'HEAD')).toBe(oldHead)
})
