import { expect, test } from 'bun:test'
import type { DashboardBuild, DashboardModel } from 'autobuild/operator-presentation'
import { canPreviewPointer } from '../app/dashboard/BuildsView'
import {
  checkEvidence,
  chromiumBinary,
  evidenceText,
  renderWebFrame,
  WEB_FRAME_SPECS,
  type WebFixtureModels,
} from './web-dashboard-capture'

function build(overrides: Partial<DashboardBuild>): DashboardBuild {
  return {
    slug: 'demo',
    status: 'running',
    alsoPaused: false,
    steps: [],
    blockers: [],
    autoMerge: 'off',
    ...overrides,
  }
}

const HAPPY_STEPS: DashboardBuild['steps'] = [
  { label: 'plan', state: 'done', timing: { accumulatedMs: 1000 } },
  { label: 'implement', state: 'current', timing: { accumulatedMs: 0, runningSince: 1 } },
  { label: 'merge', state: 'pending', qualifier: 'waiting' },
]

/** Small stand-ins for the harness scenarios, carrying the same evidence. */
function models(): WebFixtureModels {
  const base = {
    repo: 'fixture/repo',
    queued: 0,
    observations: { current: 0, limit: 5 },
    defaultAutoMerge: false,
  }
  const happy: DashboardModel = {
    ...base,
    active: { current: 2, limit: 6 },
    drained: false,
    repositoryPaused: false,
    harvestPaused: false,
    builds: [
      build({
        slug: 'cache-warm-on-deploy',
        ticketId: 'AUT-1',
        steps: HAPPY_STEPS,
        pr: { url: 'https://forge.example/pr/1', state: 'merged' },
      }),
      build({ slug: 'dashboard-key-legend', ticketId: 'AUT-2', steps: HAPPY_STEPS }),
    ],
    harvest: {
      kind: 'harvest',
      run: 'h1',
      status: 'running',
      steps: [{ label: 'scan', state: 'done', timing: { accumulatedMs: 1000 } }],
      observations: 3,
      rounds: 1,
    },
  }
  const mixed: DashboardModel = {
    ...base,
    active: { current: 3, limit: 4 },
    drained: true,
    repositoryPaused: true,
    harvestPaused: true,
    builds: [
      build({
        slug: 'complete-dashboard-evidence',
        ticketId: 'CAP-COMPLETE',
        status: 'pausing',
        steps: HAPPY_STEPS,
        pr: { url: 'https://forge.example/pr/2', state: 'open' },
      }),
      build({
        slug: 'plan-blocked-dashboard',
        ticketId: 'CAP-PLAN',
        status: 'blocked',
        steps: HAPPY_STEPS,
        blockers: ['Question one.\n\nTHE CONFLICT\nLine three.\nLine four.\nLine five.'],
        sessions: [
          {
            id: 's1',
            role: 'plan',
            phase: 'plan',
            runtime: 'scripted',
            startedSeq: 1,
            status: 'ended',
            usage: { inputTokens: 1, outputTokens: 1, turns: 1 },
            transcript: { kind: 'transcript:plan', rev: 1 },
          },
        ],
      }),
      build({
        slug: 'implement-blocked-dashboard',
        ticketId: 'CAP-IMPLEMENT',
        status: 'blocked',
        steps: HAPPY_STEPS,
        blockers: ['Second question.'],
      }),
      build({
        slug: 'queued-dashboard-evidence',
        ticketId: 'CAP-QUEUED',
        status: 'queued',
        dispatch: 'dispatch workspace failed (attempt 1)',
      }),
    ],
  }
  return { happy, mixed }
}

test('every web frame renders its required evidence and none of the forbidden', () => {
  const fixtures = models()
  for (const spec of WEB_FRAME_SPECS) {
    const html = renderWebFrame(spec, fixtures, { css: '', fontCss: '' })
    expect(() => checkEvidence(spec, html), spec.id).not.toThrow()
    expect(html, spec.id).not.toContain('<script')
    expect(html, spec.id).toContain('<!doctype html>')
  }
})

