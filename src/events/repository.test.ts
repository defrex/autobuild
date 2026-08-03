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
  test('harvest start accepts durable trigger provenance and historical omission', () => {
    const base = {
      run: 'h_1',
      observations: [{ build: 'a', seq: 1 }],
      scan: { kind: 'harvest-scan', rev: 0 },
    }
    for (const trigger of ['count', 'drift', 'both'] as const) {
      expect(
        validateRepositoryEventWrite({
          actor: KERNEL,
          type: 'harvest.started',
          payload: { ...base, trigger },
        }).payload,
      ).toEqual({ ...base, trigger })
    }
    expect(
      validateRepositoryEventWrite({
        actor: KERNEL,
        type: 'harvest.started',
        payload: base,
      }).payload,
    ).toEqual(base)
    expect(() =>
      validateRepositoryEventWrite({
        actor: KERNEL,
        type: 'harvest.started',
        payload: { ...base, trigger: 'age' },
      }),
    ).toThrow(/invalid payload/)
  })

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

  test('config reload facts are dispatcher-only and strict', () => {
    const payload = {
      artifact: { kind: 'dispatcher-config', rev: 2 },
      restartRequired: ['forge', 'tickets.source'] as Array<'forge' | 'tickets.source'>,
      effectiveChanged: true,
    }
    expect(
      validateRepositoryEventWrite({
        actor: DISPATCHER,
        type: 'dispatcher.config-reloaded',
        payload,
      }),
    ).toEqual({ actor: DISPATCHER, type: 'dispatcher.config-reloaded', payload })

    for (const actor of [KERNEL, humanActor('operator'), agentActor('harvest', 'hs_1')]) {
      expect(() =>
        validateRepositoryEventWrite({
          actor,
          type: 'dispatcher.config-reloaded',
          payload,
        }),
      ).toThrow(/may not emit/)
    }
    for (const badPayload of [
      { ...payload, extra: true },
      { ...payload, restartRequired: ['unknown'] },
      { ...payload, restartRequired: ['forge', 'forge'] },
    ]) {
      expect(() =>
        validateRepositoryEventWrite({
          actor: DISPATCHER,
          type: 'dispatcher.config-reloaded',
          payload: badPayload,
        }),
      ).toThrow(/invalid payload/)
    }
  })

  test('dispatch status facts are run-correlated, strict, and dispatcher-owned', () => {
    const payload = {
      run: 'dispatch-1',
      pid: 123,
      effectiveConfig: { kind: 'dispatcher-effective-config', rev: 0 },
      roleWarnings: ['roles.old is not consumed'],
    }
    expect(
      validateRepositoryEventWrite({
        actor: DISPATCHER,
        type: 'dispatcher.run-started',
        payload,
      }),
    ).toEqual({ actor: DISPATCHER, type: 'dispatcher.run-started', payload })
    expect(() =>
      validateRepositoryEventWrite({
        actor: humanActor('operator'),
        type: 'dispatcher.run-started',
        payload,
      }),
    ).toThrow(/may not emit/)
    for (const bad of [
      { ...payload, run: '' },
      { ...payload, extra: true },
    ]) {
      expect(() =>
        validateRepositoryEventWrite({
          actor: DISPATCHER,
          type: 'dispatcher.run-started',
          payload: bad,
        }),
      ).toThrow(/invalid payload/)
    }

    const upgrade = { run: 'dispatch-1', version: '0.5.0' }
    expect(
      validateRepositoryEventWrite({
        actor: DISPATCHER,
        type: 'dispatcher.upgrade-available',
        payload: upgrade,
      }),
    ).toEqual({ actor: DISPATCHER, type: 'dispatcher.upgrade-available', payload: upgrade })
    expect(() =>
      validateRepositoryEventWrite({
        actor: humanActor('operator'),
        type: 'dispatcher.upgrade-available',
        payload: upgrade,
      }),
    ).toThrow(/may not emit/)
    expect(() =>
      validateRepositoryEventWrite({
        actor: DISPATCHER,
        type: 'dispatcher.upgrade-available',
        payload: { ...upgrade, extra: true },
      }),
    ).toThrow(/invalid payload/)
  })

  test('dispatcher setting facts require strict booleans and human actors', () => {
    for (const type of [
      'dispatcher.intake-set',
      'dispatcher.pause-set',
      'dispatcher.auto-merge-default-set',
    ] as const) {
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
