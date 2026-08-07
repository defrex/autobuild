import type { BuildState } from '../kernel/reducer'
import type { BuildRecord } from '../store/types'

/**
 * Event silence must be long enough to distinguish ordinary agent turns from
 * durable progress that has fallen behind a renewing runner lease.
 */
export const PROGRESS_DIVERGENCE_MS = 60 * 60 * 1000

/** Exact, JSON-safe inputs for the presentation-only progress projection. */
export interface BuildProgress {
  lastEventAt?: string
  heartbeatAt?: string
  leaseExpiresAt?: string
  /** Reducer-terminal even when abort cleanup keeps a dashboard row visible. */
  terminal: boolean
}

/** Project only retained facts. Relative ages and divergence depend on render time. */
export function buildProgress(record: BuildRecord, state: BuildState): BuildProgress {
  return {
    ...(state.lastEvent !== undefined ? { lastEventAt: state.lastEvent.ts } : {}),
    ...(record.heartbeatAt !== undefined ? { heartbeatAt: record.heartbeatAt } : {}),
    ...(record.lease !== undefined ? { leaseExpiresAt: record.lease.expiresAt } : {}),
    terminal: state.status === 'done' || state.status === 'aborted',
  }
}

function timestamp(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * True only for a nonterminal build with a strictly live lease whose renewing
 * heartbeat is at least one hour newer than its latest durable event.
 */
export function isDiverged(progress: BuildProgress, now: Date | number): boolean {
  if (progress.terminal) return false
  const lastEventAt = timestamp(progress.lastEventAt)
  const heartbeatAt = timestamp(progress.heartbeatAt)
  const leaseExpiresAt = timestamp(progress.leaseExpiresAt)
  const nowMs = typeof now === 'number' ? now : now.getTime()
  if (
    lastEventAt === undefined ||
    heartbeatAt === undefined ||
    leaseExpiresAt === undefined ||
    !Number.isFinite(nowMs) ||
    leaseExpiresAt <= nowMs
  ) {
    return false
  }
  return heartbeatAt - lastEventAt >= PROGRESS_DIVERGENCE_MS
}
