/**
 * Test support for the incremental-reducer property tests of the small
 * selector projections: build and repository event generators drawn from
 * small value pools (so correlations happen), seeded, and shuffled to prove
 * the carried state reproduces the whole-array result for any array order.
 * Imported only by tests. Events are cast, not validated: the projections
 * under test read only the fields the generators set.
 */
import type { AbEvent } from '../events/catalog'
import { KERNEL } from '../events/envelope'
import type { RepositoryEvent } from '../events/repository'
import { expect } from 'bun:test'
import { checkIncremental, pick, seededRandom, shuffled } from './incremental-contract'
import type { IncrementalReducer } from './incremental'

export type Rand = () => number

export function buildLog(
  items: ReadonlyArray<readonly [string, Record<string, unknown>]>,
): AbEvent[] {
  return items.map(
    ([type, payload], index) =>
      ({
        build: 'b',
        seq: index + 1,
        ts: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        actor: KERNEL,
        type,
        payload,
      }) as unknown as AbEvent,
  )
}

export function repoLog(
  items: ReadonlyArray<readonly [string, Record<string, unknown>]>,
): RepositoryEvent[] {
  return items.map(
    ([type, payload], index) =>
      ({
        repo: 'r',
        seq: index + 1,
        ts: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        actor: KERNEL,
        type,
        payload,
      }) as unknown as RepositoryEvent,
  )
}

/** For each seed: an ordered log and two shuffled copies of it (seq is
 * assigned before shuffling, so shuffled arrays carry out-of-order seqs). */
export function generatedLogs<E>(
  make: (items: ReadonlyArray<readonly [string, Record<string, unknown>]>) => E[],
  item: (rand: Rand) => readonly [string, Record<string, unknown>],
  seeds: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
): E[][] {
  const out: E[][] = []
  for (const seed of seeds) {
    const rand = seededRandom(seed)
    const length = 4 + Math.floor(rand() * 16)
    const ordered = make(Array.from({ length }, () => item(rand)))
    out.push(ordered, shuffled(rand, ordered), shuffled(rand, ordered))
  }
  return out
}

/** A random build event of the kinds the process-layer selectors read. */
export function randomBuildItem(rand: Rand): readonly [string, Record<string, unknown>] {
  const instance = pick(rand, ['i1', 'i2'])
  const attempt = 1 + Math.floor(rand() * 3)
  const id = pick(rand, ['e1', 'e2', 'e3'])
  const sha = pick(rand, ['s1', 's2', 's3', 's4'])
  const ref = pick(rand, ['/ws/a', '/ws/b'])
  const marker = pick(rand, [
    'auto-merge-gate:pr:7:command:1',
    'auto-merge-gate:pr:7:command:2',
    'other',
  ])
  const assets = () =>
    rand() < 0.3
      ? undefined
      : [
          { kind: 'doc', name: pick(rand, ['a', 'b']), revision: 1 + Math.floor(rand() * 3) },
          ...(rand() < 0.5 ? [{ kind: 'img', name: 'c', revision: 1 }] : []),
        ]
  const templates: Array<() => readonly [string, Record<string, unknown>]> = [
    () => ['build.created', { baseBranch: pick(rand, ['main', 'dev']), assets: assets() }],
    () => ['spec.revised', { artifact: { kind: 'spec', rev: 1 }, escalation: 1, assets: assets() }],
    () => [
      'execution.started',
      {
        provider: 'p',
        workspaceRef: ref,
        instance,
        ...(rand() < 0.5 ? { environmentId: 'env' } : {}),
        ...(rand() < 0.5 ? { sessionId: 'sess' } : {}),
        ...(rand() < 0.5 ? { commandId: 'cmd' } : {}),
      },
    ],
    () => [
      'execution.ended',
      { instance, workspaceRef: ref, outcome: pick(rand, ['completed', 'stopped', 'lost']) },
    ],
    () => [
      'workspace.provisioned',
      {
        provider: 'p',
        ref,
        ...(rand() < 0.5 ? { path: '/p' } : {}),
        branch: 'ab/x',
        base: { source: 'remote', sha },
      },
    ],
    () => ['workspace.released', {}],
    () => ['workspace.provision-started', { provider: 'p', branch: 'ab/x', generation: attempt }],
    () => ['implement.completed', { round: 1, commits: { base: 'b', head: sha }, artifact: {} }],
    () => ['reconcile.started', { attempt, baseSha: sha }],
    () => ['reconcile.completed', { mergeCommit: sha, artifact: {} }],
    () => [
      'finalize.step-completed',
      { step: 'n', ok: rand() < 0.7, ...(rand() < 0.7 ? { headSha: sha } : {}) },
    ],
    () => ['finalize.completed', { pr: { number: 7, url: 'u', headSha: sha } }],
    () => ['pr.merged', { sha }],
    () => ['pr.closed', {}],
    () => ['runner.attached', { instance, host: 'h' }],
    () => ['runner.setup-failed', { command: 'c', attempt, exitStatus: 1, output: '' }],
    () => [
      'escalation.raised',
      {
        id,
        phase: pick(rand, ['setup', 'plan', 'implement', 'verify:unit']),
        source: pick(rand, ['policy', 'agent']),
        ...(rand() < 0.7
          ? { policyCause: pick(rand, ['infrastructure-failure-limit', 'setup-failure-limit']) }
          : {}),
        ...(rand() < 0.5 ? { round: 1 } : {}),
        question: 'q',
      },
    ],
    () => [
      'escalation.answered',
      { id, answer: 'a', resolution: pick(rand, ['retry', 'guidance', 'abort']) },
    ],
    () => [
      'phase.failed',
      {
        phase: pick(rand, ['plan', 'implement']),
        round: 1 + Math.floor(rand() * 2),
        attempt,
        error: `err${attempt}`,
        willRetry: rand() < 0.5,
        ...(rand() < 0.5 ? { providerAttempts: [{ index: 1, runner: 'r', error: 'e' }] } : {}),
      },
    ],
    () => ['observation.recorded', { id: 'o', kind: 'followup', summary: 's', refs: [marker] }],
    () => ['observation.recorded', { id: 'o2', kind: 'refactor', summary: 's' }],
    () => ['session.started', { session: 's', role: 'r', runner: 'c', phase: 'plan' }],
  ]
  return pick(rand, templates)()
}

