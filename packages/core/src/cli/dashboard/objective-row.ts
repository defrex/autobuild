/**
 * An optimization node's objective row (RFC 0005 §12): the at-a-glance
 * progress every surface shows — the terminal dashboard, `ab status`,
 * `ab build status`, `ab watch` and the operator tools. It is a pure function
 * of the node's reduced digest, so it adds no store read to any surface.
 *
 * The row is independent of `now`, like the rest of the cached dashboard
 * model: it records when the budget opened and renderers evaluate elapsed
 * hours against their own clock.
 */
import type { BuildState } from '../../kernel/reducer'
import type { OptimizationStopCause } from '../../events/payloads'

export interface ObjectiveRow {
  metric: 'command' | 'panel'
  direction: 'minimize' | 'maximize'
  /** The value the node started from; a panel's is 0.5 by definition. */
  starting?: number
  /** The node head's value: a command's median, a panel's win rate. */
  current?: number
  threshold?: number
  /** The baseline measurement's spread. */
  noise?: number
  attempts: { filed: number; accepted: number; rejected: number; running: number }
  budget: { maxAttempts?: number; maxHours?: number; openedAt: string }
  stopped?: { cause: OptimizationStopCause; mode: 'abort' | 'drain'; at: string }
}

/** The row with its elapsed hours evaluated, as the status, watch and
 * operator surfaces carry it under `objective`. */
export type ObjectiveSummary = ObjectiveRow & { elapsedHours: number }

/** The terms every objective surface uses. */
export const objectiveVocabulary = {
  objective: 'objective',
  winRate: 'win rate',
  threshold: 'threshold',
  noThreshold: 'no threshold',
  noise: 'noise',
  notMeasured: 'not measured',
  attempts: 'attempts',
  accepted: 'accepted',
  rejected: 'rejected',
  running: 'running',
  budget: 'budget',
  hours: 'hours',
  stopped: 'stopped',
} as const

/** The row for an optimization node; undefined for every other build. */
export function projectObjectiveRow(state: BuildState): ObjectiveRow | undefined {
  const digest = state.optimization
  if (state.kind !== 'node' || digest === undefined) return undefined
  const { objective } = digest
  const panel = objective.metric.kind === 'panel'
  const starting = panel ? (digest.starting?.value ?? 0.5) : digest.starting?.value
  const current = digest.current ?? starting
  const { maxAttempts, maxHours } = objective.budget
  return {
    metric: objective.metric.kind,
    direction: objective.metric.kind === 'command' ? objective.metric.direction : 'maximize',
    ...(starting !== undefined ? { starting } : {}),
    ...(current !== undefined ? { current } : {}),
    ...(objective.target.threshold !== undefined ? { threshold: objective.target.threshold } : {}),
    ...(digest.starting !== undefined ? { noise: digest.starting.spread } : {}),
    attempts: { ...digest.attempts, running: digest.inFlight.length },
    budget: {
      ...(maxAttempts !== undefined ? { maxAttempts } : {}),
      ...(maxHours !== undefined ? { maxHours } : {}),
      openedAt: digest.openedAt,
    },
    ...(digest.stopped !== undefined ? { stopped: { ...digest.stopped } } : {}),
  }
}

const HOUR_MS = 3_600_000

/** Hours the budget has consumed at `now`; a stopped node's stop at its stop. */
export function objectiveElapsedHours(row: ObjectiveRow, now: Date): number {
  const end = row.stopped !== undefined ? Date.parse(row.stopped.at) : now.getTime()
  return Math.max(0, (end - Date.parse(row.budget.openedAt)) / HOUR_MS)
}

/** The summary surfaces carry, or undefined for a build that is not an
 * optimization node. */
export function objectiveSummary(state: BuildState, now: Date): ObjectiveSummary | undefined {
  const row = projectObjectiveRow(state)
  return row === undefined ? undefined : { ...row, elapsedHours: objectiveElapsedHours(row, now) }
}

/** A measured value, trimmed to at most six decimals. */
export function objectiveNumber(n: number): string {
  return String(+n.toFixed(6))
}

const percent = (n: number) => `${+(n * 100).toFixed(1)}%`

/**
 * The ordered segments every text surface prints, each split into its
 * ` · `-separated parts so a narrow renderer can wrap between them.
 */
export function objectiveParts(row: ObjectiveRow, elapsedHours: number): string[][] {
  const v = objectiveVocabulary
  const panel = row.metric === 'panel'
  const format = panel ? percent : objectiveNumber
  const value: string[] = []
  if (row.starting === undefined) value.push(`${v.objective} ${v.notMeasured}`)
  else
    value.push(
      panel
        ? `${v.winRate} ${format(row.starting)} → ${format(row.current ?? row.starting)}`
        : `${v.objective} ${format(row.starting)} → ${format(row.current ?? row.starting)} (${row.direction})`,
    )
  value.push(
    row.threshold === undefined ? v.noThreshold : `${v.threshold} ${format(row.threshold)}`,
  )
  if (row.noise !== undefined) value.push(`${v.noise} ±${format(row.noise)}`)
  const { attempts, budget } = row
  const budgetParts: string[] = []
  if (budget.maxAttempts !== undefined)
    budgetParts.push(`${attempts.filed}/${budget.maxAttempts} ${v.attempts}`)
  if (budget.maxHours !== undefined)
    budgetParts.push(`${elapsedHours.toFixed(1)}/${budget.maxHours} ${v.hours}`)
  return [
    value,
    [
      `${v.attempts} ${attempts.accepted} ${v.accepted}`,
      `${attempts.rejected} ${v.rejected}`,
      `${attempts.running} ${v.running}`,
    ],
    ...(budgetParts.length > 0 ? [[`${v.budget} ${budgetParts[0]}`, ...budgetParts.slice(1)]] : []),
    ...(row.stopped !== undefined
      ? [[`${v.stopped} ${row.stopped.cause} (${row.stopped.mode})`]]
      : []),
  ]
}

/** The segments joined for surfaces without a width bound. */
export function objectiveSegments(row: ObjectiveRow, elapsedHours: number): string[] {
  return objectiveParts(row, elapsedHours).map((parts) => parts.join(' · '))
}
