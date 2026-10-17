import type { RepositoryEvent } from '../events/repository'
import { defineReducer } from './incremental'
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

interface SourceAttention {
  event: Degraded
  deadline: number
  dependencyLimited: boolean
  requiresRetry: boolean
  retryObserved: boolean
}
export interface RepositoryAttentionState {
  sources: [string, SourceAttention][]
  failure?: Failed
  tickStarts: [string, number][]
}
/** Incremental journal projection. Episode starts survive run anchors and
 * repeated evidence can strengthen, but never postpone, an existing deadline. */
export class RepositoryAttention {
  private sources: Map<string, SourceAttention>
  private failure: Failed | undefined
  private tickStarts: Map<string, number>
  constructor(state?: RepositoryAttentionState) {
    this.sources = new Map(state?.sources ?? [])
    this.failure = state?.failure
    this.tickStarts = new Map(state?.tickStarts ?? [])
  }
  snapshot(): RepositoryAttentionState {
    return structuredClone({
      sources: [...this.sources],
      failure: this.failure,
      tickStarts: [...this.tickStarts],
    })
  }

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
        this.tickStarts.set(event.payload.run, Date.parse(event.payload.startedAt ?? event.ts))
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

export const repositoryAttentionReducer = defineReducer<
  RepositoryAttentionState,
  RepositoryEvent,
  RepositoryAttentionState
>({
  version: 1,
  initial: () => ({ sources: [], tickStarts: [] }),
  fold(acc, events) {
    const attention = new RepositoryAttention(acc)
    for (const event of events) attention.fold(event)
    Object.assign(acc, attention.snapshot())
  },
  finish: (acc) => structuredClone(acc),
})
