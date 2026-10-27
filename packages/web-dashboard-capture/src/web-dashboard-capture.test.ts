import { expect, test } from 'bun:test'
import type { DashboardBuild, DashboardModel } from '@defrex/autobuild/operator-presentation'
import {
  buildRowActions,
  canPreviewPointer,
  handleRowControlKey,
} from '../../hosted-store-service/app/dashboard/BuildsView'
import {
  captureStateCss,
  checkEvidence,
  chromiumBinary,
  evidenceText,
  fontFaceCss,
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

/** The shell line under the masthead: view tabs, then the repository controls. */
const tabLine = (html: string) =>
  html.match(/<div class="line navline">[\s\S]*?<\/fieldset><\/div>/)?.[0]

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
        ticketId: 'AUT-131',
        steps: HAPPY_STEPS,
        pr: { url: 'https://forge.example/pr/1', state: 'merged' },
      }),
      build({ slug: 'dashboard-key-legend', ticketId: 'AUT-129', steps: HAPPY_STEPS }),
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
        steps: [
          ...HAPPY_STEPS,
          {
            label: 'verify:unit',
            state: 'done',
            qualifier: 'skipped',
            reason: 'skipped by post-reconcile policy: verify.afterReconcile = false',
          },
        ],
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
            streamStatus: 'closed',
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
  return {
    happy,
    mixed,
    forgeReadiness: {
      ...mixed,
      warningLines: [
        'Forge squash: merging disabled. Allow squash merging.',
        'Forge rebase: merging disabled. Allow rebase merging.',
      ],
    },
    capacity: {
      ...happy,
      active: { current: 5, limit: 5 },
      capacity: { configured: 4, occupied: 5, effective: 5, borrowingNodes: ['queue-conflict'] },
    },
    integration: {
      ...happy,
      builds: [
        build({
          slug: 'integration-empty',
          ticketId: 'NODE-3',
          status: 'collecting',
          kind: 'integration',
          integrationRow: {
            destination: 'main',
            openChildren: [],
            children: { known: false },
            verified: false,
            steps: [{ label: 'merge', state: 'pending', qualifier: 'consent' }],
          },
        }),
        ...['integration-with-pr', 'queue-conflict', 'queue-failed', 'queue-ready-node'].map(
          (slug) =>
            build({
              slug,
              kind: 'integration',
              integrationRow: {
                destination: 'main',
                openChildren: ['A', 'B'],
                children: { known: true, landed: 1, building: 2, queued: 0, total: 3 },
                verified: false,
                steps: [],
              },
              integrationDetail: {
                destination: 'main',
                branch: 'ab-node/node',
                restack: 'idle',
                conflictFiles: ['src/a file.ts'],
                membershipKnown: true,
                diagnostics: [],
                children: [
                  { source: 'fake', id: 'A', title: 'Work A', state: 'implement', landed: false },
                  { source: 'fake', id: 'B', title: 'Work B', state: 'code-review', landed: false },
                ],
                verification: 'unit failed — file a repair child targeting node',
                verifySteps: [{ step: 'unit', outcome: 'fail' }],
                landing: 'consent — press l, or ab merge node',
              },
            }),
        ),
        build({
          slug: 'integration-progress',
          kind: 'integration',
          integrationRow: {
            destination: 'main',
            openChildren: ['a', 'b'],
            children: { known: true, landed: 8, building: 1, queued: 1, total: 10 },
            verified: false,
            steps: [],
            alert: { tone: 'red', text: 'unit failed — file a repair child targeting NODE-3' },
          },
        }),
        build({
          slug: 'integration-ready',
          kind: 'integration',
          status: 'collecting',
          integration: 'awaiting consent',
          landing: {
            decision: {
              seq: 10,
              mode: 'consent',
              from: 'node',
              into: { kind: 'root' },
              labels: [],
              rule: { default: true },
              candidate: { head: 'head', parent: 'parent', cycle: 'cycle' },
            },
          },
          integrationRow: {
            destination: 'main',
            openChildren: [],
            children: { known: true, landed: 11, building: 0, queued: 0, total: 11 },
            verified: true,
            steps: [],
            alert: {
              tone: 'yellow',
              text: 'ready to merge into main — press l, or ab merge integration-ready',
            },
          },
        }),
      ],
    },
  }
}

