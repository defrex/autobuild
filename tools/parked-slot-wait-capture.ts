import {
  buildDashboardFromProjected,
  type DashboardModel,
} from '../packages/core/src/cli/dashboard/model'
import type { SlotState } from '../packages/core/src/kernel/dispatch-capacity'

/** The model with a finished work row parked for a merge decision on an open
 * PR and waiting to reconcile ahead of normal ticket claims. The row alert and
 * the capacity notice come from the shared projection, as in both live
 * dashboards. */
export function parkedSlotWaitCapture(model: DashboardModel): DashboardModel {
  const parked = model.builds.find((build) => build.integrationRow === undefined && build.pr)
  if (parked === undefined) return model
  // Every other row keeps its slot; the parked row asks for one to reconcile.
  const slots: Record<string, SlotState> = {
    ...Object.fromEntries(
      model.builds.flatMap((build) => (build.slot ? [[build.slug, build.slot]] : [])),
    ),
    [parked.slug]: { state: 'requested', request: 'reconcile' },
  }
  const frame = buildDashboardFromProjected(
    model.builds.map(({ alert: _, ...build }) =>
      build.slug === parked.slug
        ? { ...build, pr: { ...build.pr!, state: 'open' as const } }
        : build,
    ),
    {
      repo: model.repo,
      queued: model.queued,
      activeCount: Object.values(slots).filter((slot) => slot.state === 'held').length,
      capacity: model.active.limit,
      capacityProjection: {
        configured: model.active.limit,
        occupied: Object.values(slots).filter((slot) => slot.state === 'held').length,
        effective: model.active.limit,
        borrowingNodes: [],
        waitingBuilds: [{ slug: parked.slug, request: 'reconcile' }],
        slots,
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
