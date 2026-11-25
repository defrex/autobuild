import { useEffect, useMemo, useState } from 'react'
import type { WebAnalytics } from '../../../core/src/web/protocol'
import { Gantt, type GanttAxis, GanttSkeleton } from '../charts/gantt'
import { type DurationMode, StepDurations, StepDurationsSkeleton } from '../charts/step-durations'
import { EmptySentence, SectionHeading } from '../components/composites'
import { Choice, WordAction } from '../components/controls'
import { type FlowBlock, StableFlow } from '../components/motion'
import {
  type AnalyticsFilters,
  analyticsUrl,
  durationStats,
  FIRST_PAGE,
  ganttTimeline,
  newerPage,
  olderPage,
  type PageCursor,
  queryFromSearch,
  queryKey,
  searchFromQuery,
  timelineLive,
} from './analytics-model'
import { useClock } from './clock'
import { useApi } from './fetch'

/** Rows the Gantt always reserves: one full page. */
export const GANTT_ROWS = 25
/** Rows the step table's skeleton holds: the pipeline's usual steps. */
export const DURATION_ROWS = 12

const WINDOW_TEXT: Record<AnalyticsFilters['window'], string> = {
  '24h': 'last 24 hours',
  '7d': 'last 7 days',
  '30d': 'last 30 days',
  all: 'all retained history',
}

/** "merged leaf builds", "node builds", "all builds". */
export function populationText(filters: Pick<AnalyticsFilters, 'outcome' | 'kind'>): string {
  const words = [
    ...(filters.outcome === 'merged' ? ['merged'] : []),
    ...(filters.kind === 'all' ? [] : [filters.kind]),
  ]
  return words.length === 0 ? 'all builds' : `${words.join(' ')} builds`
}

export function durationsCaption(filters: AnalyticsFilters, mode: DurationMode): string {
  const lead = mode === 'per-run' ? 'Time per run' : 'Where the time went'
  return `${lead}, ${WINDOW_TEXT[filters.window]}, ${populationText(filters)}`
}

export interface AnalyticsView {
  /** The last answer, possibly for an earlier query while a newer one loads. */
  data: WebAnalytics | undefined
  /** Whether `data` answers the current filters and page. */
  current: boolean
  /** The current request's failure. It outranks `data`: a failed refresh
   * shows its message, never the stale charts as if current. */
  error: string | undefined
  filters: AnalyticsFilters
  cursor: PageCursor
  axis: GanttAxis
  mode: DurationMode
  now: number
  expanded: string[]
  /** Changes apply to the latest state, never to the closure a shown block
   * captured, so a control clicked mid-transition keeps the other filters. */
  on: {
    filters(patch: Partial<AnalyticsFilters>): void
    page(change: (cursor: PageCursor) => PageCursor): void
    axis(next: GanttAxis): void
    mode(next: DurationMode): void
    expanded(next: string[]): void
  }
}

function control<V extends string>(
  label: string,
  value: V,
  options: readonly { value: V; label: string }[],
  onValueChange: (value: V) => void,
) {
  return (
    <div data-app="control">
      <span data-app="control-label" aria-hidden="true">
        {label}
      </span>
      <Choice label={label} value={value} options={options} onValueChange={onValueChange} />
    </div>
  )
}

/** A reserved pager action: always present, a link only when it can act. */
function pagerAction(label: string, act: (() => void) | undefined) {
  return act === undefined ? (
    <WordAction aria-disabled="true">{label}</WordAction>
  ) : (
    <WordAction
      href={`#${label.toLowerCase()}`}
      onClick={(event) => {
        event.preventDefault()
        act()
      }}
    >
      {label}
    </WordAction>
  )
}

/**
 * The analytics page as keyed flow blocks: controls, the Gantt and the step
 * table. Chart keys carry the answered query, and the Gantt's its axis, so a
 * window, filter, page or axis change is a layout transaction. The measure
 * keeps its key: the table's bars scale and its markers slide by transform,
 * which moves nothing in layout. Pure.
 */
