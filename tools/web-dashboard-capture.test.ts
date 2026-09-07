import { expect, test } from 'bun:test'
import type { DashboardBuild, DashboardModel } from 'autobuild/operator-presentation'
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
