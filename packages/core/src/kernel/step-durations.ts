/**
 * `stepDurations`, the first rollup (RFC 0007 §8.6, SPEC §7.7): per step and
 * UTC day, a log-scale histogram of closed segment durations from every
 * build's `buildTimeline`.
 *
 * - Key arguments: `outcome` (`merged`, default, or `all`) and `kind` (`leaf`,
 *   default, `node` or `all`). `leaf` means any build whose kind is not
 *   `node`, so optimization attempts count as leaves.
 * - Read-time argument: `window` (`24h`, `7d`, default, `30d` or `all`). A
 *   window selects every UTC day it overlaps.
 * - Retention: days before `utcDay(now) − 400 days` are dropped.
 *
 * Pure and browser-safe.
 */
import { z } from 'zod'
import {
  TIMELINE_LATE_PHASE_STEPS,
  TIMELINE_PHASE_STEPS,
  TIMELINE_WAIT_STEPS,
  buildTimelineReducer,
  type BuildTimeline,
} from '../cli/dashboard/timeline'
import {
  addCell,
  bucketOf,
  histogramSchema,
  mergeInto,
  percentile,
  subtractFrom,
  totals,
  type Histogram,
} from '../store/histogram'
import { reducerVersion } from './reducer-identity'
import type { RollupDefinition } from './rollup'

export const STEP_DURATIONS_RETENTION_DAYS = 400
const DAY_MS = 86_400_000
const DAY = /^\d{4}-\d{2}-\d{2}$/

export const STEP_DURATION_WINDOWS = ['24h', '7d', '30d', 'all'] as const
export type StepDurationWindow = (typeof STEP_DURATION_WINDOWS)[number]
const WINDOW_MS: Record<Exclude<StepDurationWindow, 'all'>, number> = {
  '24h': DAY_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
}

const argsSchema = z
  .object({
    outcome: z.enum(['merged', 'all']).default('merged'),
    kind: z.enum(['leaf', 'node', 'all']).default('leaf'),
  })
  .strict()
export type StepDurationArgs = z.infer<typeof argsSchema>
const readSchema = z.object({ window: z.enum(STEP_DURATION_WINDOWS).default('7d') }).strict()
export type StepDurationRead = z.infer<typeof readSchema>

/** UTC day → step → histogram. */
export type DayHistograms = Record<string, Record<string, Histogram>>
const dayHistogramsSchema = z.record(
  z.string().regex(DAY),
  z.record(z.string().min(1), histogramSchema),
)
export interface StepDurationsAcc {
  days: DayHistograms
}
const accSchema = z.object({ days: dayHistogramsSchema }).strict()

export interface StepDurationStat {
  step: string
  count: number
  meanMs: number
  p50Ms: number
  p90Ms: number
  p99Ms: number
  totalMs: number
}
export interface StepDurationsValue {
  /** The repository change position the answer reflects. */
  position: string
  window: StepDurationWindow
  steps: StepDurationStat[]
}
const statSchema = z
  .object({
    step: z.string().min(1),
    count: z.number().int().positive(),
    meanMs: z.number().nonnegative(),
    p50Ms: z.number().nonnegative(),
    p90Ms: z.number().nonnegative(),
    p99Ms: z.number().nonnegative(),
    totalMs: z.number().nonnegative(),
  })
  .strict()
const valueSchema = z
  .object({
    position: z.string().regex(/^(0|[1-9][0-9]*)$/),
    window: z.enum(STEP_DURATION_WINDOWS),
    steps: z.array(statSchema),
  })
  .strict()

export function utcDay(at: Date | number | string): string {
  return new Date(at).toISOString().slice(0, 10)
}

/** The oldest UTC day retention keeps at `now`. */
export function retentionCutoff(now: Date): string {
  return utcDay(now.getTime() - STEP_DURATIONS_RETENTION_DAYS * DAY_MS)
}

/** Pipeline order: phases, `verify:*` by name, finalize, reconcile, then waits
 * in table order. Unknown steps sort last by name. */
export function stepOrder(steps: Iterable<string>): string[] {
  const rank = (step: string): number => {
    const phase = (TIMELINE_PHASE_STEPS as readonly string[]).indexOf(step)
    if (phase >= 0) return phase
    if (step.startsWith('verify:')) return 10
    const late = (TIMELINE_LATE_PHASE_STEPS as readonly string[]).indexOf(step)
    if (late >= 0) return 20 + late
    const wait = (TIMELINE_WAIT_STEPS as readonly string[]).indexOf(step)
    if (wait >= 0) return 30 + wait
    return 100
  }
  return [...steps].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
}

