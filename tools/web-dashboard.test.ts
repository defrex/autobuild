import { expect, test } from 'bun:test'
import type { DashboardModel } from 'autobuild/operator-presentation'
import { elapsedMilliseconds, reconcileDashboard } from '../app/dashboard/view-model'

function model(status: 'running' | 'paused' = 'running'): DashboardModel {
  return {
    repo: 'owner/repo',
    queued: 0,
    active: { current: 1, limit: 2 },
    observations: { current: 0, limit: 5 },
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
