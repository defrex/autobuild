import { expect, test } from 'bun:test'
import type { AbEvent } from '../events/catalog'
import { infrastructureFailureResetSeq } from './infrastructure-failure-budget'

function event(seq: number, type: string, payload: unknown): AbEvent {
  return {
    seq,
    ts: '2026-01-01T00:00:00.000Z',
    actor: { kind: 'dispatcher' },
    type,
    payload,
  } as AbEvent
}

test('infrastructure retry epochs reset only for their own retry answer or execution end', () => {
  const events = [
    event(1, 'escalation.raised', {
      id: 'setup-limit',
      phase: 'plan',
      source: 'policy',
      policyCause: 'setup-failure-limit',
      question: 'retry setup?',
    }),
    event(2, 'escalation.answered', { id: 'setup-limit', resolution: 'retry' }),
    event(3, 'escalation.raised', {
      id: 'infra-limit',
      phase: 'plan',
      source: 'policy',
      policyCause: 'infrastructure-failure-limit',
      question: 'retry infrastructure?',
    }),
    event(4, 'escalation.answered', { id: 'infra-limit', resolution: 'retry' }),
  ]
  expect(infrastructureFailureResetSeq(events.slice(0, 2))).toBe(0)
  expect(infrastructureFailureResetSeq(events)).toBe(4)
  expect(
    infrastructureFailureResetSeq([
      ...events,
      event(5, 'execution.ended', {
        instance: 'instance-1',
        workspaceRef: 'sandbox-g1',
        outcome: 'completed',
      }),
    ]),
  ).toBe(5)
})
