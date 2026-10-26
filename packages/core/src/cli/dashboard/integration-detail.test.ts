import { expect, test } from 'bun:test'
import { configSchema } from '../../config/schema'
import { reduceBuild, type BuildState } from '../../kernel/reducer'
import type { BuildRecord } from '../../store/types'
import { projectBuild } from './model'
import { enrichIntegrationRows } from './integration-row'
import { projectIntegrationDetail } from './integration-detail'

const config = configSchema.parse({
  tickets: { source: 'file', readyState: 'ready' },
  verify: {
    steps: ['lint', 'unit'],
    lint: { kind: 'agent', skill: 'lint' },
    unit: { kind: 'agent', skill: 'unit' },
  },
})
const record: BuildRecord = {
  slug: 'node',
  repo: 'repo',
  branch: 'ab-node/node',
  ticket: { source: 'fake', id: 'NODE' },
  createdAt: '',
  updatedAt: '',
}
function state(): BuildState {
  return {
    ...reduceBuild([]),
    kind: 'node',
    status: 'running',
    baseBranch: 'main',
    specRev: 0,
    nodeOpened: { sha: 'base' },
    integration: {
      observation: {
        openChildren: ['OPEN', 'QUEUED'],
        contributions: ['old'],
        diagnostics: [],
        children: [
          { source: 'fake', id: 'LANDED', title: 'Finished work', builds: ['old'] },
          { source: 'fake', id: 'OPEN', title: 'Build work' },
          { source: 'fake', id: 'QUEUED', title: 'Waiting work' },
        ],
      },
    },
  }
}
const detail = (s = state(), c = config) =>
  projectIntegrationDetail(record, s, { gates: {} }, c, config)!
