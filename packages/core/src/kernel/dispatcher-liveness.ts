import type { RepositoryEvent } from '../events/repository'
import type { RepositoryRecord } from '../store/types'

export function projectDispatcherLiveness(
  record: RepositoryRecord | null,
  events: RepositoryEvent[],
  now: Date,
) {
  const ordered = [...events].sort((a, b) => a.seq - b.seq)
  const age = (at: string) => Math.max(0, now.getTime() - Date.parse(at))
  const run = (id: string) => {
    const start = ordered.find((e) => e.type === 'dispatcher.run-started' && e.payload.run === id)
    const stop = ordered.findLast(
      (e) => e.type === 'dispatcher.run-stopped' && e.payload.run === id,
    )
    const tick = ordered.findLast(
      (e) =>
        (e.type === 'dispatcher.tick-completed' || e.type === 'dispatcher.tick-failed') &&
        e.payload.run === id,
    )
    const finished = record?.tick?.finished?.run === id ? record.tick.finished : undefined
    const useSample = finished !== undefined && (!tick || finished.completedAt >= tick.ts)
    const lastTickAt = useSample ? finished.completedAt : (tick?.ts ?? null)
    const heartbeatAt =
      record?.lease?.holder === id && start && record.heartbeatAt && record.heartbeatAt >= start.ts
        ? record.heartbeatAt
        : null
    return {
      run: id,
      pid: start?.type === 'dispatcher.run-started' ? start.payload.pid : null,
      host: start?.type === 'dispatcher.run-started' ? (start.payload.host ?? null) : null,
      startedAt: start?.ts ?? null,
      heartbeatAt,
      heartbeatAgeMs: heartbeatAt === null ? null : age(heartbeatAt),
      leaseExpiresAt: record?.lease?.holder === id ? record.lease.expiresAt : null,
      lastTickAt,
      lastTickAgeMs: lastTickAt ? age(lastTickAt) : null,
      lastTick: useSample
        ? finished.outcome === 'completed'
          ? { outcome: 'completed' as const, counters: finished.counters }
          : { outcome: 'failed' as const, error: finished.error }
        : tick?.type === 'dispatcher.tick-completed'
          ? { outcome: 'completed' as const, counters: tick.payload.counters }
          : tick?.type === 'dispatcher.tick-failed'
            ? { outcome: 'failed' as const, error: tick.payload.error }
            : null,
      stoppedAt: stop?.ts ?? null,
      stop: stop?.type === 'dispatcher.run-stopped' ? stop.payload : null,
    }
  }
  const latest = ordered.findLast((e) => e.type === 'dispatcher.run-started')
  const latestStop = ordered.findLast((e) => e.type === 'dispatcher.run-stopped')
  const owner = record?.lease ? run(record.lease.holder) : null
  const held =
    owner !== null && owner.stop === null && Date.parse(record!.lease!.expiresAt) > now.getTime()
  return {
    state: held
      ? ('held' as const)
      : owner && !owner.stop
        ? ('lost' as const)
        : latestStop
          ? ('stopped' as const)
          : ('absent' as const),
    holder: held ? owner : null,
    expiredHolder: !held && owner && !owner.stop ? owner : null,
    latestRun: latest?.type === 'dispatcher.run-started' ? run(latest.payload.run) : null,
    latestStoppedRun:
      latestStop?.type === 'dispatcher.run-stopped' ? run(latestStop.payload.run) : null,
  }
}
export type DispatcherLiveness = ReturnType<typeof projectDispatcherLiveness>
export function formatDispatcherIdentity(
  run: NonNullable<DispatcherLiveness['latestRun']>,
): string {
  return `${run.run}; pid ${run.pid ?? 'unknown'}; host ${run.host ?? 'unknown'}; started ${run.startedAt ?? 'unknown'}; ${run.heartbeatAgeMs === null ? 'heartbeat unknown (no renewal attributable to this run)' : `heartbeat ${run.heartbeatAgeMs}ms ago`}`
}
