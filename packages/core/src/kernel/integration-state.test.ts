import { expect, test } from 'bun:test'
import { parseConfig } from '../config/load'
import { decideNextFromFacts } from './engine'
import { indexLog } from './log-index'
import { reduceBuild } from './reducer'
import {
  integrationConfig,
  integrationCurrent,
  integrationVerified,
  integrationNeedsRunner,
} from './integration-state'

const config = parseConfig(`
[tickets]
source = "file"
readyState = "Ready"
[commands]
test = "true"
[verify]
steps = ["unit", "agent"]
[verify.unit]
kind = "check"
command = "test"
[verify.agent]
kind = "agent"
skill = "verify-feature"
`)
function prepared() {
  const state = reduceBuild([])
  state.kind = 'node'
  state.status = 'collecting'
  state.nodeOpened = { sha: 'parent' }
  state.nodeComparison = { parentSha: 'parent', headSha: 'head', ahead: 1 }
  state.nodeRestack = { items: [], contributionBase: 'parent' }
  state.integration = {
    observation: { openChildren: [], diagnostics: [], contributions: ['child'] },
    cycle: {
      id: 'cycle',
      head: 'head',
      parent: 'parent',
      config: integrationConfig(config),
      seq: 1,
    },
  }
  return state
}
test('integration routing requires a prepared exact current cycle and never enters producers', () => {
  const state = prepared()
  expect(decideNextFromFacts(state, indexLog([]), config)).toEqual({
    kind: 'run-check',
    step: 'unit',
    command: 'true',
    attempt: 1,
  })
  expect(integrationNeedsRunner(state)).toBe(true)
  state.nodeComparison!.headSha = 'new-head'
  expect(integrationCurrent(state)).toBe(false)
  expect(decideNextFromFacts(state, indexLog([]), config)).toEqual({
    kind: 'wait',
    reason: 'awaiting-pr',
  })
})
test('parent movement, reopened children and configuration changes invalidate verification', () => {
  for (const mutate of [
    (state: ReturnType<typeof prepared>) => {
      state.nodeRestack!.observedParent = { branch: 'main', sha: 'new-parent' }
    },
    (state: ReturnType<typeof prepared>) => {
      state.integration!.observation!.openChildren = ['REOPENED']
    },
    (state: ReturnType<typeof prepared>) => {
      state.integration!.cycle!.config = 'old configuration'
    },
  ]) {
    const state = prepared()
    mutate(state)
    expect(integrationVerified(state, config)).toBe(false)
    expect(decideNextFromFacts(state, indexLog([]), config)).toEqual({
      kind: 'wait',
      reason: 'awaiting-pr',
    })
  }
})
test('only matching successful cycle receipts satisfy every configured step', () => {
  const state = prepared()
  for (const step of config.verify.steps)
    state.verify.results.push({
      step,
      seq: 2,
      attempt: 1,
      outcome: 'pass',
      headSha: 'head',
      baseSha: 'parent',
      restackId: 'old-cycle',
    })
  expect(integrationVerified(state, config)).toBe(false)
  for (const result of state.verify.results) result.restackId = 'cycle'
  expect(integrationVerified(state, config)).toBe(true)
  expect(integrationNeedsRunner(state)).toBe(false)
})
test('failed integration checks park for repair rather than implementation', () => {
  const state = prepared()
  state.verify.results.push({
    step: 'unit',
    seq: 2,
    attempt: 1,
    outcome: 'fail',
    headSha: 'head',
    baseSha: 'parent',
    restackId: 'cycle',
  })
  expect(decideNextFromFacts(state, indexLog([]), config)).toEqual({
    kind: 'wait',
    reason: 'blocked',
  })
  expect(integrationNeedsRunner(state)).toBe(false)
})

