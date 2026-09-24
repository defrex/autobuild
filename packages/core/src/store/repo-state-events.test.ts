/**
 * Unit coverage for the bounded repository-journal read (AUT-489). The store
 * contract suite pins each adapter's `getRepoStateEvents` against this
 * module's projector; these tests pin the projector itself — the partition
 * that makes the bound safe, the bound itself, and the subset's equivalence
 * with a full replay under the four state readers.
 */
import { describe, expect, test } from 'bun:test'
import { DISPATCHER, humanActor, KERNEL } from '../events/envelope'
import type { RepositoryEvent, RepositoryEventType } from '../events/repository'
import { REPOSITORY_EVENT_TYPES } from '../events/repository'
import {
  REPOSITORY_RUN_SCOPED_EVENT_TYPES,
  REPOSITORY_STATE_EVENT_TYPES,
  projectRepositoryStateEvents,
} from './repo-state-events'
import { reduceDispatchSettings } from '../kernel/dispatch-settings'
import { reduceDispatchStatus } from '../kernel/dispatch-status'
import { reduceHarvest } from '../kernel/harvest'
import { sandboxStates } from '../processes/sandbox-state'
import { projectHarvestStatus } from '../cli/harvest'
import { projectRepositoryStatus } from '../cli/repository-status'

let nextSeq = 0

/** A well-formed repository event of any type; payloads satisfy their
 * schemas, which keeps the events honest for the reducers the equivalence
 * assertions run them through. */
function event(
  type: RepositoryEventType,
  overrides: Partial<Pick<RepositoryEvent, 'seq' | 'payload' | 'run' | 'actor'>> = {},
): RepositoryEvent {
  const seq = overrides.seq ?? ++nextSeq
  const payload = {
    ...payloadShape(type),
    ...overrides.payload,
    ...(overrides.run !== undefined && 'run' in payloadShape(type) ? { run: overrides.run } : {}),
  } as never
  if ('run' in (payload as object) === false && 'run' in payloadShape(type)) {
    ;(payload as { run: string }).run = overrides.run ?? 'run_1'
  }
  return {
    repo: 'acme/a',
    seq,
    ts: new Date(Date.parse('2026-09-17T12:00:00.000Z') + seq).toISOString(),
    actor: overrides.actor ?? KERNEL,
    type,
    payload,
  } as RepositoryEvent
}

/** Minimal payloads for the types the tests use, keyed by the shape each
 * schema demands. Kept explicit so a catalog payload change that breaks one
 * of these fails loudly here rather than silently in production. */
function payloadShape(type: RepositoryEventType): Record<string, unknown> {
  switch (type) {
    case 'harvest.started':
      return {
        run: '',
        observations: [{ build: 'b', seq: 1 }],
        scan: { kind: 'harvest-scan', rev: 0 },
      }
    case 'harvest.step.started':
      return { run: '', step: 'scan' }
    case 'harvest.proposal.id-reserved':
      return { run: '', proposalKey: 'k', id: '00000000-0000-4000-8000-000000000000' }
    case 'orchestrator.sandbox.provisioned':
      return { operator: 'op', environmentId: 'env', provider: 'p', workspacePath: '/w' }
    case 'dispatcher.run-started':
      return {
        run: '',
        pid: 1,
        effectiveConfig: { kind: 'effective-config', rev: 0 },
        roleWarnings: [],
      }
    case 'dispatcher.run-stopped':
      return { run: '', outcome: 'normal' }
    case 'dispatcher.tick-started':
      return { run: '' }
    case 'dispatcher.tick-completed':
      return {
        run: '',
        queued: 0,
        counters: {
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
        },
        janitorDiagnostics: [],
        ticketDiagnostics: [],
        dependencyDiagnostics: [],
      }
    case 'dispatcher.tick-yielded':
      return { holder: 'other' }
    case 'dispatcher.tick-failed':
      return { run: '', error: 'e' }
    case 'dispatcher.operator-reported':
      return { run: '', level: 'warning', message: 'm' }
    case 'dispatcher.config-reloaded':
      return {
        artifact: { kind: 'config-revision', rev: 0 },
        restartRequired: [],
        effectiveChanged: false,
      }
    case 'dispatcher.intake-set':
    case 'dispatcher.pause-set':
    case 'dispatcher.auto-merge-default-set':
      return { enabled: false }
    default:
      return { run: '' }
  }
}

/** One no-op hosted dispatcher invocation: the ~4 facts an invocation appends
 * whether or not it did anything. */
function noopInvocation(run: string, baseSeq?: number): RepositoryEvent[] {
  return [
    event('dispatcher.run-started', { seq: baseSeq, run }),
    event('dispatcher.tick-started', { run }),
    event('dispatcher.tick-completed', { run }),
    event('dispatcher.run-stopped', { run }),
  ]
}

describe('REPOSITORY_STATE_EVENT_TYPES partition', () => {
  test('durable and run-scoped types exactly partition the repository catalog, disjointly', () => {
    const durable = new Set<string>(REPOSITORY_STATE_EVENT_TYPES)
    const runScoped = new Set<string>(REPOSITORY_RUN_SCOPED_EVENT_TYPES)
    const catalog = new Set<string>(REPOSITORY_EVENT_TYPES)
    expect(durable.size + runScoped.size).toBe(catalog.size)
    for (const type of durable) expect(runScoped.has(type)).toBe(false)
    for (const type of catalog) {
      expect(durable.has(type) || runScoped.has(type)).toBe(true)
    }
  })
})

