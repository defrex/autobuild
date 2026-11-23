import {
  Waterfall,
  WaterfallAxis,
  WaterfallBar,
  WaterfallColumnHeader,
  WaterfallHeaderRow,
  WaterfallIndicator,
  WaterfallRow,
  WaterfallRowHeader,
  type WaterfallData,
  visibleWaterfallRows,
} from '@ui-sdk/react/waterfall'
import { type CSSProperties, useMemo, useState } from 'react'
import { type SegmentCategory, segmentStyle } from '../tokens'
import {
  type BuildTimeline,
  formatDuration,
  type Segment,
  segmentEnd,
  segmentLabel,
  timelineSpan,
} from './model'

export type GanttAxis = 'clock' | 'relative'

interface Props {
  builds: readonly BuildTimeline[]
  now: number
  axis: GanttAxis
  label: string
  defaultExpanded?: string[]
}

const segmentValue = (slug: string, index: number) => `${slug}/${index}`

function clockFormat(span: number) {
  const day = 24 * 3600_000
  const opts: Intl.DateTimeFormatOptions =
    span > 10 * day
      ? { month: 'short', day: 'numeric' }
      : span > day
        ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }
        : { hour: '2-digit', minute: '2-digit', hour12: false }
  const f = new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' })
  return (ms: number) => f.format(ms)
}

export function Gantt({ builds, now, axis, label, defaultExpanded = [] }: Props) {
  const [expanded, setExpanded] = useState<string[]>(defaultExpanded)
  const [hover, setHover] = useState<{ build: BuildTimeline; segment: Segment } | null>(null)

  const { items, range, origin } = useMemo(() => {
    const origin = new Map<string, number>()
    let lo = Number.POSITIVE_INFINITY
    let hi = Number.NEGATIVE_INFINITY
    const items: WaterfallData = builds.map((b) => {
      const [start, end] = timelineSpan(b, now)
      const zero = axis === 'relative' ? start : 0
      origin.set(b.slug, zero)
      lo = Math.min(lo, start - zero)
      hi = Math.max(hi, end - zero)
      return {
        value: b.slug,
        label: `${b.ticket} ${b.title}`,
        start: start - zero,
        duration: end - start,
        children: b.segments.map((s, i) => ({
          value: segmentValue(b.slug, i),
          label: segmentLabel[s.category],
          start: s.start - zero,
          duration: segmentEnd(s, now) - s.start,
        })),
      }
    })
    return { items, range: [lo, hi] as [number, number], origin }
  }, [builds, now, axis])

  const rows = visibleWaterfallRows(items, expanded)
  const byValue = new Map(builds.map((b) => [b.slug, b]))
  const width = range[1] - range[0]
  const pct = (t: number) => `${((t - range[0]) / width) * 100}%`
  const format = axis === 'relative' ? formatDuration : clockFormat(width)

  const used = new Set(builds.flatMap((b) => b.segments.map((s) => s.category)))

  return (
    <figure data-ansi="gantt">
      <Waterfall
        aria-label={label}
        items={items}
        range={range}
        expanded={expanded}
        onExpandedChange={setExpanded}
        format={format}
        getBarLabel={(item) => `${item.label}, ${formatDuration(item.duration)}`}
      >
        <WaterfallHeaderRow>
          <WaterfallColumnHeader>Build</WaterfallColumnHeader>
          <WaterfallColumnHeader aria-label="Timeline">
            <WaterfallAxis maxTicks={6} />
          </WaterfallColumnHeader>
        </WaterfallHeaderRow>
        {rows.map(({ item, parent }) => {
          if (parent === null) {
            const build = byValue.get(item.value)
            if (build === undefined) return null
            const zero = origin.get(build.slug) ?? 0
            return (
              <WaterfallRow key={item.value} value={item.value} data-outcome={build.outcome}>
                <WaterfallRowHeader>
                  <WaterfallIndicator>
                    <span data-ansi="disclosure" aria-hidden="true" />
                  </WaterfallIndicator>
                  <span data-ansi="ticket-id">{build.ticket}</span>
                  <span data-ansi="gantt-title">{build.title}</span>
                </WaterfallRowHeader>
                <WaterfallBar data-ansi="gantt-track">
                  {build.segments.map((s, i) => (
                    <span
                      key={segmentValue(build.slug, i)}
                      data-ansi="segment"
                      data-category={s.category}
                      data-fill={segmentStyle[s.category].fill}
                      data-open={s.end === undefined ? '' : undefined}
                      style={
                        {
                          '--seg-start': pct(s.start - zero),
                          '--seg-size': pct(range[0] + segmentEnd(s, now) - s.start),
                        } as CSSProperties
                      }
                      onPointerEnter={() => setHover({ build, segment: s })}
                      onPointerLeave={() => setHover(null)}
                    />
                  ))}
                </WaterfallBar>
              </WaterfallRow>
            )
          }
          const build = byValue.get(parent)
          const index = Number(item.value.slice(parent.length + 1))
          const segment = build?.segments[index]
          if (build === undefined || segment === undefined) return null
          return (
            <WaterfallRow key={item.value} value={item.value}>
              <WaterfallRowHeader>
                <span data-ansi="segment-name">{segmentLabel[segment.category]}</span>
                {segment.round !== undefined && <span data-ansi="round"> r{segment.round}</span>}
                <span data-ansi="elapsed">
                  {' '}
                  {formatDuration(segmentEnd(segment, now) - segment.start)}
                </span>
              </WaterfallRowHeader>
              <WaterfallBar
                data-ansi="segment-bar"
                data-category={segment.category}
                data-fill={segmentStyle[segment.category].fill}
                data-open={segment.end === undefined ? '' : undefined}
              />
            </WaterfallRow>
          )
        })}
      </Waterfall>
      <p data-ansi="readout" aria-live="off">
        {hover === null ? (
          <span data-ansi="slack">
            Point at a segment for its detail. Expand a build to list its segments.
          </span>
        ) : (
          <>
            <span data-ansi="ticket-id">{hover.build.ticket}</span>{' '}
            {segmentLabel[hover.segment.category]}
            {hover.segment.round !== undefined && ` round ${hover.segment.round}`} ·{' '}
            <span data-ansi="machine">
              {formatDuration(segmentEnd(hover.segment, now) - hover.segment.start)}
              {hover.segment.end === undefined && ' and counting'}
            </span>
          </>
        )}
      </p>
      <SegmentLegend categories={[...used]} />
    </figure>
  )
}

const work: SegmentCategory[] = [
  'plan',
  'plan-review',
  'implement',
  'code-review',
  'verify',
  'finalize',
  'reconcile',
]
const waits: SegmentCategory[] = ['queued', 'ticket-wait', 'paused', 'escalated', 'awaiting-merge']

export function SegmentLegend({ categories }: { categories?: readonly SegmentCategory[] }) {
  const show = (list: SegmentCategory[]) =>
    list.filter((c) => categories === undefined || categories.includes(c))
  return (
    <div data-ansi="legend">
      {[
        ['Work', show(work)],
        ['Waiting', show(waits)],
      ].map(([title, list]) =>
        (list as SegmentCategory[]).length === 0 ? null : (
          <div key={title as string} data-ansi="legend-group">
            <span data-ansi="legend-title">{title as string}</span>
            <ul>
              {(list as SegmentCategory[]).map((c) => (
                <li key={c}>
                  <span
                    data-ansi="swatch"
                    data-category={c}
                    data-fill={segmentStyle[c].fill}
                    aria-hidden="true"
                  />
                  {segmentLabel[c]}
                </li>
              ))}
            </ul>
          </div>
        ),
      )}
    </div>
  )
}
