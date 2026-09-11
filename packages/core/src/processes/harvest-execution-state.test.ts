import { describe, expect, test } from 'bun:test'
import { KERNEL } from '../events/envelope'
import type { RepositoryEvent } from '../events/repository'
import { classifyHarvestOutcome, openHarvestExecutions } from './harvest-execution-state'

const REPO = 'https://github.com/acme/app.git'

let seq = 0
function repoEvent<T extends RepositoryEvent['type']>(
  type: T,
  payload: Extract<RepositoryEvent, { type: T }>['payload'],
): RepositoryEvent {
  seq += 1
  return {
    repo: REPO,
    seq,
    ts: new Date(2026, 8, 10, 12, 0, seq).toISOString(),
    actor: KERNEL,
    type,
    payload,
  } as RepositoryEvent
}

function startedRun(
  run: string,
  over: Partial<Extract<RepositoryEvent, { type: 'harvest.started' }>['payload']> = {},
): RepositoryEvent {
  return repoEvent('harvest.started', {
    run,
    observations: [{ build: 'b1', seq: 1 }],
    scan: { kind: 'harvest-scan', rev: 0 },
    ...over,
  })
}

function executionStarted(execution: string): RepositoryEvent {
  return repoEvent('harvest.execution.started', {
    execution,
    provider: 'vercel-sandbox',
    environmentId: 'autobuild-harvest-abc1234567',
    commandId: 'cmd-1',
  })
}

describe('harvest execution journal projection', () => {
  test('openHarvestExecutions pairs started and released facts', () => {
    const events = [
      executionStarted('e1'),
      repoEvent('harvest.execution.released', {
        execution: 'e1',
        environmentId: 'autobuild-harvest-abc1234567',
        snapshots: { outcome: 'confirmed', deleted: 1 },
      }),
      executionStarted('e2'),
      executionStarted('e3'),
    ]
    expect(openHarvestExecutions(events).map((entry) => entry.execution)).toEqual(['e2', 'e3'])
    expect(openHarvestExecutions([])).toEqual([])
  })
})