test('selected Harvest frames keep fixed Fastext slots, empty outlines, and action labels', () => {
  const fixtures = models()
  for (const id of ['builds-harvest-wide', 'builds-harvest-narrow']) {
    const spec = WEB_FRAME_SPECS.find((frame) => frame.id === id)
    if (!spec) throw new Error(`${id} frame spec is missing`)
    const html = renderWebFrame(spec, fixtures, { css: '', fontCss: '' })
    const footer = html.match(/<div class="fastext"[\s\S]*?<\/div>/)?.[0]

    expect(footer).toContain('data-slot="red" data-empty="true"')
    expect(footer).toContain('data-slot="green" data-empty="true"')
    expect(footer).toContain('data-slot="yellow"><kbd>h</kbd><span>HARVEST</span>')
    expect(footer).toContain('data-slot="cyan"><kbd>Esc</kbd><span>DESELECT</span>')
    expect(evidenceText(footer ?? '')).not.toContain('PAUSE ALL')
    expect(evidenceText(footer ?? '')).not.toContain('RESUME ALL')
  }
})

test('singleton capture frames omit the repository selector', () => {
  const fixtures = models()
  const singletonFrames = WEB_FRAME_SPECS.filter(
    (spec) =>
      (spec.id.startsWith('builds-') || spec.id.startsWith('tickets-')) &&
      spec.id !== 'builds-multirepo-wide',
  )

  for (const spec of singletonFrames) {
    const html = renderWebFrame(spec, fixtures, { css: '', fontCss: '' })
    const nav = html.match(/<nav class="line navline"[\s\S]*?<\/nav>/)?.[0]
    expect(nav, spec.id).toBeDefined()
    expect(nav, spec.id).not.toContain('<label class="repo">')
    expect(nav, spec.id).not.toContain('<select')
  }
})

test('multi-repository capture frame exposes the selector and both options', () => {
  const spec = WEB_FRAME_SPECS.find((frame) => frame.id === 'builds-multirepo-wide')
  if (!spec) throw new Error('multi-repository frame spec is missing')
  const html = renderWebFrame(spec, models(), { css: '', fontCss: '' })

  expect(html).toContain('<label class="repo">')
  expect(html).toContain('<span class="slack">repo </span>')
  expect(html).toContain('<select>')
  expect(html).toContain('<option selected="">example/repository</option>')
  expect(html).toContain('<option>example/alternate</option>')
})
test('ticket frames render one semantic body inline and a calm empty queue', () => {
  const fixtures = models()
  for (const id of ['tickets-backlog-open-wide', 'tickets-backlog-open-narrow']) {
    const spec = WEB_FRAME_SPECS.find((frame) => frame.id === id)
    if (!spec) throw new Error(`${id} frame spec is missing`)
    const html = renderWebFrame(spec, fixtures, { css: '', fontCss: '' })
    expect(html).toContain('<h1>Capture fixture</h1>')
    expect(html).toContain('<ul>')
    expect(html).toContain('<hr/>')
    expect(html).not.toContain('<textarea')
    expect(html).not.toContain('Preview')
    const selected = html.match(/<li data-selected="true">[\s\S]*?<\/li>/)?.[0]
    expect(selected).toContain('class="trow"')
    expect(selected).toContain('class="detail tdetail"')
    expect(selected!.indexOf('class="detail tdetail"')).toBeGreaterThan(
      selected!.indexOf('class="trow"'),
    )
  }

  const emptySpec = WEB_FRAME_SPECS.find((frame) => frame.id === 'tickets-backlog-empty')
  if (!emptySpec) throw new Error('ticket empty frame spec is missing')
  const empty = renderWebFrame(emptySpec, fixtures, { css: '', fontCss: '' })
  expect(evidenceText(empty)).toContain('Nothing is waiting in Backlog.')
  expect(empty).not.toContain('loading-state')
})

test('ticket narrow keeps two complete Fastext identity rows', () => {
  const spec = WEB_FRAME_SPECS.find((frame) => frame.id === 'tickets-backlog-open-narrow')
  if (!spec) throw new Error('tickets narrow frame spec is missing')
  const html = renderWebFrame(spec, models(), { css: '', fontCss: '' })
  const footer = html.match(/<div class="fastext"[\s\S]*?<\/div>/)?.[0]

  expect(footer).toContain('data-slot="red"><kbd>Esc</kbd><span>CLOSE</span>')
  expect(footer).toContain('data-slot="green"><kbd>p</kbd><span>TO TODO</span>')
  expect(footer).toContain('data-slot="yellow"><kbd>n</kbd><span>NEW TICKET</span>')
  expect(footer).toContain('data-slot="cyan"><kbd>b</kbd><span>OPEN BUILD</span>')
  expect(() =>
    checkEvidence(spec, html.replace('data-slot="cyan"', 'data-missing="cyan"')),
  ).toThrow(/expected red, green, yellow, cyan Fastext slots/)
})

