import { describe, expect, test } from 'bun:test'
import { EventValidationError } from './catalog'
import { DISPATCHER, KERNEL, humanActor } from './envelope'
import { validateHarvestEventWrite } from './harvest'

const request = {
  run: 'h_1',
  attempt: 1,
  limit: 2,
}

const exhausted = {
  run: 'h_1',
  step: 'file' as const,
  error: 'ticket provider unavailable',
  attempts: 2,
  limit: 2,
  releasedObservations: [{ build: 'a', seq: 1 }],
  committedDispositions: [],
  pendingProposals: [
    {
      proposalKey: 'cluster-a',
      action: 'create' as const,
      observations: [{ build: 'a', seq: 1 }],
    },
  ],
}

describe('harvest recovery event catalog', () => {
  test('automatic request and exhaustion facts are kernel-only', () => {
    expect(
      validateHarvestEventWrite({
        actor: KERNEL,
        type: 'harvest.recovery-requested',
        payload: request,
      }),
    ).toEqual({
      actor: KERNEL,
      type: 'harvest.recovery-requested',
      payload: request,
    })
    expect(
      validateHarvestEventWrite({
        actor: KERNEL,
        type: 'harvest.recovery-exhausted',
        payload: exhausted,
      }),
    ).toEqual({
      actor: KERNEL,
      type: 'harvest.recovery-exhausted',
      payload: exhausted,
    })

    for (const actor of [DISPATCHER, humanActor('operator')]) {
      expect(() =>
        validateHarvestEventWrite({
          actor,
          type: 'harvest.recovery-requested',
          payload: request,
        }),
      ).toThrow(EventValidationError)
      expect(() =>
        validateHarvestEventWrite({
          actor,
          type: 'harvest.recovery-exhausted',
          payload: exhausted,
        }),
      ).toThrow(EventValidationError)
    }
  })

  test('recovery payloads reject invalid budgets and malformed pending descriptors', () => {
    expect(() =>
      validateHarvestEventWrite({
        actor: KERNEL,
        type: 'harvest.recovery-requested',
        payload: { ...request, attempt: 0 },
      }),
    ).toThrow(/invalid payload/)
    expect(() =>
      validateHarvestEventWrite({
        actor: KERNEL,
        type: 'harvest.recovery-exhausted',
        payload: {
          ...exhausted,
          pendingProposals: [
            { proposalKey: '', action: 'create', observations: [] },
          ],
        },
      }),
    ).toThrow(/invalid payload/)
  })
})
