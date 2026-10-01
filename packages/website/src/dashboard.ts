import { COLOR, esc } from './svg'

type StepState = 'done' | 'current' | 'pending'

interface Step {
  state: StepState
  text: string
}

interface Row {
  lane: boolean
  id: string
  slug: string
  pr?: string
  status: 'RUNNING' | 'ESCALATED' | 'QUEUED'
  steps: Step[]
  message?: string
}

const done = (text: string): Step => ({ state: 'done', text: `[x] ${text}` })
const current = (text: string): Step => ({ state: 'current', text: `[>] ${text}` })
const pending = (text: string): Step => ({ state: 'pending', text: `[ ] ${text}` })

const ROWS: Row[] = [
  {
    lane: true,
    id: 'AUT-412',
    slug: 'add-retry-budget',
    status: 'RUNNING',
    steps: [
      done('spec(2s)'),
      done('plan(48s)'),
      done('plan-review(1m02s)'),
      current('implement(4m12s)'),
      pending('code-review'),
      pending('verify:*'),
      pending('finalize'),
    ],
  },
  {
    lane: false,
    id: 'AUT-415',
    slug: 'split-store-migrations',
    status: 'RUNNING',
    steps: [
      done('spec(3s)'),
      done('plan(1m10s)'),
      done('plan-review(2m40s)'),
      done('implement(9m03s)'),
      done('code-review(3m11s)'),
      current('verify:test(38s)'),
      pending('finalize'),
    ],
  },
  {
    lane: false,
    id: 'AUT-407',
    slug: 'export-csv-endpoint',
    pr: 'PR #88',
    status: 'RUNNING',
    steps: [done('verify:*(4m30s)'), done('finalize(52s)'), current('merge(waiting, 8m47s)')],
  },
  {
    lane: false,
    id: 'AUT-409',
    slug: 'cache-invalidation-race',
    status: 'ESCALATED',
    steps: [
      done('plan(40s)'),
      done('plan-review(55s)'),
      done('implement(6m50s)'),
      current('code-review(round 4)'),
    ],
    message: '! review-round ceiling reached: reviewer and implementer disagree on lock order',
  },
  {
    lane: false,
    id: 'AUT-418',
    slug: 'dark-mode-settings',
    status: 'QUEUED',
    steps: [
      pending('spec'),
      pending('plan'),
      pending('plan-review'),
      pending('implement'),
      pending('code-review'),
      pending('verify:*'),
      pending('finalize'),
    ],
  },
]

const STATUS_COLOR = { RUNNING: COLOR.ok, ESCALATED: COLOR.title, QUEUED: COLOR.live }
const STEP_STYLE: Record<StepState, string> = {
  done: `color: ${COLOR.ok}; font-weight: 400`,
  current: `color: ${COLOR.live}; font-weight: 700`,
  pending: `color: ${COLOR.slack}; font-weight: 400`,
}

const dim = (text: string): string => `<span style="color: ${COLOR.slack}">${text}</span>`

function row(r: Row): string {
  const steps = r.steps
    .map((s) => `<span style="${STEP_STYLE[s.state]}">${esc(s.text)}</span>`)
    .join('')
  const message = r.message
    ? `<div class="dash-full" style="color: ${COLOR.alert}">${esc(r.message)}</div>`
    : ''
  return `<div class="dash-row"><span style="color: ${COLOR.live}">${r.lane ? '&gt;' : ''}</span>${dim(r.id)}<b>${r.slug}</b><span${r.pr ? ` style="color: ${COLOR.live}"` : ''}>${r.pr ?? ''}</span><b style="color: ${STATUS_COLOR[r.status]}; text-align: right">${r.status}</b><div class="dash-full dash-steps">${steps}</div>${message}</div>`
}

/** The terminal dashboard rendition, drawn from fixture data. */
export function dashboardRendition(): string {
  const on = `<b style="color: ${COLOR.ok}">ON</b>`
  return `<div class="scroll" tabindex="0" role="region" aria-label="Terminal dashboard showing five example builds"><div class="dash"><div class="dash-head"><b style="color: ${COLOR.title}">example/webapp</b>${dim('operator ▾')}</div><div class="dash-status"><span>${dim('queue')} 1 ${dim('·')} ${dim('active')} 4/6 ${dim('·')} ${dim('observations')} 7/20</span><span>intake ${on}  auto merge ${on}  harvest ${on}</span><span>14:02:31</span></div>${ROWS.map(row).join('')}</div></div>`
}
