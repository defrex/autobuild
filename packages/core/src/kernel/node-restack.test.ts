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

// Operator guidance esc_5ba2be9e: an identity on the merge itself always
// refuses flattening; its identity must never be stripped or reinterpreted.
test('identified foreign merge refuses even when every side identity is upstream', async () => {
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
    `identity-bearing merge is anomalous: ${oldHead} carries Autobuild-Build: merge-build`,
  )
  expect(await git('rev-parse', 'ab-node/a')).toBe(oldHead)
  expect(await git('rev-parse', 'HEAD')).toBe(oldHead)
})

test('octopus preflight scans every side parent before replaying a clean prefix', async () => {
  const { deps, git, commit, base } = await fixture()
  await git('checkout', '-b', 'side-one')
  await commit('side-one', 'present')
  const sideOne = await git('rev-parse', 'HEAD')
  await git('checkout', '-b', 'side-two', base)
  await commit('side-two', 'missing')
  await git('checkout', '-b', 'ab-node/a', base)
  await commit('prefix', 'prefix')
  await git('merge', '--no-ff', 'side-one', 'side-two', '-m', 'octopus')
  const oldHead = await git('rev-parse', 'HEAD')
  await git('checkout', 'main')
  await commit('parent-advance')
  await git('cherry-pick', sideOne)
  const parent = await git('rev-parse', 'HEAD')
  const input = await prepareNodeReplay(deps, { oldBase: base, oldHead, parent })
  expect(input.merges[0]).toEqual({
    sha: oldHead,
    parent,
    identities: ['missing', 'present'],
    missing: ['missing'],
  })
  await expect(replayNodeChange(deps, input, 0, parent)).rejects.toThrow('missing')
  expect(await git('rev-parse', 'HEAD')).toBe(parent)
  expect(await git('rev-parse', 'ab-node/a')).toBe(oldHead)

  // Only a fresh transaction may use newly available upstream identities.
  await git('cherry-pick', 'side-two')
  const newer = await git('rev-parse', 'HEAD')
  expect(() => assertSafeNodeReplay(input)).toThrow('missing')
  const retry = await prepareNodeReplay(deps, { oldBase: base, oldHead, parent: newer })
  expect(retry.merges[0]?.missing).toEqual([])
  assertSafeNodeReplay(retry)
})

test('nested side merges cannot hide a missing identity', async () => {
  const { deps, git, commit, base } = await fixture()
  await git('checkout', '-b', 'nested')
  await commit('hidden', 'hidden')
  await git('checkout', '-b', 'side', base)
  await commit('side-foreign')
  await git('merge', '--no-ff', 'nested', '-m', 'nested foreign merge')
  await git('checkout', '-b', 'ab-node/a', base)
  await commit('owned')
  await git('merge', '--no-ff', 'side', '-m', 'outer foreign merge')
  const oldHead = await git('rev-parse', 'HEAD')
  const input = await prepareNodeReplay(deps, { oldBase: base, oldHead, parent: base })
  expect(input.merges[0]?.identities).toEqual(['hidden'])
  expect(() => assertSafeNodeReplay(input)).toThrow(
    `merge ${oldHead} would lose build identities hidden`,
  )
})

test('untagged side history flattens while preserving merge-specific resolution content', async () => {
  const { deps, git, commit, base } = await fixture()
  await git('checkout', '-b', 'side')
  await commit('foreign-side')
  await git('checkout', '-b', 'ab-node/a', base)
  await commit('owned', 'owned')
  await git('merge', '--no-ff', 'side', '-m', 'foreign merge')
  await Bun.write(join(deps.workspacePath, 'resolution'), 'merge-specific content')
  await git('add', 'resolution')
  await git('commit', '--amend', '--no-edit')
  const oldHead = await git('rev-parse', 'HEAD')
  await git('checkout', 'main')
  const parent = await commit('parent-advance')
  const inputs = await prepareNodeReplay(deps, { oldBase: base, oldHead, parent })
  assertSafeNodeReplay(inputs)
  expect(inputs.merges[0]?.identities).toEqual([])
  let head = parent
  for (let index = 0; index < inputs.changes.length; index++) {
    const result = await replayNodeChange(deps, inputs, index, head)
    if (result.kind === 'conflict') throw new Error('unexpected conflict')
    head = result.head
  }
  expect(await git('show', `${head}:resolution`)).toBe('merge-specific content')
  expect(await git('show', `${head}:foreign-side`)).toBe('foreign-side')
  expect(await git('show', '-s', '--format=%P', head)).not.toContain(' ')
  expect(await nodeInventory(deps, head, parent)).toEqual({
    head,
    builds: ['owned'],
    foreign: [head],
  })
})

test('a later conflict resumes from the completed prefix without replaying it twice', async () => {
  const { deps, git, commit, base } = await fixture()
  await git('checkout', '-b', 'ab-node/a')
  await commit('prefix', 'prefix')
  await Bun.write(join(deps.workspacePath, 'initial'), 'node edit')
  await git('add', 'initial')
  await git('commit', '-m', 'conflicting change\n\nAutobuild-Build: conflict')
  const oldHead = await git('rev-parse', 'HEAD')
  await git('checkout', 'main')
  await Bun.write(join(deps.workspacePath, 'initial'), 'parent edit')
  await git('add', 'initial')
  await git('commit', '-m', 'parent edit')
  const parent = await git('rev-parse', 'HEAD')
  const input = await prepareNodeReplay(deps, { oldBase: base, oldHead, parent })
  const prefix = await replayNodeChange(deps, input, 0, parent)
  if (prefix.kind !== 'replayed') throw new Error('prefix was not replayed')
  expect(await replayNodeChange(deps, input, 1, prefix.head)).toEqual({
    kind: 'conflict',
    base: prefix.head,
  })
  await git('cherry-pick', '--abort')
  // The receipt's replay prefix is sufficient to reconstruct a lost workspace.
  await git('checkout', '--detach', parent)
  expect(await replayNodeChange(deps, input, 1, prefix.head)).toEqual({
    kind: 'conflict',
    base: prefix.head,
  })
  expect(await git('rev-list', '--count', `${parent}..HEAD`)).toBe('1')
  expect(await git('rev-parse', 'ab-node/a')).toBe(oldHead)
})

test('a hand-rewritten node head refuses an incompatible contribution boundary', async () => {
  const { deps, git, commit, base } = await fixture()
  await git('checkout', '--orphan', 'unrelated')
  await git('rm', '-rf', '.')
  const oldHead = await commit('unrelated')
  await expect(prepareNodeReplay(deps, { oldBase: base, oldHead, parent: base })).rejects.toThrow(
    'no longer descends',
  )
})
