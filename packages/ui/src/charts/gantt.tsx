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
import {
  type CSSProperties,
  Fragment,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Placeholder } from '../components/display'
import { usePresence } from '../components/motion'
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
  /** Controlled expansion: a page that re-renders the chart (a live flow's
   * measuring pass) keeps one expansion across every copy. */
  expanded?: string[]
  onExpandedChange?: (expanded: string[]) => void
  /** Collapsed rows of height the chart always holds, so a sparse page moves
   * nothing below it. */
  reserveRows?: number
  /** Shown inside the reserved area when there are no builds. */
  empty?: ReactNode
}

const segmentName = (segment: Segment) => segment.step ?? segmentLabel[segment.category]

/** A step name with a line-break opportunity after each colon, so a narrow
 * label column wraps `verify:integration` at the colon, not mid-word. */
function breakable(name: string): ReactNode {
  const parts = name.split(':')
  return parts.map((part, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: fixed split of one name
    <Fragment key={i}>
      {part}
      {i < parts.length - 1 && (
        <>
          :<wbr />
        </>
      )}
    </Fragment>
  ))
}

const reserve = (rows: number | undefined) =>
  rows === undefined ? undefined : ({ '--gantt-reserve-rows': String(rows) } as CSSProperties)

const segmentValue = (slug: string, index: number) => `${slug}/${index}`
const COLLAPSE_MS = 180
const DAY = 24 * 3600_000

function clockFormat(span: number) {
  const opts: Intl.DateTimeFormatOptions =
    span > 10 * DAY
      ? { month: 'short', day: 'numeric' }
      : span > DAY
        ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }
        : { hour: '2-digit', minute: '2-digit', hour12: false }
  const f = new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' })
  return (ms: number) => f.format(ms)
}

const timeOfDay = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
})

export interface Detail {
  build: BuildTimeline
  segment: Segment
  x: number
  y: number
}

/** Collapsing keeps the children mounted for one exit transition. */
function useCollapsing(expanded: string[]) {
  const [closing, setClosing] = useState<string[]>([])
  const previous = useRef(expanded)
  useEffect(() => {
    const gone = previous.current.filter((v) => !expanded.includes(v))
    previous.current = expanded
    if (gone.length === 0) return
    setClosing((c) => [...c, ...gone])
    const t = setTimeout(() => setClosing((c) => c.filter((v) => !gone.includes(v))), COLLAPSE_MS)
    return () => clearTimeout(t)
  }, [expanded])
  return closing.filter((v) => !expanded.includes(v))
}

export function Gantt({
  builds,
  now,
  axis,
  label,
  defaultExpanded = [],
  expanded: controlled,
  onExpandedChange,
  reserveRows,
  empty,
}: Props) {
  const [own, setOwn] = useState<string[]>(defaultExpanded)
  const expanded = controlled ?? own
  const setExpanded = onExpandedChange ?? setOwn
  const closing = useCollapsing(expanded)
  const figure = useRef<HTMLElement>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const last = useRef<Detail | null>(null)
  if (detail !== null) last.current = detail
  const presence = usePresence(detail !== null, 140)

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
          label: segmentName(s),
          start: s.start - zero,
          duration: segmentEnd(s, now) - s.start,
        })),
      }
    })
    // An empty page keeps the axis row's height over a nominal span, but
    // labels no ticks: there is no time to place them at.
    if (items.length === 0) return { items, range: [0, 3600_000] as [number, number], origin }
    return { items, range: [lo, hi] as [number, number], origin }
  }, [builds, now, axis])

  const open = [...expanded, ...closing]
  const rows = visibleWaterfallRows(items, open)
  const byValue = new Map(builds.map((b) => [b.slug, b]))
  const width = range[1] - range[0]
  const pct = (t: number) => `${((t - range[0]) / width) * 100}%`
  const format = axis === 'relative' ? formatDuration : clockFormat(width)

  const show = (build: BuildTimeline, segment: Segment) => (event: { currentTarget: Element }) => {
    const host = figure.current?.getBoundingClientRect()
    if (host === undefined) return
    const r = event.currentTarget.getBoundingClientRect()
    const target =
      event.currentTarget.getAttribute('data-ansi') === 'segment-bar'
        ? (event.currentTarget.querySelector('[data-ansi="bar-mark"]')?.getBoundingClientRect() ??
          r)
        : r
    const x = Math.min(Math.max(target.left + target.width / 2 - host.left, 150), host.width - 150)
    setDetail({ build, segment, x, y: target.top - host.top })
  }
  const hide = () => setDetail(null)

  const shown = detail ?? last.current

  return (
    <figure
      data-ansi="gantt"
      ref={figure}
      data-reserve={reserveRows !== undefined ? '' : undefined}
      style={reserve(reserveRows)}
    >
      {builds.length === 0 && empty !== undefined && <div data-ansi="gantt-empty">{empty}</div>}
      <Waterfall
        aria-label={label}
        items={items}
        range={range}
        expanded={open}
        onExpandedChange={(next) =>
          setExpanded(next.filter((v) => !closing.includes(v) || expanded.includes(v)))
        }
        format={format}
        getBarLabel={(item) => `${item.label}, ${formatDuration(item.duration)}`}
      >
        <WaterfallHeaderRow>
          <WaterfallColumnHeader>Build</WaterfallColumnHeader>
          <WaterfallColumnHeader aria-label="Timeline">
            {items.length > 0 && <WaterfallAxis maxTicks={6} />}
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
                      onPointerEnter={show(build, s)}
                      onPointerLeave={hide}
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
            <WaterfallRow
              key={item.value}
              value={item.value}
              data-exiting={closing.includes(parent) ? '' : undefined}
            >
              <WaterfallRowHeader>
                <span data-ansi="segment-name">{breakable(segmentName(segment))}</span>
                {segment.round !== undefined && <span data-ansi="round"> r{segment.round}</span>}
                <span data-ansi="elapsed">
                  {' '}
                  {formatDuration(segmentEnd(segment, now) - segment.start)}
                </span>
              </WaterfallRowHeader>
              <WaterfallBar
                data-ansi="segment-bar"
                onPointerEnter={show(build, segment)}
                onPointerLeave={hide}
                onFocus={show(build, segment)}
                onBlur={hide}
              >
                <span
                  data-ansi="bar-mark"
                  data-category={segment.category}
                  data-fill={segmentStyle[segment.category].fill}
                  data-open={segment.end === undefined ? '' : undefined}
                />
              </WaterfallBar>
            </WaterfallRow>
          )
        })}
      </Waterfall>
      {presence !== null && shown !== null && (
        <SegmentPopover detail={shown} now={now} presence={presence} />
      )}
      <SegmentLegend />
    </figure>
  )
}

