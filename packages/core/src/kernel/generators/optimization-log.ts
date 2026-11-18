import { validateEventWrite, type AbEvent, type EventWrite } from '../../events/catalog'
import { DISPATCHER, KERNEL, agentActor, humanActor } from '../../events/envelope'
import type { AttemptOutcome } from '../../events/payloads'
import type { Objective } from '../../objective'

export const OPTIMIZATION_SHA = (char: string) => char.repeat(40)

/** A command objective minimizing a benchmark, with every optional field set. */
export function commandObjective(overrides: Partial<Objective> = {}): Objective {
  return {
    purpose: 'p95 latency of the catalog search query',
    metric: {
      kind: 'command',
      command: 'bun bench/search.ts',
      direction: 'minimize',
      samples: 7,
      harness: ['bench/search/**'],
    },
    target: { threshold: 40, epsilon: { relative: 0.03 } },
    budget: { maxAttempts: 60, maxHours: 24 },
    stop: { plateau: { attempts: 12 }, mode: 'abort' },
    proposer: { concurrency: 4 },
    ...overrides,
  }
}

/** A panel objective judged by win rate. */
export function panelObjective(): Objective {
  return {
    purpose: 'clearer onboarding prose',
    metric: { kind: 'panel', judges: 5, rubric: 'evals/rubric.md', harness: ['evals/**'] },
    target: { threshold: 0.8, epsilon: { absolute: 0.1 } },
    budget: { maxAttempts: 10 },
    stop: { mode: 'drain' },
    proposer: { concurrency: 2 },
  }
}

/** Builds a validated node log one fact at a time, with ascending seq and ts. */
export class OptimizationLogBuilder {
  readonly events: AbEvent[] = []
  private clock: number

  constructor(
    readonly build = 'opt-node',
    start = Date.parse('2026-11-17T00:00:00Z'),
  ) {
    this.clock = start
  }

  /** Advance the log's clock by `minutes`. */
  wait(minutes: number): this {
    this.clock += minutes * 60_000
    return this
  }

  push(write: EventWrite): this {
    const valid = validateEventWrite(write)
    this.events.push({
      ...valid,
      build: this.build,
      seq: this.events.length + 1,
      ts: new Date(this.clock).toISOString(),
    } as AbEvent)
    return this
  }

  accept(objective: Objective, revision: number, specRev = 0, pin = OPTIMIZATION_SHA('a')): this {
    return this.push({
      actor: DISPATCHER,
      type: 'optimization.objective-accepted',
      payload: { objective, revision, harnessPin: pin, specRev },
    })
  }

  revise(
    changes: EventWrite<'optimization.objective-revised'>['payload']['changes'],
    revision: number,
  ) {
    return this.push({
      actor: humanActor('ada'),
      type: 'optimization.objective-revised',
      payload: { changes, revision },
    })
  }

  baseline(revision: number, median: number, spread: number, head = OPTIMIZATION_SHA('a')) {
    return this.push({
      actor: KERNEL,
      type: 'optimization.baseline-measured',
      payload: { revision, head, harnessPin: OPTIMIZATION_SHA('a'), samples: 7, median, spread },
    })
  }

  propose(request: string, ids: readonly string[], reason?: string): this {
    this.push({
      actor: DISPATCHER,
      type: 'optimization.proposal-requested',
      payload: {
        id: request,
        head: OPTIMIZATION_SHA('a'),
        room: ids.length,
        budgetUsed: { attempts: 0, hours: 0 },
      },
    })
    return this.push({
      actor: DISPATCHER,
      type: 'optimization.attempts-proposed',
      payload: {
        request,
        proposals: ids.map((id) => ({
          id,
          ticket: { source: 'file', id: `T-${id}` },
          title: `Attempt ${id}`,
          strategy: `strategy ${id}`,
        })),
        ...(reason !== undefined ? { reason } : {}),
      },
    })
  }

  /** A proposal request alone, left open. */
  request(id: string, room: number, head = OPTIMIZATION_SHA('a')): this {
    return this.push({
      actor: DISPATCHER,
      type: 'optimization.proposal-requested',
      payload: { id, head, room, budgetUsed: { attempts: 0, hours: 0 } },
    })
  }

