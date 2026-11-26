/**
 * Hand-written projection values for the web pages: a representative
 * overview and the frames that change it, plus the analytics answers and
 * build timelines the JSON routes serve. Valid against the shared
 * projection's types, never produced by calling core, so the views test,
 * the catalog and the layout probe share one scripted frame source. Status
 * tones are looked up in the shared word table, never restated here.
 */
import type { StepText } from '../../../core/src/cli/dashboard/row-text'
import {
  BUILD_STATUS_TONE,
  HARVEST_STATUS_TONE,
  type BuildStatusWord,
  type DashboardStatus,
  type HarvestStatusWord,
  type StatusText,
} from '../../../core/src/cli/dashboard/vocabulary'
import type { TimelineSegment } from '../../../core/src/cli/dashboard/timeline'
import type { StepDurationStat } from '../../../core/src/kernel/step-durations'
import type {
  WebAnalytics,
  WebAnalyticsQuery,
  WebBuildRow,
  WebFinishedRow,
  WebFrame,
  WebTimelineRow,
} from '../../../core/src/web/protocol'
import { NOW as CATALOG_NOW, fixtureBuilds as catalogBuilds } from '../catalog/fixtures'
import { stepStats } from '../charts/model'

export const NOW = Date.UTC(2026, 10, 24, 15, 0, 0)

const MIN = 60_000
const DAY = 24 * 60 * MIN

const done = (label: string, ms: number): StepText => ({
  label,
  state: 'done',
  timing: { accumulatedMs: ms },
  mark: '[x]',
  tone: 'ok',
})
const pending = (label: string): StepText => ({
  label,
  state: 'pending',
  mark: '[ ]',
  tone: 'pending',
})
const current = (label: string, sinceMs: number, extra: Partial<StepText> = {}): StepText => ({
  label,
  state: 'current',
  timing: { accumulatedMs: 0, runningSince: NOW - sinceMs },
  mark: '[>]',
  tone: 'live',
  ...extra,
})

const merge = { text: 'merge auto', tone: 'ok' as const }

/** A build row's status, its tone from the shared table. */
const word = (status: DashboardStatus, w: BuildStatusWord, note?: string): StatusText => ({
  status,
  word: w,
  tone: BUILD_STATUS_TONE[w],
  ...(note !== undefined ? { note } : {}),
})

/** A harvest row's status, its tone from the shared table. */
export const harvestWord = (status: DashboardStatus, w: HarvestStatusWord): StatusText => ({
  status,
  word: w,
  tone: HARVEST_STATUS_TONE[w],
})

/** The long-title running row: a ticking verify step on its second attempt. */
export const RUNNING_SLUG = 'resume-suspended-sessions-after-clean-stop'
const running: WebBuildRow = {
  slug: RUNNING_SLUG,
  ticketId: '#1084',
  title: 'Resume suspended sessions after a clean stop, keeping each harness native session',
  ticketUrl: 'https://github.com/acme/app/issues/1084',
  kind: 'work',
  status: word('running', 'RUNNING'),
  phase: 'verify:unit',
  flags: [],
  merge,
  pr: { text: 'PR open', url: 'https://github.com/acme/app/pull/1212' },
  target: { destination: 'main', distance: '+3' },
  steps: [
    done('plan', 6 * MIN),
    done('implement', 31 * MIN),
    done('code-review', 9 * MIN),
    current('verify:unit', 4 * MIN + 12_000, { qualifier: '2/3', count: 2 }),
    pending('finalize'),
  ],
  attention: [],
}

/** The blocked row: a multi-sentence escalation that wraps at phone width. */
export const BLOCKED_SLUG = 'archive-ref-store-copy'
const blockedQuestion =
  'The forge refuses refs/autobuild/archive pushes from this sandbox. Should the archive copy live only in the store, or should the build fail until the forge accepts the ref? The plan assumed the push would succeed.'
const blocked: WebBuildRow = {
  slug: BLOCKED_SLUG,
  ticketId: '#1051',
  title: 'Copy archive refs into the store when the forge refuses them',
  kind: 'work',
  status: word('blocked', 'BLOCKED'),
  phase: 'implement',
  flags: [],
  merge,
  target: { destination: 'main', distance: '+1' },
  steps: [
    done('plan', 7 * MIN),
    {
      ...current('implement', 0),
      timing: { accumulatedMs: 22 * MIN },
      state: 'provisional',
      mark: '[~]',
      tone: 'held',
    },
    pending('code-review'),
    pending('verify'),
  ],
  attention: [{ kind: 'escalation', tone: 'alert', text: blockedQuestion }],
}

