import { expect, test } from 'bun:test'
import type { AbEvent } from '../events/catalog'
import { reduceBuild } from './reducer'
import {
  advancePollingActivity,
  nodeActivityKey,
  nodePollingSchedule,
  nodePollingCheckpointRequired,
} from './node-polling'

const policy = { nodeIdleAfterSeconds: 600, nodeIdlePollSeconds: 120 }
const start = Date.parse('2026-10-22T12:00:00Z')
const at = (seconds: number) => new Date(start + seconds * 1000)
function node() {
  return {
    ...reduceBuild([]),
    kind: 'node' as const,
    status: 'running' as const,
    nodeOpened: { sha: 'head' },
    nodeComparison: { headSha: 'head', parentSha: 'parent', ahead: 0 },
    pollingActivity: { 'build.created': '1' },
  }
}
function checked() {
  const state = node()
  return {
    ...state,
    nodePolling: {
      ...policy,
      activityKey: nodeActivityKey(state, []),
      checkedAt: at(590).toISOString(),
      unchangedSince: at(0).toISOString(),
    },
  }
}

test('unknown evidence, quiet threshold, deadline, policy revisions and clock anomalies', () => {
  const state = checked()
  const key = nodeActivityKey(state, [])
  expect(nodePollingSchedule(node(), key, policy, at(700)).due).toBe(true)
  expect(nodePollingSchedule(state, key, policy, at(599)).mode).toBe('active')
  expect(nodePollingSchedule(state, key, policy, at(600))).toMatchObject({
    mode: 'idle',
    due: false,
  })
  expect(nodePollingSchedule(state, key, policy, at(709)).due).toBe(false)
  expect(nodePollingSchedule(state, key, policy, at(710)).due).toBe(true)
  expect(
    nodePollingSchedule(state, key, { ...policy, nodeIdlePollSeconds: 60 }, at(600)).mode,
  ).toBe('active')
  expect(nodePollingSchedule(state, key, policy, at(-1)).due).toBe(true)
  expect(nodePollingSchedule(state, key, policy, new Date(NaN)).due).toBe(true)
  expect(nodePollingSchedule(structuredClone(state), key, policy, at(600)).mode).toBe('idle')
})

for (const type of [
  'build.land-requested',
  'build.hold-requested',
  'node.restack-requested',
  'escalation.answered',
  'pr.opened',
  'pr.merged',
]) {
  test(`${type} wakes a node directly and through a child, including repeated values`, () => {
    const state = checked()
    const child = node()
    const beforeChild = nodeActivityKey(state, [{ slug: 'child', state: child }])
    const key = nodeActivityKey(state, [])
    const event = { type, seq: 100, payload: {} } as AbEvent
    advancePollingActivity(state.pollingActivity, event)
    expect(nodePollingSchedule(state, nodeActivityKey(state, []), policy, at(600)).mode).toBe(
      'active',
    )
    expect(nodeActivityKey(state, [])).not.toBe(key)
    advancePollingActivity(child.pollingActivity, event)
    expect(nodeActivityKey(checked(), [{ slug: 'child', state: child }])).not.toBe(beforeChild)
    const repeated = nodeActivityKey(state, [])
    advancePollingActivity(state.pollingActivity, { ...event, seq: 101 })
    expect(nodeActivityKey(state, [])).not.toBe(repeated)
  })
}

test('membership wakes; checkpoint and identical observations do not', () => {
  const state = checked()
  expect(nodeActivityKey(state, [{ slug: 'new-claim', state: node() }])).not.toBe(
    nodeActivityKey(state, []),
  )
  const event = {
    type: 'node.compared',
    seq: 10,
    payload: { headSha: 'head', parentSha: 'parent', ahead: 0 },
  } as AbEvent
  advancePollingActivity(state.pollingActivity, event)
  const key = nodeActivityKey(state, [])
  advancePollingActivity(state.pollingActivity, { ...event, seq: 11 })
  advancePollingActivity(state.pollingActivity, {
    type: 'node.poll-checked',
    seq: 12,
    payload: {},
  } as AbEvent)
  expect(nodeActivityKey(state, [])).toBe(key)
  advancePollingActivity(state.pollingActivity, {
    ...event,
    seq: 13,
    payload: { headSha: 'changed', parentSha: 'parent', ahead: 1 },
  } as AbEvent)
  expect(nodeActivityKey(state, [])).not.toBe(key)
})

