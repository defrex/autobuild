/**
 * Hand-written projection values for the web pages: a representative
 * overview and the frames that change it. Valid against the shared
 * projection's types, never produced by calling core, so the views test,
 * the catalog and the layout probe share one scripted frame source.
 */
import type { StepText } from '../../../core/src/cli/dashboard/row-text'
import type { WebBuildRow, WebFinishedRow, WebFrame } from '../../../core/src/web/protocol'

export const NOW = Date.UTC(2026, 10, 24, 15, 0, 0)

const MIN = 60_000

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

/** The long-title running row: a ticking verify step on its second attempt. */
export const RUNNING_SLUG = 'resume-suspended-sessions-after-clean-stop'
const running: WebBuildRow = {
  slug: RUNNING_SLUG,
  ticketId: '#1084',
  title: 'Resume suspended sessions after a clean stop, keeping each harness native session',
  ticketUrl: 'https://github.com/acme/app/issues/1084',
  kind: 'work',
  status: { status: 'running', word: 'RUNNING', tone: 'ok' },
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
  status: { status: 'blocked', word: 'BLOCKED', tone: 'alert' },
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
  status: { status: 'waiting', word: 'WAITING', tone: 'held' },
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
  status: { status: 'collecting', word: 'COLLECTING', tone: 'live' },
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
  status: { status: 'suspended', word: 'SUSPENDED', tone: 'held' },
  flags: [
    { term: 'held', tone: 'held' },
    { term: 'paused', tone: 'held' },
  ],
  merge: { text: 'merge off', tone: 'pending' },
  target: { destination: 'main', distance: '+2' },
  tree: ['ab/record-forge-rate-limits · restack idle · verify pending · not ready to land'],
  ceiling: 'review round ceiling: code 4',
  steps: [done('plan', 4 * MIN), pending('implement')],
  attention: [{ kind: 'setup-error', tone: 'alert', text: 'Janitor failing: worktree is locked' }],
}

const queuedRows: WebBuildRow[] = [
  {
    slug: 'page-hosted-ticket-listing',
    ticketId: '#1101',
    title: 'Page the hosted ticket listing',
    kind: 'work',
    status: { status: 'queued', word: 'QUEUED', tone: 'live' },
    flags: [],
    merge,
    steps: [pending('plan'), pending('implement')],
    attention: [],
  },
  {
    slug: 'split-verify-into-stages',
    ticketId: '#1102',
    title: 'Split verify into ordered stages',
    kind: 'work',
    status: { status: 'queued', word: 'QUEUED', tone: 'live' },
    flags: [],
    merge,
    steps: [pending('plan')],
    notice: { text: 'next to launch when a slot opens', tone: 'live' },
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
        { label: 'active', value: '3/4' },
      ],
      capacityNote: '(limit lowered from 6 while a handoff drains)',
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
      status: { status: 'running', word: 'RUNNING', tone: 'ok' },
      observations: '14 observations',
      steps: [current('distill', 2 * MIN + 5000), pending('propose')],
    },
    active: [running, blocked, waiting, integration, held],
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
    row.status = { status: 'paused', word: 'PAUSED', tone: 'held' }
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
    row.status = { status: 'blocked', word: 'BLOCKED', tone: 'alert' }
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
      status: { status: 'running', word: 'RUNNING', tone: 'ok' },
      phase: 'plan',
      steps: [current('plan', 3000), pending('implement')],
    })
    o.header.counts = [
      { label: 'triage', value: '4' },
      { label: 'queue', value: '1' },
      { label: 'active', value: '3/4' },
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
