import { expect, test } from 'bun:test'
import type {
  DashboardBuild,
  DashboardHarvest,
  DashboardModel,
} from '@defrex/autobuild/operator-presentation'
import { renderToStaticMarkup } from 'react-dom/server'
import { BuildsView, type Selection, finalizedHarvestStreamLinks } from './BuildsView'

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

function harvestModel(harvest: DashboardHarvest): DashboardModel {
  return {
    repo: 'owner/repo',
    queued: 0,
    active: { current: 0, limit: 2 },
    observations: { current: 0, limit: 5 },
    drained: false,
    repositoryPaused: false,
    defaultAutoMerge: false,
    harvestPaused: false,
    builds: [],
    harvest,
  }
}

type HarvestSessionView = NonNullable<DashboardHarvest['sessions']>[number]

function session(overrides: Partial<HarvestSessionView> & { session: string }): HarvestSessionView {
  return {
    role: 'harvest',
    step: 'synthesize',
    round: 1,
    streamStatus: 'closed',
    status: 'ended',
    ...overrides,
  }
}

function renderHarvestView(harvest: DashboardHarvest, repo = 'owner/repo'): string {
  return renderToStaticMarkup(
    <BuildsView
      repo={repo}
      model={harvestModel(harvest)}
      now={0}
      detailOpen={false}
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

const BASE_HARVEST: DashboardHarvest = {
  kind: 'harvest',
  run: 'h1',
  status: 'running',
  steps: [],
  observations: 2,
  rounds: 1,
}

test('a finalized harvest session stream renders its download anchor with href and accessible name', () => {
  const harvest = {
    ...BASE_HARVEST,
    sessions: [
      session({ session: 'hs_1', stream: 'st_abc' }),
      session({
        session: 'hs_2',
        role: 'harvest-review',
        step: 'review',
        round: 2,
        stream: 'st_def',
      }),
    ],
  }
  const html = renderHarvestView(harvest)
  const repoSegment = encodeURIComponent('owner/repo')

  expect(html).toContain(
    `href="/api/web/repos/${repoSegment}/artifacts/${encodeURIComponent('stream:st_abc')}"`,
  )
  expect(html).toContain(
    `<a class="stream" aria-label="Download synthesize r1 stream st_abc" href="/api/web/repos/${repoSegment}/artifacts/${encodeURIComponent('stream:st_abc')}">synthesize r1</a>`,
  )
  expect(html).toContain(
    `<a class="stream" aria-label="Download review r2 stream st_def" href="/api/web/repos/${repoSegment}/artifacts/${encodeURIComponent('stream:st_def')}">review r2</a>`,
  )
  // The link helper is the single source of the anchors the row renders.
  expect(finalizedHarvestStreamLinks(harvest, 'owner/repo')).toEqual([
    {
      key: 'hs_1',
      label: 'synthesize r1',
      aria: 'Download synthesize r1 stream st_abc',
      href: `/api/web/repos/${repoSegment}/artifacts/${encodeURIComponent('stream:st_abc')}`,
    },
    {
      key: 'hs_2',
      label: 'review r2',
      aria: 'Download review r2 stream st_def',
      href: `/api/web/repos/${repoSegment}/artifacts/${encodeURIComponent('stream:st_def')}`,
    },
  ])
})

test('an open stream and a session without a stream render no anchor', () => {
  const harvest = {
    ...BASE_HARVEST,
    sessions: [
      session({ session: 'hs_open', stream: 'st_open', streamStatus: 'open', status: 'open' }),
      session({ session: 'hs_streamless', stream: undefined }),
    ],
  }
  const html = renderHarvestView(harvest)

  expect(html).not.toContain('class="stream"')
  expect(finalizedHarvestStreamLinks(harvest, 'owner/repo')).toEqual([])
})

test('absent sessions render no anchor and no attribute noise', () => {
  expect(renderHarvestView(BASE_HARVEST)).not.toContain('class="stream"')
  expect(finalizedHarvestStreamLinks(BASE_HARVEST, 'owner/repo')).toEqual([])
})
