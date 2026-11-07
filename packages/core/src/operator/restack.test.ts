import { expect, test } from 'bun:test'
import { MemoryBuildStore } from '../store/memory'
import { DISPATCHER, KERNEL } from '../events/envelope'
import { requestNodeRestack } from './restack'

async function fixture(kind: 'node' | 'work' = 'node', opened = true) {
  const store = new MemoryBuildStore({ clock: () => new Date() })
  await store.createBuild({ slug: 'demo', repo: 'repo', branch: 'ab-node/demo' })
  await store.append('demo', {
    actor: DISPATCHER,
    type: 'build.created',
    payload: { repo: 'repo', ticket: { source: 'file', id: 'N' }, baseBranch: 'main', kind },
  })
  if (opened && kind === 'node')
    await store.append('demo', {
      actor: DISPATCHER,
      type: 'node.opened',
      payload: { sha: 'a'.repeat(40) },
    })
  return store
}
test('operator restack coalesces durably with human attribution, even while paused', async () => {
  const store = await fixture()
  await store.append('demo', { actor: KERNEL, type: 'build.paused', payload: {} })
  const input = { store, repo: 'repo', slug: 'demo', user: 'maintainer' }
  const first = await requestNodeRestack(input)
  expect(first.waiting).toBe(true)
  expect(first.coalesced).toBe(false)
  expect((await requestNodeRestack(input)).request.id).toBe(first.request.id)
  const events = await store.getEvents('demo')
  expect(events.filter((e) => e.type === 'node.restack-requested')).toHaveLength(1)
  expect(events.at(-1)!.actor).toMatchObject({ kind: 'human' })
  await expect(requestNodeRestack({ ...input, repo: 'foreign' })).rejects.toThrow('unknown build')
})
test('operator restack refuses leaves, unopened and terminal nodes', async () => {
  for (const [kind, opened, message] of [
    ['work', true, 'not a node'],
    ['node', false, 'no open branch'],
  ] as const) {
    const store = await fixture(kind, opened)
    await expect(
      requestNodeRestack({ store, repo: 'repo', slug: 'demo', user: 'operator' }),
    ).rejects.toThrow(message)
  }
  const store = await fixture()
  await store.append('demo', { actor: KERNEL, type: 'build.aborted', payload: {} })
  await expect(
    requestNodeRestack({ store, repo: 'repo', slug: 'demo', user: 'operator' }),
  ).rejects.toThrow('terminal')
})