export const WAITING_SLUG = 'show-waits-on-build-page'
const waiting: WebBuildRow = {
  slug: WAITING_SLUG,
  ticketId: '#1090',
  title: 'Show waits on the build page',
  kind: 'work',
  status: word('waiting', 'WAITING', 'on #1084, #1051'),
  flags: [],
  merge,
  target: { destination: 'main', distance: '+0' },
  steps: [done('plan', 5 * MIN), pending('implement'), pending('code-review')],
  attention: [{ kind: 'wait', tone: 'held', text: 'waiting on #1084 and #1051 to merge' }],
}

const integration: WebBuildRow = {
  slug: 'dispatcher-web-ui',
  ticketId: '#1073',
  title: 'Dispatcher web UI',
  kind: 'integration',
  status: word('collecting', 'COLLECTING'),
  phase: 'collect',
  flags: [],
  target: { destination: 'main', distance: '+12' },
  progress: {
    children: { known: true, total: 8, landed: 5, building: 2, queued: 1 },
    counts: [
      { text: '5/8 children merged', tone: 'ok' },
      { text: '2 building', tone: 'live' },
      { text: '1 queued', tone: 'pending' },
    ],
    verified: false,
  },
  steps: [current('collect', 3 * 3600_000 + 4 * MIN), pending('verify'), pending('finalize')],
  attention: [],
}

const held: WebBuildRow = {
  slug: 'record-forge-rate-limits',
  ticketId: '#1093',
  title: 'Record forge rate limits per credential',
  kind: 'work',
  status: word('paused', 'PAUSED'),
  flags: [],
  merge: { text: 'merge off', tone: 'pending' },
  target: { destination: 'main', distance: '+2' },
  tree: ['ab/record-forge-rate-limits · restack idle · verify pending · not ready to land'],
  ceiling: 'review round ceiling: code 4',
  steps: [done('plan', 4 * MIN), pending('implement')],
  attention: [{ kind: 'setup-error', tone: 'alert', text: 'Janitor failing: worktree is locked' }],
}

/** Rows for the words no other fixture row shows, so the overview renders
 * the whole build vocabulary (SPEC §14 "Status words"). */
const vocabularyRows: WebBuildRow[] = [
  {
    slug: 'trim-session-transcripts',
    ticketId: '#1094',
    title: 'Trim session transcripts before upload',
    kind: 'work',
    status: word('pausing', 'PAUSING'),
    phase: 'implement',
    flags: [],
    merge,
    target: { destination: 'main', distance: '+1' },
    steps: [done('plan', 6 * MIN), current('implement', 9 * MIN), pending('code-review')],
    attention: [],
  },
  {
    slug: 'retire-legacy-store-flag',
    ticketId: '#1095',
    title: 'Retire the legacy store flag',
    kind: 'work',
    status: word('aborting', 'ABORTING'),
    flags: [],
    merge,
    target: { destination: 'main', distance: '+0' },
    steps: [],
    notice: { text: 'abort requested; waiting for running work to stop', tone: 'ok' },
    attention: [],
  },
  {
    slug: 'resume-after-answer',
    ticketId: '#1096',
    title: 'Resume answered builds ahead of new claims',
    kind: 'work',
    status: word('resuming', 'QUEUED', 'resume'),
    flags: [],
    merge,
    target: { destination: 'main', distance: '+1' },
    steps: [done('plan', 5 * MIN), pending('implement')],
    attention: [],
  },
  {
    slug: 'land-forge-merge-queue',
    ticketId: '#1097',
    title: 'Land through the forge merge queue',
    kind: 'work',
    status: word('running', 'MERGING'),
    flags: [],
    merge,
    pr: { text: 'PR open', url: 'https://github.com/acme/app/pull/1097' },
    target: { destination: 'main', distance: '+1' },
    steps: [done('plan', 4 * MIN), done('implement', 18 * MIN), done('finalize', MIN)],
    attention: [],
  },
  {
    slug: 'drop-stale-preview-env',
    ticketId: '#1098',
    title: 'Drop the stale preview environment',
    kind: 'work',
    status: word('cleaning', 'CLEANING'),
    flags: [],
    merge,
    steps: [],
    notice: { text: 'running work stopped; abort cleanup pending or in progress', tone: 'pending' },
    attention: [],
  },
]