export function analyticsBlocks(view: AnalyticsView): FlowBlock[] {
  const { data, filters, cursor, on } = view
  const pageNumber = cursor.stack.length + 1
  const blocks: FlowBlock[] = [
    {
      key: 'controls',
      node: (
        // A slot: a choice's moving indicator is the control's own feedback,
        // never a reason to fade the page.
        <div data-app="controls" data-flow-slot="">
          {control(
            'Window',
            filters.window,
            [
              { value: '24h', label: '24 hours' },
              { value: '7d', label: '7 days' },
              { value: '30d', label: '30 days' },
              { value: 'all', label: 'All retained' },
            ],
            (window) => on.filters({ window }),
          )}
          {control(
            'Outcome',
            filters.outcome,
            [
              { value: 'merged', label: 'Merged' },
              { value: 'all', label: 'All' },
            ],
            (outcome) => on.filters({ outcome }),
          )}
          {control(
            'Kind',
            filters.kind,
            [
              { value: 'leaf', label: 'Leaf' },
              { value: 'node', label: 'Node' },
              { value: 'all', label: 'All' },
            ],
            (kind) => on.filters({ kind }),
          )}
          {control(
            'Time axis',
            view.axis,
            [
              { value: 'clock', label: 'Clock' },
              { value: 'relative', label: 'From start' },
            ],
            on.axis,
          )}
          {control(
            'Measure',
            view.mode,
            [
              { value: 'per-run', label: 'Per run' },
              { value: 'total', label: 'Total time' },
            ],
            on.mode,
          )}
        </div>
      ),
    },
    {
      key: 'h:gantt',
      node: <SectionHeading title="Builds" />,
    },
    {
      key: 'pager',
      node: (
        <p data-app="pager" data-flow-slot="">
          <span data-ansi="slack">Most recently active first, page {pageNumber}</span>
          <span data-app="pager-actions">
            {pagerAction('Newer', cursor.stack.length > 0 ? () => on.page(newerPage) : undefined)}
            {pagerAction(
              'Older',
              view.current && view.error === undefined && data?.gantt.next != null
                ? () => on.page((c) => olderPage(c, data.gantt.next!))
                : undefined,
            )}
          </span>
        </p>
      ),
    },
  ]

  const failed = view.error !== undefined
  const label = `Builds, page ${pageNumber}`
  if (data === undefined && !failed)
    blocks.push({
      key: 'gantt:loading',
      node: <GanttSkeleton rows={GANTT_ROWS} reserveRows={GANTT_ROWS} />,
    })
  else {
    const rows = failed || data === undefined ? [] : data.gantt.rows.map(ganttTimeline)
    const empty = failed ? view.error : 'No build matching these filters was active in this window.'
    blocks.push({
      // The axis is in the key: a switch moves every bar and tick, so it is
      // a layout transaction (fade, commit hidden, fade in), never a slide.
      key: failed ? 'gantt:error' : `gantt:${queryKey(data!.query, data!.query.page)}:${view.axis}`,
      node: (
        <div data-flow-slot="">
          <Gantt
            builds={rows}
            now={view.now}
            axis={view.axis}
            label={label}
            reserveRows={GANTT_ROWS}
            expanded={view.expanded}
            onExpandedChange={on.expanded}
            empty={<EmptySentence>{empty}</EmptySentence>}
          />
        </div>
      ),
    })
  }

  blocks.push({ key: 'h:durations', node: <SectionHeading title="Step durations" /> })
  if (data === undefined && !failed)
    blocks.push({
      key: 'durations:loading',
      node: <StepDurationsSkeleton rows={DURATION_ROWS} />,
    })
  else if (failed)
    blocks.push({
      key: 'durations:error',
      node: <EmptySentence>{view.error}</EmptySentence>,
    })
  else {
    const answered = data!.query
    const steps = durationStats(data!.durations)
    blocks.push({
      key: `durations:${queryKey(answered, undefined)}`,
      node: (
        <>
          <StepDurations
            steps={steps}
            mode={view.mode}
            caption={durationsCaption(answered, view.mode)}
          />
          {steps.length === 0 && (
            <EmptySentence>No step finished in this window for these builds.</EmptySentence>
          )}
        </>
      ),
    })
  }
  return blocks
}

/** The analytics page. Its filters live in the URL, so a reload keeps them;
 * it fetches on every query change and whenever the frame's change position
 * moves, never on a timer. */
export function AnalyticsPage({ position }: { position: string | undefined }) {
  const [filters, setFilters] = useState<AnalyticsFilters>(() =>
    queryFromSearch(typeof location === 'undefined' ? '' : location.search),
  )
  const [cursor, setCursor] = useState<PageCursor>(FIRST_PAGE)
  const [axis, setAxis] = useState<GanttAxis>('clock')
  const [mode, setMode] = useState<DurationMode>('per-run')
  const [expanded, setExpanded] = useState<string[]>([])
  // The URL keeps the filters, so a reload shows the same question.
  useEffect(() => {
    const search = searchFromQuery(filters, location.search)
    if (search !== location.search)
      history.replaceState(history.state, '', `${location.pathname}${search}`)
  }, [filters])
  const url = analyticsUrl(filters, cursor.page)
  const state = useApi<WebAnalytics>(url, position)
  const error = state.errorUrl === url ? state.error : undefined
  // A failed refresh shows no chart, so nothing grows on a stale answer.
  const live = error === undefined && (state.data?.gantt.rows.some(timelineLive) ?? false)
  const now = useClock(live)
  const blocks = useMemo(
    () =>
      analyticsBlocks({
        data: state.data,
        current: state.dataUrl === url,
        error,
        filters,
        cursor,
        axis,
        mode,
        now,
        expanded,
        on: {
          filters: (patch) => {
            setFilters((previous) => ({ ...previous, ...patch }))
            setCursor(FIRST_PAGE)
          },
          page: setCursor,
          axis: setAxis,
          mode: setMode,
          expanded: setExpanded,
        },
      }),
    [state, error, url, filters, cursor, axis, mode, now, expanded],
  )
  return <StableFlow blocks={blocks} seq={0} />
}
