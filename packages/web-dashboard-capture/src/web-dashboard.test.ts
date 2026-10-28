import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DashboardModel } from '@defrex/autobuild/operator-presentation'
import {
  elapsedMilliseconds,
  projectWebParity,
  reconcileDashboard,
} from '../../hosted-store-service/app/dashboard/view-model'
import { captureDashboardFrames, FRAME_SPECS } from '../../../tools/dashboard-capture'

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
        ...(frame.model.rollback ? { rollback: frame.model.rollback } : {}),
        ...(frame.model.handoffs ? { handoffs: frame.model.handoffs } : {}),
        builds: frame.model.builds.map((build) => ({
          identity: build.slug,
          ...(build.draining ? { draining: true } : {}),
          status: build.status,
          ...(build.integrationRow ? { integrationRow: build.integrationRow } : {}),
          steps: (build.integrationRow?.steps ?? build.steps).map((step) => ({
            label: step.label,
            state: step.state,
            ...(step.qualifier !== undefined ? { qualifier: step.qualifier } : {}),
            ...(step.count !== undefined ? { count: step.count } : {}),
            ...(step.timing !== undefined ? { timing: step.timing } : {}),
            ...(step.reason !== undefined ? { reason: step.reason } : {}),
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
                  ...(step.reason !== undefined ? { reason: step.reason } : {}),
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
}, 60_000)

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
