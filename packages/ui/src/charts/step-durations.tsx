import type { CSSProperties } from 'react'
import { Placeholder } from '../components/display'
import { segmentStyle } from '../tokens'
import { formatDuration, type StepStats } from './model'

export type DurationMode = 'per-run' | 'total'

/* Literals of TIMELINE_PHASE_STEPS, TIMELINE_LATE_PHASE_STEPS and
   TIMELINE_WAIT_STEPS in packages/core/src/cli/dashboard/timeline.ts; this
   package imports core only as types. A unit test holds them equal. */
const phases = ['plan', 'plan-review', 'implement', 'code-review']
const late = ['finalize', 'reconcile']
const waits = ['queued', 'escalated', 'paused', 'ticket-wait', 'awaiting-merge']

function rank(step: string): number {
  const phase = phases.indexOf(step)
  if (phase >= 0) return phase
  if (step.startsWith('verify:') || step === 'verify') return 10
  if (late.includes(step)) return 20 + late.indexOf(step)
  if (waits.includes(step)) return 30 + waits.indexOf(step)
  return 100
}

/** Steps in the served rollup's pipeline order: phases, `verify:*` by name,
 * finalize, reconcile, then waits; unknown steps last by name. Rows never
 * reorder when the measure or the window changes. */
export function orderSteps(steps: readonly StepStats[]): StepStats[] {
  return [...steps].sort(
    (a, b) => rank(a.step) - rank(b.step) || (a.step < b.step ? -1 : a.step > b.step ? 1 : 0),
  )
}

/** One bar per step. Per-run: the bar is the mean, ticks mark P50, P90 and
 * P99. Total: the bar is the summed time in the window. The columns stay the
 * same in both modes, so switching moves bars, never the table. It is a
 * table, so the numbers are the accessible view and the bars sit beside them. */
export function StepDurations({
  steps,
  mode,
  caption,
}: {
  steps: readonly StepStats[]
  mode: DurationMode
  caption: string
}) {
  const ordered = orderSteps(steps)
  const scale = Math.max(1, ...steps.map((s) => (mode === 'total' ? s.total : s.p99)))
  const fraction = (ms: number) => String(ms / scale)
  const grand = steps.reduce((sum, s) => sum + s.total, 0)

  return (
    <table data-ansi="step-durations" data-mode={mode}>
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Step</th>
          <th scope="col" data-ansi="bar-head">
            <span data-ansi="visually-hidden">Distribution</span>
            <span data-ansi="marker-key" aria-hidden="true">
              <span data-marker="p50" /> P50 <span data-marker="p90" /> P90{' '}
              <span data-marker="p99" /> P99
            </span>
          </th>
          <th scope="col" data-measure="per-run">
            Mean
          </th>
          <th scope="col" data-measure="per-run">
            P50
          </th>
          <th scope="col" data-measure="per-run">
            P90
          </th>
          <th scope="col" data-measure="per-run">
            P99
          </th>
          <th scope="col" data-measure="total">
            Total
          </th>
          <th scope="col" data-measure="total">
            Share
          </th>
          <th scope="col">Runs</th>
        </tr>
      </thead>
      <tbody>
        {ordered.map((s) => (
          <tr key={s.step}>
            <th scope="row" data-ansi="machine">
              {s.step}
            </th>
            <td data-ansi="bar-cell" aria-hidden="true">
              <span data-ansi="track">
                <span
                  data-ansi="bar"
                  data-category={s.category}
                  data-fill={segmentStyle[s.category].fill}
                  style={
                    { '--fraction': fraction(mode === 'total' ? s.total : s.mean) } as CSSProperties
                  }
                />
                {(['p50', 'p90', 'p99'] as const).map((p) => (
                  <span
                    key={p}
                    data-marker={p}
                    style={{ '--fraction': fraction(s[p]) } as CSSProperties}
                  />
                ))}
              </span>
            </td>
            <td data-ansi="num" data-measure="per-run" data-label="Mean">
              {formatDuration(s.mean)}
            </td>
            <td data-ansi="num" data-measure="per-run" data-label="P50">
              {formatDuration(s.p50)}
            </td>
            <td data-ansi="num" data-measure="per-run" data-label="P90">
              {formatDuration(s.p90)}
            </td>
            <td data-ansi="num" data-measure="per-run" data-label="P99">
              {formatDuration(s.p99)}
            </td>
            <td data-ansi="num" data-measure="total" data-label="Total">
              {formatDuration(s.total)}
            </td>
            <td data-ansi="num" data-measure="total" data-label="Share">
              {grand ? `${Math.round((s.total / grand) * 100)}%` : '–'}
            </td>
            <td data-ansi="num" data-label="Runs">
              {s.count}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** The table's geometry for a known number of steps. Its cells carry the
 * same column labels, which phone width shows above each figure. */
export function StepDurationsSkeleton({ rows }: { rows: number }) {
  const cells = ['Mean', 'P50', 'P90', 'P99', 'Total', 'Share', 'Runs']
  return (
    <table data-ansi="step-durations" data-skeleton="">
      <caption>
        <Placeholder width="26ch" />
      </caption>
      <thead>
        <tr>
          <th>
            <Placeholder width="4ch" />
          </th>
          <th data-ansi="bar-head">
            <Placeholder width="16ch" mono />
          </th>
          {cells.map((c) => (
            <th key={c}>
              <Placeholder width="5ch" />
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: rows }, (_, r) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton rows
          <tr key={r}>
            <th>
              <Placeholder width="14ch" mono />
            </th>
            <td data-ansi="bar-cell">
              <span data-ansi="track" />
            </td>
            {cells.map((c) => (
              <td key={c} data-ansi="num" data-label={c}>
                <Placeholder width="7ch" mono />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
