import type { DashboardBuild, DashboardHarvest, DashboardModel, EffectiveStatus } from './model'

export type DashboardBuildControl =
  | { key: 'p'; action: 'pause'; label: 'pause' }
  | { key: 'p'; action: 'cancel-pause'; label: 'cancel pause' }
  | { key: 'r'; action: 'resume'; label: 'resume' }

/** Authoritative effective-status mapping consumed by every dashboard frontend. */
export function dashboardBuildControl(status: EffectiveStatus): DashboardBuildControl | undefined {
  switch (status) {
    case 'running':
      return { key: 'p', action: 'pause', label: 'pause' }
    case 'pausing':
      return { key: 'p', action: 'cancel-pause', label: 'cancel pause' }
    case 'paused':
    case 'blocked':
      return { key: 'r', action: 'resume', label: 'resume' }
    case 'queued':
    case 'resuming':
    case 'aborting':
    case 'cleaning':
      return undefined
  }
}

export interface DashboardActionAvailability {
  primary?: DashboardBuildControl['action']
  abort: boolean
  discard: boolean
  autoMerge: boolean
  answer: boolean
}

export function buildActionAvailability(build: DashboardBuild): DashboardActionAvailability {
  return {
    ...(dashboardBuildControl(build.status)
      ? { primary: dashboardBuildControl(build.status)!.action }
      : {}),
    abort: ['queued', 'running', 'pausing', 'paused', 'resuming', 'blocked'].includes(build.status),
    discard: build.status === 'queued',
    autoMerge: !['aborting', 'cleaning'].includes(build.status),
    answer: build.blockers.length > 0,
  }
}

export function repositoryActionAvailability(model: DashboardModel) {
  return {
    intake: true,
    defaultAutoMerge: true,
    bulkPause: model.builds.some((build) => build.status === 'running'),
    bulkResume: model.builds.some((build) => build.status === 'paused'),
    harvestToggle: true,
    harvestRun: model.harvestPaused === false,
  }
}

export function harvestActionAvailability(harvest: DashboardHarvest | undefined) {
  return { resume: harvest?.action === 'resume', acknowledge: harvest?.action === 'acknowledge' }
}
