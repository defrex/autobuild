import { describe, expect, test } from 'bun:test'
import type { AbEvent } from '../events/catalog'
import { DISPATCHER, KERNEL, humanActor } from '../events/envelope'
import { sequentialIds } from '../ids'
import { MemoryBuildStore } from '../store/memory'
import {
  classifyInfrastructureFailure,
  infrastructureFailureResetSeq,
  recordInfrastructureFailure,
} from './infrastructure-failure-budget'

function event(seq: number, type: string, payload: unknown): AbEvent {
  return {
    build: 'budget',
    seq,
    ts: '2026-01-01T00:00:00.000Z',
    actor: DISPATCHER,
    type,
    payload,
  } as AbEvent
}

async function record(
  store: MemoryBuildStore,
  maxAttempts = 3,
  error: unknown = 'provider failed',
) {
  return recordInfrastructureFailure(
    { store, ids: sequentialIds() },
    {
      slug: 'budget',
      events: await store.getEvents('budget'),
      maxAttempts,
      provider: 'remote-test',
      workspaceRef: 'sandbox-g1',
      instance: 'instance-1',
      environmentId: 'environment-1',
      sessionId: 'session-1',
      operation: 'provision',
      error,
      cleanupPending: true,
    },
  )
}

describe('infrastructure failure epochs', () => {
  test('reset matching is chronological and limited to this policy retry or execution end', () => {
    const events = [
      event(1, 'escalation.answered', {
        id: 'raised-later',
        answer: 'retry',
        resolution: 'retry',
      }),
      event(2, 'escalation.raised', {
        id: 'raised-later',
        phase: 'setup',
        source: 'policy',
        policyCause: 'infrastructure-failure-limit',
        question: 'retry infrastructure?',
      }),
      event(3, 'escalation.raised', {
        id: 'setup-limit',
        phase: 'setup',
        source: 'policy',
        policyCause: 'setup-failure-limit',
        question: 'retry setup?',
      }),
      event(4, 'escalation.answered', {
        id: 'setup-limit',
        answer: 'retry',
        resolution: 'retry',
      }),
      event(5, 'escalation.answered', {
        id: 'raised-later',
        answer: 'retry',
        resolution: 'retry',
      }),
    ]
    expect(infrastructureFailureResetSeq(events.slice(0, 4))).toBe(0)
    expect(infrastructureFailureResetSeq(events)).toBe(5)
    expect(
      infrastructureFailureResetSeq([
        ...events,
        event(6, 'execution.ended', {
          instance: 'instance-1',
          workspaceRef: 'sandbox-g1',
          outcome: 'completed',
        }),
      ]),
    ).toBe(6)
  })

  test('unrelated retries preserve consecutive attempts and exhaustion raises once', async () => {
    const store = new MemoryBuildStore()
    await store.createBuild({ slug: 'budget', repo: '/repo' })
    await record(store)
    await store.append('budget', {
      actor: KERNEL,
      type: 'escalation.raised',
      payload: {
        id: 'setup-limit',
        phase: 'setup',
        source: 'policy',
        policyCause: 'setup-failure-limit',
        question: 'retry setup?',
      },
    })
    await store.append('budget', {
      actor: humanActor('operator'),
      type: 'escalation.answered',
      payload: { id: 'setup-limit', answer: 'retry', resolution: 'retry' },
    })
    await record(store)
    await record(store)
    await record(store)

    const events = await store.getEvents('budget')
    expect(
      events
        .filter((entry) => entry.type === 'infrastructure.failed')
        .map((entry) => entry.payload.attempt),
    ).toEqual([1, 2, 3, 4])
    expect(
      events.filter(
        (entry) =>
          entry.type === 'escalation.raised' &&
          entry.payload.policyCause === 'infrastructure-failure-limit',
      ),
    ).toHaveLength(1)
  })

  test('answering the infrastructure limit and confirmed completion each begin a new epoch', async () => {
    const store = new MemoryBuildStore()
    await store.createBuild({ slug: 'budget', repo: '/repo' })
    await record(store, 1)
    const escalation = (await store.getEvents('budget')).find(
      (entry) => entry.type === 'escalation.raised',
    )
    if (escalation?.type !== 'escalation.raised') throw new Error('missing escalation')
    await store.append('budget', {
      actor: humanActor('operator'),
      type: 'escalation.answered',
      payload: { id: escalation.payload.id, answer: 'retry', resolution: 'retry' },
    })
    await record(store, 2)
    await store.append('budget', {
      actor: DISPATCHER,
      type: 'execution.ended',
      payload: {
        instance: 'instance-1',
        workspaceRef: 'sandbox-g1',
        outcome: 'completed',
      },
    })
    await record(store, 2)

    expect(
      (await store.getEvents('budget'))
        .filter((entry) => entry.type === 'infrastructure.failed')
        .map((entry) => entry.payload.attempt),
    ).toEqual([1, 1, 1])
  })
})

test('shared cause classification covers provider limits, timeouts, missing resources, and fallbacks', () => {
  const cases = [
    ['CPU quota exceeded', false, 'provider-limit'],
    ['operation aborted by timeout', false, 'timeout'],
    ['remote environment no longer exists', true, 'missing'],
    ['sandbox not found', true, 'missing'],
    ['workspace is missing', true, 'missing'],
    ['cleanup response was malformed', true, 'unknown-outcome'],
    ['provider returned 500', false, 'provider-error'],
  ] as const
  for (const [message, cleanupPending, expected] of cases) {
    expect(classifyInfrastructureFailure(message, cleanupPending)).toBe(expected)
  }
})
