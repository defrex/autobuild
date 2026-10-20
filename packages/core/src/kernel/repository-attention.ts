import type { RepositoryEvent } from '../events/repository'
import { defineReducer } from './incremental'
type Degraded = Extract<RepositoryEvent, { type: 'dispatcher.ticket-source-degraded' }>
type Failed = Extract<RepositoryEvent, { type: 'dispatcher.tick-failed' }>
type ForgeDegraded = Extract<RepositoryEvent, { type: 'dispatcher.forge-degraded' }>
type ForgeAttention = { event: ForgeDegraded; deadline: number; retryObserved: boolean }
export type PersistenceObservation =
  | {
      type: 'dispatcher.forge-persistent'
      forge: string
      message: string
      resetAt: string
      episodeSeq: number
      observedAt: string
    }
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
  forge?: ForgeAttention
  sources: [string, SourceAttention][]
  failure?: Failed
  tickStarts: [string, number][]
}
/** Incremental journal projection. Episode starts survive run anchors and
 * repeated evidence can strengthen, but never postpone, an existing deadline. */
export class RepositoryAttention {
  private forge: ForgeAttention | undefined
  private sources: Map<string, SourceAttention>
  private failure: Failed | undefined
  private tickStarts: Map<string, number>
  constructor(state?: RepositoryAttentionState) {
    this.forge = state?.forge
    this.sources = new Map(state?.sources ?? [])
    this.failure = state?.failure
    this.tickStarts = new Map(state?.tickStarts ?? [])
  }
  snapshot(): RepositoryAttentionState {
    return structuredClone({
      forge: this.forge,
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
    if (this.forge && startedAt >= this.forge.deadline) this.forge.retryObserved = true
    for (const source of this.sources.values()) {
      if (startedAt >= source.deadline) source.retryObserved = true
    }
  }
  fold(event: RepositoryEvent): void {
    switch (event.type) {
      case 'dispatcher.forge-degraded':
        if (!this.forge)
          this.forge = { event, deadline: Date.parse(event.payload.resetAt), retryObserved: false }
        else this.forge.deadline = Math.min(this.forge.deadline, Date.parse(event.payload.resetAt))
        break
      case 'dispatcher.forge-recovered':
        this.forge = undefined
        break
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
    if (this.forge?.retryObserved && now.getTime() >= this.forge.deadline) {
      const { event } = this.forge
      results.push({
        identity: `forge:${event.seq}`,
        observation: {
          type: 'dispatcher.forge-persistent',
          forge: event.payload.forge,
          message: event.payload.message,
          resetAt: event.payload.resetAt,
          episodeSeq: event.seq,
          observedAt: now.toISOString(),
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
  version: 2,
  initial: () => ({ sources: [], tickStarts: [] }),
  fold(acc, events) {
    const attention = new RepositoryAttention(acc)
    for (const event of events) attention.fold(event)
    Object.assign(acc, attention.snapshot())
  },
  finish: (acc) => structuredClone(acc),
})
