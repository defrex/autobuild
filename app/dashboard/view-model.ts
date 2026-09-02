import type { DashboardBuild, DashboardModel, StepTiming } from 'autobuild/operator-presentation'

function equalRow(a: DashboardBuild, b: DashboardBuild): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Keep React row identities stable when only generatedAt, leases, or heartbeats changed. */
export function reconcileDashboard(
  previous: DashboardModel | undefined,
  next: DashboardModel,
): DashboardModel {
  if (!previous) return next
  const oldRows = new Map(previous.builds.map((row) => [row.slug, row]))
  const builds = next.builds.map((row) => {
    const old = oldRows.get(row.slug)
    return old && equalRow(old, row) ? old : row
  })
  return { ...next, builds }
}

export function elapsedMilliseconds(
  timing: StepTiming | undefined,
  now = Date.now(),
): number | undefined {
  if (!timing) return undefined
  return (
    timing.accumulatedMs +
    (timing.runningSince === undefined ? 0 : Math.max(0, now - timing.runningSince))
  )
}

export interface DashboardParityProjection {
  builds: Array<{
    identity: string
    status: DashboardBuild['status']
    steps: Array<{
      label: string
      state: string
      qualifier?: string
      count?: number
      timing?: StepTiming
    }>
  }>
  harvest?: {
    identity: 'Harvest'
    run: string
    status: string
    steps: DashboardParityProjection['builds'][number]['steps']
  }
}

/** Semantic rows rendered by the browser, kept explicit for capture-fixture parity tests. */
export function projectWebParity(model: DashboardModel): DashboardParityProjection {
  const steps = (items: DashboardBuild['steps']) =>
    items.map((step) => ({
      label: step.label,
      state: step.state,
      ...(step.qualifier !== undefined ? { qualifier: step.qualifier } : {}),
      ...(step.count !== undefined ? { count: step.count } : {}),
      ...(step.timing !== undefined ? { timing: step.timing } : {}),
    }))
  return {
    builds: model.builds.map((build) => ({
      identity: build.slug,
      status: build.status,
      steps: steps(build.steps),
    })),
    ...(model.harvest
      ? {
          harvest: {
            identity: 'Harvest' as const,
            run: model.harvest.run,
            status: model.harvest.status,
            steps: steps(model.harvest.steps),
          },
        }
      : {}),
  }
}

export function formatElapsed(timing: StepTiming | undefined, now = Date.now()): string {
  const ms = elapsedMilliseconds(timing, now)
  if (ms === undefined) return ''
  const seconds = Math.floor(ms / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