describe('hosted harvest outcome classification', () => {
  /** The adopted holder is constant; the execution's journal seq is always
   * read back from the fixture events. */
  const input = (events: RepositoryEvent[], leaseHolder?: string) => ({
    executionStartedSeq: events.find((event) => event.type === 'harvest.execution.started')!.seq,
    adoptedHolder: 'host-dispatch-i0',
    ...(leaseHolder !== undefined ? { leaseHolder } : {}),
  })

  test('a run started by this execution with a terminal fact maps to that outcome, attributed started', () => {
    const events = [
      executionStarted('e1'),
      startedRun('h_1'),
      repoEvent('harvest.completed', {
        run: 'h_1',
        dispositions: [
          {
            occurrence: { build: 'b1', seq: 1 },
            action: 'suppressed',
            proposalKey: 'k',
            reason: 'r',
          },
        ],
        report: { kind: 'harvest-report', rev: 0 },
      }),
    ]
    expect(classifyHarvestOutcome(events, input(events))).toEqual({
      outcome: 'completed',
      launch: 'started',
      run: 'h_1',
    })
  })

  test('escalated and unresolved-failed runs classify with launch attribution', () => {
    const escalated = [
      executionStarted('e1'),
      startedRun('h_1'),
      repoEvent('harvest.escalated', {
        run: 'h_1',
        source: 'stall',
        reason: 'chain persisted',
        observations: [{ build: 'b1', seq: 1 }],
      }),
    ]
    expect(classifyHarvestOutcome(escalated, input(escalated))).toEqual({
      outcome: 'escalated',
      launch: 'started',
      run: 'h_1',
    })

    const failed = [
      executionStarted('e1'),
      startedRun('h_1'),
      repoEvent('harvest.failed', {
        run: 'h_1',
        step: 'synthesize',
        attempt: 1,
        error: 'no-terminal',
        willRetry: false,
      }),
    ]
    expect(classifyHarvestOutcome(failed, input(failed))).toEqual({
      outcome: 'failed',
      launch: 'started',
      run: 'h_1',
    })
  })

  test('a terminal fact predating this execution is not re-reported', () => {
    const completed = [
      startedRun('h_old'),
      repoEvent('harvest.completed', {
        run: 'h_old',
        dispositions: [
          {
            occurrence: { build: 'b1', seq: 1 },
            action: 'suppressed',
            proposalKey: 'k',
            reason: 'r',
          },
        ],
        report: { kind: 'harvest-report', rev: 0 },
      }),
      executionStarted('e1'),
    ]
    // The run started AND terminated before this execution: the producing
    // execution already counted and announced it, so this one is idle.
    expect(classifyHarvestOutcome(completed, input(completed, 'host-dispatch-i0'))).toEqual({
      outcome: 'idle',
    })

    const escalated = [
      startedRun('h_old'),
      repoEvent('harvest.escalated', {
        run: 'h_old',
        source: 'stall',
        reason: 'chain persisted',
        observations: [{ build: 'b1', seq: 1 }],
      }),
      executionStarted('e1'),
    ]
    expect(classifyHarvestOutcome(escalated, input(escalated, 'host-dispatch-i0'))).toEqual({
      outcome: 'idle',
    })
  })

  test('an unresolved failure predating this execution is not re-reported', () => {
    const events = [
      startedRun('h_old'),
      repoEvent('harvest.failed', {
        run: 'h_old',
        step: 'synthesize',
        attempt: 1,
        error: 'no-terminal',
        willRetry: false,
      }),
      executionStarted('e1'),
    ]
    expect(classifyHarvestOutcome(events, input(events, 'host-dispatch-i0'))).toEqual({
      outcome: 'idle',
    })
  })

  test('a failure borne by this execution still classifies failed', () => {
    const events = [
      startedRun('h_old'),
      executionStarted('e1'),
      repoEvent('harvest.failed', {
        run: 'h_old',
        step: 'synthesize',
        attempt: 1,
        error: 'no-terminal',
        willRetry: true,
      }),
    ]
    expect(classifyHarvestOutcome(events, input(events))).toEqual({
      outcome: 'failed',
      launch: 'resumed',
      run: 'h_old',
    })
  })

  test('a run predating this execution is attributed resumed', () => {
    const events = [
      startedRun('h_old'),
      executionStarted('e1'),
      repoEvent('harvest.completed', {
        run: 'h_old',
        dispositions: [
          {
            occurrence: { build: 'b1', seq: 1 },
            action: 'suppressed',
            proposalKey: 'k',
            reason: 'r',
          },
        ],
        report: { kind: 'harvest-report', rev: 0 },
      }),
    ]
    expect(classifyHarvestOutcome(events, input(events))).toEqual({
      outcome: 'completed',
      launch: 'resumed',
      run: 'h_old',
    })
  })

  test('no terminal fact and a paused repository parks with the open run id', () => {
    const events = [
      executionStarted('e1'),
      startedRun('h_1'),
      repoEvent('harvest.pause-requested', {}),
      repoEvent('harvest.paused', {}),
    ]
    expect(classifyHarvestOutcome(events, input(events))).toEqual({ outcome: 'parked', run: 'h_1' })
  })

  test('no run at all and a paused repository parks without a run id', () => {
    const events = [
      executionStarted('e1'),
      repoEvent('harvest.pause-requested', {}),
      repoEvent('harvest.paused', {}),
    ]
    expect(classifyHarvestOutcome(events, input(events))).toEqual({ outcome: 'parked' })
  })

  test('a lease held by a peer after the guest exited is held', () => {
    const events = [executionStarted('e1'), startedRun('h_1')]
    expect(classifyHarvestOutcome(events, input(events, 'other-dispatch-i9'))).toEqual({
      outcome: 'held',
    })
  })

  test('nothing claimed and nothing started is idle', () => {
    const events = [executionStarted('e1')]
    expect(classifyHarvestOutcome(events, input(events, 'host-dispatch-i0'))).toEqual({
      outcome: 'idle',
    })
  })
})
