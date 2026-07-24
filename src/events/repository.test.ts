import { describe, expect, test } from 'bun:test'
import { EventValidationError } from './catalog'
import { DISPATCHER, KERNEL, agentActor, humanActor } from './envelope'
import { isHarvestEvent, validateRepositoryEventWrite, type RepositoryEvent } from './repository'

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

describe('repository event catalog', () => {
  test('harvest automatic request and exhaustion facts are kernel-only', () => {
    expect(
      validateRepositoryEventWrite({
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
      validateRepositoryEventWrite({
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
        validateRepositoryEventWrite({
          actor,
          type: 'harvest.recovery-requested',
          payload: request,
        }),
      ).toThrow(EventValidationError)
      expect(() =>
        validateRepositoryEventWrite({
          actor,
          type: 'harvest.recovery-exhausted',
          payload: exhausted,
        }),
      ).toThrow(EventValidationError)
    }
  })

  test('harvest recovery payloads reject invalid budgets and malformed pending descriptors', () => {
    expect(() =>
      validateRepositoryEventWrite({
        actor: KERNEL,
        type: 'harvest.recovery-requested',
        payload: { ...request, attempt: 0 },
      }),
    ).toThrow(/invalid payload/)
    expect(() =>
      validateRepositoryEventWrite({
        actor: KERNEL,
        type: 'harvest.recovery-exhausted',
        payload: {
          ...exhausted,
          pendingProposals: [{ proposalKey: '', action: 'create', observations: [] }],
        },
      }),
    ).toThrow(/invalid payload/)
  })

  test('dispatcher setting facts require strict booleans and human actors', () => {
    for (const type of ['dispatcher.intake-set', 'dispatcher.auto-merge-default-set'] as const) {
      expect(
        validateRepositoryEventWrite({
          actor: humanActor('operator'),
          type,
          payload: { enabled: true },
        }),
      ).toEqual({
        actor: humanActor('operator'),
        type,
        payload: { enabled: true },
      })

      for (const actor of [KERNEL, DISPATCHER, agentActor('harvest', 'hs_1')]) {
        expect(() =>
          validateRepositoryEventWrite({
            actor,
            type,
            payload: { enabled: false },
          }),
        ).toThrow(/may not emit/)
      }
      for (const payload of [
        { enabled: 'true' },
        { enabled: 1 },
        {},
        { enabled: true, stale: false },
      ]) {
        expect(() =>
          validateRepositoryEventWrite({
            actor: humanActor('operator'),
            type,
            payload,
          }),
        ).toThrow(/invalid payload/)
      }
    }
  })

  test('rejects unknown repository facts and identifies the harvest subset', () => {
    expect(() =>
      validateRepositoryEventWrite({
        actor: humanActor('operator'),
        type: 'dispatcher.unknown-set',
        payload: { enabled: true },
      }),
    ).toThrow(/unknown repository event type/)

    const events: RepositoryEvent[] = [
      {
        repo: 'acme/repo',
        seq: 1,
        ts: '2026-07-20T00:00:00.000Z',
        actor: humanActor('operator'),
        type: 'dispatcher.intake-set',
        payload: { enabled: false },
      },
      {
        repo: 'acme/repo',
        seq: 2,
        ts: '2026-07-20T00:00:01.000Z',
        actor: humanActor('operator'),
        type: 'harvest.pause-requested',
        payload: {},
      },
    ]
    expect(events.filter(isHarvestEvent).map((event) => event.type)).toEqual([
      'harvest.pause-requested',
    ])
  })
})
