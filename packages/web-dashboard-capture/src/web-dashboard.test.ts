import { expect, test } from 'bun:test'
import type { DashboardModel } from '@defrex/autobuild/operator-presentation'
import {
  elapsedMilliseconds,
  projectWebParity,
  reconcileDashboard,
} from '../../hosted-store-service/app/dashboard/view-model'

function model(status: 'running' | 'paused' = 'running'): DashboardModel {
  return {
    repo: 'owner/repo',
    queued: 0,
    active: { current: 1, limit: 2 },
    drained: false,
    repositoryPaused: false,
    defaultAutoMerge: false,
    harvestPaused: false,
    builds: [
      { slug: 'demo', status, alsoPaused: false, steps: [], blockers: [], autoMerge: 'off' },
    ],
  }
}

test('web polling preserves equal rows and replaces changed facts', () => {
  const previous = model()
  const equal = reconcileDashboard(previous, model())
  expect(equal.builds[0]).toBe(previous.builds[0])
  const changed = reconcileDashboard(previous, model('paused'))
  expect(changed.builds[0]).not.toBe(previous.builds[0])
})

test('elapsed presentation ticks without replacing model rows', () => {
  expect(elapsedMilliseconds({ accumulatedMs: 500, runningSince: 1_000 }, 2_500)).toBe(2_000)
  expect(elapsedMilliseconds({ accumulatedMs: 500 }, 99_000)).toBe(500)
})

test('repository-only draining changes replace that row and retain unrelated row identity', async () => {
  const { handoffCapture } = await import('../../../tools/handoff-capture')
  const base = model()
  base.builds.push({ ...base.builds[0]!, slug: 'other' })
  const active = handoffCapture(base)
  const settled = reconcileDashboard(active, handoffCapture(active, 'settled'))
  expect(settled.builds[0]).not.toBe(active.builds[0])
  expect(settled.builds[1]).toBe(active.builds[1])
  expect(projectWebParity(active).builds[0]?.draining).toBe(true)
})

test('polling removes resolved rollback notices while retaining equal row identities', async () => {
  const { rollbackCapture } = await import('../../../tools/rollback-capture')
  const active = rollbackCapture(model())
  expect(projectWebParity(active).rollback).toEqual(active.rollback)
  for (const stage of ['cleared', 'restarted'] as const) {
    const next = reconcileDashboard(active, rollbackCapture(active, stage))
    expect(next.rollback).toBeUndefined()
    expect(next.builds[0]).toBe(active.builds[0])
    expect(projectWebParity(next).rollback).toBeUndefined()
  }
})
