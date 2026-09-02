import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DashboardModel } from 'autobuild/operator-presentation'
import {
  elapsedMilliseconds,
  projectWebParity,
  reconcileDashboard,
} from '../app/dashboard/view-model'
import { captureDashboardFrames, FRAME_SPECS } from './dashboard-capture'

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

test('every terminal capture fixture has identical web rows and step facts', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'ab-web-parity-'))
  try {
    const capture = await captureDashboardFrames({ workspacePath: workspace })
    expect(capture.frames.map((frame) => frame.id)).toEqual(FRAME_SPECS.map((frame) => frame.id))
    for (const frame of capture.frames) {
      const terminal = {
        builds: frame.model.builds.map((build) => ({
          identity: build.slug,
          status: build.status,
          steps: build.steps.map((step) => ({
            label: step.label,
            state: step.state,
            ...(step.qualifier !== undefined ? { qualifier: step.qualifier } : {}),
            ...(step.count !== undefined ? { count: step.count } : {}),
            ...(step.timing !== undefined ? { timing: step.timing } : {}),
          })),
        })),
        ...(frame.model.harvest
          ? {
              harvest: {
                identity: 'Harvest' as const,
                run: frame.model.harvest.run,
                status: frame.model.harvest.status,
                steps: frame.model.harvest.steps.map((step) => ({
                  label: step.label,
                  state: step.state,
                  ...(step.qualifier !== undefined ? { qualifier: step.qualifier } : {}),
                  ...(step.count !== undefined ? { count: step.count } : {}),
                  ...(step.timing !== undefined ? { timing: step.timing } : {}),
                })),
              },
            }
          : {}),
      }
      expect(projectWebParity(frame.model), frame.id).toEqual(terminal)
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}, 30_000)

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