test('every web frame renders its required evidence and none of the forbidden', async () => {
  const fixtures = models()
  for (const spec of WEB_FRAME_SPECS) {
    const html = await renderWebFrame(spec, fixtures, { css: '', fontCss: '' })
    expect(() => checkEvidence(spec, html), spec.id).not.toThrow()
    expect(html, spec.id).toContain('document.fonts.ready')
    expect(html, spec.id).toContain('<!doctype html>')
    if (spec.id.startsWith('builds-')) {
      expect(html, spec.id).not.toContain('class="fastext"')
      for (const retired of ['PAUSE ALL', 'RESUME ALL', 'DESELECT']) {
        expect(evidenceText(html), spec.id).not.toContain(retired)
      }
    }
  }
})

test('selected Harvest frames keep the run action in the row register without a footer', async () => {
  const fixtures = models()
  for (const id of ['builds-harvest-wide', 'builds-harvest-narrow']) {
    const spec = WEB_FRAME_SPECS.find((frame) => frame.id === id)
    if (!spec) throw new Error(`${id} frame spec is missing`)
    const html = await renderWebFrame(spec, fixtures, { css: '', fontCss: '' })

    expect(html).toContain('aria-label="RESUME Harvest run h1"')
    expect(html).not.toContain('class="fastext"')
    expect(evidenceText(html)).not.toContain('DESELECT')
  }
})

test('Harvest acknowledge is rendered as a run-qualified row control', async () => {
  const fixtures = models()
  const harvest = fixtures.happy.harvest
  if (!harvest) throw new Error('happy fixture has no Harvest run')
  const model: DashboardModel = {
    ...fixtures.happy,
    harvest: { ...harvest, status: 'escalated', action: 'acknowledge' },
  }
  const spec = WEB_FRAME_SPECS.find((frame) => frame.id === 'builds-harvest-wide')!
  const html = await renderWebFrame(spec, { ...fixtures, happy: model }, { css: '', fontCss: '' })

  expect(html).toContain('aria-label="ACKNOWLEDGE Harvest run h1"')
  expect(html).toContain('>ACKNOWLEDGE</button>')
})

test('singleton capture frames omit the project picker', async () => {
  const fixtures = models()
  const singletonFrames = WEB_FRAME_SPECS.filter(
    (spec) => spec.id.startsWith('builds-') && spec.id !== 'builds-multirepo-wide',
  )

  for (const spec of singletonFrames) {
    const html = await renderWebFrame(spec, fixtures, { css: '', fontCss: '' })
    const nav = tabLine(html)
    expect(nav, spec.id).toBeDefined()
    expect(html, spec.id).not.toContain('project-menu')
    expect(nav, spec.id).not.toContain('<select')
  }
})

