import { describe, expect, test } from 'bun:test'
import {
  buildActionAvailability,
  dashboardBuildControl,
  repositoryActionAvailability,
} from './actions'
import type { DashboardBuild, DashboardModel, EffectiveStatus } from './model'

const row = (status: EffectiveStatus): DashboardBuild => ({
  slug: status,
  status,
  alsoPaused: false,
  steps: [],
  blockers: [],
  autoMerge: 'off',
})

describe('shared dashboard action availability', () => {
  test.each([
    ['queued', undefined],
    ['running', 'pause'],
    ['pausing', 'cancel-pause'],
    ['paused', 'resume'],
    ['blocked', 'resume'],
    ['resuming', undefined],
    ['aborting', undefined],
    ['cleaning', undefined],
  ] as const)('%s primary control', (status, action) => {
    expect(dashboardBuildControl(status)?.action).toBe(action)
  })

  test('covers destructive, merge, answer and repository controls', () => {
    expect(buildActionAvailability(row('queued'))).toMatchObject({
      discard: true,
      abort: true,
      autoMerge: true,
      answer: false,
    })
    expect(buildActionAvailability({ ...row('blocked'), blockers: ['question'] })).toMatchObject({
      primary: 'resume',
      answer: true,
    })
    expect(buildActionAvailability(row('aborting'))).toMatchObject({
      abort: false,
      autoMerge: false,
    })
    const model = { builds: [row('running'), row('paused')] } as DashboardModel
    expect(repositoryActionAvailability(model)).toMatchObject({ bulkPause: true, bulkResume: true })
  })
})
