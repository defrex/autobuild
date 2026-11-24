/**
 * A build's timeline: its segments of phase and wait time (RFC 0007 §7.4,
 * SPEC §15.5 "Build timeline: segments and steps"), as an incremental
 * reducer saved per build as a named value. The Gantt rows draw it, and the
 * `stepDurations` rollup (`kernel/step-durations.ts`) folds its closed
 * segments into duration histograms.
 *
 * Phase segments pair the same start and terminal events the dashboard's
 * `foldInterval` pairs (`phaseBoundary`). Waits overlap phases; idle time
 * between segments is not a segment.
 *
 * The accumulator is plain JSON, and this module is browser-safe: no Bun or
 * `node:` APIs, because the operator web app bundles the dashboard projection.
 */
import type { AbEvent } from '../../events/catalog'
import { defineReducer } from '../../kernel/incremental'
import type { BuildOutcome } from '../../ontology'
import { phaseBoundary } from './facts'

/** Phase steps in pipeline order; `verify:<step>` sorts between code-review
 * and finalize. */
export const TIMELINE_PHASE_STEPS = ['plan', 'plan-review', 'implement', 'code-review'] as const
export const TIMELINE_LATE_PHASE_STEPS = ['finalize', 'reconcile'] as const
/** Wait steps, in table order. */
export const TIMELINE_WAIT_STEPS = [
  'queued',
  'escalated',
  'paused',
  'ticket-wait',
  'awaiting-merge',
] as const
export type TimelineWaitStep = (typeof TIMELINE_WAIT_STEPS)[number]

/** Past this many closed segments, the earliest segment with a later
 * same-category, same-state segment merges into it. */
export const TIMELINE_SEGMENT_CAP = 200

export interface TimelineBoundary {
  type: string
  seq: number
}

export interface TimelineSegment {
  /** The step: a phase (`plan`, `verify:<step>`, …) or a wait (`queued`, …). */
  category: string
  /** ISO timestamp of the opening event. */
  start: string
  /** ISO timestamp of the closing event; absent while open. */
  end?: string
  /** Wall-clock milliseconds; for a merged segment the sum of its
   * occurrences, not `end − start`. Zero while open. */
  durationMs: number
  opened: TimelineBoundary
  closed?: TimelineBoundary
  /** The opening payload's `round` (loop phases, escalations). */
  round?: number
  /** The opening payload's `attempt` (verify, reconcile). */
  attempt?: number
  /** `abandoned`: still open when the build completed or aborted. Abandoned
   * segments stop growing at the terminal event and contribute nothing to
   * step durations. */
  state: 'open' | 'closed' | 'abandoned'
  /** How many occurrences the cap merged into this one; absent for one. */
  merged?: number
}

export interface BuildTimeline {
  kind: 'work' | 'node'
  /** The latest `build.completed` outcome, cleared by `build.reopened`. */
  outcome?: BuildOutcome
  /** Timestamp of `build.created`. */
  createdAt?: string
  /** Closed, abandoned and open segments, ordered by opening seq. */
  segments: TimelineSegment[]
}

export interface BuildTimelineAcc {
  kind: 'work' | 'node'
  outcome?: BuildOutcome
  createdAt?: string
  /** `queued` closes once, at the first `execution.started`, and never reopens. */
  queuedClosed: boolean
  /** Raised escalation ids not yet answered; `escalated` is open while any is. */
  openEscalations: string[]
  /** The open ticket wait's escalation id; its answer also ends the wait. */
  waitEscalation?: string
  /** Open segments by category. */
  open: Record<string, TimelineSegment>
  /** Closed and abandoned segments, in closing order. */
  closed: TimelineSegment[]
}

function durationBetween(start: string, end: string): number {
  const ms = Date.parse(end) - Date.parse(start)
  return Number.isFinite(ms) && ms > 0 ? ms : 0
}

/** Merge pairs past the cap: the earliest segment that has a later segment of
 * the same category and state absorbs that segment. Repeats until the list is
 * at or under the cap or no pair remains, so the list is bounded by
 * max(cap, distinct category-state pairs). */
export function capSegments(closed: TimelineSegment[], cap = TIMELINE_SEGMENT_CAP): void {
  while (closed.length > cap) {
    const first = new Map<string, number>()
    let pair: [number, number] | undefined
    for (let i = 0; i < closed.length; i++) {
      const key = `${closed[i]!.state}\u0000${closed[i]!.category}`
      const earlier = first.get(key)
      if (earlier === undefined) first.set(key, i)
      else if (pair === undefined || earlier < pair[0]) {
        pair = [earlier, i]
        // The earliest candidate is the first index with any later partner;
        // indices only grow, so stop once the earliest-possible pair is found.
        if (earlier === 0) break
      }
    }
    if (pair === undefined) return
    const [keep, drop] = pair
    const kept = closed[keep]!
    const later = closed[drop]!
    closed[keep] = {
      ...kept,
      ...(later.end !== undefined ? { end: later.end } : {}),
      ...(later.closed !== undefined ? { closed: later.closed } : {}),
      durationMs: kept.durationMs + later.durationMs,
      merged: (kept.merged ?? 1) + (later.merged ?? 1),
    }
    closed.splice(drop, 1)
  }
}

