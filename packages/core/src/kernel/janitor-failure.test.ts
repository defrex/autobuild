import { expect, test } from 'bun:test'
import { MemoryBuildStore } from '../store/memory'
import { manualClock } from '../testing/fixed'
import { readBuildFacts } from '../store/reduced-reads'
import { DISPATCHER } from '../events/envelope'
import { recordJanitorFailure } from './janitor-failure'

test('durable janitor episode doubles retries, caps them and emits attention once before recovery', async () => {
  const clock = manualClock()
  const store = new MemoryBuildStore({ clock })
  await store.createBuild({ slug: 'failing', repo: 'r' })
  const policy = { janitorBackoffMaxSeconds: 300, janitorFailureAttentionSeconds: 600 }
  for (const delay of [30, 60, 120, 240, 300, 300, 300]) {
    const previous = (await readBuildFacts(store, 'failing')).value.state.janitor
    const at = clock()
    await recordJanitorFailure(store, 'failing', previous, `error ${delay}`, at, policy)
    const current = (await readBuildFacts(store, 'failing')).value.state.janitor!
    expect(Date.parse(current.nextAttemptAt) - at.getTime()).toBe(delay * 1000)
    expect(current.firstFailureAt).toBe('2026-07-15T12:00:00.000Z')
    clock.advance(delay * 1000)
  }
  expect(
    (await store.getEvents('failing')).filter((e) => e.type === 'build.janitor-failing'),
  ).toHaveLength(1)
  expect((await readBuildFacts(store, 'failing')).value.state.janitor?.attention).toBe(true)
  await store.append('failing', { actor: DISPATCHER, type: 'build.janitor-recovered', payload: {} })
  expect((await readBuildFacts(store, 'failing')).value.state.janitor).toBeUndefined()
  await recordJanitorFailure(store, 'failing', undefined, 'new episode', clock(), {
    ...policy,
    janitorBackoffMaxSeconds: 7,
  })
  const next = (await readBuildFacts(store, 'failing')).value.state.janitor!
  expect(next.attempt).toBe(1)
  expect(Date.parse(next.nextAttemptAt) - clock().getTime()).toBe(7000)
  expect(next.attention).toBeUndefined()
})
