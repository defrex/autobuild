import { describe, expect, test } from 'bun:test'
import { NO_DISPATCHER_RUN_LINE } from './configuration'
import type { DashboardHandoff } from './handoff'
import { mergeVocabulary } from './landing-display'
import type { DashboardBuild, DashboardHarvest, DashboardModel } from './model'
import {
  projectAttention,
  projectDispatcherMode,
  projectFinishedRow,
  projectHarvestRowText,
  projectHeaderText,
  projectOverview,
  projectRowText,
} from './row-text'

const build = (extra: Partial<DashboardBuild> = {}): DashboardBuild => ({
  slug: 'b',
  status: 'running',
  alsoPaused: false,
  steps: [
    { label: 'spec', state: 'done' },
    { label: 'plan', state: 'current', timing: { accumulatedMs: 0, runningSince: 5 } },
  ],
  blockers: [],
  autoMerge: 'off',
  ...extra,
})

const tree = (extra: Record<string, unknown>) =>
  ({
    kind: 'work',
    branch: 'ab/b',
    restack: 'idle',
    verification: { current: true, results: [] },
    ready: false,
    consent: false,
    ...extra,
  }) as unknown as NonNullable<DashboardBuild['tree']>

const integrationRow = (
  extra: Partial<NonNullable<DashboardBuild['integrationRow']>> = {},
): NonNullable<DashboardBuild['integrationRow']> => ({
  destination: 'main',
  children: { known: false },
  verified: false,
  steps: [{ label: 'collect', state: 'current' }],
  openChildren: [],
  ...extra,
})

const row = (extra: Partial<DashboardBuild> = {}, repositoryPaused = false) =>
  projectRowText(build(extra), { repositoryPaused })

