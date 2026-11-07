import { describe, expect, test } from 'bun:test'
import { reduceBuild, type BuildState } from '../../kernel/reducer'
import { configSchema } from '../../config/schema'
import type { BuildRecord } from '../../store/types'
import { projectBuild } from './model'
import {
  enrichIntegrationRows,
  integrationBarCells,
  projectIntegrationRow,
} from './integration-row'

const config = configSchema.parse({ tickets: { source: 'file', readyState: 'ready' } })
const record: BuildRecord = {
  slug: 'node',
  repo: 'repo',
  ticket: { source: 'fake', id: 'NODE-1' },
  createdAt: '',
  updatedAt: '',
}
function node(): BuildState {
  return {
    ...reduceBuild([]),
    kind: 'node',
    status: 'running',
    baseBranch: 'main',
    specRev: 0,
    nodeOpened: { sha: 'base' },
    integration: { observation: { openChildren: [], contributions: [], diagnostics: [] } },
  }
}
function row(state = node()) {
  return projectIntegrationRow(record, state, { gates: {} }, config)!
}
function verifying(): BuildState {
  const state = node()
  state.integration = {
    observation: { openChildren: [], contributions: ['a', 'b'], diagnostics: [] },
    cycle: {
      seq: 10,
      id: 'cycle',
      head: 'head',
      parent: 'base',
      config: JSON.stringify({ verify: { steps: ['lint', 'unit', 'e2e'] } }),
    },
  }
  state.nodeComparison = { headSha: 'head', parentSha: 'base', ahead: 1 }
  state.nodeRestack = { contributionBase: 'base', items: [] }
  state.verify.results = [
    {
      seq: 11,
      step: 'lint',
      outcome: 'pass',
      restackId: 'cycle',
      headSha: 'head',
      baseSha: 'base',
      attempt: 1,
    },
  ]
  return state
}
describe('integration list projection', () => {
  test('absent/partial observations are unknown, recovery is known, empty is distinct', () => {
    const state = node()
    expect(row(state).children).toEqual({
      known: true,
      landed: 0,
      building: 0,
      queued: 0,
      total: 0,
    })
    delete state.integration
    expect(row(state).children).toEqual({ known: false })
    for (const contributions of [[], ['previous']]) {
      state.integration = {
        observation: { openChildren: [], contributions, diagnostics: ['enumeration failed'] },
      }
      expect(row(state).children).toEqual({ known: false })
      expect(row(state).verified).toBe(false)
      state.integration.observation!.diagnostics = []
      expect(row(state).children).toMatchObject({
        known: true,
        landed: contributions.length,
        total: contributions.length,
      })
    }
  })
  test('five durable steps and nested identity, opening and node default consent', () => {
    const state = node()
    delete state.nodeOpened
    state.target = { ticket: { source: 'fake', id: 'NODE-900' }, build: 'release-1.0' }
    expect(row(state).destination).toBe('NODE-900')
    expect(row(state).steps).toEqual([
      { label: 'spec', state: 'done' },
      { label: 'open', state: 'current' },
      { label: 'collect', state: 'pending' },
      { label: 'verify', state: 'pending' },
      { label: 'merge', state: 'pending', qualifier: 'consent' },
    ])
  })
  test('current cycle progress, failure, repair and moved parents exclude stale evidence', () => {
    const state = verifying()
    expect(row(state).steps[3]).toMatchObject({ state: 'current', qualifier: '1/3' })
    state.verify.results.push({
      ...state.verify.results[0]!,
      seq: 12,
      step: 'unit',
      outcome: 'fail',
    })
    expect(row(state).alert).toEqual({
      tone: 'red',
      text: 'unit failed — file a repair child targeting NODE-1',
    })
    expect(row(state).steps[3]?.qualifier).toBe('failed')
    state.integration!.observation!.openChildren = ['REPAIR']
    expect(row(state).alert).toBeUndefined()
    expect(row(state).steps[3]).toEqual({ label: 'verify', state: 'pending' })
    state.integration!.observation!.openChildren = []
    state.nodeComparison!.parentSha = 'new-base'
    expect(row(state).alert).toBeUndefined()
    expect(row(state).verified).toBe(false)
    state.nodeComparison!.parentSha = 'base'
    state.verify.results = ['lint', 'unit', 'e2e'].map((step, i) => ({
      ...state.verify.results[0]!,
      seq: 20 + i,
      step,
      outcome: 'pass',
    }))
    expect(row(state).verified).toBe(true)
    state.landing = {
      decision: {
        seq: 30,
        candidate: { head: 'head', parent: 'base', cycle: 'cycle' },
        from: 'node',
        into: { kind: 'root' },
        labels: [],
        mode: 'consent',
        rule: { default: true },
      },
    }
    state.prState = 'open'
    expect(row(state).alert?.text).toBe('ready to merge into main — press l, or ab merge node')
    state.landing.command = { seq: 31, kind: 'hold' }
    expect(row(state).alert).toBeUndefined()
    expect(row(state).steps[4]?.qualifier).toBe('held')
    state.nodeRestack!.conflict = { id: 'conflict', index: 0, base: 'base' }
    expect(row(state).alert?.text).toContain('restack onto main conflicted')
  })
  test('repository identity, retry deduplication and live lifecycle define building', () => {
    const state = node()
    state.integration!.observation = {
      openChildren: ['A', 'B', 'C', 'A'],
      contributions: ['one', 'one', ...Array.from({ length: 7 }, (_, i) => `landed-${i}`)],
      diagnostics: [],
    }
    const parent = projectBuild(record, state, config, [])!
    const child = (id: string, status: BuildState['status'] = 'running', slug = id) =>
      projectBuild(
        { ...record, slug, ticket: { source: 'fake', id } },
        { ...node(), kind: 'work', status, target: { ticket: record.ticket!, build: 'node' } },
        config,
        [],
      )!
    const a = child('A')
    const b = child('B', 'paused')
    const c = child('C', 'queued')
    const enriched = enrichIntegrationRows([parent, a, child('A', 'blocked', 'retry'), b, c])
    expect(enriched[0]!.integrationRow!.children).toEqual({
      known: true,
      landed: 8,
      building: 2,
      queued: 1,
      total: 11,
    })
    expect(enriched[1]).toBe(a)
    expect(parent.integrationRow!.children).toMatchObject({ building: 0, queued: 3 })
    a.collectionIdentity!.repo = 'foreign'
    b.collectionIdentity!.targetBuild = 'other'
    expect(enrichIntegrationRows([parent, a, b, c])[0]!.integrationRow!.children).toMatchObject({
      building: 0,
      queued: 3,
    })
    a.collectionIdentity!.repo = 'repo'
    a.collectionIdentity!.status = 'aborted'
    expect(enrichIntegrationRows([parent, a])[0]!.integrationRow!.children).toMatchObject({
      building: 0,
    })
  })
  test('22 cells including empty, rounding and full tracks', () => {
    expect(integrationBarCells(8, 2, 1)).toEqual([16, 4, 2])
    expect(integrationBarCells(0, 0, 0)).toEqual([0, 0, 22])
    expect(integrationBarCells(11, 0, 0)).toEqual([22, 0, 0])
    expect(integrationBarCells(100, 1, 2).reduce((a, b) => a + b)).toBe(22)
  })
})

