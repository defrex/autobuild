import { dashboardWaitFrom, type DashboardModel } from '../packages/core/src/cli/dashboard/model'

/** The capture's waiting row: the tickets it waits on and when it began. */
export const TICKET_WAIT_TICKETS = ['CAP-API', 'CAP-SCHEMA']

/** The model with one active work row parked on a ticket wait, beside the
 * scenario's blocked row so waiting and blocked render side by side. The
 * wait's wording comes from the shared projection builder, as in both live
 * dashboards; a waiting build holds no slot, so it leaves the active count. */
export function ticketWaitCapture(model: DashboardModel): DashboardModel {
  // A row without a PR, chosen so another row stays BLOCKED beside it.
  const waiting = model.builds.find(
    (build) =>
      build.integrationRow === undefined &&
      build.pr === undefined &&
      (build.status === 'running' || build.status === 'blocked') &&
      model.builds.some((other) => other !== build && other.status === 'blocked'),
  )
  if (waiting === undefined) return model
  const wait = dashboardWaitFrom({
    tickets: TICKET_WAIT_TICKETS,
    reason: 'needs the new API schema',
    since: '2026-07-15T12:02:00.000Z',
    escalation: 'esc_capture_wait',
    question: `Waiting on ${TICKET_WAIT_TICKETS.join(', ')} to complete: needs the new API schema.`,
  })
  const released = waiting.slot?.state === 'held' ? 1 : 0
  return {
    ...model,
    active: { ...model.active, current: Math.max(0, model.active.current - released) },
    builds: model.builds.map((build) =>
      build.slug === waiting.slug
        ? {
            ...build,
            status: 'waiting' as const,
            slot: { state: 'none' as const },
            statusBasis: { resting: 'waiting' as const, runner: false, waitTickets: wait.tickets },
            blockers: [],
            wait,
            // A parked build's open step stops ticking while it waits.
            steps: build.steps.map(({ timing, ...step }) =>
              timing === undefined
                ? step
                : { ...step, timing: { accumulatedMs: timing.accumulatedMs } },
            ),
          }
        : build,
    ),
  }
}

/** The slug the capture rewrites, for detail and page frames. */
export function ticketWaitSlug(model: DashboardModel): string | undefined {
  return ticketWaitCapture(model).builds.find((build) => build.status === 'waiting')?.slug
}
