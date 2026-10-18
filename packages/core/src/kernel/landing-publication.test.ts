import { expect, test } from 'bun:test'
import { MemoryBuildStore } from '../store/memory'
import { FakeForge } from '../ports/forge/fake'
import { KERNEL, humanActor } from '../events/envelope'
import { suspendNativeLanding } from './landing-publication'
import { readBuildFacts } from '../store/reduced-reads'

async function fixture() {
  const store = new MemoryBuildStore()
  await store.createBuild({ slug: 'build', repo: '/repo' })
  await store.append('build', {
    actor: KERNEL,
    type: 'finalize.completed',
    payload: { pr: { number: 1, url: 'https://forge/pr/1', headSha: 'old' } },
  })
  const decision = await store.append('build', {
    actor: KERNEL,
    type: 'landing.decided',
    payload: {
      candidate: { head: 'old', parent: 'base', cycle: '1' },
      from: 'leaf',
      into: { kind: 'root' },
      labels: [],
      mode: 'consent',
      rule: { default: true },
    },
  })
  const command = await store.append('build', {
    actor: humanActor('operator'),
    type: 'build.land-requested',
    payload: { decisionSeq: decision.seq },
  })
  const forge = new FakeForge()
  forge.setPrState(1, { state: 'open', mergeable: true })
  await forge.setAutoMerge('/repo', 1, true)
  return { store, forge, slug: 'build', workspacePath: '/repo', command }
}
test('replacement cancellation is confirmed and preserves landing consent across retries', async () => {
  const h = await fixture()
  await suspendNativeLanding(h, 'replacement')
  await suspendNativeLanding(h, 'replacement')
  expect(h.forge.isAutoMergeEnabled(1)).toBe(false)
  const state = (await readBuildFacts(h.store, h.slug)).value.state
  expect(state.landing?.command?.seq).toBe(h.command.seq)
  expect(state.landing?.native).toMatchObject({
    enabled: false,
    operation: 'replacement',
    candidate: { head: 'old' },
  })
})
test('unconfirmed cancellation blocks publication and records no receipt', async () => {
  const h = await fixture()
  h.forge.setAutoMerge = async () => ({ kind: 'deferred' })
  await expect(suspendNativeLanding(h, 'replacement')).rejects.toThrow('publication suspended')
  expect((await readBuildFacts(h.store, h.slug)).value.state.landing?.native).toBeUndefined()
})
test('a concurrent merge is settled instead of publishing a replacement', async () => {
  const h = await fixture()
  const set = h.forge.setAutoMerge.bind(h.forge)
  h.forge.setAutoMerge = async (...args) => {
    const result = await set(...args)
    h.forge.setPrState(1, { state: 'merged', sha: 'landed' })
    return result
  }
  await expect(suspendNativeLanding(h, 'replacement')).rejects.toThrow(
    'settle it before publishing',
  )
})
