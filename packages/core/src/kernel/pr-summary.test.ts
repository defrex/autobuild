import { describe, expect, test } from 'bun:test'
import type { Decision } from './engine'
import { continuesVerifyCycle } from './pr-summary'

const verifyStarted = [{ seq: 10 }, { seq: 14 }]
const boundary = { occurrence: 14 }

describe('continuesVerifyCycle', () => {
  test('a verify-step occurrence followed by more of the same cycle defers', () => {
    const continuations: Decision[] = [
      { kind: 'run-check', step: 'unit', command: 'bun test', attempt: 1 },
      { kind: 'run-agent-verify', step: 'e2e', skill: 'verify-e2e', attempt: 1 },
      {
        kind: 'evaluate-verify',
        step: 'ui',
        attempt: 1,
        paths: ['src/**'],
        action: { kind: 'run-check', step: 'ui', command: 'true', attempt: 1 },
      },
      { kind: 'skip-verify', step: 'ui', attempt: 1, reason: 'no matching paths' },
      { kind: 'run-verify-stage', members: [] },
      { kind: 'cancel-verify-stage', steps: ['b'], cause: 'a failed', attempt: 1 },
      {
        kind: 'record-verify-stage-failure',
        failure: {} as Extract<Decision, { kind: 'record-verify-stage-failure' }>['failure'],
      },
    ]
    for (const next of continuations)
      expect(continuesVerifyCycle(boundary, verifyStarted, next)).toBe(true)
  })

  test('the end of a cycle, a non-verify occurrence, or no boundary publishes', () => {
    const run: Decision = { kind: 'run-check', step: 'unit', command: 'bun test', attempt: 1 }
    const ends: Decision[] = [
      { kind: 'run-phase', phase: 'implement', round: 2 },
      { kind: 'run-phase', phase: 'finalize', round: 1 },
      { kind: 'wait', reason: 'awaiting-pr' },
      { kind: 'acknowledge', command: 'pause' },
      {
        kind: 'raise-escalation',
        source: 'policy',
        question: 'budget exhausted',
      } as unknown as Decision,
    ]
    for (const next of ends) expect(continuesVerifyCycle(boundary, verifyStarted, next)).toBe(false)
    // A code-review occurrence is not a verify step: its boundary publishes.
    expect(continuesVerifyCycle({ occurrence: 12 }, verifyStarted, run)).toBe(false)
    expect(continuesVerifyCycle(undefined, verifyStarted, run)).toBe(false)
  })
})
