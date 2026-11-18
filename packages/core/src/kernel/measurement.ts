/**
 * Paired, harness-pinned objective measurement (SPEC §13.1.1, RFC 0005 §7.3,
 * §7.4): the deterministic math and the reduced-state selectors the
 * engine and dispatch capacity share. Nothing here performs I/O; the paired
 * execution itself lives in `processes/measurement-runner.ts`.
 */
import { compilePathSelectors } from '../config/path-selectors'
import type { EventPayload } from '../events/payloads'
import type { CommandMetric, ObjectiveEpsilon } from '../objective'
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
  /** The object id, when parsed from `ls-tree` output. */
  object?: string
}

/** Parse `git ls-tree -r -z` output. */
export function parseLsTree(output: string): TreeEntry[] {
  const entries: TreeEntry[] = []
  for (const record of output.split('\0')) {
    if (record === '') continue
    const tab = record.indexOf('\t')
    if (tab < 0) continue
    const [mode = '', type = '', object] = record.slice(0, tab).split(' ')
    entries.push({
      mode,
      type,
      path: record.slice(tab + 1),
      ...(object !== undefined ? { object } : {}),
    })
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

/** A leaf's latest measurement request that has not been sampled or
 * measured yet: the attempt runner's work. Read from reduced state alone. */
export function pendingMeasurementRequest(
  state: BuildState,
): EventPayload<'attempt.measurement-requested'> | undefined {
  const measurement = state.attemptMeasurement
  const request = measurement?.request
  if (request === undefined || state.kind === 'node' || terminal(state)) return undefined
  if (measurement?.measured?.request === request.id) return undefined
  if (measurement?.sampled?.request === request.id) return undefined
  const { seq: _seq, ...payload } = request
  return payload
}

/** The samples of a leaf's latest request that await their decision: the
 * dispatcher's work. Read from reduced state alone. */
export function sampledMeasurement(state: BuildState): EventPayload<'attempt.sampled'> | undefined {
  const measurement = state.attemptMeasurement
  const request = measurement?.request
  const sampled = measurement?.sampled
  if (request === undefined || sampled === undefined) return undefined
  if (state.kind === 'node' || terminal(state)) return undefined
  if (sampled.request !== request.id) return undefined
  if (measurement?.measured?.request === request.id || measurement?.refused === request.id)
    return undefined
  const { seq: _seq, ...payload } = sampled
  return payload
}

/** Why a node's digest cannot measure `request` under its current ruler, or
 * undefined. A ruler or harness pin newer than the request's, a panel, or a
 * missing starting value all refuse. */
export function unmeasurable(
  node: BuildState,
  request: Pick<
    EventPayload<'attempt.measurement-requested'>,
    'id' | 'node' | 'revision' | 'harnessPin'
  > & { metric?: CommandMetric },
): string | undefined {
  const optimization = node.optimization
  if (optimization === undefined) return `node ${request.node} has no accepted objective`
  const metric = optimization.objective.metric
  if (metric.kind !== 'command') return `node ${request.node} measures with a panel, not a command`
  if (request.revision < optimization.rulerRevision)
    return `request ${request.id} uses objective revision ${request.revision}, older than the current ruler (revision ${optimization.rulerRevision})`
  if (request.harnessPin !== optimization.accepted.harnessPin)
    return `request ${request.id} pins the harness at ${request.harnessPin}, but the node pins it at ${optimization.accepted.harnessPin}`
  if (request.metric !== undefined && !sameMetric(request.metric, metric))
    return `request ${request.id} names a metric that differs from the node's ruler`
  if (optimization.starting === undefined)
    return `node ${request.node} has no starting measurement under its current ruler`
  return undefined
}

function sameMetric(a: CommandMetric, b: CommandMetric): boolean {
  return (
    a.command === b.command &&
    a.direction === b.direction &&
    a.samples === b.samples &&
    a.harness.length === b.harness.length &&
    a.harness.every((selector, index) => selector === b.harness[index])
  )
}

/** The decision for one request's samples, against the node as it stands
 * now: its current ε and starting spread. A ruler or pin that moved past the
 * request refuses instead of deciding. */
export function decideSampledMeasurement(
  node: BuildState,
  request: EventPayload<'attempt.measurement-requested'>,
  sampled: EventPayload<'attempt.sampled'>,
): { measured: EventPayload<'attempt.measured'> } | { refusal: string } {
  const refusal = unmeasurable(node, request)
  if (refusal !== undefined) return { refusal }
  const optimization = node.optimization!
  const metric = optimization.objective.metric as CommandMetric
  const { medians } = sampled
  const delta = measurementDelta(metric.direction, medians.baseline, medians.candidate)
  const epsilon = effectiveEpsilon(optimization.objective.target.epsilon, medians.baseline)
  return {
    measured: {
      request: sampled.request,
      candidate: sampled.candidate,
      baseline: sampled.baseline,
      harnessPin: sampled.harnessPin,
      revision: sampled.revision,
      samples: sampled.samples,
      medians: { ...medians },
      delta,
      decision: measurementDecision(delta, epsilon),
      spread: optimization.starting!.spread,
      report: { ...sampled.report },
    },
  }
}

/** Whether an opened optimization node may run a node measurement now: not
 * terminal, paused or blocked, with no pending commands. */
function nodeMeasurable(state: BuildState): boolean {
  return (
    state.kind === 'node' &&
    state.nodeOpened !== undefined &&
    state.optimization !== undefined &&
    !terminal(state) &&
    state.status !== 'paused' &&
    state.status !== 'blocked' &&
    state.pendingCommands.length === 0
  )
}

/** An opened optimization node has no starting value under its current
 * ruler. Read from reduced state alone. A command samples its pin against
 * itself; a panel judges its pin against itself, and its starting value is
 * 0.5 by definition. */
export function baselineMeasurementDue(state: BuildState): boolean {
  const optimization = state.optimization
  return (
    nodeMeasurable(state) &&
    optimization!.starting === undefined &&
    optimization!.stopped === undefined
  )
}

/** The progress panel a panel node owes: its oldest landed head without a
 * recorded `progress-measured`, judged against the starting head. Read from
 * reduced state alone. Not gated on a stop, so a draining node still records
 * the progress of an attempt that lands. */
export function progressMeasurementDue(
  state: BuildState,
): { revision: number; head: string; start: string; harnessPin: string } | undefined {
  if (!nodeMeasurable(state)) return undefined
  const optimization = state.optimization!
  const head = optimization.progressQueue?.[0]
  if (
    optimization.objective.metric.kind !== 'panel' ||
    optimization.starting === undefined ||
    head === undefined
  )
    return undefined
  return {
    revision: optimization.revision,
    head,
    start: optimization.starting.head,
    harnessPin: optimization.accepted.harnessPin,
  }
}

/** Whether a node needs its runner for a measurement, starting or progress.
 * Every runner-admission site asks this. */
export function nodeMeasurementDue(state: BuildState): boolean {
  return baselineMeasurementDue(state) || progressMeasurementDue(state) !== undefined
}

/** The deterministic id of the escalation a failed node panel raises. */
export function nodePanelEscalationId(panelId: string): string {
  return `node-panel-failed-${panelId}`
}

/** The id of a node panel for `base`: generation `g` is the number of
 * answered failure escalations for this base, so a crash before an answer
 * resumes the same run, and an answer starts a new run with fresh judges.
 * Bounded by the answers to this one panel. */
export function nodePanelId(state: Pick<BuildState, 'answeredEscalations'>, base: string): string {
  const answered = new Set(state.answeredEscalations.map((escalation) => escalation.id))
  let generation = 0
  while (answered.has(nodePanelEscalationId(`${base}-r${generation}`))) generation += 1
  return `${base}-r${generation}`
}
