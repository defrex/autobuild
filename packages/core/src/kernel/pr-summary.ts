import { defineReducer } from './incremental'
import type { AbEvent } from '../events/catalog'

/** Latest completed occurrence only: never replay an obsolete publication backlog. */
export const summaryBoundaryReducer = defineReducer<
  {
    occurrence?: number
    boundary?: number
    sessions: Record<string, true>
  },
  AbEvent,
  { occurrence: number; boundary: number } | undefined
>({
  version: 1,
  initial: () => ({ sessions: {} }),
  fold(acc, events) {
    for (const event of events) {
      if (
        [
          'plan.started',
          'plan-review.started',
          'implement.started',
          'code-review.started',
          'verify.started',
          'reconcile.started',
          'finalize.started',
          'finalize.step-started',
        ].includes(event.type)
      ) {
        acc.occurrence = event.seq
        delete acc.boundary
      }
      if (event.type === 'session.started') acc.sessions[event.payload.session] = true
      if (event.type === 'session.ended') delete acc.sessions[event.payload.session]
      if (
        acc.occurrence !== undefined &&
        (event.type === 'session.ended' ||
          [
            'plan.completed',
            'plan-review.verdict',
            'implement.completed',
            'code-review.verdict',
            'verify.completed',
            'reconcile.completed',
            'finalize.completed',
            'finalize.step-completed',
            'phase.failed',
            'escalation.raised',
            'publication.requested',
          ].includes(event.type))
      )
        acc.boundary = event.seq
    }
  },
  finish: (acc) =>
    acc.occurrence !== undefined &&
    acc.boundary !== undefined &&
    Object.keys(acc.sessions).length === 0
      ? { occurrence: acc.occurrence, boundary: acc.boundary }
      : undefined,
})

export function summaryBoundary(events: readonly AbEvent[]) {
  return summaryBoundaryReducer.reduce(events)
}

type SummaryRequest = Extract<AbEvent, { type: 'pr-summary.requested' }>
export const summaryRequestsReducer = defineReducer<
  {
    requests: SummaryRequest[]
    settled: number[]
  },
  AbEvent,
  SummaryRequest[]
>({
  version: 1,
  initial: () => ({ requests: [], settled: [] }),
  fold(acc, events) {
    for (const event of events) {
      if (event.type === 'pr-summary.requested') acc.requests.push(event)
      if (event.type === 'pr-summary.settled') acc.settled.push(event.payload.request)
    }
  },
  finish: (acc) => acc.requests.filter((event) => !acc.settled.includes(event.seq)),
})

export function pendingSummaryRequests(events: readonly AbEvent[]) {
  return summaryRequestsReducer.reduce(events)
}
