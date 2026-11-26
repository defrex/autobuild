/** Status surfaces name an urgent build's slot-admission priority (SPEC §12
 * "Slot admission order"); normal builds stay unmarked. */
import { expect, test } from 'bun:test'
import { DISPATCHER, humanActor } from '../events/envelope'
import { MemoryBuildStore } from '../store/memory'
import { detail, renderDetail, renderSummaries, summarize, summarizeFrom } from './status'
import { reduceBuild } from '../kernel/reducer'

const now = new Date('2026-11-20T00:00:00Z')

async function seeded(priority?: 'urgent') {
  const store = new MemoryBuildStore()
  const record = await store.createBuild({ slug: 'expedite', repo: '/repo' })
  await store.append(record.slug, {
    actor: DISPATCHER,
    type: 'build.created',
    payload: {
      ticket: { source: 'fake', id: 'T-1' },
      repo: '/repo',
      baseBranch: 'main',
      ...(priority !== undefined ? { priority } : {}),
    },
  })
  return { store, record }
}

test('a normal build carries no priority in JSON or text', async () => {
  const { store, record } = await seeded()
  const events = await store.getEvents(record.slug)
  const summary = summarize(record, events, now)
  expect(summary).not.toHaveProperty('priority')
  expect(renderSummaries([summary], now, '').join('\n')).not.toContain('URGENT')
  expect(renderDetail(detail(record, events, now), now)).not.toContain('  priority: urgent')
})

test('an urgent build is marked in JSON, the builds row and build status', async () => {
  const { store, record } = await seeded('urgent')
  const events = await store.getEvents(record.slug)
  const summary = summarize(record, events, now)
  expect(summary.priority).toBe('urgent')
  expect(renderSummaries([summary], now, '')[1]).toContain('URGENT')
  expect(renderDetail(detail(record, events, now), now)).toContain('  priority: urgent')
})

test('a slot wait names the waiter priority', async () => {
  const { store, record } = await seeded()
  await store.append(record.slug, {
    actor: humanActor('operator'),
    type: 'build.priority-set',
    payload: { priority: 'urgent' },
  })
  const state = reduceBuild(await store.getEvents(record.slug))
  const urgent = { ...summarizeFrom(record, state, now), slotWait: 'reconcile' as const }
  expect(renderSummaries([urgent], now, '')[1]).toContain(
    'urgent reconcile waiting for a slot ahead of normal work',
  )
  const normal = {
    ...summarizeFrom(record, { ...state, priority: 'normal' }, now),
    slotWait: 'reconcile' as const,
  }
  expect(renderSummaries([normal], now, '')[1]).toContain(
    'reconcile waiting for a slot ahead of normal ticket claims',
  )
})