const queuedRows: WebBuildRow[] = [
  {
    slug: 'page-hosted-ticket-listing',
    ticketId: '#1101',
    title: 'Page the hosted ticket listing',
    kind: 'work',
    status: word('queued', 'STARTING'),
    flags: [{ term: 'held', tone: 'held' }],
    merge,
    steps: [pending('plan'), pending('implement')],
    attention: [],
  },
  {
    slug: 'split-verify-into-stages',
    ticketId: '#1102',
    title: 'Split verify into ordered stages',
    kind: 'work',
    status: word('queued', 'STARTING'),
    flags: [],
    merge,
    steps: [pending('plan')],
    notice: { text: 'workspace provisioning pending', tone: 'ok' },
    attention: [],
  },
]

const finishedRows: WebFinishedRow[] = [
  {
    slug: 'github-cooldown-exhausted',
    kind: 'work',
    outcome: 'merged',
    word: 'MERGED',
    tone: 'ok',
    completedAt: '2026-11-24T14:12:00.000Z',
  },
  {
    slug: 'rename-node-kind',
    kind: 'work',
    outcome: 'closed',
    word: 'CLOSED',
    tone: 'pending',
    completedAt: '2026-11-24T11:40:00.000Z',
  },
  {
    slug: 'hosted-intake-gate',
    kind: 'integration',
    outcome: 'aborted',
    word: 'ABORTED',
    tone: 'alert',
    completedAt: '2026-11-23T22:05:00.000Z',
  },
]

/** A representative overview: every row shape, built to wrap at 390 px.
 * Each call returns a fresh copy, so a derived frame never edits another. */
export function overviewFrame(): WebFrame {
  return structuredClone(baseFrame)
}

const baseFrame: WebFrame = {
  overview: {
    dispatcher: { mode: 'running', word: 'running', tone: 'ok' },
    header: {
      counts: [
        { label: 'triage', value: '4' },
        { label: 'queue', value: '2' },
        { label: 'active', value: '5/6' },
      ],
      capacityNote:
        '(6 configured; 1 parked build waiting for a slot ahead of normal ticket claims: resume-after-answer)',
      gates: [
        { label: 'intake', word: 'OFF', tone: 'held' },
        { label: 'harvest', word: 'ON', tone: 'ok' },
      ],
    },
    attention: [
      {
        kind: 'escalation',
        tone: 'alert',
        text: blockedQuestion,
        slug: BLOCKED_SLUG,
        ticketId: '#1051',
      },
      {
        kind: 'setup-error',
        tone: 'alert',
        text: 'Janitor failing: worktree is locked',
        slug: held.slug,
        ticketId: '#1093',
      },
      {
        kind: 'wait',
        tone: 'held',
        text: 'waiting on #1084 and #1051 to merge',
        slug: WAITING_SLUG,
        ticketId: '#1090',
      },
    ],
    harvest: {
      title: 'Harvest',
      status: harvestWord('running', 'HARVESTING'),
      observations: '14 observations',
      steps: [current('distill', 2 * MIN + 5000), pending('propose')],
    },
    active: [running, blocked, waiting, integration, held, ...vocabularyRows],
    queued: queuedRows,
    finished: finishedRows,
  },
}

function withOverview(change: (o: NonNullable<WebFrame['overview']>) => void): WebFrame {
  const frame = overviewFrame()
  change(frame.overview!)
  return frame
}

/** In place: the running row's verify step finishes, finalize starts, and
 * the row reads PAUSED. Nothing structural changes. */
export function stateChangedFrame(): WebFrame {
  return withOverview((o) => {
    const row = o.active[0]!
    row.status = word('paused', 'PAUSED')
    row.phase = 'finalize'
    row.steps = [
      ...row.steps.slice(0, 3),
      { ...done('verify:unit', 4 * MIN + 30_000), qualifier: '2/3', count: 2 },
      current('finalize', 5000),
    ]
  })
}

/** A transaction near the top: the running row is blocked with a question
 * that wraps at phone width, and the attention list gains it first. */