describe('projectRepositoryStateEvents', () => {
  test('an empty journal derives an empty subset', () => {
    expect(projectRepositoryStateEvents([])).toEqual([])
  })

  test('a journal with no run-started yields durable types only — never the whole journal', () => {
    const journal = [
      event('dispatcher.intake-set', { actor: humanActor('op'), payload: { enabled: true } }),
      event('harvest.started'),
      event('orchestrator.sandbox.provisioned'),
    ]
    expect(projectRepositoryStateEvents(journal).map((e) => e.type)).toEqual([
      'dispatcher.intake-set',
      'harvest.started',
      'orchestrator.sandbox.provisioned',
    ])
  })

  test('pre-anchor dispatcher facts are absent; the anchor and durable facts are present; order is by seq', () => {
    const journal = [
      event('dispatcher.run-started', { seq: 1, run: 'old' }),
      event('dispatcher.tick-started', { seq: 2, run: 'old' }),
      event('dispatcher.tick-completed', { seq: 3, run: 'old' }),
      event('dispatcher.run-stopped', { seq: 4, run: 'old' }),
      event('harvest.started', { seq: 5, run: 'h1' }),
      event('orchestrator.sandbox.provisioned', { seq: 6 }),
      event('dispatcher.intake-set', {
        seq: 7,
        actor: humanActor('op'),
        payload: { enabled: true },
      }),
      event('dispatcher.run-started', { seq: 8, run: 'new' }),
      event('dispatcher.tick-started', { seq: 9, run: 'new' }),
      event('dispatcher.tick-completed', { seq: 10, run: 'new' }),
      event('dispatcher.run-stopped', { seq: 11, run: 'new' }),
    ]
    const subset = projectRepositoryStateEvents(journal)
    expect(subset.map((e) => e.seq)).toEqual([5, 6, 7, 8, 9, 10, 11])
    expect(subset.find((e) => e.type === 'dispatcher.run-started')?.payload.run).toBe('new')
  })

  test('boundedness: 1,000 and 2,000 no-op invocations yield identical-size subsets', () => {
    for (const count of [1_000, 2_000]) {
      const journal: RepositoryEvent[] = []
      for (let index = 0; index < count; index += 1) {
        journal.push(...noopInvocation(`run_${index}`, undefined))
      }
      journal.push(event('harvest.started', { run: 'h1' }))
      journal.push(
        event('dispatcher.intake-set', { actor: humanActor('op'), payload: { enabled: true } }),
      )
      const subset = projectRepositoryStateEvents(journal)
      expect(subset.length).toBe(4 + 2) // the latest invocation's 4 facts + durable signal
      expect(subset).toEqual(projectRepositoryStateEvents(journal)) // stable
    }
  })

  test('replay equivalence: the state readers report the same state from subset and full replay', () => {
    // Adversarial journal: late old-run events after a new anchor, a
    // historical config-reloaded with no run, launch-flag setting events
    // carrying run, a harvest run spanning an anchor move, a crashed run with
    // no run-stopped, a yield-only invocation.
    const journal: RepositoryEvent[] = [
      event('dispatcher.run-started', { seq: 1, run: 'r1' }),
      event('dispatcher.tick-completed', { seq: 2, run: 'r1' }),
      event('dispatcher.run-stopped', {
        seq: 3,
        run: 'r1',
        payload: { run: 'r1', outcome: 'abnormal', error: 'boom' },
      }),
      event('harvest.pause-requested', { seq: 4, actor: humanActor('op'), payload: {} }),
      event('harvest.paused', { seq: 5 }),
      event('orchestrator.sandbox.provisioned', { seq: 6, actor: humanActor('op') }),
      event('dispatcher.intake-set', {
        seq: 7,
        actor: humanActor('op'),
        payload: { enabled: false, run: 'r0' },
      }),
      event('dispatcher.config-reloaded', {
        seq: 8,
        payload: {
          artifact: { kind: 'config-revision', rev: 1 },
          restartRequired: [],
          effectiveChanged: true,
        },
      }),
      event('harvest.started', { seq: 9, run: 'h1' }),
      event('harvest.step.started', { seq: 10, payload: { run: 'h1', step: 'scan' } }),
      event('dispatcher.run-started', { seq: 11, run: 'r2' }),
      event('dispatcher.tick-yielded', { seq: 12, payload: { holder: 'other' } }),
      // A late fact of the OLD run, appended after the new anchor: the status
      // reducer skips it by run id, so the subset may include or omit it —
      // here it is included (>= anchor) and changes nothing.
      event('dispatcher.tick-failed', { seq: 13, run: 'r1' }),
      event('harvest.step.completed', {
        seq: 14,
        payload: { run: 'h1', step: 'scan', outcome: 'completed' },
      }),
      event('dispatcher.auto-merge-default-set', {
        seq: 15,
        actor: humanActor('op'),
        payload: { enabled: true, run: 'r2' },
      }),
      // A crashed latest run: no run-stopped at all.
      event('dispatcher.tick-completed', { seq: 16, run: 'r2' }),
      event('dispatcher.operator-reported', {
        seq: 17,
        actor: humanActor('op'),
        payload: { run: 'r2', level: 'warning', message: 'w' },
      }),
      event('orchestrator.sandbox.activity', { seq: 18, actor: humanActor('op') }),
    ]
    const subset = projectRepositoryStateEvents(journal)
    const latestRun = 'r2'
    expect(subset.map((e) => e.type)).toContain('dispatcher.operator-reported')
    for (const project of [
      (events: RepositoryEvent[]) => reduceDispatchSettings(events),
      (events: RepositoryEvent[]) => reduceDispatchStatus(events, latestRun),
      (events: RepositoryEvent[]) => reduceHarvest(events),
      (events: RepositoryEvent[]) => sandboxStates(events),
      (events: RepositoryEvent[]) => projectRepositoryStatus('acme/a', events),
      (events: RepositoryEvent[]) => projectHarvestStatus('acme/a', events),
    ]) {
      expect(project(subset)).toEqual(project(journal))
    }
  })
})
