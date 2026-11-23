import type { CSSProperties } from 'react'
import { segmentStyle } from '../tokens'
import { formatDuration, type StepStats } from './model'

export type DurationMode = 'per-run' | 'total'

/** One bar per step. Per-run: bar is the mean, ticks mark P50, P90 and P99.
 * Total: bar is the summed time in the window. It is a table, so the numbers
 * are the accessible view and the bars are decoration beside them. */
export function StepDurations({
  steps,
  mode,
  caption,
}: {
  steps: readonly StepStats[]
  mode: DurationMode
  caption: string
}) {
  const measure = (s: StepStats) => (mode === 'total' ? s.total : s.mean)
  const sorted = [...steps].sort((a, b) => measure(b) - measure(a))
  const scale = Math.max(1, ...steps.map((s) => (mode === 'total' ? s.total : s.p99)))
  const pct = (ms: number) => `${(ms / scale) * 100}%`
  const grand = steps.reduce((sum, s) => sum + s.total, 0)

  return (
    <table data-ansi="step-durations" data-mode={mode}>
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Step</th>
          <th scope="col" data-ansi="bar-head">
            <span data-ansi="visually-hidden">Distribution</span>
            {mode === 'per-run' && (
              <span data-ansi="marker-key" aria-hidden="true">
                <span data-marker="p50" /> P50 <span data-marker="p90" /> P90{' '}
                <span data-marker="p99" /> P99
              </span>
            )}
          </th>
          {mode === 'per-run' ? (
            <>
              <th scope="col">Mean</th>
              <th scope="col">P50</th>
              <th scope="col">P90</th>
              <th scope="col">P99</th>
              <th scope="col">Runs</th>
            </>
          ) : (
            <>
              <th scope="col">Total</th>
              <th scope="col">Share</th>
              <th scope="col">Runs</th>
            </>
          )}
        </tr>
      </thead>
      <tbody>
        {sorted.map((s) => (
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
                  style={{ '--bar': pct(measure(s)) } as CSSProperties}
                />
                {mode === 'per-run' &&
                  (['p50', 'p90', 'p99'] as const).map((p) => (
                    <span key={p} data-marker={p} style={{ '--at': pct(s[p]) } as CSSProperties} />
                  ))}
              </span>
            </td>
            {mode === 'per-run' ? (
              <>
                <td data-ansi="num">{formatDuration(s.mean)}</td>
                <td data-ansi="num">{formatDuration(s.p50)}</td>
                <td data-ansi="num">{formatDuration(s.p90)}</td>
                <td data-ansi="num">{formatDuration(s.p99)}</td>
                <td data-ansi="num">{s.count}</td>
              </>
            ) : (
              <>
                <td data-ansi="num">{formatDuration(s.total)}</td>
                <td data-ansi="num">{grand ? `${Math.round((s.total / grand) * 100)}%` : '–'}</td>
                <td data-ansi="num">{s.count}</td>
              </>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
