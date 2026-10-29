import { expect, test } from 'bun:test'
import { MemoryBuildStore } from '../store/memory'
import { clearForgeDegradation } from './control'
import { forgeHealthReducer } from '../kernel/forge-health'
import { RepositoryAttention } from '../kernel/repository-attention'

test('explicit recovery is attributed, reasoned and clears historical degradation without reading history', async () => {
  const store = new MemoryBuildStore()
  await store.ensureRepo('r')
  await store.appendRepo('r', {
    actor: { kind: 'kernel' },
    type: 'dispatcher.forge-degraded',
    payload: {
      forge: 'github',
      message: 'bad deadline',
      resetAt: '9999-01-01T00:00:00Z',
      firstFailureAt: '2026-01-01T00:00:00Z',
    },
  })
  const opts = { store, repo: 'r', user: 'Ada', forge: 'github', reason: ' erroneous deadline ' }
  for (const invalid of [{ reason: ' ' }, { forge: ' ' }, { user: ' ' }])
    await expect(clearForgeDegradation({ ...opts, ...invalid })).rejects.toThrow()
  expect((await store.getRepoEvents('r')).length).toBe(1)
  const readEvents = store.getRepoEvents.bind(store)
  store.getRepoEvents = async () => {
    throw new Error('control must not read history')
  }
  const result = await clearForgeDegradation(opts)
  store.getRepoEvents = readEvents
  expect(result.event.actor).toEqual({ kind: 'human', user: 'Ada' })
  expect(result.event.payload).toEqual({ forge: 'github', reason: 'erroneous deadline' })
  const events = await store.getRepoEvents('r')
  expect(forgeHealthReducer.reduce(events)).toBeUndefined()
  const attention = new RepositoryAttention()
  for (const event of events) attention.fold(event)
  expect(attention.pending(new Date('9999-01-02'))).toEqual([])
})
