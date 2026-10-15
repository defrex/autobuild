import type { AbEvent } from '../events/catalog'
import { DISPATCHER } from '../events/envelope'
import type { IdSource } from '../ids'
import { defineReducer } from '../kernel/incremental'
import type { BuildStore } from '../store/types'

interface DispatchBudgetAccumulator {
  failures: Extract<AbEvent, { type: 'dispatch.failed' }>[]
  open: string[]
  aborted: boolean
}

export function dispatchFailureBudgetReducer(infrastructureOwnsWorkspace: boolean) {
  return defineReducer({
    version: 1,
    initial: (): DispatchBudgetAccumulator => ({ failures: [], open: [], aborted: false }),
    fold(acc, events: readonly AbEvent[]) {
      for (const event of events) {
        if (event.type === 'runner.attached') {
          acc.failures = []
        } else if (
          event.type === 'escalation.raised' &&
          event.payload.source === 'policy' &&
          event.payload.policyCause === 'dispatch-failure-limit'
        ) {
          if (!acc.open.includes(event.payload.id)) acc.open.push(event.payload.id)
        } else if (event.type === 'escalation.answered' && acc.open.includes(event.payload.id)) {
          acc.open = acc.open.filter((id) => id !== event.payload.id)
          if (event.payload.resolution !== 'abort') acc.failures = []
          else acc.aborted = true
        } else if (
          event.type === 'dispatch.failed' &&
          !(infrastructureOwnsWorkspace && event.payload.stage === 'workspace')
        ) {
          acc.failures.push(event)
        }
      }
    },
    finish: (acc) => ({
      count: acc.failures.length,
      latest: acc.failures.at(-1),
      parked: acc.aborted || acc.open.length > 0,
    }),
  })
}

/** Lifetime diagnostic attempt numbers are deliberately independent of this epoch. */
export function dispatchFailureBudget(
  events: readonly AbEvent[],
  infrastructureOwnsWorkspace: boolean,
) {
  return dispatchFailureBudgetReducer(infrastructureOwnsWorkspace).reduce(events)
}

/** Repair the failure/raise crash gap before allowing another provider call. */
export async function ensureDispatchBudget(
  store: Pick<BuildStore, 'getEvents' | 'appendIfCurrent'>,
  ids: IdSource,
  slug: string,
  maxAttempts: number,
  infrastructureOwnsWorkspace: boolean,
): Promise<boolean> {
  for (;;) {
    const events = await store.getEvents(slug)
    const budget = dispatchFailureBudget(events, infrastructureOwnsWorkspace)
    if (budget.parked) return false
    if (budget.count < maxAttempts || budget.latest === undefined) return true
    const failure = budget.latest.payload
    const raised = await store.appendIfCurrent(slug, events.at(-1)?.seq ?? 0, {
      actor: DISPATCHER,
      type: 'escalation.raised',
      payload: {
        id: ids('esc'),
        phase: 'setup',
        source: 'policy',
        policyCause: 'dispatch-failure-limit',
        question: `maxDispatchAttempts (${maxAttempts}) exhausted during ${failure.stage}: ${failure.error}`,
        refs: [],
      },
    })
    if (raised !== null) return false
  }
}
