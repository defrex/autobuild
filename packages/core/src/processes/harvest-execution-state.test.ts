import { describe, expect, test } from 'bun:test'
import { KERNEL } from '../events/envelope'
import type { RepositoryEvent } from '../events/repository'
import { EventValidationError } from '../events/catalog'
import { ReducerValueValidationError } from '../store/reduced-reads'
import { AuthError } from '../store/remote/client'
import { ReducerValueIncompatibilityError } from '../store/remote/compatibility'
import {
  classifyAuthorityReadError,
  classifyHarvestOutcome,
  decideHostedHarvestAuthority,
  hostedHarvestAuthorityReducer,
  openHarvestExecutions,
} from './harvest-execution-state'

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

describe('hosted harvest execution authority', () => {
  const authorized = (execution: string, run = 'h_1', leaseHolder = 'inv-1') =>
    repoEvent('harvest.execution.authorized', { execution, run, launch: 'started', leaseHolder })
  const released = (execution: string) =>
    repoEvent('harvest.execution.released', {
      execution,
      environmentId: 'autobuild-harvest-abc1234567',
      snapshots: { outcome: 'confirmed' },
    })
  const ended = (execution: string) =>
    repoEvent('harvest.execution.ended', { execution, run: 'h_1' })
  const guest = { execution: 'x1', run: 'h_1', leaseHolder: 'inv-1' }
  const decide = (events: RepositoryEvent[], input = guest) =>
    decideHostedHarvestAuthority(hostedHarvestAuthorityReducer.reduce(events), input)
  const fenced = (reason: string) => ({ kind: 'fenced', reason })

  test.each<[string, () => RepositoryEvent[], ReturnType<typeof decide>]>([
    ['authorized with no started fact yet', () => [authorized('x1')], { kind: 'authorized' }],
    [
      'authorized then started',
      () => [authorized('x1'), executionStarted('x1')],
      { kind: 'authorized' },
    ],
    [
      'released after started',
      () => [authorized('x1'), executionStarted('x1'), released('x1')],
      fenced('released') as never,
    ],
    [
      'released before started',
      () => [authorized('x1'), released('x1'), executionStarted('x1')],
      fenced('released') as never,
    ],
    ['ended', () => [authorized('x1'), ended('x1')], fenced('released') as never],
    [
      'replaced by a later execution of the same run',
      () => [authorized('x1'), authorized('x2')],
      fenced('replaced') as never,
    ],
    [
      'replaced by a later execution of another run',
      () => [authorized('x1'), authorized('x2', 'h_2', 'inv-2')],
      fenced('replaced') as never,
    ],
    [
      're-authorization of the same execution keeps the first',
      () => [authorized('x1'), authorized('x1', 'h_1', 'inv-9')],
      { kind: 'authorized' },
    ],
    [
      'release of an older execution is ignored',
      () => [authorized('x0'), executionStarted('x0'), authorized('x1'), released('x0')],
      { kind: 'authorized' },
    ],
    ['no authorization', () => [executionStarted('x1')], fenced('unauthorized') as never],
    [
      'authorization for another run',
      () => [authorized('x1', 'h_9')],
      fenced('unauthorized') as never,
    ],
    [
      'authorization with a different lease holder',
      () => [authorized('x1', 'h_1', 'inv-2')],
      fenced('unauthorized') as never,
    ],
  ])('%s', (_name, events, expected) => {
    expect(decide(events())).toEqual(expected)
  })

  test('the finished value is independent of execution history', () => {
    const cycle = (execution: string) => [
      startedRun(`h_${execution}`),
      authorized(execution, `h_${execution}`),
      executionStarted(execution),
      released(execution),
    ]
    const one = hostedHarvestAuthorityReducer.reduce([...cycle('old'), authorized('x1')])
    const many = hostedHarvestAuthorityReducer.reduce([
      ...Array.from({ length: 1_000 }, (_, index) => cycle(`old-${index}`)).flat(),
      authorized('x1'),
    ])
    expect(Object.keys(many)).toEqual(Object.keys(one))
    expect(Object.keys(many.current!)).toEqual(Object.keys(one.current!))
    expect(many).toEqual(one)
    expect(decideHostedHarvestAuthority(many, guest)).toEqual({ kind: 'authorized' })
    expect(hostedHarvestAuthorityReducer.reduce([])).toEqual({})
  })

  test.each<[string, unknown, ReturnType<typeof classifyAuthorityReadError>]>([
    [
      'an incompatible served value',
      new ReducerValueIncompatibilityError(
        'hostedHarvestAuthority',
        { kind: 'repo', repo: REPO },
        1,
        2,
        'shape',
      ),
      'permanent',
    ],
    [
      'an invalid persisted value',
      new ReducerValueValidationError('hostedHarvestAuthority', { kind: 'repo', repo: REPO }, 0, {
        path: '$',
        expected: 'object',
      }),
      'permanent',
    ],
    [
      'an old server rejecting the reducer name',
      new EventValidationError('Error: unknown reducer "hostedHarvestAuthority"'),
      'permanent',
    ],
    ['a local unknown reducer', new Error('unknown reducer "hostedHarvestAuthority"'), 'permanent'],
    ['an excluded reducer', new Error('excluded reducer "x": reason'), 'permanent'],
    ['a wrong-scope reducer', new Error('wrong scope for reducer "x"'), 'permanent'],
    ['an auth refusal', new AuthError('grant retired'), 'revoked'],
    ['a network failure', new TypeError('fetch failed'), 'transient'],
    ['a server error', new Error('store server responded 503'), 'transient'],
  ])('classifies %s', (_name, error, expected) => {
    expect(classifyAuthorityReadError(error)).toBe(expected)
  })
})
