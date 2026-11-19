import { validateEventWrite, type AbEvent, type EventWrite } from '../../events/catalog'
import { DISPATCHER, KERNEL, humanActor } from '../../events/envelope'
import type { AttemptOutcome, UnmeasuredMergeReason } from '../../events/payloads'
import type { CommandMetric, Objective, ObjectiveMetric } from '../../objective'

export const OPTIMIZATION_SHA = (char: string) => char.repeat(40)

/** The command metric `commandObjective` measures with. */
export function commandMetric(): CommandMetric {
  return {
    kind: 'command',
    command: 'bun bench/search.ts',
    direction: 'minimize',
    samples: 7,
    harness: ['bench/search/**'],
  }
}

/** A command objective minimizing a benchmark, with every optional field set. */
export function commandObjective(overrides: Partial<Objective> = {}): Objective {
  return {
    purpose: 'p95 latency of the catalog search query',
    metric: commandMetric(),
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

  baseline(
    revision: number,
    median: number,
    spread: number,
    head = OPTIMIZATION_SHA('a'),
    report?: { kind: string; rev: number },
  ) {
    return this.push({
      actor: KERNEL,
      type: 'optimization.baseline-measured',
      payload: {
        revision,
        head,
        harnessPin: OPTIMIZATION_SHA('a'),
        samples: 7,
        median,
        spread,
        ...(report !== undefined ? { report } : {}),
      },
    })
  }

  noiseExceeded(revision: number, median: number, spread: number, effectiveEpsilon: number) {
    return this.push({
      actor: KERNEL,
      type: 'optimization.noise-exceeded',
      payload: {
        revision,
        head: OPTIMIZATION_SHA('a'),
        harnessPin: OPTIMIZATION_SHA('a'),
        median,
        spread,
        epsilon: { relative: 0.03 },
        effectiveEpsilon,
      },
    })
  }

  /** An attempt's measurement request, on the attempt's own log. */
  requestMeasurement(
    id: string,
    node = 'opt-node',
    revision = 1,
    candidate = OPTIMIZATION_SHA('c'),
    metric?: ObjectiveMetric,
    purpose = panelObjective().purpose,
  ) {
    return this.push({
      actor: DISPATCHER,
      type: 'attempt.measurement-requested',
      payload: {
        id,
        node,
        candidate,
        baseline: OPTIMIZATION_SHA('a'),
        harnessPin: OPTIMIZATION_SHA('a'),
        revision,
        ...(metric !== undefined ? { metric } : {}),
        ...(metric?.kind === 'panel' ? { purpose } : {}),
      },
    })
  }

  /** An attempt runner's judge panel win rate, on the attempt's own log. */
  panelSampled(
    request: string,
    winRate: number,
    opts: { revision?: number; judges?: number } = {},
  ) {
    return this.push({
      actor: KERNEL,
      type: 'attempt.sampled',
      payload: {
        request,
        candidate: OPTIMIZATION_SHA('c'),
        baseline: OPTIMIZATION_SHA('a'),
        harnessPin: OPTIMIZATION_SHA('a'),
        revision: opts.revision ?? 1,
        samples: opts.judges ?? 5,
        winRate,
        report: { kind: 'measurement-samples', rev: 0 },
      },
    })
  }

  /** An attempt runner's paired samples, on the attempt's own log. */
  sampled(
    request: string,
    medians: { baseline: number; candidate: number },
    opts: { revision?: number; candidate?: string } = {},
  ) {
    return this.push({
      actor: KERNEL,
      type: 'attempt.sampled',
      payload: {
        request,
        candidate: opts.candidate ?? OPTIMIZATION_SHA('c'),
        baseline: OPTIMIZATION_SHA('a'),
        harnessPin: OPTIMIZATION_SHA('a'),
        revision: opts.revision ?? 1,
        samples: 7,
        medians,
        report: { kind: 'measurement-samples', rev: 0 },
      },
    })
  }

  /** An attempt's recorded measurement, on the attempt's own log. */
  measured(
    request: string,
    medians: { baseline: number; candidate: number },
    opts: { revision?: number; spread?: number; report?: { kind: string; rev: number } } = {},
  ) {
    const delta = medians.baseline - medians.candidate
    return this.push({
      actor: KERNEL,
      type: 'attempt.measured',
      payload: {
        request,
        candidate: OPTIMIZATION_SHA('c'),
        baseline: OPTIMIZATION_SHA('a'),
        harnessPin: OPTIMIZATION_SHA('a'),
        revision: opts.revision ?? 1,
        samples: 7,
        medians,
        delta,
        decision: delta > 0 ? 'improved' : 'no-improvement',
        ...(opts.spread !== undefined ? { spread: opts.spread } : {}),
        ...(opts.report !== undefined ? { report: opts.report } : {}),
      },
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

  settle(
    proposal: string,
    outcome: AttemptOutcome,
    measurement?: { revision: number; baseline: number; candidate: number; delta: number },
    note?: string,
    extra: Pick<EventWrite<'attempt.settled'>['payload'], 'policy' | 'mergedSha'> & {
      branch?: string
    } = {},
  ): this {
    const { branch, ...rest } = extra
    return this.push({
      actor: DISPATCHER,
      type: 'attempt.settled',
      payload: {
        attempt: {
          proposal,
          ticket: { source: 'file', id: `T-${proposal}` },
          build: `attempt-${proposal}`,
          ...(branch !== undefined ? { branch } : {}),
        },
        outcome,
        ...(measurement !== undefined ? { measurement } : {}),
        ...rest,
        ...(note !== undefined ? { note } : {}),
      },
    })
  }

  /** Record that an in-flight attempt merged without a landing measurement. */
  markUnmeasured(
    proposal: string,
    reason: UnmeasuredMergeReason,
    sha: string | undefined = OPTIMIZATION_SHA('d'),
    measuredCandidate?: string,
  ): this {
    return this.push({
      actor: DISPATCHER,
      type: 'attempt.merged-unmeasured',
      payload: {
        proposal,
        ticket: { source: 'file', id: `T-${proposal}` },
        build: `attempt-${proposal}`,
        ...(sha !== undefined && reason !== 'unresolvable' ? { sha } : {}),
        reason,
        ...(measuredCandidate !== undefined ? { measuredCandidate } : {}),
      },
    })
  }

  /** Record a settled attempt's branch deletion, or a failed attempt at it. */
  branchCleanup(proposal: string, branch: string, error?: string): this {
    return error === undefined
      ? this.push({
          actor: DISPATCHER,
          type: 'attempt.branch-deleted',
          payload: { proposal, build: `attempt-${proposal}`, branch },
        })
      : this.push({
          actor: DISPATCHER,
          type: 'attempt.branch-cleanup-failed',
          payload: { proposal, build: `attempt-${proposal}`, branch, error },
        })
  }

  /** Record that a settled attempt's ticket moved to the rejected role. */
  ticketRejected(proposal: string, state = 'Rejected'): this {
    return this.push({
      actor: DISPATCHER,
      type: 'attempt.ticket-rejected',
      payload: { proposal, ticket: { source: 'file', id: `T-${proposal}` }, state },
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
    .noiseExceeded(1, 50, 1.6, 1.5)
    .baseline(1, 50, 1.6, OPTIMIZATION_SHA('a'), { kind: 'measurement-samples', rev: 0 })
    .revise({ threshold: 35, plateau: 8, epsilon: { absolute: 2 } }, 2)
    .propose('r1', ['a1', 'a2', 'a3'])
    .settle('a1', 'accepted', { revision: 2, baseline: 50, candidate: 44, delta: 6 })
    .settle('a2', 'no-improvement', { revision: 2, baseline: 44, candidate: 43, delta: 1 }, 'noise')
    .settle('a3', 'declined', undefined, 'not worth it')
    .ticketRejected('a2')
    .propose('r2', [], 'out of ideas')
    .propose('r3', ['a4'])
    .stop('plateau', 'drain')
    .settle('a4', 'stopped').events
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

/** An attempt leaf's log that reaches every measurement field. */
export function attemptMeasurementLog(): AbEvent[] {
  return new OptimizationLogBuilder('attempt-a1')
    .push({
      actor: DISPATCHER,
      type: 'build.created',
      payload: {
        repo: 'repo',
        ticket: { source: 'file', id: 'T-a1' },
        baseBranch: 'ab/opt-node',
        kind: 'work',
      },
    })
    .requestMeasurement('m1', 'opt-node', 1, OPTIMIZATION_SHA('c'), commandMetric())
    .sampled('m1', { baseline: 50, candidate: 44 })
    .measured(
      'm1',
      { baseline: 50, candidate: 44 },
      {
        spread: 1.6,
        report: { kind: 'measurement-samples', rev: 0 },
      },
    )
    .requestMeasurement('m2')
    .sampled('m2', { baseline: 44, candidate: 43 })
    .push({
      actor: DISPATCHER,
      type: 'escalation.raised',
      payload: {
        id: 'esc_m2',
        phase: 'measurement',
        source: 'policy',
        policyCause: 'measurement-failed',
        question: 'request m2 sampled a superseded ruler',
      },
    })
    .requestMeasurement('m3').events
}

/** A child of an optimization node whose head the node moved under: two
 * requests with different baselines and a result, for the child's landing
 * measurement state. */
export function attemptLandingLog(): AbEvent[] {
  const request = (id: string, baseline: string) => ({
    actor: DISPATCHER,
    type: 'attempt.measurement-requested' as const,
    payload: {
      id,
      node: 'opt-node',
      candidate: OPTIMIZATION_SHA('c'),
      baseline,
      harnessPin: OPTIMIZATION_SHA('a'),
      revision: 1,
    },
  })
  return new OptimizationLogBuilder('attempt-a1')
    .push({
      actor: DISPATCHER,
      type: 'build.created',
      payload: {
        repo: 'repo',
        ticket: { source: 'file', id: 'T-a1' },
        baseBranch: 'ab-node/opt',
        target: { build: 'opt-node', ticket: { source: 'file', id: 'node' } },
      },
    })
    .push(request('m1', OPTIMIZATION_SHA('a')))
    .push(request('m2', OPTIMIZATION_SHA('b')))
    .push({
      actor: KERNEL,
      type: 'attempt.measured',
      payload: {
        request: 'm2',
        candidate: OPTIMIZATION_SHA('c'),
        baseline: OPTIMIZATION_SHA('b'),
        harnessPin: OPTIMIZATION_SHA('a'),
        revision: 1,
        samples: 7,
        medians: { candidate: 41, baseline: 44 },
        delta: 3,
        decision: 'improved',
      },
    }).events
}

/** A node log that reaches the unmeasured-merge and branch-cleanup fields:
 * a marked in-flight attempt, a released one, and pending and cleared
 * branch obligations. */
export function unmeasuredMergeLog(): AbEvent[] {
  return new OptimizationLogBuilder()
    .accept(commandObjective(), 1)
    .baseline(1, 50, 1.6)
    .propose('r1', ['u1', 'u2', 'u3', 'u4'])
    .markUnmeasured('u1', 'stale-head', OPTIMIZATION_SHA('d'), OPTIMIZATION_SHA('c'))
    .markUnmeasured('u2', 'absent')
    .settle('u2', 'merged-unmeasured', undefined, 'released', {
      policy: 'release-unmeasured',
      mergedSha: OPTIMIZATION_SHA('d'),
    })
    .settle('u3', 'declined', undefined, 'no gain', { branch: 'ab/attempt-u3' })
    .branchCleanup('u3', 'ab/attempt-u3', 'forge refused the delete')
    .settle(
      'u4',
      'no-improvement',
      { revision: 1, baseline: 50, candidate: 49, delta: 1 },
      'noise',
      {
        branch: 'ab/attempt-u4',
      },
    )
    .branchCleanup('u4', 'ab/attempt-u4').events
}