function passes(timeline: BuildTimeline, args: StepDurationArgs): boolean {
  if (args.outcome === 'merged' && timeline.outcome !== 'merged') return false
  if (args.kind === 'leaf' && timeline.kind === 'node') return false
  if (args.kind === 'node' && timeline.kind !== 'node') return false
  return true
}

function contribute(value: unknown, args: StepDurationArgs, now: Date): DayHistograms | null {
  const timeline = value as BuildTimeline
  if (!passes(timeline, args)) return null
  const cutoff = retentionCutoff(now)
  const days: DayHistograms = {}
  for (const segment of timeline.segments) {
    // Open and abandoned segments contribute nothing.
    if (segment.state !== 'closed' || segment.end === undefined) continue
    const day = utcDay(segment.end)
    if (day < cutoff) continue
    const count = segment.merged ?? 1
    const steps = (days[day] ??= {})
    const hist = (steps[segment.category] ??= {})
    // A merged segment records its occurrences at their mean's bucket, so
    // count and total stay exact.
    addCell(hist, bucketOf(segment.durationMs / count), count, segment.durationMs)
  }
  return Object.keys(days).length ? days : null
}

function add(acc: StepDurationsAcc, contribution: DayHistograms): void {
  for (const [day, steps] of Object.entries(contribution)) {
    const into = (acc.days[day] ??= {})
    for (const [step, hist] of Object.entries(steps)) mergeInto((into[step] ??= {}), hist)
  }
}

function subtract(acc: StepDurationsAcc, contribution: DayHistograms): void {
  for (const [day, steps] of Object.entries(contribution)) {
    // A day retention already dropped has nothing left to subtract.
    const from = acc.days[day]
    if (from === undefined) continue
    for (const [step, hist] of Object.entries(steps)) {
      const target = from[step]
      if (target === undefined) continue
      subtractFrom(target, hist)
      if (Object.keys(target).length === 0) delete from[step]
    }
    if (Object.keys(from).length === 0) delete acc.days[day]
  }
}

function expired(acc: StepDurationsAcc, now: Date): boolean {
  const cutoff = retentionCutoff(now)
  for (const day of Object.keys(acc.days)) if (day < cutoff) return true
  return false
}

function prune(acc: StepDurationsAcc, now: Date): boolean {
  const cutoff = retentionCutoff(now)
  let changed = false
  for (const day of Object.keys(acc.days))
    if (day < cutoff) {
      delete acc.days[day]
      changed = true
    }
  return changed
}

function finish(
  acc: StepDurationsAcc,
  read: StepDurationRead,
  now: Date,
  position: string,
): StepDurationsValue {
  const retained = retentionCutoff(now)
  const since = read.window === 'all' ? retained : utcDay(now.getTime() - WINDOW_MS[read.window])
  const from = since > retained ? since : retained
  const merged: Record<string, Histogram> = {}
  for (const [day, steps] of Object.entries(acc.days)) {
    if (day < from) continue
    for (const [step, hist] of Object.entries(steps)) mergeInto((merged[step] ??= {}), hist)
  }
  const steps: StepDurationStat[] = []
  for (const step of stepOrder(Object.keys(merged))) {
    const hist = merged[step]!
    const { count, totalMs } = totals(hist)
    if (count === 0) continue
    steps.push({
      step,
      count,
      meanMs: Math.round(totalMs / count),
      p50Ms: Math.round(percentile(hist, 0.5)),
      p90Ms: Math.round(percentile(hist, 0.9)),
      p99Ms: Math.round(percentile(hist, 0.99)),
      totalMs,
    })
  }
  return { position, window: read.window, steps }
}

export const stepDurationsRollup: RollupDefinition<
  StepDurationArgs,
  StepDurationRead,
  StepDurationsAcc,
  DayHistograms
> = {
  identity: 'stepDurations',
  version: reducerVersion('stepDurations', [buildTimelineReducer]),
  buildReducer: 'buildTimeline',
  args: argsSchema,
  read: readSchema,
  accSchema,
  contributionSchema: dayHistogramsSchema,
  valueSchema,
  initial: () => ({ days: {} }),
  contribute,
  add,
  subtract,
  expired,
  prune,
  finish,
}