/** The hovered segment's detail, floating over the chart so nothing in the
 * page moves. Screen readers get the same facts from each bar's label. */
export function SegmentPopover({
  detail,
  now,
  presence,
}: {
  detail: Detail
  now: number
  presence: 'entering' | 'present' | 'exiting'
}) {
  const { build, segment } = detail
  const end = segmentEnd(segment, now)
  return (
    <div
      data-ansi="chart-popover"
      data-presence={presence}
      aria-hidden="true"
      style={{ '--x': `${detail.x}px`, '--y': `${detail.y}px` } as CSSProperties}
    >
      <p data-ansi="popover-head">
        <span
          data-ansi="swatch"
          data-category={segment.category}
          data-fill={segmentStyle[segment.category].fill}
        />
        <span data-ansi="machine">
          {segmentName(segment)}
          {segment.round !== undefined && ` round ${segment.round}`}
        </span>
      </p>
      <p data-ansi="popover-build">
        <span data-ansi="ticket-id">{build.ticket}</span> {build.title}
      </p>
      <p data-ansi="machine" data-ansi-tone="slack">
        {timeOfDay.format(segment.start)}–
        {segment.end === undefined ? 'now' : timeOfDay.format(end)} ·{' '}
        {formatDuration(end - segment.start)}
        {segment.end === undefined && ' and counting'}
      </p>
    </div>
  )
}

/** The chart's geometry for a known number of rows. */
export function GanttSkeleton({ rows, reserveRows }: { rows: number; reserveRows?: number }) {
  return (
    <figure
      data-ansi="gantt"
      data-skeleton=""
      data-reserve={reserveRows !== undefined ? '' : undefined}
      style={reserve(reserveRows)}
    >
      <div data-ansi="gantt-skeleton-grid">
        <div data-ansi="gantt-skeleton-head">
          <Placeholder width="5ch" />
          <Placeholder width="40%" mono />
        </div>
        {Array.from({ length: rows }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton rows
          <div key={i} data-ansi="gantt-skeleton-row">
            <Placeholder width="min(18ch, 85%)" />
            <span data-ansi="gantt-skeleton-bar" />
          </div>
        ))}
      </div>
      <SegmentLegend />
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
const waits: SegmentCategory[] = ['queued', 'ticket-wait', 'paused', 'awaiting-merge', 'escalated']

/** The full legend, always: a chart's legend never changes with its data. */
export function SegmentLegend() {
  return (
    <div data-ansi="legend">
      {(
        [
          ['Work', work],
          ['Waiting', waits],
        ] as const
      ).map(([title, list]) => (
        <div key={title} data-ansi="legend-group">
          <span data-ansi="legend-title">{title}</span>
          <ul>
            {list.map((c) => (
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
      ))}
    </div>
  )
}
