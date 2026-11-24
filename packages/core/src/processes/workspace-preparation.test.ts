import { expect, test } from 'bun:test'
import type { Decision } from '../kernel/engine'
import { decisionUsesWorkspace, preparationStale } from './workspace-preparation'

const check = { kind: 'run-check', step: 'unit', command: 'test', attempt: 1 } as Decision

test('decisions that run against the tree use the workspace; reconcile and bookkeeping do not', () => {
  const uses: Decision[] = [
    check,
    { kind: 'run-verify-stage', members: [] },
    { kind: 'run-agent-verify', step: 'review', skill: 'x', attempt: 1 },
    { kind: 'evaluate-verify', step: 'unit', attempt: 1, paths: [], action: check } as Decision,
    { kind: 'run-finalize-step', step: 'pr', action: { kind: 'check', command: 'true' } },
    { kind: 'run-phase', phase: 'implement', round: 1 },
    { kind: 'run-phase', phase: 'code-review', round: 1 },
    { kind: 'run-measurement' } as Decision,
  ]
  const skips: Decision[] = [
    { kind: 'run-phase', phase: 'reconcile', round: 1, reconcile: { attempt: 1 } },
    { kind: 'restack', trigger: 'verify-entry', cycle: 1 },
    { kind: 'wait', reason: 'blocked' },
    { kind: 'acknowledge', command: 'pause' },
    { kind: 'skip-verify', step: 'unit', attempt: 1, reason: 'paths' },
  ]
  expect(uses.map(decisionUsesWorkspace)).toEqual(uses.map(() => true))
  expect(skips.map(decisionUsesWorkspace)).toEqual(skips.map(() => false))
})

test('preparation is stale only after this process prepared a base that has since moved', () => {
  expect(preparationStale(undefined, 'b', check)).toBe(false)
  expect(preparationStale({ base: 'a' }, 'a', check)).toBe(false)
  expect(preparationStale({ base: undefined }, undefined, check)).toBe(false)
  expect(preparationStale({ base: 'a' }, 'b', check)).toBe(true)
  expect(preparationStale({ base: undefined }, 'b', check)).toBe(true)
  expect(
    preparationStale({ base: 'a' }, 'b', { kind: 'restack', trigger: 'verify-entry', cycle: 1 }),
  ).toBe(false)
})