test('multi-repository capture frame opens the masthead project picker', async () => {
  const spec = WEB_FRAME_SPECS.find((frame) => frame.id === 'builds-multirepo-wide')
  if (!spec) throw new Error('multi-repository frame spec is missing')
  const html = await renderWebFrame(spec, models(), { css: '', fontCss: '' })
  const header = html.match(/<header class="masthead"[\s\S]*?<\/header>/)?.[0]

  expect(header).toContain('class="menu project-menu"')
  expect(header).toContain('aria-expanded="true"')
  expect(header).toContain('aria-checked="true" data-autofocus="true"')
  expect(header).toContain('>github.com/example/repository</button>')
  expect(header).toContain('>example/alternate</button>')
  expect(html).not.toContain('https://github.com')
  expect(html).not.toContain('<select')
})
test('signed-in frames lead with the view tabs and Builds ticket ids remain plain text', async () => {
  const fixtures = models()
  for (const spec of WEB_FRAME_SPECS.filter((frame) => frame.id.startsWith('builds-'))) {
    const html = await renderWebFrame(spec, fixtures, { css: '', fontCss: '' })
    const nav = tabLine(html)
    expect(nav, spec.id).toBeDefined()
    expect(nav, spec.id).toContain('<nav class="tabs" aria-label="Views">')
    for (const tab of ['Triage', 'Queue', 'Active', 'Done', 'Settings'])
      expect(evidenceText(nav!), spec.id).toContain(tab)
    expect(nav, spec.id).toMatch(/aria-current="page"[^>]*>Active/)
    // A falsy count in a render condition must never leak into the page as text.
    expect(html, spec.id).not.toMatch(/<section class="dashboard-surface">0/)
    expect(nav!.indexOf('class="tabs"'), spec.id).toBeLessThan(
      nav!.indexOf('aria-label="Operator controls"'),
    )
  }

  const happy = WEB_FRAME_SPECS.find((frame) => frame.id === 'builds-happy-wide')
  if (!happy) throw new Error('happy frame spec is missing')
  const html = await renderWebFrame(happy, fixtures, { css: '', fontCss: '' })
  expect(html).toContain('<span class="ticket">AUT-131</span>')
  expect(html).not.toMatch(/<a[^>]*>AUT-131<\/a>/)
})

test('loading frames preserve shell landmarks and expose only one hidden announcement', async () => {
  const fixtures = models()
  for (const id of ['builds-loading-wide', 'builds-loading-narrow']) {
    const spec = WEB_FRAME_SPECS.find((entry) => entry.id === id)
    expect(spec).toBeDefined()
    const html = await renderWebFrame(spec!, fixtures, { css: '', fontCss: '' })
    expect(html).toContain('<main class="frame">')
    expect(html).toContain('<header class="masthead">')
    expect(html).toContain('<div class="line navline">')
    const nav = tabLine(html)
    expect(nav).toContain('class="loading-controls"')
    expect(nav?.match(/class="sk sk-control"/g)).toHaveLength(4)
    expect(html).not.toContain('role="toolbar"')
    expect(html.match(/aria-live="polite"/g)).toHaveLength(1)
    const loadingStart = html.indexOf('<div class="loading-state" data-loading="builds">')
    const skeletonStart = html.indexOf('<div class="skeletons"', loadingStart)
    const loadingAnnouncement = html.slice(loadingStart, skeletonStart)
    expect(loadingStart).toBeGreaterThan(-1)
    expect(skeletonStart).toBeGreaterThan(loadingStart)
    expect(loadingAnnouncement.match(/aria-live="polite"/g)).toHaveLength(1)
    expect(html.match(/data-loading-row=""/g)).toHaveLength(5)
    expect(html).toContain('<div class="skeletons" aria-hidden="true">')
    expect(html).not.toContain('skeleton-dispatch')
    expect(html).not.toContain('polling')
    expect(html).not.toContain('class="status"')
  }
})

test('running and paused repositories use terminal-compatible control vocabulary', async () => {
  const fixtures = models()
  const happySpec = WEB_FRAME_SPECS.find((frame) => frame.id === 'builds-happy-wide')!
  const mixedSpec = WEB_FRAME_SPECS.find((frame) => frame.id === 'builds-mixed-rest-wide')!
  const happy = await renderWebFrame(happySpec, fixtures, { css: '', fontCss: '' })
  const mixed = await renderWebFrame(mixedSpec, fixtures, { css: '', fontCss: '' })
  const controlLandmark = (html: string) => tabLine(html) ?? ''

  expect(controlLandmark(happy)).not.toContain('repository RUNNING')
  expect(controlLandmark(happy)).not.toContain('repository PAUSED')
  expect(controlLandmark(mixed)).toContain('repository<b class="off">PAUSED</b>')
})

