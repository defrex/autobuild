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
    ['waiting', 'resume'],
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
    // A waiting build has no blockers; its open wait is what answering ends.
    expect(
      buildActionAvailability({
        ...row('waiting'),
        wait: {
          tickets: ['B'],
          reason: 'needs B',
          since: '2026-11-16T00:00:00.000Z',
          escalation: 'esc_w',
          question: 'Waiting on B to complete: needs B.',
          text: 'waiting on B — needs B',
        },
      }),
    ).toMatchObject({ primary: 'resume', abort: true, answer: true })
    expect(buildActionAvailability(row('waiting'))).toMatchObject({ answer: false })
    expect(buildActionAvailability(row('aborting'))).toMatchObject({
      abort: false,
      autoMerge: false,
    })
    const model = { builds: [row('running'), row('paused')] } as DashboardModel
    expect(repositoryActionAvailability(model)).toMatchObject({ bulkPause: true, bulkResume: true })
  })
})

test.each(['collecting', 'verification failed'] as const)(
  'integration consent remains revocable while %s',
  (integration) => {
    for (const autoMerge of ['requested', 'enabled', 'cancelling'] as const)
      expect(
        buildActionAvailability({
          ...row('collecting'),
          kind: 'integration',
          integration,
          autoMerge,
        }).autoMerge,
      ).toBe(true)
    expect(
      buildActionAvailability({
        ...row('collecting'),
        kind: 'integration',
        integration,
        autoMerge: 'off',
      }).autoMerge,
    ).toBe(true)
    expect(
      buildActionAvailability({
        ...row('aborting'),
        kind: 'integration',
        integration,
        autoMerge: 'requested',
      }).autoMerge,
    ).toBe(false)
  },
)
