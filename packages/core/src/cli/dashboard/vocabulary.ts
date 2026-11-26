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
 *
 * Build status words come from one closed word→tone table
 * (`BUILD_STATUS_TONE`, SPEC §14 "Status words"), chosen by
 * `buildStatusText` from the row's slot state and a small `StatusBasis` of
 * lifecycle facts. No frontend keeps its own word or tone map.
 */
import { displayText } from './cells'
import type { DashboardHarvest, EffectiveStatus, PipelineStep, StepState } from './model'
import type { RosterOutcome } from '../../kernel/build-roster'
import type { SlotState } from '../../kernel/dispatch-capacity'

/** The emphasis a term carries. Never the only carrier of meaning: every toned
 * term also has its literal word or glyph. */
export type DashboardTone = 'ok' | 'live' | 'held' | 'alert' | 'pending'

/** Every lifecycle status a dashboard row routes on. */
export type DashboardStatus = EffectiveStatus | DashboardHarvest['status']

/**
 * The closed build status vocabulary (SPEC §14 "Status words"). Each tone
 * falls wholly on one side of the slot line (§12 "What holds a slot"): every
 * `ok` (green) word holds a slot, `live` (teal) requested one, and the rest
 * hold none.
 */
export type BuildStatusWord =
  | 'RUNNING'
  | 'STARTING'
  | 'PAUSING'
  | 'ABORTING'
  | 'QUEUED'
  | 'WAITING'
  | 'MERGING'
  | 'PAUSED'
  | 'COLLECTING'
  | 'BLOCKED'
  | 'CLEANING'

/** A harvest run's words. A harvest never holds a slot, so none is green. */
export type HarvestStatusWord = 'HARVESTING' | 'PAUSED' | 'SUSPENDED' | 'ESCALATED' | 'FAILED'

export const BUILD_STATUS_TONE: Readonly<Record<BuildStatusWord, DashboardTone>> = {
  RUNNING: 'ok',
  STARTING: 'ok',
  PAUSING: 'ok',
  ABORTING: 'ok',
  QUEUED: 'live',
  WAITING: 'held',
  MERGING: 'held',
  PAUSED: 'held',
  COLLECTING: 'held',
  BLOCKED: 'alert',
  CLEANING: 'pending',
}

export const HARVEST_STATUS_TONE: Readonly<Record<HarvestStatusWord, DashboardTone>> = {
  HARVESTING: 'live',
  PAUSED: 'held',
  SUSPENDED: 'held',
  ESCALATED: 'alert',
  FAILED: 'alert',
}

export interface StatusText {
  /** The routing value: the build's effective status or the harvest status. */
  status: DashboardStatus
  /** The literal uppercase word (`RUNNING`, `BLOCKED`). */
  word: BuildStatusWord | HarvestStatusWord
  tone: DashboardTone
  /** Why the build shows its word (`resume`, `merge decision`, `on AUT-1`). */
  note?: string
}

/**
 * The lifecycle facts a build's status word is chosen from, projected once
 * from its reduced state. JSON-safe: no member is ever `undefined`.
 */
export interface StatusBasis {
  /** The effective status with pending commands ignored. */
  resting: 'queued' | 'running' | 'collecting' | 'paused' | 'blocked' | 'waiting' | 'cleaning'
  /** A pause command is pending. */
  pause?: true
  /** An abort command is pending. */
  abort?: true
  /** A resume command is pending. */
  resume?: true
  /** A runner's execution is open. */
  runner: boolean
  node?: true
  /** A finished pipeline: waiting for a merge decision, on hold, or merging
   * (consent given, waiting for gates or the forge). */
  settled?: 'decision' | 'hold' | 'merging'
  /** A `revise-spec` answer waits for its revision. */
  reviseSpec?: true
  /** The open ticket wait's tickets, when the build rests `waiting`. */
  waitTickets?: string[]
}

/** The basis a hand-built row without one implies from its status alone. */
function basisFromStatus(status: EffectiveStatus): StatusBasis {
  switch (status) {
    case 'pausing':
      return { resting: 'running', pause: true, runner: true }
    case 'aborting':
      return { resting: 'running', abort: true, runner: true }
    case 'resuming':
      return { resting: 'paused', resume: true, runner: false }
    default:
      return { resting: status, runner: status === 'running' }
  }
}

function buildWord(status: EffectiveStatus, word: BuildStatusWord, note?: string): StatusText {
  return {
    status,
    word,
    tone: BUILD_STATUS_TONE[word],
    ...(note !== undefined ? { note } : {}),
  }
}

/**
 * A nonterminal build's status word (SPEC §14 "Status words"): its slot state
 * picks the tone, then lifecycle facts pick the word within it. A build that
 * holds no slot is never green. When the slot is unknown (a value from an
 * older server, or a caller without capacity facts), it is inferred from
 * lifecycle facts.
 */
export function buildStatusText(input: {
  status: EffectiveStatus
  slot?: SlotState
  basis?: StatusBasis
}): StatusText {
  const { status } = input
  const basis = input.basis ?? basisFromStatus(status)
  if (basis.resting === 'cleaning') return buildWord(status, 'CLEANING')
  const slot: SlotState | undefined =
    input.slot ??
    (((basis.resting === 'queued' || basis.resting === 'running') &&
      basis.settled === undefined &&
      basis.reviseSpec === undefined) ||
    (basis.resting === 'collecting' && basis.runner)
      ? { state: 'held' }
      : basis.resume && basis.resting === 'paused'
        ? { state: 'requested', request: 'resume' }
        : undefined)
  if (slot?.state === 'held') {
    if (basis.abort) return buildWord(status, 'ABORTING')
    if (basis.pause) return buildWord(status, 'PAUSING')
    return buildWord(status, basis.runner ? 'RUNNING' : 'STARTING')
  }
  if (slot?.state === 'requested')
    return buildWord(
      status,
      'QUEUED',
      slot.priority === 'urgent' ? `urgent ${slot.request}` : slot.request,
    )
  // No slot: a pending pause or abort waits for its acknowledgement.
  if (basis.resting === 'blocked') return buildWord(status, 'BLOCKED')
  if (basis.resting === 'waiting')
    return buildWord(
      status,
      'WAITING',
      basis.waitTickets?.length ? `on ${basis.waitTickets.join(', ')}` : undefined,
    )
  if (basis.resting === 'paused') return buildWord(status, 'PAUSED')
  if (basis.reviseSpec) return buildWord(status, 'WAITING', 'spec revision')
  if (basis.settled === 'merging') return buildWord(status, 'MERGING')
  if (basis.settled !== undefined)
    return buildWord(status, 'WAITING', basis.settled === 'hold' ? 'on hold' : 'merge decision')
  if (basis.resting === 'collecting' || basis.node) return buildWord(status, 'COLLECTING')
  return buildWord(status, 'WAITING')
}

/** A harvest row's word: `HARVESTING` while it works, its stop otherwise. */
export function harvestStatusText(status: DashboardHarvest['status']): StatusText {
  const word: HarvestStatusWord =
    status === 'running' ? 'HARVESTING' : (status.toUpperCase() as HarvestStatusWord)
  return { status, word, tone: HARVEST_STATUS_TONE[word] }
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
