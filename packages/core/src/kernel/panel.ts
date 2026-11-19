/**
 * One judge panel run (SPEC §13.1.1, RFC 0005 §8): a panel of agent judges
 * compares two harness-pinned variants, labeled A and B in an order drawn per
 * judge, and each judge prefers A, B or neither. This module holds the pure
 * half: the order, the scoring, the win rate and the run's reduced state.
 * Nothing here performs I/O; materialization lives in
 * `processes/panel-runner.ts` and the sessions in `BuildRunner.runPanel`.
 */
import type { EventPayload } from '../events/payloads'
import type { AbEvent } from '../events/catalog'

/** Which variant a judge sees as A. Recorded only in kernel facts no judge
 * channel reads. */
export type PanelOrder = 'candidate-first' | 'baseline-first'
export type PanelPreference = 'A' | 'B' | 'tie'
export type PanelSide = 'candidate' | 'baseline'
export type PanelJudgeOutcome = EventPayload<'panel.judge-ended'>['outcome']

/** Counted failures per judge before the run fails, matching the default
 * `maxPhaseAttempts`. Reclaims and interruptions are not counted. */
export const PANEL_JUDGE_ATTEMPTS = 2

const COUNTED_FAILURES: ReadonlySet<PanelJudgeOutcome> = new Set([
  'no-terminal',
  'failed',
  'expired',
])

export function drawOrder(random: () => number): PanelOrder {
  return random() < 0.5 ? 'candidate-first' : 'baseline-first'
}

/** The variant each label shows under an order. */
export function labelSides(order: PanelOrder): Record<'A' | 'B', PanelSide> {
  return order === 'candidate-first'
    ? { A: 'candidate', B: 'baseline' }
    : { A: 'baseline', B: 'candidate' }
}

/** A preference for the candidate scores 1, a tie 0.5, the baseline 0. */
export function candidateScore(order: PanelOrder, preference: PanelPreference): number {
  if (preference === 'tie') return 0.5
  return labelSides(order)[preference] === 'candidate' ? 1 : 0
}

/** The candidate's mean score over the judgments, ties counted as half. */
export function panelWinRate(
  judgments: ReadonlyArray<{ order: PanelOrder; preference: PanelPreference }>,
): number {
  if (judgments.length === 0) throw new Error('win rate of no judgments')
  const total = judgments.reduce((sum, j) => sum + candidateScore(j.order, j.preference), 0)
  return total / judgments.length
}

/** One judge session start: the order it was given, the target that ran
 * it, its stream and, for an alternate, the session it substitutes. */
export interface PanelJudgeStart {
  session: string
  order: PanelOrder
  runner: string
  model?: string
  stream?: string
  substitutes?: string
}

export interface PanelJudgeState {
  /** Every session started for this judge, with the order it was given. */
  starts: PanelJudgeStart[]
  ended: Array<{ session: string; outcome: PanelJudgeOutcome }>
  preferred?: { session: string; preference: PanelPreference; reason: string }
  judged?: EventPayload<'panel.judged'>
}

/** The latest panel run on a build (SPEC §15.5). Bounded by the judge count:
 * events for any other panel id are ignored. */
export interface PanelRunState {
  started: EventPayload<'panel.started'>
  /** Keyed by the judge index as a string. */
  judges: Record<string, PanelJudgeState>
}

export type PanelEvent = Extract<
  AbEvent,
  {
    type:
      | 'panel.started'
      | 'panel.judge-started'
      | 'panel.preferred'
      | 'panel.judged'
      | 'panel.judge-ended'
  }
>

export function isPanelEvent(event: AbEvent): event is PanelEvent {
  return event.type.startsWith('panel.')
}

function judgeState(run: PanelRunState, judge: number): PanelJudgeState {
  const key = String(judge)
  run.judges[key] ??= { starts: [], ended: [] }
  return run.judges[key]!
}

