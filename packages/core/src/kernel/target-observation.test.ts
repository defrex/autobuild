import { expect, test } from 'bun:test'
import { BUILD, seedStore } from '../cli/testkit'
import { KERNEL } from '../events/envelope'
import { FakeForge } from '../ports/forge/fake'
import { readBuildFacts } from '../store/reduced-reads'
import { observeTarget } from './target-observation'

const A = 'a'.repeat(40),
  B = 'b'.repeat(40),
  C = 'c'.repeat(40)
async function fixture() {
  const store = await seedStore()
  const forge = new FakeForge()
  forge.seedCommit(A)
  forge.seedCommit(B, [A])
  forge.seedCommit(C, [A])
  const observe = (sha: string) =>
    observeTarget({ store, forge, slug: BUILD, branch: 'main', sha, actor: KERNEL })
  return { store, forge, observe }
}

test('forward targets advance; rewinds and divergent tips retain accepted state and deduplicate', async () => {
  const { store, observe } = await fixture()
  expect(await observe(A)).toBe('moved')
  expect(await observe(B)).toBe('moved')
  expect(await observe(A)).toBe('rejected')
  expect(await observe(A)).toBe('rejected')
  let facts = (await readBuildFacts(store, BUILD)).value
  expect(facts.log.restack.target?.sha).toBe(B)
  expect(facts.state.targetRewrite?.payload).toEqual({ branch: 'main', previousSha: B, sha: A })
  expect((await store.getEvents(BUILD)).filter((e) => e.type === 'target.rewritten')).toHaveLength(
    1,
  )
  expect(await observe(C)).toBe('rejected')
  // A new process sees the same reduced rejection and can recover to the
  // unchanged accepted tip without fabricating another move.
  expect(
    await observeTarget({
      store,
      forge: new FakeForge(),
      slug: BUILD,
      branch: 'main',
      sha: B,
      actor: KERNEL,
    }),
  ).toBe('cleared')
  facts = (await readBuildFacts(store, BUILD)).value
  expect(facts.state.targetRewrite).toBeUndefined()
  expect(facts.log.restack.targetRewrite).toBeUndefined()
  expect((await store.getEvents(BUILD)).filter((e) => e.type === 'target.moved')).toHaveLength(2)
})

test('unavailable proof and invalid OIDs leave the log unchanged', async () => {
  const { store, forge, observe } = await fixture()
  await observe(A)
  const before = (await readBuildFacts(store, BUILD)).cursor
  forge.isCommitAncestor = async () => {
    throw new Error('remote unavailable')
  }
  await expect(observe(B)).rejects.toThrow('remote unavailable')
  Object.defineProperty(forge, 'isCommitAncestor', { value: undefined })
  await expect(observe(B)).rejects.toThrow('capability unavailable')
  await expect(observe('main')).rejects.toThrow('invalid target')
  expect((await readBuildFacts(store, BUILD)).cursor).toBe(before)
})

test('first observation cannot regress behind the initial workspace base', async () => {
  const { store, observe } = await fixture()
  await store.append(BUILD, {
    actor: KERNEL,
    type: 'workspace.provisioned',
    payload: {
      provider: 'fake',
      ref: '/ws',
      branch: 'ab/test',
      base: { source: 'remote', sha: B },
    },
  })
  expect(await observe(A)).toBe('rejected')
  expect((await readBuildFacts(store, BUILD)).value.log.restack.target).toBeUndefined()
})

test('concurrent conflicting observers reclassify after CAS contention', async () => {
  const { store, observe } = await fixture()
  await observe(A)
  const result = await Promise.all([observe(B), observe(C)])
  expect(result.sort()).toEqual(['moved', 'rejected'])
  const facts = (await readBuildFacts(store, BUILD)).value
  expect([B, C]).toContain(facts.log.restack.target!.sha)
  expect(facts.state.targetRewrite?.payload.previousSha).toBe(facts.log.restack.target?.sha)
})

test('restart with a completed restack and no previous target cannot admit an older base', async () => {
  const { leafTransaction } = await import('./generators/leaf-restack-log')
  const { store, observe } = await fixture()
  await store.append(BUILD, {
    actor: KERNEL,
    type: 'restack.completed',
    payload: {
      ...leafTransaction,
      targetBase: B,
      headSha: C,
    },
  })
  expect(await observe(A)).toBe('rejected')
  const facts = (await readBuildFacts(store, BUILD)).value
  expect(facts.log.restack.target).toBeUndefined()
  expect(facts.state.targetRewrite?.payload.previousSha).toBe(B)
})

test('node baselines use the parent contribution, and explicit reparent starts a new branch scope', async () => {
  const { MemoryBuildStore } = await import('../store/memory')
  const { DISPATCHER } = await import('../events/envelope')
  const store = new MemoryBuildStore()
  await store.createBuild({ slug: 'node', repo: 'repo', branch: 'ab-node/node' })
  await store.append('node', {
    actor: DISPATCHER,
    type: 'build.created',
    payload: {
      ticket: { source: 'fake', id: 'N' },
      repo: 'repo',
      baseBranch: 'main',
      kind: 'node',
    },
  })
  await store.append('node', { actor: DISPATCHER, type: 'node.opened', payload: { sha: B } })
  const forge = new FakeForge()
  forge.seedCommit(A)
  forge.seedCommit(B, [A])
  forge.seedCommit(C)
  const observe = (branch: string, sha: string) =>
    observeTarget({
      store,
      forge,
      slug: 'node',
      branch,
      sha,
      actor: KERNEL,
      enforceUsedBaseline: true,
    })
  expect(await observe('main', A)).toBe('rejected')
  expect(
    (await readBuildFacts(store, 'node')).value.state.nodeRestack?.observedParent,
  ).toBeUndefined()
  await store.append('node', {
    actor: DISPATCHER,
    type: 'node.parent-accepted',
    payload: {
      id: 'reparent',
      old: { branch: 'main', target: null },
      next: { branch: 'other', target: null },
      revision: '2',
    },
  })
  expect(await observe('other', C)).toBe('moved')
  const facts = (await readBuildFacts(store, 'node')).value
  expect(facts.state.targetRewrite).toBeUndefined()
  expect(facts.state.nodeRestack?.observedParent?.sha).toBe(C)
})

test('unchanged accepted tips and repeated rejected pairs require no ancestry requests', async () => {
  const { forge, observe } = await fixture()
  let proofs = 0
  const prove = forge.isCommitAncestor.bind(forge)
  forge.isCommitAncestor = async (a, b) => {
    proofs++
    return prove(a, b)
  }
  await observe(A)
  await observe(B)
  expect(proofs).toBe(1)
  await observe(B)
  expect(proofs).toBe(1)
  await observe(A)
  expect(proofs).toBe(2)
  await observe(A)
  expect(proofs).toBe(2)
})