export function attentionArrivedFrame(): WebFrame {
  const question =
    'Verify fails on the unit suite because the fixture clock is a day ahead. Should the fixture move, or should the test pin its own clock? Either answer resumes the build.'
  return withOverview((o) => {
    const row = o.active[0]!
    row.status = word('blocked', 'BLOCKED')
    row.attention = [{ kind: 'escalation', tone: 'alert', text: question }]
    o.attention.unshift({
      kind: 'escalation',
      tone: 'alert',
      text: question,
      slug: RUNNING_SLUG,
      ticketId: '#1084',
    })
  })
}

/** Rows change sections: the running row merges and leads Recently finished,
 * the oldest finished row drops off, and the first queued row starts. */
export function movedFrame(): WebFrame {
  return withOverview((o) => {
    const merged = o.active.shift()!
    o.finished = [
      {
        slug: merged.slug,
        kind: 'work',
        outcome: 'merged',
        word: 'MERGED',
        tone: 'ok',
        completedAt: '2026-11-24T15:00:00.000Z',
      },
      ...o.finished.slice(0, -1),
    ]
    const started = o.queued.shift()!
    o.active.push({
      ...started,
      status: word('running', 'RUNNING'),
      phase: 'plan',
      steps: [current('plan', 3000), pending('implement')],
    })
    o.header.counts = [
      { label: 'triage', value: '4' },
      { label: 'queue', value: '1' },
      { label: 'active', value: '4/6' },
    ]
  })
}

/** The running row's current step at `elapsedMs` as of `base`, for sitting
 * a timer just short of a width boundary (`10s`, `1m00s`, `1h00m00s`). */
export function timedFrame(base: number, elapsedMs: number): WebFrame {
  return withOverview((o) => {
    const row = o.active[0]!
    row.steps = row.steps.map((step) =>
      step.state === 'current'
        ? { ...step, timing: { accumulatedMs: 0, runningSince: base - elapsedMs } }
        : step,
    )
  })
}

// ── Analytics and timelines ─────────────────────────────────────────────

type SegmentSpec = [
  category: string,
  minutes: number,
  extra?: Pick<TimelineSegment, 'round' | 'attempt'>,
]

/** Segments laid end to end so the last one ends at `endAt`, or is still
 * open there when `open`. */
function laidOut(specs: readonly SegmentSpec[], endAt: number, open = false): TimelineSegment[] {
  let t = endAt - specs.reduce((sum, [, minutes]) => sum + minutes * MIN, 0)
  return specs.map(([category, minutes, extra], i) => {
    const start = t
    t += minutes * MIN
    const last = open && i === specs.length - 1
    return {
      category,
      start: new Date(start).toISOString(),
      ...(last ? {} : { end: new Date(t).toISOString() }),
      durationMs: last ? 0 : minutes * MIN,
      opened: { type: 'fixture.opened', seq: 2 * i + 1 },
      ...(last ? {} : { closed: { type: 'fixture.closed', seq: 2 * i + 2 } }),
      ...extra,
      state: last ? 'open' : 'closed',
    }
  })
}

const pageRow = (row: WebBuildRow, segments: TimelineSegment[]): WebTimelineRow => ({
  slug: row.slug,
  ...(row.ticketId !== undefined ? { ticketId: row.ticketId } : {}),
  ...(row.ticketUrl !== undefined ? { ticketUrl: row.ticketUrl } : {}),
  title: row.title,
  kind: 'work',
  createdAt: segments[0]!.start,
  segments,
})

/** The build pages' own timelines: the running build on its second verify
 * attempt, the blocked one escalated, the waiting one on its tickets, and the
 * finished one merged. Any other slug has no build. */
