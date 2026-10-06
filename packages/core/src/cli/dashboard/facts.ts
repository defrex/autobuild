/**
 * The facts a dashboard row reads from a build's event array, as an
 * incremental reducer: the queued-row dispatch text, the session brackets, the
 * per-phase wall-clock intervals, the pause timestamp, and the seqs of the four
 * loop outputs. `projectBuildFromFacts` renders a row from these plus the
 * reduced `BuildState`, so a row derives from a stored accumulator and a delta
 * read with no event array, and `projectBuild(…, events, …)` is the same
 * projection over `dashboardFactsReducer.reduce(events)` — one implementation,
 * so the snapshot and replay paths agree by construction.
 *
 * The accumulator is plain JSON (see `kernel/incremental.ts`).
 */
import type { AbEvent } from '../../events/catalog'
import { defineReducer } from '../../kernel/incremental'
import { verifyPhase } from '../../ontology'

export const DASHBOARD_FACTS_REDUCER_VERSION = 1

/** One phase occurrence's wall-clock span, keyed by phase. `startSeq` is the
 * seq of the `*.started` event, so callers can scope by the same seq
 * boundaries (`restartSince`/`cycleSince`) the step STATES already use. */
export interface PhaseInterval {
  start: number
  end: number
  startSeq: number
}

export interface PhaseTiming {
  closed: PhaseInterval[]
  open?: { start: number; startSeq: number }
}

export interface DispatchFailureFact {
  seq: number
  stage: string
  attempt: number
  error: string
}

/** Max seq per round of one loop output event. */
export type RoundSeqs = Record<string, number>

type SessionEvent = Extract<AbEvent, { type: 'session.started' | 'session.ended' }>

export interface DashboardFacts {
  /** Seq of the latest event of each queued-row kind (`undefined` until seen). */
  created?: number
  workspaceProvisioned?: number
  workspaceReleased?: number
  specLanded?: number
  commentPosted?: number
  latestFailure?: DispatchFailureFact
  /** The session brackets, in log order; `projectSessions` pairs them. */
  sessionEvents: SessionEvent[]
  intervals: Record<string, PhaseTiming>
  /** Timestamp of the latest `build.paused`. */
  pausedAt?: string
  produced: {
    planCompleted: RoundSeqs
    planReviewVerdict: RoundSeqs
    implementCompleted: RoundSeqs
    codeReviewVerdict: RoundSeqs
  }
}

/** Whether a loop output of `round` landed after `since` (the restart boundary). */
export function producedAfter(seqs: RoundSeqs, round: number, since: number): boolean {
  const seq = seqs[String(round)]
  return seq !== undefined && seq > since
}

function raise(seqs: RoundSeqs, round: number, seq: number): void {
  const key = String(round)
  const current = seqs[key]
  seqs[key] = current === undefined ? seq : Math.max(current, seq)
}

function foldInterval(intervals: Record<string, PhaseTiming>, ev: AbEvent): void {
  const ms = Date.parse(ev.ts)
  const get = (key: string): PhaseTiming => {
    let t = intervals[key]
    if (t === undefined) {
      t = { closed: [] }
      intervals[key] = t
    }
    return t
  }
  const open = (key: string): void => {
    get(key).open = { start: ms, startSeq: ev.seq }
  }
  const close = (key: string): void => {
    const t = get(key)
    if (t.open === undefined) return
    t.closed.push({ start: t.open.start, end: ms, startSeq: t.open.startSeq })
    delete t.open
  }
  // Each `*.started` opens an interval for its phase key and its terminal event
  // (`.completed`/`.verdict`) closes it. A second `*.started` while one is still
  // open REPLACES the open start — a §15.6-C cross-sandbox re-run starts the
  // phase afresh, so the crashed attempt contributes nothing. Finalize
  // post-steps (`finalize.step-completed`) have no `.started` and no interval.
  switch (ev.type) {
    case 'plan.started':
      open('plan')
      break
    case 'plan.completed':
      close('plan')
      break
    case 'plan-review.started':
      open('plan-review')
      break
    case 'plan-review.verdict':
      close('plan-review')
      break
    case 'implement.started':
      open('implement')
      break
    case 'implement.completed':
      close('implement')
      break
    case 'code-review.started':
      open('code-review')
      break
    case 'code-review.verdict':
      close('code-review')
      break
    case 'verify.started':
      open(verifyPhase(ev.payload.step))
      break
    case 'verify.completed':
      close(verifyPhase(ev.payload.step))
      break
    case 'finalize.started':
      open('finalize')
      break
    case 'finalize.completed':
      close('finalize')
      break
    case 'reconcile.started':
      open('reconcile')
      break
    case 'reconcile.completed':
      close('reconcile')
      break
    default:
      break
  }
}

export const dashboardFactsReducer = defineReducer<DashboardFacts, AbEvent, DashboardFacts>({
  version: DASHBOARD_FACTS_REDUCER_VERSION,
  initial: () => ({
    sessionEvents: [],
    intervals: {},
    produced: {
      planCompleted: {},
      planReviewVerdict: {},
      implementCompleted: {},
      codeReviewVerdict: {},
    },
  }),
  fold(acc, events) {
    for (const event of events) {
      foldInterval(acc.intervals, event)
      switch (event.type) {
        case 'build.created':
          acc.created = event.seq
          break
        case 'workspace.provisioned':
          acc.workspaceProvisioned = event.seq
          break
        case 'workspace.released':
          acc.workspaceReleased = event.seq
          break
        case 'spec.imported':
        case 'spec.authored':
          acc.specLanded = event.seq
          break
        case 'dispatch.comment-posted':
          acc.commentPosted = event.seq
          break
        case 'dispatch.failed':
          acc.latestFailure = {
            seq: event.seq,
            stage: event.payload.stage,
            attempt: event.payload.attempt,
            error: event.payload.error,
          }
          break
        case 'session.started':
        case 'session.ended':
          acc.sessionEvents.push(event)
          break
        case 'build.paused':
          acc.pausedAt = event.ts
          break
        case 'plan.completed':
          raise(acc.produced.planCompleted, event.payload.round, event.seq)
          break
        case 'plan-review.verdict':
          raise(acc.produced.planReviewVerdict, event.payload.round, event.seq)
          break
        case 'implement.completed':
          raise(acc.produced.implementCompleted, event.payload.round, event.seq)
          break
        case 'code-review.verdict':
          raise(acc.produced.codeReviewVerdict, event.payload.round, event.seq)
          break
        default:
          break
      }
    }
  },
  finish: (acc) => structuredClone(acc),
})