test('detail orders all children and names expected checks, destination and default policy', () => {
  const d = detail()
  expect(d.children.map((c) => [c.id, c.state])).toEqual([
    ['OPEN', 'queued'],
    ['QUEUED', 'queued'],
    ['LANDED', 'merged'],
  ])
  expect(d.destination).toBe('main (the configured base branch)')
  expect(d.verifySteps).toEqual([
    { step: 'lint', outcome: 'pending' },
    { step: 'unit', outcome: 'pending' },
  ])
  expect(d.verification).toContain('once every child has merged')
  expect(d.landing).toContain('default rule')
  const s = state()
  s.target = { ticket: { source: 'fake', id: 'PARENT' }, build: 'parent' }
  expect(detail(s).destination).toBe('PARENT')
  s.kind = 'work'
  expect(projectIntegrationDetail(record, s, { gates: {} }, config, config)).toBeUndefined()
})
test('enrichment refreshes child phase without mutating rows and rejects other repositories and terminal attempts', () => {
  const parent = projectBuild(record, state(), config, [])!
  const s = {
    ...reduceBuild([]),
    status: 'running' as const,
    target: { ticket: { source: 'fake', id: 'NODE' }, build: 'node' },
    currentPhase: { phase: 'implement' as const, round: 1, seq: 1 },
  }
  const childRecord = {
    ...record,
    slug: 'child',
    ticket: { source: 'fake', id: 'OPEN', title: 'Current title' },
  }
  const child = projectBuild(childRecord, s, config, [])!
  const first = enrichIntegrationRows([parent, child])[0]!
  expect(first.integrationDetail?.children[0]).toMatchObject({
    state: 'implement',
    title: 'Build work',
  })
  expect(first.integrationRow?.children).toMatchObject({ building: 1, queued: 1 })
  expect(parent.integrationDetail?.children[0]?.state).toBe('queued')
  child.collectionIdentity!.phase = 'code-review'
  expect(enrichIntegrationRows([first, child])[0]?.integrationDetail?.children[0]?.state).toBe(
    'code-review',
  )
  child.collectionIdentity!.repo = 'foreign'
  expect(enrichIntegrationRows([first, child])[0]?.integrationDetail?.children[0]?.state).toBe(
    'queued',
  )
  child.collectionIdentity!.repo = 'repo'
  child.collectionIdentity!.status = 'aborted'
  expect(enrichIntegrationRows([first, child])[0]?.integrationDetail?.children[0]?.state).toBe(
    'queued',
  )
})
test('legacy facts recover contribution titles from completed records and acknowledge missing data', () => {
  const s = state()
  delete s.integration!.observation!.children
  const row = projectBuild(record, s, config, [])!
  const enriched = enrichIntegrationRows(
    [row],
    [{ ...record, slug: 'old', ticket: { source: 'fake', id: 'OLD', title: 'Completed title' } }],
  )[0]!
  expect(enriched.integrationDetail?.children.find((c) => c.landed)).toMatchObject({
    id: 'OLD',
    title: 'Completed title',
    state: 'merged',
  })
  expect(enriched.integrationDetail?.children[0]?.title).toBe('title unavailable')
  s.integration!.observation!.diagnostics = ['partial scan']
  expect(detail(s).membershipKnown).toBe(false)
  s.nodeRestack = { items: [], conflict: { id: 'tx', index: 0, base: 'base' } }
  expect(detail(s).conflictFiles).toEqual(['conflicting filenames were not recorded'])
  s.nodeRestack.conflict!.files = ['a file', '日本語']
  expect(detail(s).conflictFiles).toEqual(['a file', '日本語'])
  delete s.nodeRestack.conflict
  expect(detail(s).conflictFiles).toBeUndefined()
})
test('verification binds outcomes to cycle/head/parent and exposes repair and consent help', () => {
  const s = state()
  s.integration!.observation!.openChildren = []
  s.integration!.cycle = {
    id: 'cycle',
    head: 'head',
    parent: 'base',
    seq: 10,
    config: JSON.stringify(config),
  }
  s.nodeComparison = { headSha: 'head', parentSha: 'base', ahead: 1 }
  s.nodeRestack = { contributionBase: 'base', items: [] }
  s.verify.results = [
    {
      step: 'lint',
      outcome: 'skipped',
      seq: 11,
      restackId: 'cycle',
      headSha: 'head',
      baseSha: 'base',
      attempt: 1,
    },
    {
      step: 'unit',
      outcome: 'fail',
      seq: 12,
      restackId: 'cycle',
      headSha: 'head',
      baseSha: 'base',
      attempt: 1,
    },
  ]
  expect(detail(s).verification).toContain('unit failed — file a repair child targeting NODE')
  expect(detail(s).verifySteps[0]?.outcome).toBe('skipped')
  s.verify.results[1]!.outcome = 'pass'
  expect(detail(s).verification).toContain('verified')
  s.prState = 'open'
  s.landing = {
    decision: {
      seq: 13,
      from: 'node',
      into: { kind: 'root' },
      labels: [],
      candidate: { head: 'head', parent: 'base', cycle: 'cycle' },
      mode: 'consent',
      rule: { default: true },
    },
  }
  expect(detail(s).landing).toContain('press l, or ab merge node')
  s.nodeComparison.headSha = 'moved'
  expect(detail(s).verifySteps.every((s) => s.outcome === 'pending')).toBe(true)
  s.nodeComparison.headSha = 'head'
  s.nodeComparison.parentSha = 'moved'
  expect(detail(s).verifySteps.every((s) => s.outcome === 'pending')).toBe(true)
})
test('prospective policy retains label uncertainty and hold retains rule explanation', () => {
  const c = {
    ...config,
    landing: [{ from: 'node' as const, label: 'fast', mode: 'auto' as const }],
  }
  expect(detail(state(), c).landing).toBe('policy pending — rule pending ticket labels')
  const s = state()
  s.landing = { command: { kind: 'hold', seq: 1 } }
  expect(detail(s).landing).toContain('held — default rule')
})

test('a recorded merge snapshot explains auto and holds independently of changed live policy', () => {
  const s = state()
  s.landing = {
    decision: {
      seq: 1,
      candidate: { head: 'head', parent: 'base', cycle: 'cycle' },
      from: 'node',
      into: { kind: 'root' },
      labels: [],
      mode: 'auto',
      rule: { index: 0, snapshot: { from: 'node', into: 'root', mode: 'auto' } },
    },
  }
  expect(detail(s).landing).toBe('auto — rule 1: {"from":"node","into":"root","mode":"auto"}')
  s.landing.command = { kind: 'hold', seq: 2 }
  expect(detail(s).landing).toBe('held — rule 1: {"from":"node","into":"root","mode":"auto"}')
})

