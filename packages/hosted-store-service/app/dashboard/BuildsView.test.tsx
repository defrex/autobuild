import { expect, test } from 'bun:test'
import type { DashboardBuild, DashboardModel } from '@defrex/autobuild/operator-presentation'
import { renderToStaticMarkup } from 'react-dom/server'
import { awaitingConsent, BuildsView, LandingSignoff, type Selection } from './BuildsView'

const noop = () => {}

function pinnedBuild(
  fields: Partial<Pick<DashboardBuild, 'pipelineSource' | 'effectiveConfigRev'>>,
): DashboardBuild {
  return {
    slug: 'demo',
    status: 'running',
    alsoPaused: false,
    steps: [],
    blockers: [],
    autoMerge: 'off',
    ...fields,
  }
}

function model(build: DashboardBuild): DashboardModel {
  return {
    repo: 'owner/repo',
    queued: 0,
    active: { current: 1, limit: 2 },
    observations: { current: 0, limit: 5 },
    drained: false,
    repositoryPaused: false,
    defaultAutoMerge: false,
    harvestPaused: false,
    builds: [build],
  }
}

function renderBuildsView(build: DashboardBuild): string {
  const selection: Selection = { kind: 'build', slug: build.slug }
  return renderToStaticMarkup(
    <BuildsView
      repo="owner/repo"
      model={model(build)}
      now={0}
      detailOpen
      selection={selection}
      answerPending={false}
      onActivate={noop}
      onHoverPreview={noop}
      onRowBuildControl={noop}
      onRowRequestAbort={noop}
      onCancelAbort={noop}
      onRowToggleDetail={noop}
      onAnswerStepInput={noop}
      onSubmitAnswerStep={noop}
      onCancelAnswerStep={noop}
      onAnswer={noop}
      onTranscript={noop}
      onRowHarvest={noop}
    />,
  )
}

test('a pinned build surfaces its pipeline source and config revision in the detail', () => {
  const html = renderBuildsView(
    pinnedBuild({
      pipelineSource: { ref: 'branch-head', commit: 'a'.repeat(40) },
      effectiveConfigRev: 3,
    }),
  )
  expect(html).toContain('<span class="k">pipeline </span>')
  expect(html).toContain(`autobuild.toml@${'a'.repeat(7)} (branch-head) · config rev 3`)
})

test('a build without pinned fields renders the no-pin path: no pipeline entry', () => {
  const html = renderBuildsView(pinnedBuild({}))
  expect(html).not.toContain('>pipeline <')
  expect(html).not.toContain('autobuild.toml@')
})

test('integration list uses shared words and qualifiers, accessible states and full-color alert classes', () => {
  const row = pinnedBuild({})
  row.kind = 'integration'
  row.target = 'old-target'
  row.steps = [{ label: 'old-detail-step', state: 'pending' }]
  row.integrationRow = {
    destination: 'NODE-900 release-1.0',
    openChildren: ['a', 'b', 'c'],
    children: { known: true, landed: 8, building: 2, queued: 1, total: 11 },
    verified: false,
    steps: [
      { label: 'spec', state: 'done' },
      { label: 'open', state: 'done' },
      { label: 'collect', state: 'current' },
      { label: 'verify', state: 'pending' },
      { label: 'land', state: 'pending', qualifier: 'consent' },
    ],
    alert: { tone: 'yellow', text: 'ready to land into main — press l, or ab land demo' },
  }
  const html = renderBuildsView(row)
  expect(html).toContain('integration into NODE-900 release-1.0')
  expect(html).toContain('8/11 landed')
  expect(html).toContain('2 building')
  expect(html).toContain('1 queued')
  expect(html).toContain('land<span class="note">(consent)</span>')
  expect(html).toContain('class="sr-only">, current')
  expect(html).toContain('integration-alert warn')
  expect(html).toContain('old-detail-step')
  expect(html).not.toContain('→')
  expect(html).not.toContain('━')
  row.integrationRow.children = { known: false }
  row.integrationRow.alert = {
    tone: 'red',
    text: 'unit failed — file a repair child targeting NODE-900',
  }
  row.integrationRow.steps[3] = { label: 'verify', state: 'current', qualifier: 'failed' }
  const unknown = renderBuildsView(row)
  expect(unknown).toContain('children unknown')
  expect(unknown).not.toContain('8/11')
  expect(unknown).toContain('integration-alert alert')
  expect(unknown).toContain('verify<span class="note">(failed)</span>')
})