describe('projectRowText', () => {
  test('carries the ticket title and URL as identity, absent rather than undefined', () => {
    const identity = { repo: 'r', status: 'running' as const }
    const titled = row({
      collectionIdentity: { ...identity, title: 'Fix the gate', url: 'https://t.test/7' },
    })
    expect(titled.title).toBe('Fix the gate')
    expect(titled.ticketUrl).toBe('https://t.test/7')
    const bare = row({ collectionIdentity: { ...identity, title: undefined, url: undefined } })
    expect(JSON.parse(JSON.stringify(bare))).toEqual(bare)
    expect('title' in bare || 'ticketUrl' in bare).toBe(false)
  })

  test('flags: held only for queued rows under a repository hold, then draining, paused', () => {
    expect(row({ status: 'queued' }, true).flags.map((f) => f.term)).toEqual(['held'])
    expect(row({}, true).flags).toEqual([])
    expect(row({ status: 'queued' }).flags).toEqual([])
    expect(row({ status: 'queued', draining: true, alsoPaused: true }, true).flags).toEqual([
      { term: 'held', tone: 'held' },
      { term: 'draining', tone: 'held' },
      { term: 'paused', tone: 'held' },
    ])
  })

  test('merge text and tone per auto-merge state; absent for integration builds', () => {
    const tones = {
      off: 'pending',
      requested: 'live',
      polling: 'live',
      enabled: 'ok',
      cancelling: 'held',
      'human-merge': 'held',
    } as const
    for (const [autoMerge, tone] of Object.entries(tones))
      expect(row({ autoMerge: autoMerge as keyof typeof tones }).merge?.tone).toBe(tone)
    expect(row({ autoMerge: 'human-merge' }).merge?.text).toBe(
      `merge ${mergeVocabulary.humanMerge}`,
    )
    expect(row({ kind: 'integration' }).merge).toBeUndefined()
  })

  test('identity, PR, target distance and phase', () => {
    const text = row({ ticketId: 'T-1', pr: { url: 'https://x/1', state: 'open' }, target: 'main' })
    expect(text).toMatchObject({
      slug: 'b',
      ticketId: 'T-1',
      kind: 'work',
      status: { word: 'RUNNING', tone: 'ok' },
      phase: 'plan',
      pr: { text: 'PR open', url: 'https://x/1' },
      target: { destination: 'main', distance: '+?' },
    })
    expect(row({ target: 'main', targetDistance: '+3' }).target?.distance).toBe('+3')
    expect(row({ target: 'main', targetDistance: '' }).target?.distance).toBe('')
    expect(row().target).toBeUndefined()
    expect(row({ steps: [{ label: 'spec', state: 'done' }] }).phase).toBeUndefined()
  })

  test('notice prefers abort progress over dispatch, in the status tone', () => {
    expect(row({ status: 'aborting', abortProgress: 'a', dispatch: 'd' }).notice).toEqual({
      text: 'a',
      tone: 'alert',
    })
    expect(row({ status: 'queued', dispatch: 'd' }).notice).toEqual({ text: 'd', tone: 'live' })
  })

  test('attention lines in row order', () => {
    const text = row({
      alert: { tone: 'yellow', text: 'slot' },
      wait: { text: 'waiting on T-2' } as DashboardBuild['wait'],
      setupError: 'boom',
      blockers: ['q1', 'q2'],
    })
    expect(text.attention).toEqual([
      { kind: 'alert', tone: 'held', text: 'slot' },
      { kind: 'wait', tone: 'held', text: 'waiting on T-2' },
      { kind: 'setup-error', tone: 'alert', text: 'boom' },
      { kind: 'escalation', tone: 'alert', text: 'q1' },
      { kind: 'escalation', tone: 'alert', text: 'q2' },
    ])
  })

  test('tree lines and review ceiling', () => {
    expect(row({ tree: tree({ consent: true, reason: 'consent required' }) }).tree).toEqual([
      'ab/b · restack idle · verify current · consent required',
    ])
    expect(row({ tree: tree({}) }).tree).toBeUndefined()
    expect(
      row({
        kind: 'integration',
        tree: tree({
          kind: 'node',
          children: ['c'],
          completeness: 'incomplete',
          diagnostics: ['d'],
        }),
      }).tree,
    ).toEqual(['ab/b · restack idle · verify current · not ready', 'children 1 · incomplete · d'])
    expect(row({ reviewRoundCeilings: { plan: 2, code: 5 } }).ceiling).toBe(
      'review round ceiling: plan 2, code 5',
    )
  })

  test('integration rows: own steps, progress counts and only their alert', () => {
    const counts = (children: NonNullable<DashboardBuild['integrationRow']>['children']) =>
      row({ kind: 'integration', integrationRow: integrationRow({ children }) }).progress?.counts
    expect(counts({ known: false })).toEqual([{ text: 'children unknown', tone: 'pending' }])
    expect(counts({ known: true, landed: 0, building: 0, queued: 0, total: 0 })).toEqual([
      { text: 'no children yet', tone: 'pending' },
    ])
    expect(counts({ known: true, landed: 3, building: 1, queued: 1, total: 5 })).toEqual([
      { text: '3/5 merged', tone: 'ok' },
      { text: '1 building', tone: 'live' },
      { text: '1 queued', tone: 'pending' },
    ])
    const text = row({
      kind: 'integration',
      blockers: ['hidden'],
      tree: tree({ kind: 'node' }),
      integrationRow: integrationRow({
        verified: true,
        parentDistance: '+1',
        alert: { tone: 'red', text: 'verify failed' },
      }),
    })
    expect(text).toMatchObject({
      phase: 'collect',
      target: { destination: 'main', distance: '+1' },
      progress: { verified: true },
      attention: [{ kind: 'alert', tone: 'alert', text: 'verify failed' }],
    })
    expect(text.tree).toBeUndefined()
  })
})

test('harvest row text', () => {
  const harvest: DashboardHarvest = {
    kind: 'harvest',
    run: 'r',
    status: 'escalated',
    steps: [],
    observations: 4,
    rounds: 1,
  }
  expect(projectHarvestRowText(harvest)).toEqual({
    title: 'Harvest',
    status: { status: 'escalated', word: 'ESCALATED', tone: 'held' },
    observations: '4 observations',
    steps: [],
  })
  expect(projectHarvestRowText({ ...harvest, detail: 'why' }).detail).toEqual({
    text: 'why',
    tone: 'held',
  })
})