function openSegment(
  acc: BuildTimelineAcc,
  category: string,
  ev: AbEvent,
  extra: Pick<TimelineSegment, 'round' | 'attempt'> = {},
): void {
  acc.open[category] = {
    category,
    start: ev.ts,
    durationMs: 0,
    opened: { type: ev.type, seq: ev.seq },
    ...(extra.round !== undefined ? { round: extra.round } : {}),
    ...(extra.attempt !== undefined ? { attempt: extra.attempt } : {}),
    state: 'open',
  }
}

function closeSegment(
  acc: BuildTimelineAcc,
  category: string,
  ev: AbEvent,
  state: 'closed' | 'abandoned' = 'closed',
): void {
  const segment = acc.open[category]
  if (segment === undefined) return
  delete acc.open[category]
  acc.closed.push({
    ...segment,
    end: ev.ts,
    durationMs: durationBetween(segment.start, ev.ts),
    closed: { type: ev.type, seq: ev.seq },
    state,
  })
  capSegments(acc.closed)
}

/** A wait opening while its category is already open keeps the earlier start. */
function openWait(acc: BuildTimelineAcc, category: TimelineWaitStep, ev: AbEvent, round?: number) {
  if (acc.open[category] !== undefined) return
  openSegment(acc, category, ev, round !== undefined ? { round } : {})
}

function phaseExtra(ev: AbEvent): Pick<TimelineSegment, 'round' | 'attempt'> {
  const payload = ev.payload as { round?: unknown; attempt?: unknown } | null
  if (payload === null || typeof payload !== 'object') return {}
  return {
    ...(typeof payload.round === 'number' ? { round: payload.round } : {}),
    ...(typeof payload.attempt === 'number' ? { attempt: payload.attempt } : {}),
  }
}

function foldTimelineEvent(acc: BuildTimelineAcc, ev: AbEvent): void {
  const boundary = phaseBoundary(ev)
  if (boundary !== null) {
    // A second start while one is open replaces it, as `foldInterval` does:
    // the replaced attempt leaves no segment.
    if ('open' in boundary) openSegment(acc, boundary.open, ev, phaseExtra(ev))
    else closeSegment(acc, boundary.close, ev)
  }
  switch (ev.type) {
    case 'build.created':
      acc.kind = ev.payload.kind ?? 'work'
      acc.createdAt = ev.ts
      if (!acc.queuedClosed) openWait(acc, 'queued', ev)
      break
    case 'execution.started':
      if (acc.open.queued !== undefined) {
        closeSegment(acc, 'queued', ev)
        acc.queuedClosed = true
      }
      break
    case 'escalation.raised':
      if (!acc.openEscalations.includes(ev.payload.id)) acc.openEscalations.push(ev.payload.id)
      openWait(acc, 'escalated', ev, ev.payload.round)
      break
    case 'escalation.answered': {
      const index = acc.openEscalations.indexOf(ev.payload.id)
      if (index >= 0) {
        acc.openEscalations.splice(index, 1)
        if (acc.openEscalations.length === 0) closeSegment(acc, 'escalated', ev)
      }
      if (acc.waitEscalation === ev.payload.id && acc.open['ticket-wait'] !== undefined) {
        closeSegment(acc, 'ticket-wait', ev)
        delete acc.waitEscalation
      }
      break
    }
    case 'build.paused':
      openWait(acc, 'paused', ev)
      break
    case 'build.resumed':
      closeSegment(acc, 'paused', ev)
      break
    case 'wait.entered':
      if (acc.open['ticket-wait'] === undefined) {
        openWait(acc, 'ticket-wait', ev)
        acc.waitEscalation = ev.payload.escalation
      }
      break
    case 'wait.ended':
      closeSegment(acc, 'ticket-wait', ev)
      delete acc.waitEscalation
      break
    case 'pr.opened':
      openWait(acc, 'awaiting-merge', ev)
      break
    case 'finalize.completed':
      // The phase boundary above closed `finalize`; the merge wait starts now.
      openWait(acc, 'awaiting-merge', ev)
      break
    case 'pr.merged':
    case 'pr.closed':
      closeSegment(acc, 'awaiting-merge', ev)
      break
    case 'build.completed':
    case 'build.aborted': {
      if (ev.type === 'build.completed') acc.outcome = ev.payload.outcome
      closeSegment(acc, 'awaiting-merge', ev)
      // Every other open segment stops at the terminal event as abandoned: a
      // Gantt row stops growing, and step durations never count it.
      for (const category of Object.keys(acc.open)) {
        if (category === 'queued') acc.queuedClosed = true
        closeSegment(acc, category, ev, 'abandoned')
      }
      acc.openEscalations = []
      delete acc.waitEscalation
      break
    }
    case 'build.reopened':
      delete acc.outcome
      break
    default:
      break
  }
}

export const buildTimelineReducer = defineReducer<BuildTimelineAcc, AbEvent, BuildTimeline>({
  identity: 'buildTimeline',
  initial: () => ({
    kind: 'work',
    queuedClosed: false,
    openEscalations: [],
    open: {},
    closed: [],
  }),
  fold(acc, events) {
    for (const event of events) foldTimelineEvent(acc, event)
  },
  finish: (acc) => ({
    kind: acc.kind,
    ...(acc.outcome !== undefined ? { outcome: acc.outcome } : {}),
    ...(acc.createdAt !== undefined ? { createdAt: acc.createdAt } : {}),
    segments: [...acc.closed, ...Object.values(acc.open)]
      .map((segment) => structuredClone(segment))
      .sort((a, b) => a.opened.seq - b.opened.seq),
  }),
})