  /** The proposer's deposit for an open request. */
  deposit(request: string, round: number, ids: readonly string[], rev = 0): this {
    return this.push({
      actor: agentActor('propose', 'sess-propose'),
      type: 'propose.completed',
      payload: { round, request, proposals: [...ids], artifact: { kind: 'attempts', rev } },
    })
  }

  /** The dispatcher's filing of a deposited request. */
  file(request: string, ids: readonly string[], reason?: string): this {
    return this.push({
      actor: DISPATCHER,
      type: 'optimization.attempts-proposed',
      payload: {
        request,
        proposals: ids.map((id) => ({
          id,
          ticket: { source: 'file', id: `T-${id}` },
          title: `Attempt ${id}`,
          strategy: `strategy ${id}`,
        })),
        ...(reason !== undefined ? { reason } : {}),
      },
    })
  }

  withdraw(request: string, reason: 'stopped' | 'budget' | 'concurrency'): this {
    return this.push({
      actor: DISPATCHER,
      type: 'optimization.proposal-withdrawn',
      payload: { request, reason },
    })
  }

  defer(
    reason: EventWrite<'optimization.proposal-deferred'>['payload']['reason'] = 'paused',
  ): this {
    return this.push({
      actor: DISPATCHER,
      type: 'optimization.proposal-deferred',
      payload: { reason },
    })
  }

  settle(
    proposal: string,
    outcome: AttemptOutcome,
    measurement?: { revision: number; baseline: number; candidate: number; delta: number },
    note?: string,
  ): this {
    return this.push({
      actor: DISPATCHER,
      type: 'attempt.settled',
      payload: {
        attempt: {
          proposal,
          ticket: { source: 'file', id: `T-${proposal}` },
          build: `attempt-${proposal}`,
        },
        outcome,
        ...(measurement !== undefined ? { measurement } : {}),
        ...(note !== undefined ? { note } : {}),
      },
    })
  }

  progress(revision: number, winRate: number): this {
    return this.push({
      actor: KERNEL,
      type: 'optimization.progress-measured',
      payload: {
        revision,
        head: OPTIMIZATION_SHA('c'),
        start: OPTIMIZATION_SHA('a'),
        winRate,
        judges: 5,
      },
    })
  }

  stop(cause: EventWrite<'optimization.stopped'>['payload']['cause'], mode: 'abort' | 'drain') {
    return this.push({ actor: KERNEL, type: 'optimization.stopped', payload: { cause, mode } })
  }
}

/** A node log that reaches every digest and ledger field, for shape coverage. */
export function optimizationLog(): AbEvent[] {
  return new OptimizationLogBuilder()
    .push({
      actor: DISPATCHER,
      type: 'build.created',
      payload: {
        repo: 'repo',
        ticket: { source: 'file', id: 'node' },
        baseBranch: 'main',
        kind: 'node',
      },
    })
    .accept(commandObjective(), 1)
    .push({ actor: DISPATCHER, type: 'node.opened', payload: { sha: OPTIMIZATION_SHA('a') } })
    .baseline(1, 50, 1.5)
    .revise({ threshold: 35, plateau: 8, epsilon: { absolute: 2 } }, 2)
    .propose('r1', ['a1', 'a2', 'a3'])
    .settle('a1', 'accepted', { revision: 2, baseline: 50, candidate: 44, delta: 6 })
    .settle('a2', 'no-improvement', { revision: 2, baseline: 44, candidate: 43, delta: 1 }, 'noise')
    .settle('a3', 'declined', undefined, 'not worth it')
    .propose('r2', [], 'out of ideas')
    .propose('r3', ['a4'])
    .stop('plateau', 'drain')
    .settle('a4', 'stopped')
    .request('r4', 1)
    .withdraw('r4', 'stopped')
    .defer('paused')
    .request('r5', 1)
    .deposit('r5', 5, ['a5']).events
}

/** A panel node log, for the panel's value fields. */
export function panelOptimizationLog(): AbEvent[] {
  return new OptimizationLogBuilder('panel-node')
    .accept(panelObjective(), 1)
    .baseline(1, 0.55, 0.05)
    .propose('r1', ['p1'])
    .settle('p1', 'accepted', { revision: 1, baseline: 0.5, candidate: 0.7, delta: 0.2 })
    .progress(1, 0.7).events
}
