import { describe, expect, test } from 'bun:test'
import type { PolicyEscalationCause } from '../ontology'
import {
  POLICY_PHASE_FAILURE_RESET_SCOPES,
  resetsPhaseFailureBudget,
  type PhaseFailureBudgetResetScope,
  type PhaseFailureResetEscalation,
} from './phase-failure-budget'

const policyRaise = (
  policyCause: PolicyEscalationCause,
  round?: number,
): PhaseFailureResetEscalation => ({
  phase: 'reconcile',
  source: 'policy',
  policyCause,
  ...(round !== undefined ? { round } : {}),
})

describe('phase-failure budget reset semantics', () => {
  const scopes: Array<[PolicyEscalationCause, PhaseFailureBudgetResetScope]> = [
    ['review-round-limit', 'matching-round'],
    ['verify-failure-limit', 'all-phase-rounds'],
    ['reconcile-no-progress', 'none'],
    ['setup-failure-limit', 'none'],
    ['phase-attempt-limit', 'matching-round'],
    ['non-retryable-phase-failure', 'matching-round'],
  ]

  for (const [cause, scope] of scopes) {
    test(`${cause} has explicit ${scope} semantics`, () => {
      expect(POLICY_PHASE_FAILURE_RESET_SCOPES[cause]).toBe(scope)
    })
  }

  test('runner-failure causes reset only their matching round', () => {
    for (const cause of ['phase-attempt-limit', 'non-retryable-phase-failure'] as const) {
      expect(resetsPhaseFailureBudget(policyRaise(cause, 4), 'reconcile', 4)).toBe(true)
      expect(resetsPhaseFailureBudget(policyRaise(cause, 4), 'reconcile', 5)).toBe(false)
      expect(resetsPhaseFailureBudget(policyRaise(cause), 'reconcile', 4)).toBe(false)
    }
  })

  test('the phase-wide verify policy cause resets every round for its phase', () => {
    const raise = {
      phase: 'verify:e2e',
      source: 'policy',
      policyCause: 'verify-failure-limit',
    } as const
    expect(resetsPhaseFailureBudget(raise, 'verify:e2e', 1)).toBe(true)
    expect(resetsPhaseFailureBudget(raise, 'verify:e2e', 7)).toBe(true)
    expect(resetsPhaseFailureBudget(raise, 'verify:unit', 1)).toBe(false)
  })

  test('no-reset policy causes never affect a phase runner budget', () => {
    expect(resetsPhaseFailureBudget(policyRaise('reconcile-no-progress'), 'reconcile', 4)).toBe(
      false,
    )
    expect(resetsPhaseFailureBudget(policyRaise('setup-failure-limit'), 'reconcile', 4)).toBe(false)
  })

  test('the round-scoped review policy retains its matching-round behavior', () => {
    const raise = {
      phase: 'code-review',
      round: 6,
      source: 'policy',
      policyCause: 'review-round-limit',
    } as const
    expect(resetsPhaseFailureBudget(raise, 'code-review', 6)).toBe(true)
    expect(resetsPhaseFailureBudget(raise, 'code-review', 7)).toBe(false)
  })

  test('cause-less historical and non-policy raises retain the legacy shape rule', () => {
    const historicalPolicy = { phase: 'reconcile', source: 'policy' } as const
    expect(resetsPhaseFailureBudget(historicalPolicy, 'reconcile', 4)).toBe(true)

    const historicalRound = { ...historicalPolicy, round: 4 }
    expect(resetsPhaseFailureBudget(historicalRound, 'reconcile', 4)).toBe(true)
    expect(resetsPhaseFailureBudget(historicalRound, 'reconcile', 5)).toBe(false)

    const agentRaise = { phase: 'reconcile', source: 'agent' } as const
    expect(resetsPhaseFailureBudget(agentRaise, 'reconcile', 4)).toBe(true)
    expect(resetsPhaseFailureBudget(agentRaise, 'plan', 4)).toBe(false)
  })
})
