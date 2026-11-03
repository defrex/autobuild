import type { RepositoryEvent } from '../events/repository'
import type { TickReport } from './dispatcher'

const standingCounters = ['invalidTickets', 'dependencyBlocked', 'creationWithheld'] as const
const diagnostics = [
  'blockedDiagnostics',
  'janitorDiagnostics',
  'ticketDiagnostics',
  'creationDiagnostics',
  'dependencyDiagnostics',
] as const

/** Display-only standing values sampled beside a report rather than by the
 * Dispatcher; absent values are unknown and compare equal to absent. */
export interface TickStanding {
  triage?: number
}

/** Standing state changes publish; activity publishes on every occurrence. */
function reportRequiresPublication(
  report: TickReport,
  previous: RepositoryEvent | undefined,
  standing: TickStanding,
): boolean {
  if (previous?.type !== 'dispatcher.tick-completed' || previous.payload.queued !== report.queued)
    return true
  if (previous.payload.triage !== standing.triage) return true
  for (const key of standingCounters)
    if (report[key] !== (previous.payload.counters[key] ?? 0)) return true
  for (const key of diagnostics) {
    const before = previous.payload[key] ?? []
    if (report[key].length !== before.length || report[key].some((value, i) => value !== before[i]))
      return true
  }
  return Object.entries(report).some(
    ([key, value]) =>
      key !== 'queued' &&
      key !== 'forgeRequests' &&
      !standingCounters.some((standing) => standing === key) &&
      typeof value === 'number' &&
      value !== 0,
  )
}

export function shouldPublishTick(
  report: TickReport,
  events: readonly RepositoryEvent[],
  run: string,
  startedAt: string,
  standing: TickStanding = {},
): boolean {
  const previous = events.findLast(
    (e) => e.type === 'dispatcher.tick-completed' && e.payload.run === run,
  )
  if (reportRequiresPublication(report, previous, standing)) return true
  const boundary = events.findLast(
    (e) =>
      (e.type === 'dispatcher.tick-completed' || e.type === 'dispatcher.tick-failed') &&
      e.payload.run === run,
  )
  if (boundary?.type === 'dispatcher.tick-failed') return true

  // Preserve the first completed retry after each outstanding source cooldown.
  const sources = new Map<string, { deadline: number; requiresRetry: boolean; retried: boolean }>()
  const starts = new Map<string, number>()
  for (const event of events) {
    if (event.type === 'dispatcher.ticket-source-degraded') {
      const existing = sources.get(event.payload.source)
      const requiresRetry = 'resetAt' in event.payload
      const deadline =
        'resetAt' in event.payload
          ? Date.parse(event.payload.resetAt)
          : Date.parse(event.ts) + 15 * 60_000
      if (existing) {
        existing.deadline = Math.min(existing.deadline, deadline)
        existing.requiresRetry ||= requiresRetry
      } else sources.set(event.payload.source, { deadline, requiresRetry, retried: false })
    } else if (event.type === 'dispatcher.ticket-source-recovered')
      sources.delete(event.payload.source)
    else if (event.type === 'dispatcher.run-started') starts.clear()
    else if (event.type === 'dispatcher.run-stopped') starts.delete(event.payload.run)
    else if (event.type === 'dispatcher.tick-started')
      starts.set(event.payload.run, Date.parse(event.payload.startedAt ?? event.ts))
    else if (
      event.type === 'dispatcher.tick-completed' ||
      event.type === 'dispatcher.tick-failed'
    ) {
      const start = starts.get(event.payload.run)
      starts.delete(event.payload.run)
      for (const source of sources.values())
        if (start !== undefined && start >= source.deadline) source.retried = true
    }
  }
  return [...sources.values()].some(
    (source) => source.requiresRetry && !source.retried && Date.parse(startedAt) >= source.deadline,
  )
}

export function shouldPublishTickFromFacts(
  report: TickReport,
  facts: import('../store/reduced-reads').RepositoryReadFacts,
  run: import('../kernel/read-facts').DispatcherRunFacts,
  startedAt: string,
  standing: TickStanding = {},
): boolean {
  if (reportRequiresPublication(report, run.completed, standing)) return true
  if (run.tick?.type === 'dispatcher.tick-failed') return true
  return facts.attention.sources.some(
    ([, source]) =>
      source.requiresRetry && !source.retryObserved && Date.parse(startedAt) >= source.deadline,
  )
}