test('verify(4/7) counts distinct selected receipts and excludes previous heads and cycles', () => {
  const state = verifying()
  const steps = ['lint', 'unit', 'types', 'postgres', 'dashboard', 'web', 'e2e']
  state.integration!.cycle!.config = JSON.stringify({ verify: { steps } })
  const receipt = state.verify.results[0]!
  state.verify.results = [
    ...steps.slice(0, 4).map((step, i) => ({
      ...receipt,
      seq: 20 + i,
      step,
      outcome: i === 3 ? ('skipped' as const) : ('pass' as const),
    })),
    { ...receipt, seq: 30 },
    { ...receipt, seq: 31, step: 'e2e', restackId: 'old-cycle', outcome: 'fail' },
    { ...receipt, seq: 32, step: 'dashboard', headSha: 'old-head', outcome: 'fail' },
    { ...receipt, seq: 33, step: 'web', baseSha: 'old-parent' },
    { ...receipt, seq: 34, step: 'not-selected' },
  ]
  expect(row(state).steps[3]).toEqual({ label: 'verify', state: 'current', qualifier: '4/7' })
  expect(row(state).alert).toBeUndefined()
  expect(row(state).verified).toBe(false)
  state.nodeRestack!.observedParent = { branch: 'main', sha: 'moved' }
  expect(row(state).steps[3]).toEqual({ label: 'verify', state: 'pending' })
})

