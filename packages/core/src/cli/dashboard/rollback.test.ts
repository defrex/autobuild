import { expect, test } from 'bun:test'
import {
  rollbackEvents,
  rollbackFact,
  rollbackRun,
  ROLLBACK_AT,
} from '../../../../../tools/rollback-capture'
import { handoffEvents } from '../../../../../tools/handoff-capture'
import type { RepositoryEvent } from '../../events/repository'
import { dispatchUpgradeReducer } from '../../kernel/dispatch-upgrade'
import { repositoryReadFactsReducer } from '../../kernel/read-facts'
import { buildDashboardFromProjected, type DashboardBuild } from './model'
import { formatRollback, projectRollback } from './rollback'
import { renderDashboard, stripAnsi } from './render'

const header = {
  repo: 'repo',
  queued: 0,
  activeCount: 1,
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
const active = rollbackEvents()
const rollback = active[1]!
if (rollback.type !== 'dispatcher.runtime-rolled-back') throw new Error('fixture')
const payload = rollback.payload

/** Exercise every split, including JSON checkpoint round trips, on both read paths. */
function check(events: RepositoryEvent[], visible: boolean) {
  const ordered = events.map((event, index) => ({ ...event, seq: index + 1 }))
  const raw = buildDashboardFromProjected([row], header, ordered)
  expect(Boolean(raw.rollback)).toBe(visible)
  for (let split = 0; split <= ordered.length; split++) {
    const reducer = dispatchUpgradeReducer
    const acc = JSON.parse(
      JSON.stringify(reducer.advance(reducer.initial(), ordered.slice(0, split))),
    )
    const state = reducer.finish(reducer.advance(acc, ordered.slice(split)))
    expect(state).toEqual(reducer.reduce(ordered))
    expect(projectRollback(state)).toEqual(raw.rollback)
    const facts = repositoryReadFactsReducer
    const checkpoint = JSON.parse(
      JSON.stringify(facts.advance(facts.initial(), ordered.slice(0, split))),
    )
    const reduced = facts.finish(facts.advance(checkpoint, ordered.slice(split)))
    expect(buildDashboardFromProjected([row], header, reduced)).toEqual(raw)
  }
  return raw
}

test('rollback exposes identities and event timestamp only while current lineage hold is unresolved', () => {
  check([], false)
  const frame = check(active, true)
  expect(frame.rollback).toEqual({
    correlation: payload.correlation,
    lineage: payload.lineage,
    failed: payload.failed,
    restored: payload.restored,
    ts: ROLLBACK_AT,
  })
  expect(formatRollback(frame.rollback!)).toBe(
    `rollback: failed 1.1.0 bbbbbbbbbbbb; restored 1.0.0 aaaaaaaaaaaa; held 1.1.0 bbbbbbbbbbbb; at ${ROLLBACK_AT}`,
  )
  check([...active, rollback], true)
  check(rollbackEvents('cleared'), false)
  check(rollbackEvents('restarted'), false)
  check([...rollbackEvents('restarted'), rollback], false) // duplicate cannot reclaim authority
  const missing = active.filter((event) => event.type !== 'dispatcher.run-started')
  check(missing, false)
  const newer = structuredClone(rollback)
  newer.payload.correlation = 'later'
  newer.payload.failed.version = '1.2.0'
  expect(check([...active, newer], true).rollback?.failed.version).toBe('1.2.0')
  expect(dispatchUpgradeReducer.reduce([...active, rollback]).rollbackIds).toHaveLength(1)
})

test('only matching different-target clearance removes the hold', () => {
  const clear = rollbackEvents('cleared').at(-1)!
  if (clear.type !== 'dispatcher.rollback-hold-cleared') throw new Error('fixture')
  for (const override of [
    { correlation: 'wrong' },
    { target: payload.target },
    { lineage: 'wrong' },
  ]) {
    check([...active, { ...clear, payload: { ...clear.payload, ...override } }], true)
  }
  // An older lineage must never be resurrected when the current hold clears.
  const old = structuredClone(rollback)
  old.payload.correlation = 'historical'
  old.payload.lineage = 'historical'
  old.payload.run = 'historical'
  check([rollbackRun('historical', 'historical'), old, ...rollbackEvents('cleared')], false)
  expect(dispatchUpgradeReducer.reduce(rollbackEvents('cleared')).lastRollback).toEqual(rollback)
})

test('losing peers, yields, failures, stops, clocks and settlement completion cannot replace authority', () => {
  const events = [...active]
  for (const peer of [
    rollbackRun('legacy-peer'),
    rollbackRun('fresh-peer', 'fresh'),
    rollbackRun('unsettled-peer', 'other'),
  ]) {
    if (peer.type !== 'dispatcher.run-started') throw new Error('fixture')
    events.push(peer)
    check(events, true) // even before a yield is recorded
    events.push(
      rollbackFact('dispatcher.tick-yielded', { run: peer.payload.run, holder: 'restored' }),
    )
    check(events, true)
    events.push(rollbackFact('dispatcher.tick-started', { run: 'restored' }))
    check(events, true)
  }
  events.push(
    rollbackFact('dispatcher.tick-failed', { run: 'fresh-peer', error: 'startup failed' }),
  )
  events.push(rollbackFact('dispatcher.run-stopped', { run: 'restored', outcome: 'normal' }))
  const frame = check(events, true)
  for (const now of [0, Date.parse('2100-01-01')])
    expect(
      renderDashboard(frame, { width: 120, height: 36, color: false, now }).join('\n'),
    ).toContain('rollback:')
  events.push(
    rollbackRun('operator', 'fresh'),
    rollbackFact('dispatcher.tick-started', { run: 'operator' }),
  )
  check(events, false)
  // A draining predecessor's completion-only tick does not reclaim authority.
  events.push(
    rollbackFact('dispatcher.tick-completed', {
      run: 'restored',
      queued: 0,
      counters: Object.fromEntries(
        'merged closed conflicted abandoned discarded janitorFailed recovered dispatchFailed resumed swept dispatched authored bounced claimRaces invalidTickets dependencyBlocked harvestStarted harvestResumed harvestCompleted harvestEscalated harvestFailed'
          .split(' ')
          .map((key) => [key, 0]),
      ),
      janitorDiagnostics: [],
      ticketDiagnostics: [],
      dependencyDiagnostics: [],
    }),
  )
  check(events, false)
})

function takeover(lineage: string): RepositoryEvent[] {
  const events = handoffEvents(row.slug)
  const start = events[2]!
  if (start.type !== 'dispatcher.handoff-started') throw new Error('fixture')
  const {
    builds: _builds,
    deadline: _deadline,
    mode: _mode,
    successor: _successor,
    ...identity
  } = start.payload
  return [
    rollbackRun('new', lineage),
    ...events,
    rollbackFact('dispatcher.terminal-released', identity),
    rollbackFact('dispatcher.takeover', { ...identity, successor: 'new' }),
  ]
}

test('accepted takeover selects successor lineage; invalid takeover does not', () => {
  check([...active, ...takeover('capture')], true)
  check([...active, ...takeover('fresh')], false)
  check(
    [
      ...active,
      ...takeover('fresh').filter((event) => event.type !== 'dispatcher.terminal-released'),
    ],
    true,
  )
  check(
    [
      ...active,
      rollbackRun('generation', 'capture'),
      rollbackFact('dispatcher.tick-started', { run: 'generation' }),
    ],
    true,
  )
  const identity = handoffEvents(row.slug)[0]!
  if (identity.type !== 'dispatcher.target-prepared') throw new Error('fixture')
  check(
    [
      ...active,
      rollbackFact('dispatcher.upgrade-target-resolved', {
        run: 'restored',
        lineage: 'capture',
        target: { ...payload.target, key: 'different' },
      }),
      rollbackFact('dispatcher.upgrade-failed', {
        correlation: identity.payload.correlation,
        run: identity.payload.run,
        lineage: identity.payload.lineage,
        from: identity.payload.from,
        target: identity.payload.target,
        reason: 'incompatible',
      }),
      ...handoffEvents(row.slug, 'completed'),
    ],
    true,
  )
})

test('repository notices and cached rows have independent removal and lifecycle semantics', () => {
  const handoff = handoffEvents(row.slug)
  const current = buildDashboardFromProjected([row], header, [...active, ...handoff])
  for (const stage of ['cleared', 'restarted'] as const) {
    const next = buildDashboardFromProjected(current.builds, header, [
      ...rollbackEvents(stage),
      ...handoff,
    ])
    expect(next.rollback).toBeUndefined()
    expect(next.builds[0]?.status).toBe('running')
    expect(next.builds[0]?.draining).toBe(true)
    expect(next.handoffs).toEqual(current.handoffs)
  }
})

test('terminal list and detail wrap long rollback notices with shared height accounting', () => {
  const model = check(active, true)
  model.rollback!.failed.version = 'very-long-runtime-version-'.repeat(5)
  for (const width of [45, 60, 120]) {
    for (const detail of [false, true]) {
      model.view = detail ? { kind: 'detail', slug: row.slug, scroll: 0 } : undefined
      const lines = renderDashboard(model, { width, height: 45, color: false, now: 0 })
      const text = stripAnsi(lines.join('\n')).replace(/\s+/g, ' ')
      expect(text).toContain('rollback: failed')
      expect(text).toContain('restored 1.0.0 aaaaaaaaaaaa;')
      expect(text).toContain(ROLLBACK_AT)
      expect(lines.length).toBeLessThanOrEqual(45)
      expect(stripAnsi(lines.at(-1)!)).toContain('Keys:')
    }
  }
  for (const height of [1, 2, 3, 5, 12])
    expect(
      renderDashboard(model, { width: 45, height, color: false, now: 0 }).length,
    ).toBeLessThanOrEqual(height)
  expect(
    renderDashboard(check(rollbackEvents('cleared'), false), {
      width: 120,
      height: 36,
      color: false,
      now: 0,
    }).join('\n'),
  ).not.toContain('rollback:')
})
