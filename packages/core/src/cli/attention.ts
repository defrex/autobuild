import type { AbEvent } from '../events/catalog'
import type { RepositoryEvent } from '../events/repository'
import { currentAutoMergeDeferral } from '../kernel/auto-merge'
import { reduceBuild, type BuildState } from '../kernel/reducer'

export interface MergeDecision {
  type: 'build.merge-decision'
  pr: { number: number; url: string; headSha: string }
  reason: string
  observedAt: string
}

/** Consent pending application is armed; only a current actionable deferral
 * or withdrawn consent needs a person. Currency is owned by the kernel. */
export function mergeDecision(
  events: AbEvent[],
  now: Date,
  state = reduceBuild(events),
): MergeDecision | null {
  if (
    !state.finalizeCompletedSeq ||
    !state.pr ||
    state.prState !== 'open' ||
    state.status === 'done' ||
    state.status === 'aborted'
  )
    return null
  const deferral = currentAutoMergeDeferral(events, state)
  if (state.autoMerge.requested && deferral === undefined) return null
  return {
    type: 'build.merge-decision',
    pr: state.pr,
    reason: deferral ?? 'Auto-merge is not armed',
    observedAt: now.toISOString(),
  }
}

export function buildNeedsAttention(events: AbEvent[], state: BuildState): boolean {
  return (
    (state.openEscalations?.length ?? 0) > 0 || mergeDecision(events, new Date(0), state) !== null
  )
}

export function mergeIdentity(slug: string, pr: number): string {
  return JSON.stringify([slug, pr])
}

export function repositoryNeedsAttention(event: RepositoryEvent): boolean {
  switch (event.type) {
    case 'harvest.escalated':
    case 'harvest.recovery-exhausted':
    case 'dispatcher.config-rejected':
      return true
    case 'dispatcher.config-reloaded':
      return event.payload.restartRequired.length > 0
    case 'dispatcher.run-stopped':
      return event.payload.outcome === 'abnormal'
    default:
      return false
  }
}

type Degraded = Extract<RepositoryEvent, { type: 'dispatcher.ticket-source-degraded' }>
type Failed = Extract<RepositoryEvent, { type: 'dispatcher.tick-failed' }>
export type PersistenceObservation =
  | {
      type: 'dispatcher.ticket-source-persistent'
      source: string
      cause: string
      message: string
      resetAt?: string
      episodeSeq: number
      observedAt: string
      dependencyLimited: boolean
    }
  | {
      type: 'dispatcher.tick-failure-persistent'
      run: string
      firstFailure: string
      error: string
      episodeSeq: number
      observedAt: string
    }

/** Incremental journal projection. Episode starts survive run anchors and
 * repeated evidence can strengthen, but never postpone, an existing deadline. */
export class RepositoryAttention {
  private sources = new Map<
    string,
    {
      event: Degraded
      deadline: number
      dependencyLimited: boolean
      requiresRetry: boolean
      retryObserved: boolean
    }
  >()
  private failure: Failed | undefined
  private tickStarts = new Map<string, number>()

  private sourceDefersTick(now: number): boolean {
    return [...this.sources.values()].some(
      (source) => now < source.deadline || (source.requiresRetry && !source.retryObserved),
    )
  }

  /** Crossing resetAt alone does not prove persistence: the dispatcher must
   * finish a tick that could actually retry after the provider cooldown. */
  private observeRetry(run: string): void {
    const startedAt = this.tickStarts.get(run)
    this.tickStarts.delete(run)
    if (startedAt === undefined) return
    for (const source of this.sources.values()) {
      if (startedAt >= source.deadline) source.retryObserved = true
    }
  }
  fold(event: RepositoryEvent): void {
    switch (event.type) {
      case 'dispatcher.ticket-source-degraded': {
        const existing = this.sources.get(event.payload.source)
        const deadline =
          'resetAt' in event.payload
            ? Date.parse(event.payload.resetAt)
            : Date.parse(event.ts) + 15 * 60_000
        if (existing) {
          existing.deadline = Math.min(existing.deadline, deadline)
          existing.requiresRetry ||= 'resetAt' in event.payload
        } else
          this.sources.set(event.payload.source, {
            event,
            deadline,
            dependencyLimited: false,
            requiresRetry: 'resetAt' in event.payload,
            retryObserved: false,
          })
        // Cooldown-driven failures are not an independent dispatcher outage.
        if (this.sourceDefersTick(Date.parse(event.ts))) this.failure = undefined
        break
      }
      case 'dispatcher.ticket-source-dependency-limited': {
        const source = this.sources.get(event.payload.source)
        if (source) source.dependencyLimited = true
        break
      }
      case 'dispatcher.ticket-source-recovered':
        this.sources.delete(event.payload.source)
        break
      case 'dispatcher.run-started':
        this.failure = undefined
        this.tickStarts.clear()
        break
      case 'dispatcher.run-stopped':
        this.tickStarts.delete(event.payload.run)
        if (this.failure?.payload.run === event.payload.run) this.failure = undefined
        break
      case 'dispatcher.tick-started':
        this.tickStarts.set(event.payload.run, Date.parse(event.ts))
        break
      case 'dispatcher.tick-completed':
        this.observeRetry(event.payload.run)
        if (this.failure?.payload.run === event.payload.run) this.failure = undefined
        break
      case 'dispatcher.tick-failed':
        this.observeRetry(event.payload.run)
        if (this.sourceDefersTick(Date.parse(event.ts))) this.failure = undefined
        else if (this.failure?.payload.run !== event.payload.run) this.failure = event
        break
    }
  }
  pending(now: Date): { identity: string; observation: PersistenceObservation }[] {
    const results: { identity: string; observation: PersistenceObservation }[] = []
    for (const {
      event,
      deadline,
      dependencyLimited,
      requiresRetry,
      retryObserved,
    } of this.sources.values()) {
      if (now.getTime() < deadline || (requiresRetry && !retryObserved)) continue
      results.push({
        identity: `source:${event.seq}`,
        observation: {
          type: 'dispatcher.ticket-source-persistent',
          ...event.payload,
          episodeSeq: event.seq,
          observedAt: now.toISOString(),
          dependencyLimited,
        },
      })
    }
    const event = this.failure
    if (
      event &&
      !this.sourceDefersTick(now.getTime()) &&
      now.getTime() >= Date.parse(event.ts) + 5 * 60_000
    )
      results.push({
        identity: `tick:${event.seq}`,
        observation: {
          type: 'dispatcher.tick-failure-persistent',
          ...event.payload,
          firstFailure: event.ts,
          episodeSeq: event.seq,
          observedAt: now.toISOString(),
        },
      })
    return results
  }
}