describe('projectHeaderText', () => {
  const header = {
    queued: 2,
    active: { current: 1, limit: 3 },
    drained: false,
    harvestPaused: false,
    repositoryPaused: false,
    capacity: { configured: 3, occupied: 1, effective: 3, borrowingNodes: ['n'] },
  }
  test('counts and capacity note', () => {
    const text = projectHeaderText(header)
    expect(text.counts).toEqual([
      { label: 'triage', value: '–' },
      { label: 'queue', value: '2' },
      { label: 'active', value: '1/3' },
    ])
    expect(text.capacityNote).toBe('(3 configured; 1 node using descendant-held slots: n)')
    expect(projectHeaderText({ ...header, triage: 4 }).counts[0]?.value).toBe('4')
    const noRun = projectHeaderText({ ...header, configuration: 'no-dispatcher-run' })
    expect(noRun.capacityNote).toBeUndefined()
    expect(noRun.counts[2]?.value).toBe('–')
  })
  test('gates', () => {
    expect(projectHeaderText(header).gates).toEqual([
      { label: 'intake', word: 'ON', tone: 'ok' },
      { label: 'harvest', word: 'ON', tone: 'ok' },
    ])
    expect(
      projectHeaderText({ ...header, drained: true, harvestPaused: true, repositoryPaused: true })
        .gates,
    ).toEqual([
      { label: 'intake', word: 'OFF', tone: 'held' },
      { label: 'harvest', word: 'OFF', tone: 'held' },
      { label: 'repository', word: 'PAUSED', tone: 'held' },
    ])
  })
})

test('projectDispatcherMode precedence', () => {
  const handoffs = [{ run: 'r' } as DashboardHandoff]
  const mode = (input: Parameters<typeof projectDispatcherMode>[0]) => projectDispatcherMode(input)
  expect(mode({ health: 'running', handoffs }).mode).toBe('handoff')
  expect(mode({ health: 'running', viewer: {}, handoffs }).mode).toBe('handoff')
  expect(mode({ configuration: 'no-dispatcher-run' })).toEqual({
    mode: 'stopped',
    word: 'stopped',
    tone: 'alert',
    detail: NO_DISPATCHER_RUN_LINE,
  })
  expect(mode({ health: 'stopped', viewer: {} })).toEqual({
    mode: 'stopped',
    word: 'stopped',
    tone: 'alert',
  })
  expect(mode({ health: 'failed' }).mode).toBe('stopped')
  expect(mode({ health: 'running', viewer: { dispatchedBy: 'h' } })).toEqual({
    mode: 'viewer',
    word: 'viewer',
    tone: 'live',
    detail: 'dispatched by h',
  })
  expect(mode({ health: 'starting' }).mode).toBe('running')
  expect(mode({ health: 'running' }).mode).toBe('running')
})

describe('projectAttention', () => {
  test('kinds, exclusions, and red before yellow in model order', () => {
    const items = projectAttention(
      [
        build({ slug: 'w', wait: { text: 'waiting' } as DashboardBuild['wait'] }),
        build({ slug: 'slot', alert: { tone: 'yellow', text: 'slot wait' } }),
        build({ slug: 'c', tree: tree({ consent: true }) }),
        build({ slug: 'f', ticketId: 'T-9', alert: { tone: 'red', text: 'ci failed' } }),
        build({
          slug: 'node',
          kind: 'integration',
          blockers: ['node question'],
          integrationRow: integrationRow({ alert: { tone: 'red', text: 'verify failed' } }),
        }),
        build({ slug: 's', setupError: 'setup' }),
      ],
      { kind: 'harvest', run: 'r', status: 'failed', steps: [], observations: 0, rounds: 0 },
    )
    expect(items.map((i) => [i.kind, i.tone, i.slug ?? '-', i.text])).toEqual([
      ['harvest', 'alert', '-', 'FAILED'],
      ['failure', 'alert', 'f', 'ci failed'],
      ['escalation', 'alert', 'node', 'node question'],
      ['failure', 'alert', 'node', 'verify failed'],
      ['setup-error', 'alert', 's', 'setup'],
      ['wait', 'held', 'w', 'waiting'],
      ['consent', 'held', 'c', mergeVocabulary.consent],
    ])
    expect(items[1]?.ticketId).toBe('T-9')
  })
  test('harvest attention only for escalated or failed runs', () => {
    const harvest = (status: DashboardHarvest['status']): DashboardHarvest => ({
      kind: 'harvest',
      run: 'r',
      status,
      steps: [],
      observations: 0,
      rounds: 0,
      detail: 'needs you',
    })
    expect(projectAttention([], harvest('running'))).toEqual([])
    expect(projectAttention([], harvest('escalated'))).toEqual([
      { kind: 'harvest', tone: 'held', text: 'needs you' },
    ])
  })
})

