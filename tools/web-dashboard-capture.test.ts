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

test('ticket narrow keeps two complete Fastext identity rows', () => {
  const spec = WEB_FRAME_SPECS.find((frame) => frame.id === 'tickets-narrow')
  if (!spec) throw new Error('tickets narrow frame spec is missing')
  const html = renderWebFrame(spec, models(), { css: '', fontCss: '' })
  const footer = html.match(/<div class="fastext"[\s\S]*?<\/div>/)?.[0]

  expect(footer).toContain('data-slot="red" data-empty="true"')
  expect(footer).toContain('data-slot="green" data-empty="true"')
  expect(footer).toContain('data-slot="yellow"><kbd>n</kbd><span>NEW TICKET</span>')
  expect(footer).toContain('data-slot="cyan" data-empty="true"')
  expect(() =>
    checkEvidence(spec, html.replace('data-slot="cyan"', 'data-missing="cyan"')),
  ).toThrow(/expected red, green, yellow, cyan Fastext slots/)
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
