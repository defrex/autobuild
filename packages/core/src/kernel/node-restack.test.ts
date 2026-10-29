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
    contributions: ['owned'],
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
    files: ['initial'],
  })
  await git('cherry-pick', '--abort')
  // The receipt's replay prefix is sufficient to reconstruct a lost workspace.
  await git('checkout', '--detach', parent)
  expect(await replayNodeChange(deps, input, 1, prefix.head)).toEqual({
    kind: 'conflict',
    base: prefix.head,
    files: ['initial'],
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

test('durable node transaction publishes ordered changes and promotes its boundary only on completion', async () => {
  const { MemoryBuildStore } = await import('../store/memory')
  const { DISPATCHER } = await import('../events/envelope')
  const { gitRewrite } = await import('../ports/forge/git-rewrite')
  const { FakeForge } = await import('../ports/forge/fake')
  const { runNodeTransaction } = await import('./node-restack-transaction')
  const { sampleBuildInput } = await import('../store/contract')
  const { deps, git, commit, base } = await fixture()
  await git('checkout', '-b', 'ab-node/a')
  await commit('one', 'one')
  await commit('foreign')
  const oldHead = await git('rev-parse', 'HEAD')
  await git('checkout', 'main')
  const parent = await commit('parent')
  const store = new MemoryBuildStore()
  await store.createBuild(sampleBuildInput('a'))
  await store.append('a', { actor: DISPATCHER, type: 'node.opened', payload: { sha: base } })
  await store.append('a', {
    actor: DISPATCHER,
    type: 'integration.observed',
    payload: { openChildren: [], diagnostics: [], contributions: ['one'] },
  })
  await store.claimNodeWriter('a', 'holder', 60_000)
  const forge: import('../ports/types').Forge = new FakeForge()
  Object.defineProperty(forge, 'rewrite', { value: gitRewrite(deps.exec, true) })
  forge.snapshotBase = async () => parent
  await store.append('a', {
    actor: (await import('../events/envelope')).KERNEL,
    type: 'finalize.completed',
    payload: { pr: { number: 1, url: 'https://forge/1', headSha: oldHead } },
  })
  const native = forge as InstanceType<typeof FakeForge>
  native.setPrState(1, { state: 'open', mergeable: true })
  await native.setAutoMerge(deps.workspacePath, 1, true)
  const replace = forge.rewrite!.replace.bind(forge.rewrite!)
  forge.rewrite!.replace = async (input) => {
    expect(native.isAutoMergeEnabled(1)).toBe(false)
    const facts = await store.getEvents('a')
    expect(facts.findLast((e) => e.type === 'landing.native-applied')?.payload).toMatchObject({
      enabled: false,
      operation: 'first',
    })
    return replace(input)
  }
  const tx = { ...deps, store, slug: 'a', forge, holder: 'holder', canWrite: async () => true }
  expect(
    await runNodeTransaction(tx, { branch: 'ab-node/a', parentBranch: 'main', id: 'first' }),
  ).toBe('completed')
  const node = (await (await import('../store/reduced-reads')).readBuildFacts(store, 'a')).value
    .state.nodeRestack!
  expect(node.contributionBase).toBe(parent)
  expect(node.active).toBeUndefined()
  expect(node.inventory?.builds).toEqual(['one'])
  expect(node.inventory?.foreign).toHaveLength(1)
  expect(await git('rev-parse', 'ab-node/a')).toBe(node.inventory!.head)
  expect(await git('rev-parse', `refs/autobuild/archive/a/${oldHead}`)).toBe(oldHead)
  const exec = tx.exec
  let historyReads = 0
  tx.exec = async (args, options) => {
    if (args[0] === 'git' && args[1] === 'log') historyReads++
    return exec(args, options)
  }
  expect(
    await runNodeTransaction(tx, { branch: 'ab-node/a', parentBranch: 'main', id: 'next' }),
  ).toBe('idle')
  expect(historyReads).toBe(0)
  await commit('hand-push')
  await git('update-ref', 'refs/heads/ab-node/a', await git('rev-parse', 'HEAD'))
  expect(
    await runNodeTransaction(tx, { branch: 'ab-node/a', parentBranch: 'main', id: 'hand-push' }),
  ).toBe('idle')
  expect(historyReads).toBe(3)
  expect(
    (await (await import('../store/reduced-reads')).readBuildFacts(store, 'a')).value.state
      .nodeRestack?.inventory?.foreign,
  ).toHaveLength(2)
  expect(
    await runNodeTransaction(tx, { branch: 'ab-node/a', parentBranch: 'main', id: 'unchanged' }),
  ).toBe('idle')
  expect(historyReads).toBe(3)
})

for (const [boundary, local] of [
  ['node.item-replayed', true],
  ['node.rewritten', true],
  ['node.rewritten', false],
] as const) {
  test(`node recovery resumes frozen inputs after effect-before-receipt at ${boundary} (${local ? 'local-git' : 'remote with recreated cache'})`, async () => {
    const { MemoryBuildStore } = await import('../store/memory')
    const { DISPATCHER } = await import('../events/envelope')
    const { readBuildFacts } = await import('../store/reduced-reads')
    const { gitRewrite } = await import('../ports/forge/git-rewrite')
    const { FakeForge } = await import('../ports/forge/fake')
    const { runNodeTransaction } = await import('./node-restack-transaction')
    const { sampleBuildInput } = await import('../store/contract')
    const { deps, git, commit, base } = await fixture()
    await git('checkout', '-b', 'ab-node/a')
    await commit('one', 'one')
    await commit('foreign')
    const oldHead = await git('rev-parse', 'HEAD')
    await git('checkout', 'main')
    const parent = await commit('parent')
    if (!local) {
      const remote = `${deps.workspacePath}-origin.git`
      roots.push(remote)
      await git('init', '--bare', remote)
      await git('remote', 'add', 'origin', remote)
      await git('push', 'origin', 'ab-node/a')
    }
    const store = new MemoryBuildStore()
    await store.createBuild(sampleBuildInput('a'))
    await store.append('a', { actor: DISPATCHER, type: 'node.opened', payload: { sha: base } })
    await store.append('a', {
      actor: DISPATCHER,
      type: 'integration.observed',
      payload: { openChildren: [], diagnostics: [], contributions: ['one'] },
    })
    await store.claimNodeWriter('a', 'first', 60_000)
    const forge: import('../ports/types').Forge = new FakeForge()
    Object.defineProperty(forge, 'rewrite', { value: gitRewrite(deps.exec, local) })
    forge.snapshotBase = async () => parent
    const tx = { ...deps, store, slug: 'a', forge, holder: 'first', canWrite: async () => true }
    const append = store.appendIfCurrent.bind(store)
    let crashed = false
    store.appendIfCurrent = async (...args) => {
      if (!crashed && args[2].type === boundary) {
        crashed = true
        throw new Error('simulated crash')
      }
      return append(...args)
    }
    await expect(
      runNodeTransaction(tx, { branch: 'ab-node/a', parentBranch: 'main', id: 'frozen' }),
    ).rejects.toThrow('simulated crash')
    expect((await readBuildFacts(store, 'a')).value.state.nodeRestack?.contributionBase).toBe(base)
    if (!local) {
      await git('update-ref', '-d', 'refs/heads/ab-node/a')
      await git('branch', 'ab-node/a', parent)
    }
    await store.releaseNodeWriter('a', 'first')
    await store.claimNodeWriter('a', 'replacement', 60_000)
    // A pre-upgrade reservation finishes even after fresh completeness demand disappears.
    await store.append('a', {
      actor: DISPATCHER,
      type: 'integration.observed',
      payload: { openChildren: ['later-child'], diagnostics: [], contributions: ['one'] },
    })
    await store.append('a', {
      actor: DISPATCHER,
      type: 'node.restack-requested',
      payload: {
        id: 'newer-demand',
        reason: 'presence',
        branch: 'main',
        parent,
        dependent: { source: 'fake', id: 'LATER' },
        identities: ['build:later'],
      },
    })
    // A later observation does not change the transaction already in flight.
    forge.snapshotBase = async () => {
      throw new Error('must not resample a reserved transaction')
    }
    expect(
      await runNodeTransaction(
        { ...tx, holder: 'replacement' },
        { branch: 'ab-node/a', parentBranch: 'main', id: 'ignored-new-id' },
      ),
    ).toBe('completed')
    const state = (await readBuildFacts(store, 'a')).value.state.nodeRestack!
    const writes = await store.getEvents('a')
    expect(writes.filter((e) => e.type === 'node.writer-reserved')).toHaveLength(1)
    expect(writes.filter((e) => e.type === 'node.writer-settled')).toHaveLength(1)
    expect(state.contributionBase).toBe(parent)
    expect(state.requests?.['newer-demand']?.identities).toEqual(['build:later'])
    expect(state.inventory?.builds).toEqual(['one'])
    expect(state.inventory?.foreign).toHaveLength(1)
    if (local) expect(await git('rev-parse', `refs/autobuild/archive/a/${oldHead}`)).toBe(oldHead)
    else
      expect(await git('ls-remote', 'origin', `refs/autobuild/archive/a/${oldHead}`)).toContain(
        oldHead,
      )
    expect(await git('rev-list', '--count', `${parent}..ab-node/a`)).toBe('2')
  })
}

test('large reachable histories and contribution metadata are read in a bounded number of Git processes', async () => {
  const { deps, git, base } = await fixture()
  const count = 4096
  const records: string[] = []
  const builds: string[] = []
  for (let index = 1; index <= count; index++) {
    const build = index % 512 === 0 ? `source-${index}` : undefined
    if (build) builds.push(build)
    const message = `History ${index}\nBody with a record separator \x1e and blank lines.\n\n${build ? `Autobuild-Build: ${build}\n` : ''}`
    records.push(
      `commit refs/heads/main\nmark :${index}\ncommitter Test <test@example.test> 1700000000 +0000\ndata ${Buffer.byteLength(message)}\n${message}\nfrom ${index === 1 ? base : `:${index - 1}`}\n\n`,
    )
  }
  const input = join(deps.workspacePath, '.git', 'node-history-import')
  await Bun.write(input, records.join(''))
  const imported = await deps.exec(
    ['sh', '-c', 'git fast-import --quiet < "$1"', 'node-history', input],
    { cwd: deps.workspacePath },
  )
  expect(imported.exitCode).toBe(0)
  const head = await git('rev-parse', 'main')
  const exec = deps.exec
  const commands: string[][] = []
  deps.exec = async (args, options) => {
    commands.push([...args])
    return exec(args, options)
  }
  const inventory = await nodeInventory(deps, head, base)
  expect(inventory.builds).toEqual(builds.sort())
  expect(inventory.foreign).toHaveLength(count - builds.length)
  expect(commands).toHaveLength(2)
  expect(commands.every((args) => args[1] === 'log')).toBe(true)
  commands.length = 0
  const frozen = await prepareNodeReplay(deps, { oldBase: base, oldHead: head, parent: base })
  expect(frozen.changes).toHaveLength(count)
  expect(frozen.changes.filter((change) => change.build).map((change) => change.build)).toEqual(
    builds.sort((a, b) => Number(a.slice(7)) - Number(b.slice(7))),
  )
  expect(commands).toHaveLength(3)
  expect(commands.filter((args) => args[1] === 'show')).toHaveLength(0)
}, 30_000)

test('batched history preserves rejection of malformed and ambiguous terminal identities', async () => {
  const { deps, commit, base, git } = await fixture()
  const malformed = await commit('malformed', 'invalid slug')
  await expect(
    prepareNodeReplay(deps, { oldBase: base, oldHead: base, parent: malformed }),
  ).rejects.toThrow(`invalid build identity on ${malformed}`)
  await git('commit', '--amend', '-m', 'Ambiguous\n\nAutobuild-Build: one\nAutobuild-Build: two')
  const ambiguous = await git('rev-parse', 'HEAD')
  await expect(nodeInventory(deps, ambiguous, base)).rejects.toThrow(
    `ambiguous build identity on ${ambiguous}`,
  )
})

for (const race of ['lease-takeover', 'revision-change'] as const) {
  test(`node reservation rejects a stale decision after ${race}`, async () => {
    const { MemoryBuildStore } = await import('../store/memory')
    const { DISPATCHER } = await import('../events/envelope')
    const { gitRewrite } = await import('../ports/forge/git-rewrite')
    const { FakeForge } = await import('../ports/forge/fake')
    const { runNodeTransaction } = await import('./node-restack-transaction')
    const { sampleBuildInput } = await import('../store/contract')
    const { manualClock } = await import('../testing/fixed')
    const { readBuildFacts } = await import('../store/reduced-reads')
    const { deps, git, commit, base } = await fixture()
    await git('checkout', '-b', 'ab-node/a')
    const oldHead = await commit('node')
    await git('checkout', 'main')
    const parent = await commit('parent')
    const clock = manualClock()
    const store = new MemoryBuildStore({ clock })
    await store.createBuild(sampleBuildInput('a'))
    await store.append('a', { actor: DISPATCHER, type: 'node.opened', payload: { sha: base } })
    await store.append('a', {
      actor: DISPATCHER,
      type: 'integration.observed',
      payload: { openChildren: [], diagnostics: [], contributions: ['one'] },
    })
    await store.claimNodeWriter('a', 'old-holder', 60_000)
    const rewrite = gitRewrite(deps.exec, true)
    let ready = false
    const archive = rewrite.archive.bind(rewrite)
    rewrite.archive = async (input) => {
      await archive(input)
      if (input.sha === parent) ready = true
    }
    const forge: import('../ports/types').Forge = new FakeForge()
    Object.defineProperty(forge, 'rewrite', { value: rewrite })
    forge.snapshotBase = async () => parent
    const tx = {
      ...deps,
      store,
      slug: 'a',
      forge,
      holder: 'old-holder',
      canWrite: async () => {
        if (ready) {
          ready = false
          if (race === 'lease-takeover') {
            clock.advance(60_001)
            expect(await store.claimNodeWriter('a', 'new-holder', 60_000)).toBe(true)
            await store.append('a', {
              actor: DISPATCHER,
              type: 'node.writer-reserved',
              payload: {
                id: 'winner',
                operation: 'restack',
                expected: oldHead,
                parent,
                oldBase: base,
                archive: `refs/autobuild/archive/a/${oldHead}`,
                changes: [],
                merges: [],
                upstreamBuilds: [],
              },
            })
          } else {
            await store.append('a', {
              actor: DISPATCHER,
              type: 'node.inventory',
              payload: { head: oldHead, builds: [], foreign: [oldHead] },
            })
          }
        }
        return true
      },
    }
    await expect(
      runNodeTransaction(tx, { branch: 'ab-node/a', parentBranch: 'main', id: 'stale' }),
    ).rejects.toThrow(race === 'lease-takeover' ? 'authority lost' : 'log advanced')
    const facts = (await readBuildFacts(store, 'a')).value
    expect(facts.state.nodeRestack?.active?.id).toBe(
      race === 'lease-takeover' ? 'winner' : undefined,
    )
    expect(
      (await store.getEvents('a')).filter((event) => event.type === 'node.writer-reserved'),
    ).toHaveLength(race === 'lease-takeover' ? 1 : 0)
  })
}

test('foreign replay aliases drop only the same identity across a parent rewrite, retaining distinct empty changes', async () => {
  const { deps, git, commit, base } = await fixture()
  await git('checkout', '-b', 'ab-node/source')
  const foreign = await commit('foreign')
  await git('commit', '--allow-empty', '-m', 'distinct empty foreign')
  const empty = await git('rev-parse', 'HEAD')
  await git('checkout', 'main')
  await commit('sibling')
  await git('cherry-pick', foreign)
  const alias = await git('rev-parse', 'HEAD')
  expect(alias).not.toBe(foreign)
  const evidence = { aliases: new Map([[alias, foreign]]), landings: [] }
  const input = await prepareNodeReplay(
    deps,
    { oldBase: base, oldHead: empty, parent: alias },
    evidence,
  )
  expect(await replayNodeChange(deps, input, 0, alias, evidence)).toEqual({
    kind: 'dropped',
    head: alias,
    reason: 'upstream-commit',
  })
  const result = await replayNodeChange(deps, input, 1, alias, evidence)
  expect(result.kind).toBe('replayed')
  if (result.kind !== 'replayed') throw new Error('missing distinct empty change')
  expect(await git('show', '-s', '--format=%s', result.head)).toBe('distinct empty foreign')
})

test('transported nested build identity drops a source whose old SHA is absent from the rewritten parent', async () => {
  const { deps, git, commit, base } = await fixture()
  await git('checkout', '-b', 'ab-node/source')
  const source = await commit('leaf', 'leaf')
  await git('checkout', 'main')
  const parent = await commit('transport', 'outer-node')
  const evidence = {
    aliases: new Map<string, string>(),
    landings: [
      { slug: 'inner-node', sha: source, contribution: ['build:leaf' as const] },
      { slug: 'outer-node', sha: parent, contribution: ['build:inner-node' as const] },
    ],
  }
  const input = await prepareNodeReplay(deps, { oldBase: base, oldHead: source, parent }, evidence)
  expect(input.upstreamBuilds).toContain('leaf')
  expect(await replayNodeChange(deps, input, 0, parent, evidence)).toEqual({
    kind: 'dropped',
    head: parent,
    reason: 'upstream-identity',
  })
})

test('a real conflicted transaction records NUL-delimited filenames including spaces and Unicode', async () => {
  const { MemoryBuildStore } = await import('../store/memory')
  const { DISPATCHER } = await import('../events/envelope')
  const { FakeForge } = await import('../ports/forge/fake')
  const { runNodeTransaction } = await import('./node-restack-transaction')
  const { sampleBuildInput } = await import('../store/contract')
  const { deps, git } = await fixture()
  const files = ['a file.ts', '日本語.ts']
  for (const path of files) await Bun.write(join(deps.workspacePath, path), 'base\n')
  await git('add', '.')
  await git('commit', '-m', 'shared files')
  const base = await git('rev-parse', 'HEAD')
  await git('checkout', '-b', 'ab-node/a')
  for (const path of files) await Bun.write(join(deps.workspacePath, path), 'node\n')
  await git('add', '.')
  await git('commit', '-m', 'node edit')
  await git('checkout', 'main')
  for (const path of files) await Bun.write(join(deps.workspacePath, path), 'parent\n')
  await git('add', '.')
  await git('commit', '-m', 'parent edit')
  const parent = await git('rev-parse', 'HEAD')
  const store = new MemoryBuildStore()
  await store.createBuild(sampleBuildInput('a'))
  await store.append('a', { actor: DISPATCHER, type: 'node.opened', payload: { sha: base } })
  await store.append('a', {
    actor: DISPATCHER,
    type: 'integration.observed',
    payload: { openChildren: [], diagnostics: [], contributions: ['one'] },
  })
  await store.claimNodeWriter('a', 'holder', 60_000)
  const forge: import('../ports/types').Forge = new FakeForge()
  const { gitRewrite } = await import('../ports/forge/git-rewrite')
  Object.defineProperty(forge, 'rewrite', { value: gitRewrite(deps.exec, true) })
  forge.snapshotBase = async () => parent
  expect(
    await runNodeTransaction(
      { ...deps, store, slug: 'a', forge, holder: 'holder', canWrite: async () => true },
      { branch: 'ab-node/a', parentBranch: 'main', id: 'conflict' },
    ),
  ).toBe('conflict')
  expect(
    (await store.getEvents('a')).findLast((e) => e.type === 'node.item-conflicted')?.payload,
  ).toMatchObject({ files })
})

test('unavailable nested presence waits durably, survives re-parenting, and progresses only on actual coverage', async () => {
  const { MemoryBuildStore } = await import('../store/memory')
  const { DISPATCHER } = await import('../events/envelope')
  const { FakeForge } = await import('../ports/forge/fake')
  const { gitRewrite } = await import('../ports/forge/git-rewrite')
  const { runNodeTransaction } = await import('./node-restack-transaction')
  const { sampleBuildInput } = await import('../store/contract')
  const { readBuildFacts } = await import('../store/reduced-reads')
  const { deps, git, commit, base } = await fixture()
  await git('checkout', '-b', 'source')
  const source = await commit('source-change', 'source')
  await git('checkout', '-b', 'ab-node/destination', base)
  await commit('owned', 'owned')
  await git('checkout', '-b', 'parent', base)
  let parent = await commit('parent-change')
  const store = new MemoryBuildStore()
  await store.createBuild(sampleBuildInput('waiting'))
  await store.append('waiting', { actor: DISPATCHER, type: 'node.opened', payload: { sha: base } })
  await store.append('waiting', {
    actor: DISPATCHER,
    type: 'node.restack-requested',
    payload: {
      id: 'presence',
      reason: 'presence',
      branch: 'parent',
      parent,
      dependent: { source: 'fake', id: 'D' },
      identities: ['build:source'],
    },
  })
  await store.append('waiting', {
    actor: DISPATCHER,
    type: 'node.restack-requested',
    payload: {
      id: 'obsolete',
      reason: 'presence',
      branch: 'previous-destination',
      parent,
      dependent: { source: 'fake', id: 'OLD' },
      identities: ['build:absent'],
    },
  })
  await store.createBuild(sampleBuildInput('targeting-leaf'))
  await store.append('targeting-leaf', {
    actor: { kind: 'kernel' },
    type: 'finalize.completed',
    payload: {
      pr: { number: 77, url: 'https://example/77', headSha: 'old' },
    },
  })
  await store.claimNodeWriter('waiting', 'holder', 60_000)
  const forge = new FakeForge()
  forge.rewrite = gitRewrite(deps.exec, true)
  forge.setPrState(77, { state: 'open', mergeable: true })
  forge.setAutoMergeState(77, true)
  const { suspendNativeLanding } = await import('./landing-publication')
  let refuseCancellation = false
  const tx = {
    ...deps,
    store,
    slug: 'waiting',
    forge: Object.assign(forge, {
      snapshotBase: async () => parent,
    }),
    holder: 'holder',
    canWrite: async () => true,
    beforeReplay: async (operation: string) => {
      cancellations++
      if (refuseCancellation) throw new Error('cancellation unconfirmed')
      await suspendNativeLanding(
        { ...deps, store, forge, slug: 'targeting-leaf' },
        `node:waiting:${operation}`,
      )
    },
  }
  let cancellations = 0
  const run = () =>
    runNodeTransaction(tx, { branch: 'ab-node/destination', parentBranch: 'parent', id: 'replay' })
  const append = store.appendIfCurrent.bind(store)
  store.appendIfCurrent = async (...args) => {
    if (args[2].type === 'node.restack-availability-observed')
      throw new Error('assessment interrupted')
    return append(...args)
  }
  await expect(run()).rejects.toThrow('assessment interrupted')
  expect(
    (await readBuildFacts(store, 'waiting')).value.state.nodeRestack?.availability,
  ).toBeUndefined()
  store.appendIfCurrent = append
  expect(await run()).toBe('idle')
  const first = (await readBuildFacts(store, 'waiting')).value.state.nodeRestack!
  expect(first.availability?.available).toEqual([])
  expect(first.requests?.presence).toBeDefined()
  expect(first.requests?.obsolete).toBeUndefined()
  expect(
    (await store.getEvents('waiting')).find((e) => e.type === 'node.restack-satisfied')?.payload,
  ).toMatchObject({ id: 'obsolete', outcome: 'destination-changed' })
  expect(cancellations).toBe(0)
  expect(await run()).toBe('idle')
  expect(
    (await store.getEvents('waiting')).filter(
      (e) => e.type === 'node.restack-availability-observed',
    ),
  ).toHaveLength(1)
  // Same branch now points to a different ancestry without the required identity.
  await git('checkout', '--detach', base)
  parent = await commit('replacement-parent')
  expect(await run()).toBe('idle')
  expect(
    (await readBuildFacts(store, 'waiting')).value.state.nodeRestack?.requests?.presence,
  ).toBeDefined()
  // Restore the identity into the immediate parent. Only actual destination
  // coverage after replay may settle the request.
  await git('cherry-pick', source)
  parent = await git('rev-parse', 'HEAD')
  refuseCancellation = true
  await expect(run()).rejects.toThrow('cancellation unconfirmed')
  expect((await readBuildFacts(store, 'waiting')).value.state.nodeRestack?.active).toBeUndefined()
  expect(forge.isAutoMergeEnabled(77)).toBe(true)
  refuseCancellation = false
  expect(await run()).toBe('completed')
  expect(forge.autoMergeCalls.filter((call) => !call.enabled)).toHaveLength(1)
  expect(forge.isAutoMergeEnabled(77)).toBe(false)
  expect(cancellations).toBeGreaterThan(0)
  expect((await readBuildFacts(store, 'waiting')).value.state.nodeRestack?.requests).toEqual({})
  const inventory = await nodeInventory(deps, await git('rev-parse', 'ab-node/destination'), parent)
  expect(inventory.builds).toContain('source')
})
