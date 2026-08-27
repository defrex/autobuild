import { describe, expect, test } from 'bun:test'
import { DISPATCHER, humanActor } from '../events/envelope'
import type { RepositoryEvent } from '../events/repository'
import { reduceDispatchStatus } from './dispatch-status'

function event(
  seq: number,
  type: RepositoryEvent['type'],
  payload: RepositoryEvent['payload'],
): RepositoryEvent {
  return {
    repo: '/repo',
    seq,
    ts: new Date(seq * 1_000).toISOString(),
    actor: type === 'dispatcher.operator-reported' ? humanActor('operator') : DISPATCHER,
    type,
    payload,
  } as RepositoryEvent
}

const counters = {
  merged: 0,
  closed: 0,
  conflicted: 0,
  abandoned: 0,
  discarded: 0,
  janitorFailed: 0,
  recovered: 0,
  dispatchFailed: 0,
  resumed: 0,
  swept: 0,
  dispatched: 0,
  authored: 0,
  bounced: 0,
  claimRaces: 0,
  invalidTickets: 0,
  dependencyBlocked: 0,
  harvestStarted: 0,
  harvestResumed: 0,
  harvestCompleted: 0,
  harvestEscalated: 0,
  harvestFailed: 0,
}

describe('reduceDispatchStatus', () => {
  test('isolates runs and retains config/queue across rejected and failed turns', () => {
    const events = [
      event(1, 'dispatcher.run-started', {
        run: 'run-a',
        pid: 100,
        effectiveConfig: { kind: 'dispatcher-effective-config', rev: 0 },
        roleWarnings: ['unused role'],
      }),
      event(2, 'dispatcher.run-started', {
        run: 'run-b',
        pid: 200,
        effectiveConfig: { kind: 'dispatcher-effective-config', rev: 1 },
        roleWarnings: [],
      }),
      event(3, 'dispatcher.tick-completed', {
        run: 'run-a',
        queued: 4,
        observations: 2, // legacy replay field is accepted but display-owned
        counters: { ...counters, creationWithheld: 1 },
        janitorDiagnostics: ['janitor warning'],
        ticketDiagnostics: [],
        creationDiagnostics: ['ticket AUT-1: creation withheld'],
        dependencyDiagnostics: [],
      }),
      event(4, 'dispatcher.config-rejected', { run: 'run-a', error: 'bad TOML' }),
      event(5, 'dispatcher.tick-failed', { run: 'run-a', error: 'tracker offline' }),
    ]
    const status = reduceDispatchStatus(events, 'run-a')
    expect(status.effectiveConfig).toEqual({ kind: 'dispatcher-effective-config', rev: 0 })
    expect(status.queued).toBe(4)
    expect(status).not.toHaveProperty('observations')
    expect(status.creationWithheld).toBe(1)
    expect(status.diagnostics).toEqual(['janitor warning', 'ticket AUT-1: creation withheld'])
    expect(status.notice).toBe('tick failed: tracker offline')
    expect(status.lastSeq).toBe(5)
  })

  test('continues a projection from repository deltas without replaying prior facts', () => {
    const started = event(1, 'dispatcher.run-started', {
      run: 'run-a',
      pid: 100,
      effectiveConfig: { kind: 'dispatcher-effective-config', rev: 0 },
      roleWarnings: [],
    })
    const completed = event(3, 'dispatcher.tick-completed', {
      run: 'run-a',
      queued: 2,
      counters,
      janitorDiagnostics: [],
      ticketDiagnostics: [],
      dependencyDiagnostics: [],
    })
    const initial = reduceDispatchStatus([started], 'run-a')
    const incremental = reduceDispatchStatus(
      [started, event(2, 'dispatcher.tick-started', { run: 'run-b' }), completed],
      'run-a',
      initial,
    )

    expect(incremental).toEqual(reduceDispatchStatus([started, completed], 'run-a'))
    expect(initial.queued).toBeUndefined()
    expect(() => reduceDispatchStatus([], 'run-b', incremental)).toThrow(
      'cannot continue dispatch run "run-b" from "run-a" status',
    )
  })

  test('retains warning severity across later informational notices', () => {
    const started = event(1, 'dispatcher.run-started', {
      run: 'run-a',
      pid: 100,
      effectiveConfig: { kind: 'dispatcher-effective-config', rev: 0 },
      roleWarnings: [],
    })
    const status = reduceDispatchStatus(
      [
        started,
        event(2, 'dispatcher.operator-reported', {
          run: 'run-a',
          level: 'warning',
          message: 'dashboard action failed: denied',
        }),
        event(3, 'dispatcher.operator-reported', {
          run: 'run-a',
          level: 'info',
          message: 'dispatcher intake OFF',
        }),
        event(4, 'dispatcher.config-reloaded', {
          artifact: { kind: 'dispatcher-config', rev: 1 },
          restartRequired: [],
          effectiveChanged: true,
          run: 'run-a',
        }),
      ],
      'run-a',
    )

    expect(status.notice).toBe('autobuild.toml reloaded')
    expect(status.warningNotice).toBe('dashboard action failed: denied')
  })

  test('projects every intrinsic failure and restart-required reload as a warning', () => {
    const started = event(1, 'dispatcher.run-started', {
      run: 'run-a',
      pid: 100,
      effectiveConfig: { kind: 'dispatcher-effective-config', rev: 0 },
      roleWarnings: [],
    })
    const failures: Array<[RepositoryEvent['type'], RepositoryEvent['payload'], string]> = [
      ['dispatcher.tick-failed', { run: 'run-a', error: 'offline' }, 'tick failed: offline'],
      [
        'dispatcher.runner-settled',
        { run: 'run-a', slug: 'alpha', outcome: 'parked', status: 'blocked' },
        'build alpha parked (blocked)',
      ],
      [
        'dispatcher.runner-settled',
        { run: 'run-a', slug: 'alpha', outcome: 'lease-held' },
        'build alpha already held by another runner — skipped',
      ],
      [
        'dispatcher.runner-settled',
        { run: 'run-a', slug: 'alpha', outcome: 'failed', error: 'boom' },
        'build alpha runner failed: boom',
      ],
      [
        'dispatcher.harvest-runner-failed',
        { run: 'run-a', error: 'boom' },
        'harvest runner failed: boom',
      ],
      [
        'dispatcher.run-stopped',
        { run: 'run-a', outcome: 'abnormal', error: 'exit' },
        'dispatcher stopped unexpectedly: exit',
      ],
      [
        'dispatcher.config-rejected',
        { run: 'run-a', error: 'bad TOML' },
        'config reload rejected: bad TOML',
      ],
      [
        'dispatcher.config-publication-failed',
        { run: 'run-a', error: 'disk' },
        'config reload not applied because its durable trace failed: disk',
      ],
      [
        'dispatcher.config-reloaded',
        {
          artifact: { kind: 'dispatcher-config', rev: 1 },
          restartRequired: ['tickets.source'],
          effectiveChanged: true,
          run: 'run-a',
        },
        'autobuild.toml reload requires dispatch restart for: tickets.source',
      ],
    ]

    for (const [type, payload, expected] of failures) {
      expect(reduceDispatchStatus([started, event(2, type, payload)], 'run-a').warningNotice).toBe(
        expected,
      )
    }
  })

  test('successful ticks supersede diagnostics and accepted config replaces warnings', () => {
    const events = [
      event(1, 'dispatcher.run-started', {
        run: 'run-a',
        pid: 100,
        effectiveConfig: { kind: 'dispatcher-effective-config', rev: 0 },
        roleWarnings: ['old'],
      }),
      event(2, 'dispatcher.tick-completed', {
        run: 'run-a',
        queued: 1,
        counters,
        janitorDiagnostics: [],
        ticketDiagnostics: ['broken ticket'],
        dependencyDiagnostics: [],
      }),
      event(3, 'dispatcher.config-reloaded', {
        artifact: { kind: 'dispatcher-config', rev: 0 },
        restartRequired: [],
        effectiveChanged: true,
        run: 'run-a',
        effectiveConfig: { kind: 'dispatcher-effective-config', rev: 1 },
        roleWarnings: [],
      }),
      event(4, 'dispatcher.tick-completed', {
        run: 'run-a',
        queued: 0,
        counters,
        janitorDiagnostics: [],
        ticketDiagnostics: [],
        dependencyDiagnostics: [],
      }),
      event(5, 'dispatcher.upgrade-available', { run: 'run-a', version: '0.5.0' }),
    ]
    const status = reduceDispatchStatus(events, 'run-a')
    expect(status.effectiveConfig?.rev).toBe(1)
    expect(status.roleWarnings).toEqual([])
    expect(status.diagnostics).toEqual([])
    expect(status.queued).toBe(0)
    expect(status.availableUpgrade).toBe('0.5.0')
  })
})
