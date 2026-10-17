import type { RepositoryEvent } from '../events/repository'
import type { TickReport } from './dispatcher'

/** Every counter and diagnostic is significant, including standing counts.
 * Queue depth alone may be unchanged and nonzero. */
export function shouldPublishTick(
  report: TickReport,
  events: readonly RepositoryEvent[],
  startedAt: string,
): boolean {
  if (
    Object.entries(report).some(
      ([key, value]) =>
        key !== 'queued' && (typeof value === 'number' ? value !== 0 : value.length > 0),
    )
  )
    return true
  const previous = events.findLast((e) => e.type === 'dispatcher.tick-completed')
  if (previous?.type !== 'dispatcher.tick-completed' || previous.payload.queued !== report.queued)
    return true
  if (
    [
      previous.payload.blockedDiagnostics ?? [],
      previous.payload.janitorDiagnostics,
      previous.payload.ticketDiagnostics,
      previous.payload.creationDiagnostics ?? [],
      previous.payload.dependencyDiagnostics,
    ].some((list) => list.length > 0)
  )
    return true
  const boundary = events.findLast(
    (e) => e.type === 'dispatcher.tick-completed' || e.type === 'dispatcher.tick-failed',
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