test('a new cycle with identical SHAs cannot borrow historical verification', () => {
  const state = prepared()
  for (const step of config.verify.steps)
    state.verify.results.push({
      step,
      seq: 2,
      attempt: 1,
      outcome: 'pass',
      headSha: 'head',
      baseSha: 'parent',
      restackId: 'cycle',
    })
  expect(integrationNeedsRunner(state)).toBe(false)
  state.integration!.cycles = [state.integration!.cycle!]
  state.integration!.cycle = { ...state.integration!.cycle!, id: 'new-parent-cycle', seq: 3 }
  expect(integrationNeedsRunner(state)).toBe(true)
  expect(integrationVerified(state, config)).toBe(false)
})

test('spec boundary invalidates same-head failure and success without erasing audit evidence', async () => {
  const { integrationFailed, integrationHeadVerified, integrationCycleVerified } = await import(
    './integration-state'
  )
  for (const outcome of ['fail', 'pass'] as const) {
    const state = prepared()
    for (const step of config.verify.steps)
      state.verify.results.push({
        step,
        seq: 2,
        attempt: 1,
        outcome,
        headSha: 'head',
        baseSha: 'parent',
        restackId: 'cycle',
      })
    expect(integrationFailed(state)).toBe(outcome === 'fail')
    expect(integrationCycleVerified(state)).toBe(outcome === 'pass')
    state.restartSince = 3
    expect(integrationCurrent(state)).toBe(false)
    expect(integrationFailed(state)).toBe(false)
    expect(integrationCycleVerified(state)).toBe(false)
    expect(integrationHeadVerified(state, 'head')).toBe(outcome === 'pass')
    state.integration!.cycles = [state.integration!.cycle!]
    state.integration!.cycle = { ...state.integration!.cycle!, seq: 4, id: 'revised-cycle' }
    expect(integrationNeedsRunner(state)).toBe(true)
    expect(decideNextFromFacts(state, indexLog([]), config).kind).toBe('run-check')
  }
})

test('a node spec revision immediately withdraws passed-cycle landing readiness and command admission', async () => {
  const { landingReady, landPreconditions } = await import('./landing-readiness')
  const state = prepared()
  state.prState = 'open'
  state.landing = {
    decision: {
      seq: 3,
      candidate: { head: 'head', parent: 'parent', cycle: 'cycle' },
      from: 'node',
      into: { kind: 'root' },
      labels: [],
      mode: 'consent',
      rule: { default: true },
    },
  }
  for (const step of config.verify.steps)
    state.verify.results.push({
      step,
      seq: 2,
      attempt: 1,
      outcome: 'pass',
      headSha: 'head',
      baseSha: 'parent',
      restackId: 'cycle',
    })
  expect(landingReady(state, indexLog([]).restack)).toBe(true)
  expect(landPreconditions(state, indexLog([]).restack)).toBe(true)
  state.restartSince = 4
  expect(landingReady(state, indexLog([]).restack)).toBe(false)
  expect(landPreconditions(state, indexLog([]).restack)).toBe(false)
})

test('integration stages hold failure attention until every exact-cycle member settles', () => {
  const grouped = { ...config, verify: { ...config.verify, stages: [['unit', 'agent']] } }
  const state = prepared()
  state.integration!.cycle!.config = integrationConfig(grouped)
  const result = {
    seq: 3,
    step: 'unit',
    attempt: 1,
    outcome: 'fail' as const,
    restackId: 'cycle',
    headSha: 'head',
    baseSha: 'parent',
  }
  state.verify.results.push(result)
  const log = { ...indexLog([]), verifyCompleted: [result], maxVerifyAttemptEver: 1 }
  const next = decideNextFromFacts(state, log, grouped)
  expect(next.kind).toBe('run-verify-stage')
  if (next.kind === 'run-verify-stage') expect(next.members.map((m) => m.step)).toEqual(['agent'])
  const settled = { ...result, seq: 4, step: 'agent', outcome: 'pass' as const }
  state.verify.results.push(settled)
  expect(
    decideNextFromFacts(state, { ...log, verifyCompleted: [result, settled] }, grouped).kind,
  ).toBe('record-verify-stage-failure')
  const foreign = { ...settled, restackId: 'foreign' }
  expect(
    decideNextFromFacts(state, { ...log, verifyCompleted: [result, foreign] }, grouped).kind,
  ).toBe('run-verify-stage')
})
