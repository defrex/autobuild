/**
 * The dashboard's browser-safe vocabulary: the closed word tables and the
 * clock-dependent step text every frontend shows. The terminal renderer paints
 * these values and the web UI renders the same ones, so the two frontends never
 * disagree on a word (CLAUDE.md, "Parity is the vocabulary, not the pixels").
 *
 * **Import rule.** This module holds only pure functions and constants. Its
 * only value import is `./cells`, which itself imports nothing; every other
 * import is `import type`. That keeps it importable by value from a browser
 * bundle, which needs the timer formatters because elapsed time depends on the
 * viewer's clock. Projections that need kernel helpers live in `./row-text`.
 *
 * Tones are presentation-neutral names. The terminal maps them to ANSI colours
 * and the web maps them to `packages/ui` state tones, whose names are the same.
 */
import { displayText } from './cells'
import type { DashboardHarvest, EffectiveStatus, PipelineStep, StepState } from './model'
import type { RosterOutcome } from '../../kernel/build-roster'

/** The emphasis a term carries. Never the only carrier of meaning: every toned
 * term also has its literal word or glyph. */
export type DashboardTone = 'ok' | 'live' | 'held' | 'alert' | 'pending'

/** Every lifecycle word a dashboard row can show. */
export type DashboardStatus = EffectiveStatus | DashboardHarvest['status']

export interface StatusText {
  status: DashboardStatus
  /** The literal uppercase word (`RUNNING`, `BLOCKED`). */
  word: string
  tone: DashboardTone
}

const STATUS_TONE: Record<DashboardStatus, DashboardTone> = {
  queued: 'live',
  running: 'ok',
  collecting: 'live',
  pausing: 'held',
  paused: 'held',
  suspended: 'held',
  resuming: 'live',
  blocked: 'alert',
  waiting: 'held',
  aborting: 'alert',
  cleaning: 'held',
  escalated: 'held',
  failed: 'alert',
}

export function statusText(status: DashboardStatus): StatusText {
  return { status, word: status.toUpperCase(), tone: STATUS_TONE[status] }
}

const STEP_MARK: Record<StepState, string> = {
  done: '[x]',
  current: '[>]',
  provisional: '[~]',
  pending: '[ ]',
}

const STEP_TONE: Record<StepState, DashboardTone> = {
  done: 'ok',
  current: 'live',
  provisional: 'held',
  pending: 'pending',
}

/** The glyph that carries a step's state without colour. */
export function stepMark(state: StepState): string {
  return STEP_MARK[state]
}

export function stepTone(state: StepState): DashboardTone {
  return STEP_TONE[state]
}

/**
 * Elapsed duration, ASCII only: `Xs` under a minute, `MmSSs` under an hour,
 * `HhMMmSSs` above — seconds/minutes zero-padded when a larger unit precedes, so
 * the field width is stable as it ticks (`38s`, `4m12s`, `1h04m07s`).
 */
export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  if (totalSec < 60) return `${totalSec}s`
  const totalMin = Math.floor(totalSec / 60)
  if (totalMin < 60) return `${totalMin}m${String(totalSec % 60).padStart(2, '0')}s`
  return `${Math.floor(totalMin / 60)}h${String(totalMin % 60).padStart(2, '0')}m${String(totalSec % 60).padStart(2, '0')}s`
}

/** A step's elapsed time at `now`, or undefined when it has never run in
 * scope. An open interval grows with `now`; a closed one is stable. */
export function stepElapsedMs(timing: PipelineStep['timing'], now: number): number | undefined {
  if (timing === undefined) return undefined
  const { accumulatedMs, runningSince } = timing
  return accumulatedMs + (runningSince !== undefined ? Math.max(0, now - runningSince) : 0)
}

/** `row` is the dense list form, `detail` the build page form. */
export type StepForm = 'row' | 'detail'

/**
 * The parenthesised note after a step label.
 *
 * Row form: `(qualifier, 4m12s/2)` with no leading space. The count rides the
 * time as `/n` only when above 1, and is not shown without a time, so a fresh
 * step never carries a stale round.
 *
 * Detail form: ` (qualifier, round 2, 4m12s)`. Verify steps and reconcile
 * count attempts rather than rounds, and any defined count is shown.
 */
export function stepNote(step: PipelineStep, now: number, form: StepForm): string {
  const parts: string[] = []
  if (step.qualifier !== undefined) parts.push(step.qualifier)
  const elapsed = stepElapsedMs(step.timing, now)
  if (form === 'row') {
    if (elapsed !== undefined) {
      const count = step.count !== undefined && step.count > 1 ? `/${step.count}` : ''
      parts.push(`${formatDuration(elapsed)}${count}`)
    }
    return parts.length > 0 ? `(${parts.join(', ')})` : ''
  }
  if (step.count !== undefined) {
    const kind =
      step.label.startsWith('verify:') || step.label === 'reconcile' ? 'attempt' : 'round'
    parts.push(`${kind} ${step.count}`)
  }
  if (elapsed !== undefined) parts.push(formatDuration(elapsed))
  return parts.length > 0 ? ` (${parts.join(', ')})` : ''
}

/** The whole step text: mark, label, note and any ` — reason`. */
export function stepLine(step: PipelineStep, now: number, form: StepForm): string {
  const reason = step.reason !== undefined ? ` — ${step.reason}` : ''
  return `${stepMark(step.state)} ${step.label}${stepNote(step, now, form)}${reason}`
}

/** The term an integration row's progress adds once its tree is verified. */
export const PROGRESS_VERIFIED = 'verified'

export interface OutcomeText {
  outcome: RosterOutcome
  word: string
  tone: DashboardTone
}

const OUTCOME_TONE: Record<RosterOutcome, DashboardTone> = {
  merged: 'ok',
  closed: 'pending',
  aborted: 'alert',
}

/** The word a finished build's row shows. */
export function finishedOutcomeText(outcome: RosterOutcome): OutcomeText {
  return { outcome, word: outcome.toUpperCase(), tone: OUTCOME_TONE[outcome] }
}

/**
 * What the repository's dispatcher is doing, as one word. `handoff` is an
 * upgrade handoff in progress; `viewer` is a dispatcher this process watches
 * but does not own. Standby is a separate header term, not a mode.
 */
export type DispatcherMode = 'running' | 'viewer' | 'stopped' | 'handoff'

const MODE_TONE: Record<DispatcherMode, DashboardTone> = {
  running: 'ok',
  viewer: 'live',
  stopped: 'alert',
  handoff: 'held',
}

export function dispatcherModeWord(mode: DispatcherMode): {
  word: string
  tone: DashboardTone
} {
  return { word: mode, tone: MODE_TONE[mode] }
}

/** Who owns the dispatcher a viewer watches. */
export function dispatchedByText(dispatchedBy: string): string {
  return `dispatched by ${displayText(dispatchedBy)}`
}

/** `viewer`, or `viewer · dispatched by X` when the owner is known. */
export function viewerLabel(viewer: { dispatchedBy?: string }): string {
  return viewer.dispatchedBy === undefined
    ? 'viewer'
    : `viewer · ${dispatchedByText(viewer.dispatchedBy)}`
}
