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
