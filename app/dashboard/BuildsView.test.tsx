import { expect, test } from 'bun:test'
import type { DashboardBuild, DashboardModel } from '@defrex/autobuild/operator-presentation'
import { renderToStaticMarkup } from 'react-dom/server'
import { BuildsView, type Selection } from './BuildsView'

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
