/**
 * Paired, harness-pinned objective measurement (SPEC §13.1.1, RFC 0005 §7.3,
 * §7.4): the deterministic math and the two reduced-state selectors the
 * engine and dispatch capacity share. Nothing here performs I/O; the paired
 * execution itself lives in `processes/measurement-runner.ts`.
 */
import { compilePathSelectors } from '../config/path-selectors'
import type { EventPayload } from '../events/payloads'
import type { ObjectiveEpsilon } from '../objective'
import type { BuildState } from './reducer'

/** One command run's ceiling, applied to every sample run and every setup
 * run of a measurement. A run that exceeds it escalates the measurement. */
export const MEASUREMENT_RUN_TIMEOUT_MS = 30 * 60_000

export type MeasurementSide = 'baseline' | 'candidate'

/** The median: the middle value, or the mean of the two middle values. */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error('median of no values')
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/** A positive delta is an improvement in the objective's direction. */
export function measurementDelta(
  direction: 'minimize' | 'maximize',
  baseline: number,
  candidate: number,
): number {
  return direction === 'minimize' ? baseline - candidate : candidate - baseline
}

/** ε in metric units: absolute, or relative × |baseline median|. A relative
 * ε over a zero median is 0. */
export function effectiveEpsilon(epsilon: ObjectiveEpsilon, baselineMedian: number): number {
  return epsilon.relative !== undefined
    ? epsilon.relative * Math.abs(baselineMedian)
    : (epsilon.absolute ?? 0)
}

/** An attempt improved when its delta reaches ε. */
export function measurementDecision(delta: number, epsilon: number): 'improved' | 'no-improvement' {
  return delta >= epsilon ? 'improved' : 'no-improvement'
}

/** The ruler cannot resolve ε: the noise between two identical runs is
 * strictly larger than it. */
export function noiseExceeded(epsilon: number, spread: number): boolean {
  return epsilon < spread
}

export type MeasurementOutput = { value: number } | { refusal: string }

/** The output contract: stdout, trimmed, is exactly one JSON object whose
 * `value` is a finite number. */
export function parseMeasurementOutput(stdout: string): MeasurementOutput {
  const text = stdout.trim()
  if (text === '')
    return { refusal: 'printed no output; expected one JSON object with a numeric "value"' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { refusal: 'output is not one JSON object with a numeric "value"' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    return { refusal: 'output is not one JSON object with a numeric "value"' }
  const value = (parsed as { value?: unknown }).value
  if (typeof value !== 'number' || !Number.isFinite(value))
    return { refusal: 'output object has no finite numeric "value"' }
  return { value }
}

/** Round i runs baseline first when i is even and candidate first when it is
 * odd, so monotone drift (a warming cache, a throttling CPU) cancels. */
export function sampleOrder(samples: number): [MeasurementSide, MeasurementSide][] {
  return Array.from({ length: samples }, (_, round) =>
    round % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'],
  )
}

/** One `git ls-tree -r` entry. */
export interface TreeEntry {
  mode: string
  type: string
  path: string
}

/** Parse `git ls-tree -r -z` output. */
export function parseLsTree(output: string): TreeEntry[] {
  const entries: TreeEntry[] = []
  for (const record of output.split('\0')) {
    if (record === '') continue
    const tab = record.indexOf('\t')
    if (tab < 0) continue
    const [mode = '', type = ''] = record.slice(0, tab).split(' ')
    entries.push({ mode, type, path: record.slice(tab + 1) })
  }
  return entries
}

/** What overwriting a worktree's harness paths with the pin takes: restore
 * every harness file at the pin, remove every harness file the pin lacks.
 * Only blobs (files and symlinks) count; submodule entries are skipped. */
export function harnessDiff(
  pinFiles: readonly TreeEntry[],
  headFiles: readonly TreeEntry[],
  selectors: readonly string[],
): { restore: string[]; remove: string[] } {
  const matches = compilePathSelectors(selectors)
  const harness = (entries: readonly TreeEntry[]) =>
    entries.filter((entry) => entry.type === 'blob' && matches(entry.path)).map((e) => e.path)
  const restore = harness(pinFiles)
  const pinned = new Set(restore)
  return { restore, remove: harness(headFiles).filter((path) => !pinned.has(path)) }
}

/** The starting value of a self-measurement: the median of every sample, with
 * the spread between the two sides' medians as the ruler's noise. */
export function baselineSummary(
  baseline: readonly number[],
  candidate: readonly number[],
): { median: number; spread: number } {
  return {
    median: median([...baseline, ...candidate]),
    spread: Math.abs(median(baseline) - median(candidate)),
  }
}

function terminal(state: BuildState): boolean {
  return state.status === 'done' || state.status === 'aborted'
}

/** A leaf's latest measurement request that has no `attempt.measured` yet.
 * Read from reduced state alone. */
export function pendingMeasurementRequest(
  state: BuildState,
): EventPayload<'attempt.measurement-requested'> | undefined {
  const request = state.attemptMeasurement?.request
  if (request === undefined || state.kind === 'node' || terminal(state)) return undefined
  if (state.attemptMeasurement?.measured?.request === request.id) return undefined
  const { seq: _seq, ...payload } = request
  return payload
}

/** An opened optimization node with a command objective has no starting
 * value under its current ruler. Read from reduced state alone. A panel's
 * starting value is defined, never measured here. */
export function baselineMeasurementDue(state: BuildState): boolean {
  const optimization = state.optimization
  return (
    state.kind === 'node' &&
    state.nodeOpened !== undefined &&
    optimization !== undefined &&
    optimization.objective.metric.kind === 'command' &&
    optimization.starting === undefined &&
    optimization.stopped === undefined &&
    !terminal(state) &&
    state.status !== 'paused' &&
    state.status !== 'blocked' &&
    state.pendingCommands.length === 0
  )
}
