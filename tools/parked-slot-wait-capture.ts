import {
  buildDashboardFromProjected,
  type DashboardModel,
} from '../packages/core/src/cli/dashboard/model'

/** The model with a finished work row parked for a merge decision on an open
 * PR and waiting to reconcile ahead of new ticket claims. The row alert and
 * the capacity notice come from the shared projection, as in both live
 * dashboards. */
export function parkedSlotWaitCapture(model: DashboardModel): DashboardModel {
  const parked = model.builds.find((build) => build.integrationRow === undefined && build.pr)
  if (parked === undefined) return model
  const frame = buildDashboardFromProjected(
    model.builds.map(({ alert: _, ...build }) =>
      build.slug === parked.slug
        ? { ...build, pr: { ...build.pr!, state: 'open' as const } }
        : build,
    ),
    {
      repo: model.repo,
      queued: model.queued,
      activeCount: model.active.current,
      capacity: model.active.limit,
      capacityProjection: {
        configured: model.active.limit,
        occupied: model.active.limit,
        effective: model.active.limit,
        borrowingNodes: [],
        waitingBuilds: [{ slug: parked.slug, request: 'reconcile' }],
      },
    },
  )
  return {
    ...model,
    builds: frame.builds,
    active: frame.active,
    ...(frame.capacity ? { capacity: frame.capacity } : {}),
  }
}