test('native operations bypass idle, holds and awaiting consent qualify', () => {
  const state = checked()
  const key = nodeActivityKey(state, [])
  expect(
    nodePollingSchedule(
      { ...state, landing: { command: { kind: 'hold', seq: 2 }, acknowledgedSeq: 2 } },
      key,
      policy,
      at(600),
    ).mode,
  ).toBe('idle')
  expect(
    nodePollingSchedule({ ...state, landing: { nativeEnablePending: 2 } }, key, policy, at(600))
      .due,
  ).toBe(true)
})

test('ticket observation key ignores build phases but wakes for claims, PRs and operator demand', async () => {
  const { nodeTicketObservationKey } = await import('./node-polling')
  const parent = node()
  const child = node()
  const children = [{ slug: 'child', state: child }]
  const key = nodeTicketObservationKey(parent, children)
  for (const type of [
    'plan.started',
    'plan.completed',
    'plan-review.started',
    'implement.started',
    'verify.started',
  ]) {
    advancePollingActivity(child.pollingActivity, { type, seq: 10, payload: {} } as AbEvent)
    expect(nodeTicketObservationKey(parent, children)).toBe(key)
  }
  expect(nodeTicketObservationKey(parent, [])).not.toBe(key)
  for (const type of [
    'pr.opened',
    'finalize.completed',
    'pr.merged',
    'pr.closed',
    'build.completed',
  ]) {
    const before = nodeTicketObservationKey(parent, children)
    advancePollingActivity(child.pollingActivity, { type, seq: 20, payload: {} } as AbEvent)
    expect(nodeTicketObservationKey(parent, children)).not.toBe(before)
  }
  for (const type of [
    'build.land-requested',
    'build.hold-requested',
    'node.restack-requested',
    'escalation.answered',
  ]) {
    const before = nodeTicketObservationKey(parent, children)
    advancePollingActivity(parent.pollingActivity, { type, seq: 30, payload: {} } as AbEvent)
    expect(nodeTicketObservationKey(parent, children)).not.toBe(before)
  }
})

test('checkpoint growth follows epochs and idle deadlines, including invalid evidence', () => {
  const state = checked()
  state.nodePolling.checkedAt = at(0).toISOString()
  const key = nodeActivityKey(state, [])
  for (let second = 0; second < 600; second += 10)
    expect(nodePollingCheckpointRequired(state, key, policy, at(second))).toBe(false)
  expect(nodePollingCheckpointRequired(state, key, policy, at(600))).toBe(true)
  state.nodePolling.checkedAt = at(600).toISOString()
  expect(nodePollingCheckpointRequired(state, key, policy, at(719))).toBe(false)
  expect(nodePollingCheckpointRequired(state, key, policy, at(720))).toBe(true)
  expect(nodePollingCheckpointRequired(state, 'changed', policy, at(610))).toBe(true)
  expect(
    nodePollingCheckpointRequired(state, key, { ...policy, nodeIdleAfterSeconds: 900 }, at(610)),
  ).toBe(true)
  for (const value of ['invalid', at(800).toISOString()]) {
    state.nodePolling.checkedAt = value
    expect(nodePollingCheckpointRequired(state, key, policy, at(610))).toBe(true)
    expect(nodePollingSchedule(state, key, policy, at(610)).due).toBe(true)
  }
})

test('dispatcher anchors survive a lagging store clock without accepting future evidence', () => {
  const state = checked()
  const key = nodeActivityKey(state, [])
  state.nodePolling.checkedAt = at(-0.2).toISOString()
  expect(nodePollingCheckpointRequired(state, key, policy, at(10))).toBe(false)
  expect(nodePollingSchedule(state, key, policy, at(600))).toMatchObject({
    mode: 'idle',
    due: true,
  })
  expect(nodePollingCheckpointRequired(state, key, policy, at(600))).toBe(true)
  state.nodePolling.checkedAt = at(599.8).toISOString()
  expect(nodePollingSchedule(state, key, policy, at(719))).toMatchObject({
    mode: 'idle',
    due: false,
  })
  expect(nodePollingCheckpointRequired(state, key, policy, at(720))).toBe(true)
  for (const value of ['invalid', at(800).toISOString()]) {
    state.nodePolling.unchangedSince = value
    expect(nodePollingSchedule(state, key, policy, at(610)).mode).toBe('active')
    expect(nodePollingCheckpointRequired(state, key, policy, at(610))).toBe(true)
  }
})
