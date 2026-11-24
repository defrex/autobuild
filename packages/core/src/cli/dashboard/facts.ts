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

type SessionEvent = Extract<
  AbEvent,
  { type: 'session.started' | 'session.ended' | 'session.suspended' | 'session.resumed' }
>

/** One judge session of a panel run (SPEC §13.1.1), for the session rows.
 * The order the judge was given is a blinded kernel fact and never copied. */
export interface JudgeSessionFact {
  session: string
  panel: string
  judge: number
  runner: string
  model?: string
  stream?: string
  startedSeq: number
  status: 'open' | 'ended' | 'reclaimed'
  transcript?: { kind: string; rev: number }
}

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
  /** Judge sessions, in log order; `projectSessions` merges them as rows. */
  judgeSessions: JudgeSessionFact[]
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

/** Where one event bounds a phase interval: `open` for a `*.started`, `close`
 * for its terminal event (`.completed`/`.verdict`/`.cancelled`), keyed by
 * phase. Finalize post-steps (`finalize.step-completed`) have no `.started`
 * and bound nothing. Shared with the build timeline (`timeline.ts`), so both
 * pair phases from the same events. */
export type PhaseBoundary = { open: string } | { close: string } | null

export function phaseBoundary(ev: AbEvent): PhaseBoundary {
  switch (ev.type) {
    case 'plan.started':
      return { open: 'plan' }
    case 'plan.completed':
      return { close: 'plan' }
    case 'plan-review.started':
      return { open: 'plan-review' }
    case 'plan-review.verdict':
      return { close: 'plan-review' }
    case 'implement.started':
      return { open: 'implement' }
    case 'implement.completed':
      return { close: 'implement' }
    case 'code-review.started':
      return { open: 'code-review' }
    case 'code-review.verdict':
      return { close: 'code-review' }
    case 'verify.started':
      return { open: verifyPhase(ev.payload.step) }
    case 'verify.cancelled':
    case 'verify.completed':
      return { close: verifyPhase(ev.payload.step) }
    case 'finalize.started':
      return { open: 'finalize' }
    case 'finalize.completed':
      return { close: 'finalize' }
    case 'reconcile.started':
      return { open: 'reconcile' }
    case 'reconcile.completed':
      return { close: 'reconcile' }
    default:
      return null
  }
}

function foldInterval(intervals: Record<string, PhaseTiming>, ev: AbEvent): void {
  const boundary = phaseBoundary(ev)
  if (boundary === null) return
  const ms = Date.parse(ev.ts)
  const get = (key: string): PhaseTiming => {
    let t = intervals[key]
    if (t === undefined) {
      t = { closed: [] }
      intervals[key] = t
    }
    return t
  }
  // Each `*.started` opens an interval for its phase key and its terminal event
  // closes it. A second `*.started` while one is still open REPLACES the open
  // start — a §15.6-C cross-sandbox re-run starts the phase afresh, so the
  // crashed attempt contributes nothing.
  if ('open' in boundary) {
    get(boundary.open).open = { start: ms, startSeq: ev.seq }
    return
  }
  const t = get(boundary.close)
  if (t.open === undefined) return
  t.closed.push({ start: t.open.start, end: ms, startSeq: t.open.startSeq })
  delete t.open
}

export const dashboardFactsReducer = defineReducer<DashboardFacts, AbEvent, DashboardFacts>({
  identity: 'dashboardFacts',
  initial: () => ({
    sessionEvents: [],
    judgeSessions: [],
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
        case 'session.suspended':
        case 'session.resumed':
        case 'session.started':
        case 'session.ended':
          acc.sessionEvents.push(event)
          break
        case 'panel.judge-started':
          acc.judgeSessions.push({
            session: event.payload.session,
            panel: event.payload.panel,
            judge: event.payload.judge,
            runner: event.payload.runner,
            ...(event.payload.model !== undefined ? { model: event.payload.model } : {}),
            ...(event.payload.stream !== undefined ? { stream: event.payload.stream } : {}),
            startedSeq: event.seq,
            status: 'open',
          })
          break
        case 'panel.judge-ended': {
          const ended = acc.judgeSessions.find(
            (judge) => judge.session === event.payload.session && judge.status === 'open',
          )
          if (ended === undefined) break
          ended.status = event.payload.outcome === 'reclaimed' ? 'reclaimed' : 'ended'
          if (event.payload.transcript !== undefined)
            ended.transcript = { ...event.payload.transcript }
          break
        }
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