test('integration detail uses the shared facts and text progress within the existing grammar', () => {
  const build = pinnedBuild({})
  build.kind = 'integration'
  build.integrationRow = {
    destination: 'main',
    openChildren: ['A'],
    children: { known: true, landed: 1, building: 1, queued: 0, total: 2 },
    verified: false,
    steps: [{ label: 'collect', state: 'current' }],
  }
  build.integrationDetail = {
    handPushedCommits: [{ sha: 'a'.repeat(40), originalSha: 'b'.repeat(40) }],
    destination: 'main (the configured base branch)',
    branch: 'ab-node/demo',
    restack: 'conflicted',
    conflictFiles: ['src/a file.ts'],
    membershipKnown: true,
    diagnostics: [],
    children: [
      {
        source: 'fake',
        id: 'A',
        title: 'A very long title '.repeat(20),
        state: 'implement',
        landed: false,
      },
      { source: 'fake', id: 'B', title: 'Completed work', state: 'landed', landed: true },
    ],
    verification: 'unit failed — file a repair child targeting NODE',
    verifySteps: [{ step: 'unit', outcome: 'fail' }],
    landing: 'consent — press l, or ab land demo',
  }
  const html = renderBuildsView(build)
  for (const fact of [
    'Hand-pushed changes',
    'original',
    'Integration',
    'Progress',
    'Branch',
    'Steps',
    'Children',
    'implement',
    'Completed work',
    'Verification',
    'Landing',
    'repair child',
    'ab land demo',
    'src/a file.ts',
    '1/2 landed',
  ])
    expect(html).toContain(fact)
  expect(html).toContain('text-overflow:ellipsis')
  expect(html).not.toContain('<h3>Pipeline</h3>')
  expect(html).not.toContain('role="progressbar"')
})

test('title leads while slug remains a machine value, with slug fallback', () => {
  const row = pinnedBuild({})
  row.collectionIdentity = {
    repo: 'owner/repo',
    status: 'running',
    title: 'Preview the pricing page',
  }
  const html = renderBuildsView(row)
  expect(html).toContain('class="build-title">Preview the pricing page</span>')
  expect(html).toContain('class="slug">demo</span>')
  delete row.collectionIdentity.title
  expect(renderBuildsView(row)).toContain('class="build-title">demo</span>')
})

test('blocked rows show complete question, plain explanation and a single answer composer', () => {
  const row = pinnedBuild({})
  row.status = 'blocked'
  row.blockers = ['Should the link expire?']
  const html = renderBuildsView(row)
  expect(html).toContain('! Should the link expire?')
  expect(html).toContain(
    'The build stopped to ask a person. Your answer resumes it from where it paused.',
  )
  expect(html.match(/class="composer"/g)).toHaveLength(1)
  expect(html).toContain('class="btn primary"')
  expect(html).toContain('aria-label="Step marks"')
})

test('landing sign-off requires the recorded consent decision and current waiting merge', () => {
  const row = pinnedBuild({})
  row.pr = { url: 'https://forge.example/pr/1', state: 'open' }
  row.steps = [{ label: 'merge', state: 'current', qualifier: 'waiting' }]
  expect(awaitingConsent(row)).toBe(false)
  row.landing = {
    decision: {
      seq: 10,
      mode: 'consent',
      candidate: { head: 'head', parent: 'parent', cycle: '1' },
      from: 'leaf',
      into: { kind: 'root' },
      labels: [],
      rule: { default: true },
    },
  }
  expect(awaitingConsent(row)).toBe(true)
  const html = renderBuildsView(row)
  expect(html).toContain('>Land</button>')
  expect(html).toContain('>Hold</button>')
  row.status = 'paused'
  expect(awaitingConsent(row)).toBe(false)
  row.status = 'running'
  row.steps[0]!.state = 'pending'
  expect(awaitingConsent(row)).toBe(false)
  row.steps[0]!.state = 'current'
  row.landing!.command = { kind: 'land', seq: 11 }
  expect(awaitingConsent(row)).toBe(false)
})

test('Land and Hold forward the existing typed actions and both disable while pending', () => {
  const requests: string[] = []
  const create = (pending: boolean) =>
    LandingSignoff({
      slug: 'demo',
      pending,
      onControl: (slug, action) => requests.push(`${slug}:${action}`),
    })
  const controls = create(false).props.children[1].props.children
  for (const control of controls) control.props.onClick()
  expect(requests).toEqual(['demo:land', 'demo:hold'])
  for (const control of create(true).props.children[1].props.children)
    expect(control.props.disabled).toBe(true)
})
