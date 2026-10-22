import { DISPATCHER } from '../../events/envelope'
import { validateRepositoryEventWrite, type RepositoryEvent } from '../../events/repository'
import { expect, test } from 'bun:test'
import { handoffEvents } from '../../../../../tools/handoff-capture'
import { dispatchUpgradeReducer } from '../../kernel/dispatch-upgrade'
import { repositoryReadFactsReducer } from '../../kernel/read-facts'
import { buildDashboardFromProjected, type DashboardBuild } from './model'
import { formatHandoff, handoffRuntime, projectHandoffs } from './handoff'
import { renderDashboard, stripAnsi } from './render'

const header = {
  repo: 'repo',
  queued: 0,
  activeCount: 2,
  capacity: 4,
  observationCount: 0,
  observationLimit: 5,
}
const row: DashboardBuild = {
  slug: 'old-build',
  status: 'running',
  alsoPaused: false,
  steps: [],
  blockers: [],
  autoMerge: 'off',
}
const events = handoffEvents(row.slug)

test('only accepted handoffs appear; settlement changes cached rows without changing lifecycle', () => {
  expect(projectHandoffs(dispatchUpgradeReducer.reduce(events.slice(0, 2))).handoffs).toEqual([])
  const original = Object.freeze({ ...row })
  const active = buildDashboardFromProjected(
    [original, { ...row, slug: 'unaffected' }],
    header,
    events,
  )
  expect(active.builds[0]!.draining).toBe(true)
  expect(original.draining).toBeUndefined()
  expect(active.builds[1]!.draining).toBeUndefined()
  const settled = buildDashboardFromProjected(
    active.builds,
    header,
    handoffEvents(row.slug, 'settled'),
  )
  expect(settled.builds[0]!.draining).toBeUndefined()
  expect(settled.builds[0]!.status).toBe('running')
  expect(settled.handoffs).toHaveLength(1)
  const complete = buildDashboardFromProjected(
    active.builds,
    header,
    handoffEvents(row.slug, 'completed'),
  )
  expect(complete.handoffs).toBeUndefined()
  expect(complete.builds[0]!.draining).toBeUndefined()
  expect(buildDashboardFromProjected([], header, events).handoffs).toHaveLength(1)
})

test('raw and incremental repository facts agree', () => {
  const facts = repositoryReadFactsReducer.reduce(events)
  expect(buildDashboardFromProjected([row], header, facts)).toEqual(
    buildDashboardFromProjected([row], header, events),
  )
})

test('historical handoffs mean cutover with unknown deadline; runtime commits distinguish versions', () => {
  const historical = structuredClone(events[2]!)
  if (historical.type !== 'dispatcher.handoff-started') throw new Error('fixture')
  delete historical.payload.mode
  delete historical.payload.deadline
  historical.payload.to.version = historical.payload.from.version
  const projection = projectHandoffs(dispatchUpgradeReducer.reduce([historical]))
  expect(projection.draining.size).toBe(0)
  expect(formatHandoff(projection.handoffs[0]!)).toBe(
    'handoff 1.0.0 aaaaaaaaaaaa to 1.0.0 bbbbbbbbbbbb; mode cutover; drain deadline unknown',
  )
})

test('wrong instance cannot settle and multiple generations remain ordered until completion', () => {
  const wrong = handoffEvents(row.slug, 'settled')
  const last = wrong.at(-1)!
  if (last.type !== 'dispatcher.drain-settled') throw new Error('fixture')
  last.payload.instance = 'wrong'
  expect(projectHandoffs(dispatchUpgradeReducer.reduce(wrong)).draining.has(row.slug)).toBe(true)
  const newer = handoffEvents('second-build').map((event) => {
    const next = structuredClone(event)
    next.seq += 10
    if ('run' in next.payload) next.payload.run = 'second'
    if ('successor' in next.payload) next.payload.successor = 'third'
    return next
  })
  const state = dispatchUpgradeReducer.reduce([...events, ...newer])
  expect(projectHandoffs(state).handoffs.map((entry) => entry.run)).toEqual(['old', 'second'])
  expect([...projectHandoffs(state).draining]).toEqual(['old-build', 'second-build'])
  expect(
    projectHandoffs(
      dispatchUpgradeReducer.reduce([...handoffEvents(row.slug, 'completed'), ...newer]),
    ).handoffs.map((entry) => entry.run),
  ).toEqual(['second'])
})

test('terminal wraps banner at narrow widths, preserves status and respects tiny heights', () => {
  const model = buildDashboardFromProjected([row], header, events)
  for (const width of [60, 120]) {
    const text = stripAnsi(
      renderDashboard(model, { width, height: 36, color: false, now: 0 }).join('\n'),
    )
    expect(text).toContain('(draining)')
    expect(text).toContain('RUNNING')
    expect(text).toContain('handoff 1.0.0')
    expect(text.replace(/\s+/g, ' ')).toContain('mode drain;')
    expect(text).toContain('2026-07-15T12:15:00.000Z')
  }
  for (const height of [1, 2, 3, 5]) {
    expect(
      renderDashboard(model, { width: 60, height, color: false, now: 0 }).length,
    ).toBeLessThanOrEqual(height)
  }
})

test('deadline changes, takeover and overdue clocks retain banners until accepted completion', () => {
  const writes = structuredClone(events)
  const start = writes[2]!
  if (start.type !== 'dispatcher.handoff-started') throw new Error('fixture')
  start.payload.builds!.push({ slug: 'second-build', instance: 'second-execution' })
  const identity = { ...start.payload }
  const {
    successor: _successor,
    mode: _mode,
    deadline: _deadline,
    builds: _builds,
    ...handoff
  } = identity
  const fact = (type: string, payload: unknown) =>
    ({
      ...validateRepositoryEventWrite({ actor: DISPATCHER, type, payload }),
      repo: 'repo',
      seq: writes.length + 1,
      ts: '2026-07-15T12:10:00.000Z',
    }) as RepositoryEvent
  writes.push(fact('dispatcher.terminal-released', handoff))
  writes.push(fact('dispatcher.takeover', { ...handoff, successor: 'new' }))
  writes.push(
    fact('dispatcher.drain-deadline', { ...handoff, deadline: '2020-01-01T00:00:00.000Z' }),
  )
  writes.push(
    fact('dispatcher.drain-settled', {
      ...handoff,
      correlation: 'wrong',
      slug: row.slug,
      instance: 'old-execution',
      outcome: 'drained',
    }),
  )
  writes.push(
    fact('dispatcher.drain-settled', {
      ...handoff,
      slug: row.slug,
      instance: 'old-execution',
      outcome: 'drained',
    }),
  )
  const frame = buildDashboardFromProjected([row, { ...row, slug: 'second-build' }], header, writes)
  expect(frame.builds[0]!.draining).toBeUndefined()
  expect(frame.builds[1]!.draining).toBe(true)
  expect(frame.handoffs?.[0]?.deadline).toBe('2020-01-01T00:00:00.000Z')
  for (const now of [0, Date.parse('2100-01-01')]) {
    expect(
      renderDashboard(frame, { width: 120, height: 36, color: false, now }).join('\n'),
    ).toContain('handoff 1.0.0')
  }
})

test('unrecorded runtime labels are explicit and never expose source locations', () => {
  const runtime = {
    version: 'unknown',
    commit: 'unknown',
    source: { kind: 'source' as const, location: '/private/checkout' },
  }
  expect(handoffRuntime(runtime)).toBe('unknown')
  expect(handoffRuntime({ ...runtime, version: 'long-runtime-version-name' })).toBe(
    'long-runtime-version-name',
  )
})