test('verification uses the pinned build steps before preparation and the cycle steps afterward', () => {
  const s = state()
  expect(
    projectIntegrationDetail(record, s, { gates: {} }, config, {
      ...config,
      verify: { ...config.verify, steps: ['pinned'] },
    })?.verifySteps,
  ).toEqual([{ step: 'pinned', outcome: 'pending' }])
  s.integration!.cycle = {
    id: 'cycle',
    head: 'head',
    parent: 'base',
    seq: 10,
    config: JSON.stringify({ verify: { steps: ['cycle-step'] } }),
  }
  expect(detail(s).verifySteps).toEqual([{ step: 'cycle-step', outcome: 'pending' }])
})

test('normalized membership joins a current-source child to a historical parent by its recorded claim', () => {
  const s = state()
  s.integration!.observation = {
    membershipSource: 'file',
    openChildren: ['NEW-CHILD'],
    contributions: [],
    diagnostics: [],
    children: [
      { source: 'file', id: 'NEW-CHILD', title: 'Current child', claims: ['current-child'] },
    ],
  }
  const childState: BuildState = {
    ...reduceBuild([]),
    status: 'running',
    target: { ticket: { source: 'file', id: 'NEW-NODE' }, build: 'node' },
    currentPhase: { phase: 'implement', round: 1, seq: 1 },
  }
  const child = projectBuild(
    { ...record, slug: 'current-child', ticket: { source: 'file', id: 'NEW-CHILD' } },
    childState,
    config,
    [],
  )!
  const parent = projectBuild(record, s, config, [])!
  const projected = enrichIntegrationRows([parent, child])[0]!
  expect(projected.integrationDetail?.children).toContainEqual({
    source: 'file',
    id: 'NEW-CHILD',
    title: 'Current child',
    claims: ['current-child'],
    state: 'implement',
    landed: false,
  })
  expect(projected.integrationRow?.children).toMatchObject({ known: true, building: 1 })
})

test('node detail preserves unknown, empty, and rewritten hand-pushed identities', () => {
  expect(detail().handPushedCommits).toBeUndefined()
  const s = state()
  s.nodeRestack = { items: [], inventory: { head: 'head', builds: ['child'], foreign: [] } }
  expect(detail(s).handPushedCommits).toEqual([])
  s.nodeRestack.inventory!.foreign = ['current', 'direct']
  s.nodeRestack.foreignAliases = { current: 'intermediate', intermediate: 'original' }
  expect(detail(s).handPushedCommits).toEqual([
    { sha: 'current', originalSha: 'original' },
    { sha: 'direct', originalSha: 'direct' },
  ])
})

test('grouped node detail waits for settlement before requesting repairs for all failed members', () => {
  const s = state()
  s.integration!.observation!.openChildren = []
  s.integration!.cycle = {
    seq: 10,
    id: 'cycle',
    head: 'head',
    parent: 'base',
    config: JSON.stringify({ verify: { steps: ['lint', 'unit'], stages: [['lint', 'unit']] } }),
  }
  s.nodeComparison = { headSha: 'head', parentSha: 'base', ahead: 1 }
  s.nodeRestack = { contributionBase: 'base', items: [] }
  s.verify.results = [
    {
      seq: 11,
      step: 'lint',
      attempt: 1,
      outcome: 'fail',
      restackId: 'cycle',
      headSha: 'head',
      baseSha: 'base',
    },
  ]
  expect(detail(s).verification).not.toContain('file a repair')
  expect(detail(s).verifySteps).toEqual([
    { step: 'lint', outcome: 'fail' },
    { step: 'unit', outcome: 'pending' },
  ])
  s.verifyStage.failures.push({
    seq: 20,
    cycle: 10,
    attempt: 1,
    stage: ['lint', 'unit'],
    restackId: 'cycle',
    headSha: 'head',
    baseSha: 'base',
    failed: [{ step: 'lint' }, { step: 'unit' }],
    cancelled: [],
  })
  expect(detail(s).verification).toBe('lint, unit failed — file a repair child targeting NODE')
})