export function timelineFixture(slug: string): WebTimelineRow | null {
  switch (slug) {
    case RUNNING_SLUG:
      return pageRow(
        running,
        laidOut(
          [
            ['queued', 3],
            ['plan', 6, { round: 1 }],
            ['plan-review', 3, { round: 1 }],
            ['implement', 23, { round: 1 }],
            ['code-review', 5, { round: 1 }],
            ['verify:unit', 5, { attempt: 1 }],
            ['implement', 8, { round: 2 }],
            ['code-review', 4, { round: 2 }],
            ['verify:unit', 4.2, { attempt: 2 }],
          ],
          NOW,
          true,
        ),
      )
    case BLOCKED_SLUG:
      return pageRow(
        blocked,
        laidOut(
          [
            ['queued', 2],
            ['plan', 7, { round: 1 }],
            ['plan-review', 4, { round: 1 }],
            ['implement', 22, { round: 1 }],
            ['escalated', 41, { round: 1 }],
          ],
          NOW,
          true,
        ),
      )
    case WAITING_SLUG:
      return pageRow(
        waiting,
        laidOut(
          [
            ['queued', 1],
            ['plan', 5, { round: 1 }],
            ['plan-review', 3, { round: 1 }],
            ['ticket-wait', 50],
          ],
          NOW,
          true,
        ),
      )
    case finishedRows[0]!.slug: {
      const segments = laidOut(
        [
          ['queued', 6],
          ['plan', 9, { round: 1 }],
          ['plan-review', 4, { round: 1 }],
          ['implement', 34, { round: 1 }],
          ['code-review', 7, { round: 1 }],
          ['verify:unit', 6, { attempt: 1 }],
          ['verify:integration', 11, { attempt: 1 }],
          ['finalize', 2],
          ['awaiting-merge', 18],
        ],
        Date.parse(finishedRows[0]!.completedAt),
      )
      return {
        slug: finishedRows[0]!.slug,
        ticketId: '#1077',
        title: 'Back off when the GitHub cooldown is exhausted',
        kind: 'work',
        outcome: 'merged',
        createdAt: segments[0]!.start,
        segments,
      }
    }
    default:
      return null
  }
}

/** The catalog's seeded builds moved to this file's clock, as served rows:
 * the newest two still implementing, the rest merged. */
const analyticsRows: WebTimelineRow[] = catalogBuilds(30).map((b) => {
  const shift = NOW - CATALOG_NOW
  const segments = b.segments.map((s, i): TimelineSegment => {
    const start = s.start + shift
    const end = s.end === undefined ? undefined : s.end + shift
    return {
      category: s.step ?? s.category,
      start: new Date(start).toISOString(),
      ...(end !== undefined ? { end: new Date(end).toISOString() } : {}),
      durationMs: end === undefined ? 0 : end - start,
      opened: { type: 'fixture.opened', seq: 2 * i + 1 },
      ...(end !== undefined ? { closed: { type: 'fixture.closed', seq: 2 * i + 2 } } : {}),
      ...(s.round !== undefined ? { round: s.round } : {}),
      state: end === undefined ? 'open' : 'closed',
    }
  })
  return {
    slug: b.slug,
    ticketId: b.ticket,
    title: b.title,
    kind: 'work',
    ...(b.outcome === 'merged' ? { outcome: 'merged' } : {}),
    createdAt: segments[0]!.start,
    segments,
  }
})

const WINDOW_DAYS: Record<WebAnalyticsQuery['window'], number | undefined> = {
  '24h': 1,
  '7d': 7,
  '30d': 30,
  all: undefined,
}

/** `GET /api/analytics` over the seeded builds: the filters select rows,
 * the Gantt pages them 25 at a time, and the step table is computed from
 * the selected rows' closed segments. Node builds: none. */
export function analyticsFixture(query: WebAnalyticsQuery): WebAnalytics {
  const days = WINDOW_DAYS[query.window]
  const windowStart =
    days === undefined ? Date.parse(analyticsRows.at(-1)!.segments[0]!.start) : NOW - days * DAY
  const selected = analyticsRows.filter(
    (row) =>
      query.kind !== 'node' &&
      (query.outcome === 'all' || row.outcome === 'merged') &&
      Date.parse(row.segments.at(-1)!.end ?? new Date(NOW).toISOString()) >= windowStart,
  )
  const offset = query.page === undefined ? 0 : Number(query.page)
  const next = offset + 25 < selected.length ? String(offset + 25) : null
  const by = new Map<string, number[]>()
  for (const row of selected)
    for (const s of row.segments) {
      if (s.state !== 'closed' || Date.parse(s.end!) < windowStart) continue
      by.set(s.category, [...(by.get(s.category) ?? []), s.durationMs])
    }
  const durations: StepDurationStat[] = [...by].map(([step, ms]) => {
    const s = stepStats(step, 'queued', ms)
    return {
      step,
      count: s.count,
      meanMs: s.mean,
      p50Ms: s.p50,
      p90Ms: s.p90,
      p99Ms: s.p99,
      totalMs: s.total,
    }
  })
  return {
    query,
    position: 'fixture-position',
    windowStart: new Date(windowStart).toISOString(),
    durations,
    gantt: { rows: selected.slice(offset, offset + 25), next },
  }
}
