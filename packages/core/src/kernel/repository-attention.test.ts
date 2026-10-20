import type { RepositoryEvent } from '../events/repository'
import { expect, test } from 'bun:test'
import { MemoryBuildStore } from '../store/memory'
import { DISPATCHER } from '../events/envelope'
import { manualClock } from '../testing/fixed'
import { RepositoryAttention } from './repository-attention'

test('forge persistence requires a post-reset retry and repeated resets cannot postpone its episode', async () => {
  const clock = manualClock('2026-10-20T00:00:00.000Z')
  const store = new MemoryBuildStore({ clock })
  await store.ensureRepo('r')
  const append = async (event: Parameters<typeof store.appendRepo>[1]) =>
    store.appendRepo('r', event) as Promise<RepositoryEvent>
  await append({
    actor: DISPATCHER,
    type: 'dispatcher.forge-degraded',
    payload: {
      forge: 'github',
      message: 'primary limit',
      firstFailureAt: clock().toISOString(),
      resetAt: '2026-10-20T00:01:00.000Z',
    },
  })
  const attention = new RepositoryAttention()
  for (const event of await store.getRepoEvents('r')) attention.fold(event)
  clock.advance(60_000)
  expect(attention.pending(clock())).toEqual([])
  const start = await append({
    actor: DISPATCHER,
    type: 'dispatcher.tick-started',
    payload: { run: 'new-run', startedAt: clock().toISOString() },
  })
  attention.fold(start)
  attention.fold(
    await append({
      actor: DISPATCHER,
      type: 'dispatcher.forge-degraded',
      payload: {
        forge: 'github',
        message: 'secondary limit',
        firstFailureAt: '2026-10-20T00:00:00.000Z',
        resetAt: '2026-10-20T00:05:00.000Z',
      },
    }),
  )
  attention.fold(
    await append({
      actor: DISPATCHER,
      type: 'dispatcher.tick-failed',
      payload: { run: 'new-run', error: 'limited again' },
    }),
  )
  const restarted = new RepositoryAttention(attention.snapshot())
  expect(restarted.pending(clock()).map((x) => x.observation.type)).toEqual([
    'dispatcher.forge-persistent',
  ])
  restarted.fold(
    await append({
      actor: DISPATCHER,
      type: 'dispatcher.forge-recovered',
      payload: { forge: 'github' },
    }),
  )
  expect(restarted.pending(clock())).toEqual([])
})
