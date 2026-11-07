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

test('publication retry confirms one receipt; a new attempt and external enable are distinct', async () => {
  const h = await fixture()
  const start = h.forge.autoMergeCalls.length
  await suspendNativeLanding(h, 'publication:10')
  const first = await h.store.getEvents(h.slug)
  await suspendNativeLanding(h, 'publication:10')
  expect(await h.store.getEvents(h.slug)).toEqual(first)
  expect(h.forge.autoMergeCalls.length - start).toBe(1)
  await suspendNativeLanding(h, 'publication:11')
  expect((await h.store.getEvents(h.slug)).length).toBe(first.length + 1)
  // Disabled readback can confirm the new operation without another mutation.
  expect(h.forge.autoMergeCalls.length - start).toBe(1)
  await h.forge.setAutoMerge('/repo', 1, true)
  await suspendNativeLanding(h, 'publication:11')
  expect(h.forge.isAutoMergeEnabled(1)).toBe(false)
  expect((await h.store.getEvents(h.slug)).length).toBe(first.length + 2)
})

test('unknown native state requires cancellation despite a matching disabled receipt', async () => {
  const h = await fixture()
  await suspendNativeLanding(h, 'publication:10')
  const read = h.forge.getPrState.bind(h.forge)
  h.forge.getPrState = async (...args) => {
    const state = await read(...args)
    return state.state === 'open' ? { ...state, nativeAutoMerge: undefined } : state
  }
  h.forge.setAutoMerge = async () => ({ kind: 'deferred' })
  await expect(suspendNativeLanding(h, 'publication:10')).rejects.toThrow('publication suspended')
})

test('legacy receipts without publication head scope require a new confirmation', async () => {
  const h = await fixture()
  await h.forge.setAutoMerge('/repo', 1, false)
  const state = (await readBuildFacts(h.store, h.slug)).value.state
  await h.store.append(h.slug, {
    actor: KERNEL,
    type: 'landing.native-applied',
    payload: {
      enabled: false,
      operation: 'publication:10',
      candidate: state.landing!.decision!.candidate,
      decisionSeq: state.landing!.decision!.seq,
      commandSeq: state.landing!.command!.seq,
    },
  })
  const before = (await h.store.getEvents(h.slug)).length
  await suspendNativeLanding(h, 'publication:10')
  expect((await h.store.getEvents(h.slug)).length).toBe(before + 1)
  await suspendNativeLanding(h, 'publication:10')
  expect((await h.store.getEvents(h.slug)).length).toBe(before + 1)
})