test('projectFinishedRow', () => {
  expect(
    projectFinishedRow({ slug: 'n', kind: 'node', outcome: 'aborted', completedAt: 't' }),
  ).toEqual({
    slug: 'n',
    kind: 'integration',
    outcome: 'aborted',
    word: 'ABORTED',
    tone: 'alert',
    completedAt: 't',
  })
  expect(
    projectFinishedRow({ slug: 'w', kind: 'work', outcome: 'merged', completedAt: 't' }),
  ).toMatchObject({ kind: 'work', word: 'MERGED', tone: 'ok' })
})

describe('projectOverview', () => {
  const model = (extra: Partial<DashboardModel> = {}): DashboardModel => ({
    repo: '/r',
    queued: 0,
    active: { current: 0, limit: 1 },
    drained: false,
    repositoryPaused: false,
    defaultAutoMerge: false,
    harvestPaused: false,
    builds: [],
    ...extra,
  })

  test('splits active from queued in model order', () => {
    const overview = projectOverview(
      model({
        builds: [
          build({ slug: 'q1', status: 'queued' }),
          build({ slug: 'a1' }),
          build({ slug: 'q2', status: 'queued' }),
          build({ slug: 'a2', status: 'blocked' }),
        ],
      }),
      { health: 'running', finished: [] },
    )
    expect(overview.active.map((r) => r.slug)).toEqual(['a1', 'a2'])
    expect(overview.queued.map((r) => r.slug)).toEqual(['q1', 'q2'])
  })

  test('is JSON-safe plain data with no terminal escapes', () => {
    const full = projectOverview(
      model({
        viewer: { dispatchedBy: 'h' },
        triage: 1,
        repositoryPaused: true,
        capacity: { configured: 1, occupied: 1, effective: 1, borrowingNodes: ['n'] },
        harvest: {
          kind: 'harvest',
          run: 'r',
          status: 'escalated',
          steps: [{ label: 'harvest', state: 'current', timing: { accumulatedMs: 1 } }],
          observations: 1,
          rounds: 1,
          detail: 'd',
        },
        builds: [
          build({
            ticketId: 'T-1',
            status: 'queued',
            draining: true,
            alsoPaused: true,
            target: 'main',
            targetDistance: '+1',
            pr: { url: 'https://x', state: 'open' },
            dispatch: 'waiting for slot',
            alert: { tone: 'red', text: 'a' },
            wait: { text: 'w' } as DashboardBuild['wait'],
            setupError: 's',
            blockers: ['q'],
            tree: tree({ consent: true }),
            reviewRoundCeilings: { plan: 1 },
            steps: [
              {
                label: 'plan',
                state: 'current',
                qualifier: 'failed',
                count: 2,
                timing: { accumulatedMs: 1, runningSince: 2 },
                reason: 'r',
              },
            ],
          }),
          build({
            kind: 'integration',
            integrationRow: integrationRow({
              children: { known: true, landed: 1, building: 1, queued: 1, total: 3 },
              alert: { tone: 'yellow', text: 'slot' },
            }),
          }),
        ],
      }),
      {
        health: 'running',
        finished: [{ slug: 'f', kind: 'work', outcome: 'merged', completedAt: 't' }],
      },
    )
    const empty = projectOverview(model(), { finished: [] })
    for (const overview of [full, empty]) {
      const serialized = JSON.stringify(overview)
      expect(JSON.parse(serialized)).toStrictEqual(overview)
      expect(serialized).not.toContain('\x1b')
    }
    expect(full.attention.length).toBeGreaterThan(0)
  })
})