test('build row controls contain only authoritative lifecycle and destructive actions', () => {
  const expected: Array<[DashboardBuild['status'], string[]]> = [
    ['queued', ['ABORT', 'DISCARD']],
    ['running', ['ABORT', 'PAUSE']],
    ['pausing', ['ABORT', 'CANCEL PAUSE']],
    ['paused', ['ABORT', 'RESUME']],
    ['resuming', ['ABORT']],
    ['blocked', ['ABORT', 'RESUME']],
    ['aborting', []],
    ['cleaning', []],
  ]
  for (const [status, labels] of expected) {
    expect(
      buildRowActions(build({ status })).map((action) => action.label),
      status,
    ).toEqual(labels)
  }
})

test('rendered build controls follow previews and direct controls name their target', async () => {
  const fixtures = models()
  const spec = WEB_FRAME_SPECS.find((frame) => frame.id === 'builds-mixed-focus-wide')!
  const html = await renderWebFrame(spec, fixtures, { css: '', fontCss: '' })
  const slug = 'plan-blocked-dashboard'
  const start = html.indexOf(`id="build-${slug}"`)
  const end = html.indexOf('id="build-implement-blocked-dashboard"', start)
  const row = html.slice(start, end)

  expect(row).toContain(
    `aria-label="Open ${slug}" href="/build/${slug}?repo=${encodeURIComponent('example/repository')}"`,
  )
  expect(row).not.toContain('aria-expanded')
  expect(row).not.toContain(`aria-label="Auto merge off for ${slug}"`)
  expect(row).not.toContain('role="toolbar"')
  for (const label of ['ABORT', 'RESUME', 'AUTO MERGE', 'DETAILS', 'CLOSE']) {
    expect(row).not.toContain(`aria-label="${label} ${slug}"`)
  }
  const detailSpec = WEB_FRAME_SPECS.find((frame) => frame.id === 'builds-mixed-detail-wide')!
  const detail = await renderWebFrame(detailSpec, fixtures, { css: '', fontCss: '' })
  const toolbar = detail.match(
    /<div class="controls actions build-actions" role="toolbar" aria-label="Controls for plan-blocked-dashboard"[\s\S]*?<\/div>/,
  )?.[0]
  expect(toolbar).toBeDefined()
  // The primary control leads and abort, ghosted, goes last.
  expect(toolbar).toMatch(/class="btn primary action"[^>]*aria-label="RESUME/)
  expect(toolbar).toMatch(/class="btn ghost action"[^>]*aria-label="ABORT/)
  for (const label of ['ABORT', 'RESUME']) {
    expect(toolbar).toContain(`aria-label="${label} ${slug}"`)
  }
  const harvestSpec = WEB_FRAME_SPECS.find((frame) => frame.id === 'builds-harvest-wide')!
  const harvest = await renderWebFrame(harvestSpec, fixtures, { css: '', fontCss: '' })
  expect(harvest).toContain('aria-label="RESUME Harvest run')
})

test('web dashboard removes obsolete auto-merge controls', async () => {
  const spec = WEB_FRAME_SPECS.find((frame) => frame.id === 'builds-mixed-focus-wide')!
  const html = await renderWebFrame(spec, models(), { css: '', fontCss: '' })
  expect(html).not.toContain('aria-label="Auto merge')
  expect(html).not.toContain('class="word am"')
})

test('hover frame previews one row without selecting it', async () => {
  const spec = WEB_FRAME_SPECS.find((frame) => frame.id === 'builds-mixed-hover-wide')
  if (!spec) throw new Error('hover frame spec is missing')
  const html = await renderWebFrame(spec, models(), { css: '', fontCss: '' })

  expect(html).not.toContain('data-selected="true"')
  expect(html.match(/data-hovered="true"/g)).toHaveLength(1)
  expect(html.match(/<li class="row"[^>]*data-hovered="true"[^>]*>/)?.[0]).toBeDefined()
  expect(evidenceText(html)).not.toContain('ABORT')
  expect(evidenceText(html)).not.toContain('DETAILS')
  expect(evidenceText(html)).not.toContain('Unresolved blockers')
  expect(spec.emulateFineHover).toBe(true)
  expect(captureStateCss(spec)).toContain('.row[data-hovered] .rowhead')
  expect(html).toContain(
    '<style data-capture-state>.row[data-hovered] .rowhead { color: var(--live); }',
  )
})

test('the build page is named by its slug and links back to the list', async () => {
  const fixtures = models()
  const spec = WEB_FRAME_SPECS.find((frame) => frame.id === 'builds-mixed-detail-wide')!
  const html = await renderWebFrame(spec, fixtures, { css: '', fontCss: '' })
  const slug = 'plan-blocked-dashboard'

  expect(html).toContain(`<article class="build-page" aria-label="${slug}">`)
  expect(html).toContain(`aria-label="${slug} detail"`)
  expect(html).toContain(`href="/?repo=${encodeURIComponent('example/repository')}"`)
  expect(html).not.toContain('class="rows"')
})

test('answer frames expose only row-local submit and cancel while retaining focused input and detail', async () => {
  const fixtures = models()
  for (const id of ['builds-mixed-answer-wide', 'builds-mixed-answer-narrow']) {
    const spec = WEB_FRAME_SPECS.find((frame) => frame.id === id)
    if (!spec) throw new Error(`${id} frame spec is missing`)
    const html = await renderWebFrame(spec, fixtures, { css: '', fontCss: '' })
    const toolbar = html.match(
      /<div class="controls actions" role="toolbar" aria-label="Controls for plan-blocked-dashboard"[\s\S]*?<\/div>/,
    )?.[0]

    expect(html).toContain('class="answer-step"')
    expect(html).toContain('optional guidance (empty retries)')
    expect(html).toContain('<input autofocus="" type="text"')
    expect(toolbar).toContain('aria-label="SUBMIT answer for plan-blocked-dashboard"')
    expect(toolbar).toContain('aria-label="CANCEL answer for plan-blocked-dashboard"')
    expect(html).toContain('<h2 class="rowhead">')
    expect(html).not.toContain('class="word am"')
    expect(evidenceText(toolbar ?? '')).toBe(' SUBMIT CANCEL ')
    for (const label of ['RESUME', 'ABORT', 'AUTO MERGE', 'DETAILS', 'CLOSE']) {
      expect(toolbar).not.toContain(`aria-label="${label} plan-blocked-dashboard"`)
    }
    expect(html).not.toContain('aria-label="RESUME implement-blocked-dashboard"')
    expect(html).not.toContain('class="fastext"')
  }
})

test('pending answer context disables row-local submit and cancel', async () => {
  const fixtures = models()
  const model = fixtures.mixed
  const selected = model.builds.find((row) => row.blockers.length > 0)!
  const base = WEB_FRAME_SPECS.find((frame) => frame.id === 'builds-mixed-answer-wide')!
  const pendingHtml = await renderWebFrame({ ...base, answerPending: true }, fixtures, {
    css: '',
    fontCss: '',
  })

  expect(pendingHtml).toContain(
    `<button type="button" class="btn primary action" disabled="" aria-label="SUBMIT answer for ${selected.slug}"`,
  )
  expect(pendingHtml).toContain(
    `<button type="button" class="word action" disabled="" aria-label="CANCEL answer for ${selected.slug}"`,
  )
})

test('abort frame confirms in the dialog over the unchanged build page', async () => {
  const fixtures = models()
  const spec = WEB_FRAME_SPECS.find((frame) => frame.id === 'builds-mixed-abort-wide')!
  const html = await renderWebFrame(spec, fixtures, { css: '', fontCss: '' })
  const dialog = html.match(/<dialog class="confirm-dialog" open=""[\s\S]*?<\/dialog>/)?.[0]

  expect(html).not.toContain('class="answer-step"')
  expect(dialog).toBeDefined()
  expect(dialog).toContain('Abort plan-blocked-dashboard?')
  expect(evidenceText(dialog!)).toContain('Abort build Cancel')
  expect(dialog).toMatch(/class="btn danger primary"[^>]*>Abort build/)
  // The page behind keeps its controls in place: confirming never shifts the layout.
  expect(html).toContain('aria-label="RESUME plan-blocked-dashboard"')
  expect(html).toContain('aria-label="ABORT plan-blocked-dashboard"')
})

test('ticket frames list, empty and page states with their moves', async () => {
  const fixtures = models()
  const render = (id: string) =>
    renderWebFrame(WEB_FRAME_SPECS.find((frame) => frame.id === id)!, fixtures, {
      css: '',
      fontCss: '',
    })
  const triage = await render('tickets-triage-wide')
  expect(tabLine(triage)).toMatch(/aria-current="page"[^>]*>Triage/)
  expect(triage).toContain('<ol class="rows ticket-rows" aria-label="Triage tickets">')
  // Unknown blocker resolution reads as a dependency; known unresolved reads as blocked.
  expect(triage).toContain('depends on')
  expect(triage).toMatch(/<span class="warn">blocked by/)
  const page = await render('ticket-page-wide')
  expect(page).toMatch(/class="btn primary action"[^>]*aria-label="ENQUEUE CAP-PLAN"/)
  expect(page).toMatch(/class="btn ghost action"[^>]*aria-label="ICE CAP-PLAN"/)
  // The body's leading heading repeats the title, so the page drops it.
  expect(page.match(/Plan blocked dashboard/g)?.length).toBe(1)
})

test('narrow capture frames never supply a hover preview', async () => {
  const fixtures = models()
  for (const spec of WEB_FRAME_SPECS.filter((frame) => frame.width === 390)) {
    const html = await renderWebFrame(spec, fixtures, { css: '', fontCss: '' })
    expect(html, spec.id).not.toContain('data-hovered="true"')
  }
})

test('row control keys isolate button activation and cancel abort locally', () => {
  const calls: string[] = []
  const event = (key: string) => ({
    key,
    preventDefault: () => calls.push(`prevent:${key}`),
    stopPropagation: () => calls.push(`stop:${key}`),
  })

  handleRowControlKey(event('Enter'))
  handleRowControlKey(event('Escape'), () => calls.push('cancel'))
  handleRowControlKey(event('Escape'))

  expect(calls).toEqual(['stop:Enter', 'prevent:Escape', 'stop:Escape', 'cancel'])
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

test('a frame missing its evidence fails the capture by name', async () => {
  const spec = { ...WEB_FRAME_SPECS[0]!, requires: ['NOT PRESENT'] }
  const html = await renderWebFrame(spec, models(), { css: '', fontCss: '' })
  expect(() => checkEvidence(spec, html)).toThrow(/required evidence "NOT PRESENT"/)
})

test('the parked no-consent frame renders the shared reason on the build page (f_b163d7ca)', async () => {
  const spec = WEB_FRAME_SPECS.find((frame) => frame.id === 'builds-parked-no-consent-wide')
  if (!spec) throw new Error('builds-parked-no-consent-wide frame spec is missing')
  const html = await renderWebFrame(spec, models(), { css: '', fontCss: '' })
  const reason = 'Merge awaits consent'
  expect(evidenceText(html)).toContain(reason)
  expect(evidenceText(html)).toContain('ab merge complete-dashboard-evidence')
  expect(evidenceText(html)).toContain('merge consent')
  expect(evidenceText(html)).not.toContain('merge not ready')
  expect(evidenceText(html)).not.toContain('merge policy pending')
  expect(evidenceText(html)).not.toContain('use l on the build row')
  expect(html).not.toContain('data-mismatch')
})

test('landing detail distinguishes a pending policy decision from a hold', async () => {
  const spec = WEB_FRAME_SPECS.find((frame) => frame.id === 'builds-mixed-detail-wide')!
  for (const held of [false, true]) {
    const fixtures = models()
    fixtures.mixed.builds = fixtures.mixed.builds.map((build) => ({
      ...build,
      landing: held ? { command: { kind: 'hold', seq: 1 } } : undefined,
    }))
    const text = evidenceText(await renderWebFrame(spec, fixtures, { css: '', fontCss: '' }))
    expect(text).toContain(held ? 'merge held' : 'merge policy pending')
    expect(text).not.toContain('merge not ready')
  }
})

test('the named consent frame renders the real page with its registered client', async () => {
  const spec = WEB_FRAME_SPECS.find((frame) => frame.id === 'consent-named-wide')
  if (!spec) throw new Error('consent-named-wide frame spec is missing')
  const html = await renderWebFrame(spec, models(), { css: '', fontCss: '' })

  // The page reuses the sign-in frame classes and the shared button outline.
  expect(html).toContain('frame signin')
  expect(html).toContain('class="btn primary"')
  const text = evidenceText(html)
  expect(text).toContain('Capture MCP Console')
  expect(text).toContain('registered as')
  expect(text).toContain('mcp-capture-console')
  expect(text).toContain('Requested scopes: openid profile email')
})

test('the unnamed consent frame falls back to the raw client id', async () => {
  const spec = WEB_FRAME_SPECS.find((frame) => frame.id === 'consent-unnamed-narrow')
  if (!spec) throw new Error('consent-unnamed-narrow frame spec is missing')
  const html = await renderWebFrame(spec, models(), { css: '', fontCss: '' })

  const text = evidenceText(html)
  expect(text).toContain('A client registered as mcp-capture-console')
  expect(text).not.toContain('Capture MCP Console')
})

test('consent frames never render the missing-authorization-code notice', async () => {
  for (const id of ['consent-named-wide', 'consent-unnamed-narrow']) {
    const spec = WEB_FRAME_SPECS.find((frame) => frame.id === id)
    if (!spec) throw new Error(`${id} frame spec is missing`)
    const html = await renderWebFrame(spec, models(), { css: '', fontCss: '' })
    expect(evidenceText(html), id).not.toContain('missing its authorization code')
  }
})

test('the missing-code consent frame shows the notice without a form', async () => {
  const spec = WEB_FRAME_SPECS.find((frame) => frame.id === 'consent-missing-code-wide')
  if (!spec) throw new Error('consent-missing-code-wide frame spec is missing')
  const html = await renderWebFrame(spec, models(), { css: '', fontCss: '' })

  const text = evidenceText(html)
  expect(text).toContain('This consent request is missing its authorization code')
  expect(text).not.toContain('Requested scopes')
  // The form is absent on this path: no button anywhere in the frame.
  expect(html).not.toContain('<button')
})

test('the route consent frame renders through the page wrapper without a client lookup', async () => {
  const spec = WEB_FRAME_SPECS.find((frame) => frame.id === 'consent-route-narrow')
  if (!spec) throw new Error('consent-route-narrow frame spec is missing')
  const html = await renderWebFrame(spec, models(), { css: '', fontCss: '' })

  const text = evidenceText(html)
  // The unnamed-client copy, the requested scopes, and the rendered form.
  expect(text).toContain("A client requests operator access to this deployment's Autobuild tools.")
  expect(text).toContain('Requested scopes: openid profile email')
  expect(html).toContain('class="btn primary"')
  expect(html).toContain('<button')
  // The query carries no client_id, so no lookup fires and no client identity
  // appears — pinning the no-lookup/no-database invariant.
  expect(text).not.toContain('mcp-capture-console')
  expect(text).not.toContain('Capture MCP Console')
})

test('two grounds cover every scenario under unique artifact names', () => {
  const names = WEB_FRAME_SPECS.map((frame) => `${frame.id}-${frame.ground}`)
  expect(new Set(names).size).toBe(names.length)
  for (const frame of WEB_FRAME_SPECS)
    expect(
      WEB_FRAME_SPECS.filter((other) => other.id === frame.id).map((other) => other.ground),
    ).toEqual(['light', 'dark'])
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

test('handoff renders shared vocabulary and retains lifecycle; settlement and completion remove annotations', async () => {
  const { handoffCapture } = await import('../../../tools/handoff-capture')
  const spec = WEB_FRAME_SPECS.find((frame) => frame.id === 'builds-happy-wide')!
  for (const stage of ['active', 'settled', 'completed'] as const) {
    const fixture = models()
    fixture.happy = handoffCapture(fixture.happy, stage)
    const text = evidenceText(await renderWebFrame(spec, fixture, { css: '', fontCss: '' }))
    expect(text.includes('(draining)')).toBe(stage === 'active')
    expect(text.includes('handoff 1.0.0')).toBe(stage !== 'completed')
    expect(text).toContain('RUNNING')
  }
})

test('Builds shows rollback with other notices and removes it after clearance or restart', async () => {
  const { rollbackCapture, ROLLBACK_AT } = await import('../../../tools/rollback-capture')
  const { formatRollback } = await import('@defrex/autobuild/operator-presentation')
  const spec = WEB_FRAME_SPECS.find((frame) => frame.id === 'builds-happy-wide')!
  for (const stage of ['active', 'cleared', 'restarted'] as const) {
    const fixture = models()
    fixture.happy = rollbackCapture(fixture.happy, stage)
    fixture.happy.warningLines = ['independent warning']
    const text = evidenceText(await renderWebFrame(spec, fixture, { css: '', fontCss: '' }))
    expect(text.includes('rollback:')).toBe(stage === 'active')
    if (fixture.happy.rollback) {
      expect(text).toContain(formatRollback(fixture.happy.rollback))
      expect(text).toContain(ROLLBACK_AT)
    }
    expect(text).toContain('independent warning')
    expect(text).toContain('RUNNING')
  }
})

test('offline captures use the exact packaged production font files for both roles', () => {
  const css = fontFaceCss('/fixture')
  expect(css).toContain('/packages/hosted-store-service/app/fonts/AtkinsonHyperlegibleNext.ttf')
  expect(css).toContain('/packages/hosted-store-service/app/fonts/JetBrainsMono.ttf')
  expect(css).toContain("--font-sans: 'ANSI sans'")
  expect(css).toContain("--font-mono: 'ANSI mono'")
  expect(css).not.toContain('local(')
  expect(css).not.toContain('DejaVu')
})

test('pending node consent frames preserve Land/Hold and disable both while the request settles', async () => {
  for (const spec of WEB_FRAME_SPECS.filter((frame) =>
    frame.id.startsWith('integration-consent-pending-'),
  )) {
    const html = await renderWebFrame(spec, models(), { css: '', fontCss: '' })
    expect(html).toContain('class="signoff landing"')
    expect(html).toMatch(/class="btn primary" disabled="">Merge<\/button>/)
    expect(html).toMatch(/class="btn" disabled="">Hold<\/button>/)
  }
})

test('report uses actual image dimensions and packaged font bindings', async () => {
  const { report } = await import('./web-dashboard-capture')
  const text = report(
    [
      {
        id: 'long-narrow',
        width: 390,
        height: 4567,
        ground: 'dark',
        htmlPath: '/frames/long.html',
        pngPath: '/frames/long.png',
      },
    ],
    '/chromium',
    '/frames',
  )
  expect(text).toContain('390×4567')
  expect(text).toContain(
    'packaged Atkinson Hyperlegible Next and JetBrains Mono files bound through FONT_FILES',
  )
  expect(text).toContain('may exceed the initial viewport')
  expect(text).not.toContain('locally installed')
  expect(text).not.toContain('DejaVu')
})