/** A random repository-journal event of the kinds the repo selectors read. */
export function randomRepoItem(rand: Rand): readonly [string, Record<string, unknown>] {
  const execution = pick(rand, ['x1', 'x2', 'x3'])
  const run = pick(rand, ['r1', 'r2'])
  const templates: Array<() => readonly [string, Record<string, unknown>]> = [
    () => [
      'harvest.execution.started',
      {
        execution,
        provider: 'p',
        environmentId: 'env',
        ...(rand() < 0.5 ? { sessionId: 'sess' } : {}),
        ...(rand() < 0.5 ? { commandId: 'cmd' } : {}),
      },
    ],
    () => [
      'harvest.execution.released',
      { execution, environmentId: 'env', snapshots: { outcome: 'confirmed' } },
    ],
    () => ['dispatcher.tick-started', { run }],
    () => ['dispatcher.tick-completed', { run, queued: 0 }],
    () => ['dispatcher.tick-failed', { run, error: 'x' }],
    () => ['dispatcher.tick-yielded', { holder: 'h' }],
    () => ['dispatcher.operator-reported', { run, level: 'info', message: 'm' }],
    () => ['dispatcher.auto-merge-default-set', { enabled: rand() < 0.5 }],
    () => ['dispatcher.intake-set', { enabled: rand() < 0.5 }],
  ]
  return pick(rand, templates)()
}

/** Run the incremental contract over every log, and hold the result to an
 * independent reference implementation of the original whole-array function. */
export function checkAgainstReference<Acc, Event, State>(
  reducer: IncrementalReducer<Acc, Event, State>,
  logs: readonly (readonly Event[])[],
  reference: (events: readonly Event[]) => State,
  normalize: (state: State) => unknown = (state) => state,
): void {
  for (const log of logs) {
    const expected = normalize(reference(log))
    expect(normalize(reducer.reduce(log))).toEqual(expected)
    checkIncremental(reducer, log, {
      compare: (actual, oracle) => {
        expect(normalize(actual)).toEqual(normalize(oracle))
        expect(normalize(actual)).toEqual(expected)
      },
    })
  }
}
