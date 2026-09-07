import { expect, test } from 'bun:test'
import type { DashboardBuild, DashboardModel } from 'autobuild/operator-presentation'
import { dashboardImperative } from './imperative'

function build(overrides: Partial<DashboardBuild> = {}): DashboardBuild {
  return {
    slug: 'demo',
    status: 'running',
    alsoPaused: false,
    steps: [],
    blockers: [],
    autoMerge: 'off',
    ...overrides,
  }
}

function model(builds: DashboardBuild[], harvest?: DashboardModel['harvest']): DashboardModel {
  return {
    repo: 'owner/repo',
    queued: 0,
    active: { current: builds.length, limit: 4 },
    observations: { current: 0, limit: 5 },
    drained: false,
    repositoryPaused: false,
    defaultAutoMerge: false,
    harvestPaused: false,
    builds,
    ...(harvest ? { harvest } : {}),
  }
}

test('a quiet frame carries no imperative', () => {
  expect(dashboardImperative(model([build()]))).toBeUndefined()
  expect(dashboardImperative(model([]))).toBeUndefined()
})

test('blocked outranks everything and counts every parked row', () => {
  const value = dashboardImperative(
    model([
      build({ slug: 'a', status: 'blocked', blockers: ['why?'] }),
      build({ slug: 'b', setupError: 'workspace failed' }),
      build({ slug: 'c', pr: { url: 'https://forge/pr/1', state: 'open' } }),
      build({ slug: 'd', status: 'running', blockers: ['also parked'] }),
    ]),
  )
  expect(value).toEqual({ word: 'BLOCKED', tone: 'alert', count: 2 })
})

test('an escalated harvest run is a blocked frame', () => {
  const value = dashboardImperative(
    model([build()], {
      kind: 'harvest',
      run: 'h1',
      status: 'escalated',
      steps: [],
      observations: 3,
      rounds: 1,
    }),
  )
  expect(value).toEqual({ word: 'BLOCKED', tone: 'alert', count: 1 })
})

test('failures outrank pull requests', () => {
  const value = dashboardImperative(
    model([
      build({ slug: 'a', pr: { url: 'https://forge/pr/1', state: 'conflicted' } }),
      build({ slug: 'b', pr: { url: 'https://forge/pr/2', state: 'open' } }),
    ]),
  )
  expect(value).toEqual({ word: 'FAILED', tone: 'alert', count: 1 })
})

test('an open pull request reads PR READY, a merged one reads MERGED', () => {
  expect(
    dashboardImperative(model([build({ pr: { url: 'https://forge/pr/1', state: 'open' } })])),
  ).toEqual({ word: 'PR READY', tone: 'ready', count: 1 })
  expect(
    dashboardImperative(model([build({ pr: { url: 'https://forge/pr/1', state: 'merged' } })])),
  ).toEqual({ word: 'MERGED', tone: 'ready', count: 1 })
})