/** Fold one event into the latest run, in place where it applies. */
export function advancePanel(
  run: PanelRunState | undefined,
  event: AbEvent,
): PanelRunState | undefined {
  if (!isPanelEvent(event)) return run
  if (event.type === 'panel.started') {
    if (run?.started.panel === event.payload.panel) return run
    return { started: structuredClone(event.payload), judges: {} }
  }
  if (run === undefined || run.started.panel !== event.payload.panel) return run
  const judge = judgeState(run, event.payload.judge)
  switch (event.type) {
    case 'panel.judge-started':
      judge.starts.push({
        session: event.payload.session,
        order: event.payload.order,
        runner: event.payload.runner,
        ...(event.payload.model !== undefined ? { model: event.payload.model } : {}),
        ...(event.payload.stream !== undefined ? { stream: event.payload.stream } : {}),
        ...(event.payload.substitution !== undefined
          ? { substitutes: event.payload.substitution.failed.session }
          : {}),
      })
      break
    case 'panel.preferred':
      judge.preferred ??= {
        session: event.payload.session,
        preference: event.payload.preference,
        reason: event.payload.reason,
      }
      break
    case 'panel.judged':
      judge.judged ??= structuredClone(event.payload)
      break
    case 'panel.judge-ended':
      judge.ended.push({ session: event.payload.session, outcome: event.payload.outcome })
      break
  }
  return run
}

function judgeIndexes(run: PanelRunState): number[] {
  return Array.from({ length: run.started.judges }, (_, index) => index + 1)
}

function judgeOf(run: PanelRunState, judge: number): PanelJudgeState {
  return run.judges[String(judge)] ?? { starts: [], ended: [] }
}

/** Judges with no recorded preference: the ones a launch wave runs. */
export function pendingJudges(run: PanelRunState): number[] {
  return judgeIndexes(run).filter((judge) => {
    const state = judgeOf(run, judge)
    return state.preferred === undefined && state.judged === undefined
  })
}

/** Sessions started and never ended: a crashed predecessor's, with the
 * stream the reclaim closes. */
export function awaitingReclaim(
  run: PanelRunState,
): Array<{ judge: number; session: string; stream?: string }> {
  const out: Array<{ judge: number; session: string; stream?: string }> = []
  for (const judge of judgeIndexes(run)) {
    const state = judgeOf(run, judge)
    for (const { session, stream } of state.starts)
      if (!state.ended.some((ended) => ended.session === session))
        out.push({ judge, session, ...(stream !== undefined ? { stream } : {}) })
  }
  return out
}

/** A saved preference not yet recorded as a judgment, paired with the order
 * its session was started with. Completed without a new session. */
export function completable(run: PanelRunState): Array<EventPayload<'panel.judged'>> {
  const out: Array<EventPayload<'panel.judged'>> = []
  for (const judge of judgeIndexes(run)) {
    const state = judgeOf(run, judge)
    if (state.preferred === undefined || state.judged !== undefined) continue
    const start = state.starts.find((s) => s.session === state.preferred!.session)
    if (start === undefined) continue
    out.push({
      panel: run.started.panel,
      judge,
      session: state.preferred.session,
      order: start.order,
      preference: state.preferred.preference,
      reason: state.preferred.reason,
    })
  }
  return out
}

/** Failures that count against a judge's attempts. A session a later start
 * substitutes is not counted: only an exhausted provider chain consumes an
 * attempt (SPEC §8.4). */
export function countedFailures(run: PanelRunState, judge: number): PanelJudgeOutcome[] {
  const state = judgeOf(run, judge)
  const substituted = new Set(state.starts.flatMap((start) => start.substitutes ?? []))
  return state.ended
    .filter((ended) => !substituted.has(ended.session))
    .map((ended) => ended.outcome)
    .filter((outcome) => COUNTED_FAILURES.has(outcome))
}

/** The recorded judgments, in judge order. */
export function judgments(run: PanelRunState): Array<EventPayload<'panel.judged'>> {
  return judgeIndexes(run).flatMap((judge) => {
    const judged = judgeOf(run, judge).judged
    return judged === undefined ? [] : [judged]
  })
}

/** The order recorded for one session, if it started on this run. */
export function sessionOrder(
  run: PanelRunState,
  judge: number,
  session: string,
): PanelOrder | undefined {
  return judgeOf(run, judge).starts.find((start) => start.session === session)?.order
}