test('ticketless fallback is scoped to the frozen target and source-qualified children never alias it', () => {
  const state = node()
  state.integration!.observation = { openChildren: ['child'], contributions: [], diagnostics: [] }
  const parent = projectBuild(record, state, config, [])!
  const child = projectBuild(
    { ...record, slug: 'child', ticket: undefined },
    { ...node(), kind: 'work', target: { ticket: record.ticket!, build: 'node' } },
    config,
    [],
  )!
  expect(enrichIntegrationRows([parent, child])[0]!.integrationRow!.children).toMatchObject({
    building: 1,
  })
  child.collectionIdentity!.targetSource = 'foreign'
  expect(enrichIntegrationRows([parent, child])[0]!.integrationRow!.children).toMatchObject({
    building: 0,
  })
  child.collectionIdentity!.targetSource = 'fake'
  child.collectionIdentity!.id = 'child'
  child.collectionIdentity!.source = 'foreign'
  expect(enrichIntegrationRows([parent, child])[0]!.integrationRow!.children).toMatchObject({
    building: 0,
  })
})

test('real integration observations exclude native cancelled children from every count', async () => {
  const { observeIntegration } = await import('../../kernel/integration-completeness')
  const { MemoryBuildStore } = await import('../../store/memory')
  const { FakeTicketSource } = await import('../../ports/tickets/fake')
  const ticket = (id: string, status: string) => ({
    ref: { source: 'fake', id },
    title: id,
    body: '',
    labels: [],
    state: status,
    resolved: false,
    revision: '0',
  })
  const tickets = new FakeTicketSource(
    [
      { ...ticket('NODE-1', 'Ready'), kind: 'node' },
      { ...ticket('CANCELLED', 'Cancelled'), target: 'NODE-1' },
      { ...ticket('OPEN', 'Ready'), target: 'NODE-1' },
    ],
    { doneState: 'Cancelled' },
  )
  const store = new MemoryBuildStore()
  await store.createBuild({
    ...record,
    created: {
      actor: { kind: 'dispatcher' },
      type: 'build.created',
      payload: { ticket: record.ticket!, repo: record.repo, kind: 'node', baseBranch: 'main' },
    },
  })
  const observation = await observeIntegration(store, tickets, record.slug)
  expect(observation.openChildren).toEqual(['OPEN'])
  expect(row({ ...node(), integration: { observation } }).children).toEqual({
    known: true,
    landed: 0,
    building: 0,
    queued: 1,
    total: 1,
  })
})

test('janitor attention appears on the shared row and clears without changing lifecycle', () => {
  const state = node()
  state.janitor = {
    firstFailureAt: '2026-01-01T00:00:00.000Z',
    attempt: 8,
    message: 'publication failed',
    nextAttemptAt: '2026-01-01T00:20:00.000Z',
    attention: true,
  }
  expect(row(state).alert).toEqual({ tone: 'red', text: 'Janitor failing: publication failed' })
  expect(state.status).toBe('running')
  delete state.janitor
  expect(row(state).alert).toBeUndefined()
})

test('parent distance matches immutable base, parent and branch; unknown is not zero', () => {
  const state = node()
  expect(row(state).parentDistance).toBe('+?')
  state.nodeRestack = {
    items: [],
    contributionBase: 'base',
    observedParent: { branch: 'main', sha: 'parent' },
    distance: { base: 'base', parent: 'parent', branch: 'main', count: 3 },
  }
  expect(row(state).parentDistance).toBe('+3')
  state.nodeRestack.distance!.count = 1
  expect(row(state).parentDistance).toBe('+1')
  state.nodeRestack.distance!.count = 0
  expect(row(state).parentDistance).toBe('')
  state.nodeRestack.contributionBase = 'new-base'
  expect(row(state).parentDistance).toBe('+?')
})

test('grouped node repair prompts wait for an exact settled receipt and name every failure', () => {
  const s = verifying()
  s.integration!.cycle!.config = JSON.stringify({
    verify: { steps: ['lint', 'unit', 'e2e'], stages: [['lint', 'unit', 'e2e']] },
  })
  s.verify.results[0]!.outcome = 'fail'
  expect(row(s).alert).toBeUndefined()
  expect(row(s).steps.find((step) => step.label === 'verify')?.qualifier).toBe('0/3')
  s.verifyStage.failures.push({
    seq: 20,
    cycle: 10,
    attempt: 1,
    stage: ['lint', 'unit', 'e2e'],
    restackId: 'old-cycle',
    headSha: 'head',
    baseSha: 'base',
    failed: [{ step: 'lint' }, { step: 'unit' }],
    cancelled: [],
  })
  expect(row(s).alert).toBeUndefined()
  s.verifyStage.failures[0]!.restackId = 'cycle'
  expect(row(s).alert?.text).toBe('lint, unit failed — file a repair child targeting NODE-1')
  expect(row(s).steps.find((step) => step.label === 'verify')?.qualifier).toBe('failed')
})