test('loading frames preserve shell landmarks and expose only one hidden announcement', () => {
  const fixtures = models()
  for (const id of ['builds-loading-wide', 'builds-loading-narrow']) {
    const spec = WEB_FRAME_SPECS.find((entry) => entry.id === id)
    expect(spec).toBeDefined()
    const html = renderWebFrame(spec!, fixtures, { css: '', fontCss: '' })
    expect(html).toContain('<main class="frame">')
    expect(html).toContain('<header class="masthead">')
    expect(html).toContain('<nav class="line navline"')
    expect(html).toContain('role="toolbar"')
    expect(html.match(/aria-live="polite"/g)).toHaveLength(2)
    const loadingStart = html.indexOf('<div class="loading-state">')
    const skeletonStart = html.indexOf('<div class="skeletons"', loadingStart)
    const loadingAnnouncement = html.slice(loadingStart, skeletonStart)
    expect(loadingStart).toBeGreaterThan(-1)
    expect(skeletonStart).toBeGreaterThan(loadingStart)
    expect(loadingAnnouncement.match(/aria-live="polite"/g)).toHaveLength(1)
    expect(html.match(/data-loading-row=""/g)).toHaveLength(5)
    expect(html).toContain('<div class="skeletons" aria-hidden="true">')
    expect(html).not.toContain('polling')
    expect(html).not.toContain('class="status"')
  }
})

test('hover frame keeps committed and preview state independent', () => {
  const spec = WEB_FRAME_SPECS.find((frame) => frame.id === 'builds-mixed-hover-wide')
  if (!spec) throw new Error('hover frame spec is missing')
  const html = renderWebFrame(spec, models(), { css: '', fontCss: '' })

  expect(html.match(/data-selected="true"/g)).toHaveLength(1)
  expect(html.match(/data-hovered="true"/g)).toHaveLength(1)
  const selectedRow = html.match(/<li class="row"[^>]*data-selected="true"[^>]*>/)?.[0]
  const hoveredRow = html.match(/<li class="row"[^>]*data-hovered="true"[^>]*>/)?.[0]
  expect(selectedRow).toBeDefined()
  expect(hoveredRow).toBeDefined()
  expect(selectedRow).not.toBe(hoveredRow)
  expect(evidenceText(html)).toContain('ABORT')
  expect(evidenceText(html)).toContain('RESUME')
  expect(evidenceText(html)).toContain('DETAILS')
  expect(evidenceText(html)).not.toContain('Unresolved blockers')
})

test('narrow capture frames never supply a hover preview', () => {
  const fixtures = models()
  for (const spec of WEB_FRAME_SPECS.filter((frame) => frame.width === 390)) {
    const html = renderWebFrame(spec, fixtures, { css: '', fontCss: '' })
    expect(html, spec.id).not.toContain('data-hovered="true"')
  }
})

test('hover preview requires a fine hovering mouse', () => {
  expect(canPreviewPointer('mouse', true)).toBe(true)
  expect(canPreviewPointer('mouse', false)).toBe(false)
  expect(canPreviewPointer('touch', true)).toBe(false)
  expect(canPreviewPointer('pen', true)).toBe(false)
})

test('evidence text decodes the entities the renderer escapes', () => {
  expect(evidenceText('<p>[&gt;] plan &amp; review&#x27;s &quot;x&quot;</p>')).toBe(
    ' [>] plan & review\'s "x" ',
  )
})

test('a frame missing its evidence fails the capture by name', () => {
  const spec = { ...WEB_FRAME_SPECS[0]!, requires: ['NOT PRESENT'] }
  const html = renderWebFrame(spec, models(), { css: '', fontCss: '' })
  expect(() => checkEvidence(spec, html)).toThrow(/required evidence "NOT PRESENT"/)
})

test('chromium detection prefers the configured binary and reports absence', () => {
  const which = () => undefined
  expect(
    chromiumBinary({ CHROMIUM_BIN: '/opt/chromium' }, (p) => p === '/opt/chromium', which),
  ).toBe('/opt/chromium')
  expect(
    chromiumBinary(
      { CHROMIUM_BIN: '/missing' },
      () => false,
      () => '/usr/local/bin/chromium',
    ),
  ).toBe('/usr/local/bin/chromium')
  expect(chromiumBinary({}, () => false, which)).toBeUndefined()
})
