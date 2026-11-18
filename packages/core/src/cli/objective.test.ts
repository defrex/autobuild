import { expect, test } from 'bun:test'
import { projectTicketTree } from '../ports/tickets/tree'
import type { Ticket } from '../ports/types'
import { parseArgs } from './args'
import { commandObjective, OptimizationLogBuilder } from '../kernel/generators/optimization-log'
import { optimizationReducer } from '../kernel/optimization'
import { objectiveView } from '../operator/optimization'
import {
  OBJECTIVE_FLAGS,
  OBJECTIVE_USAGE,
  objectiveChangesFromFlags,
  objectiveSettleFromFlags,
  objectiveStopFromFlags,
  renderObjective,
} from './objective'

const flags = (...argv: string[]) =>
  objectiveChangesFromFlags(parseArgs(['node', ...argv], OBJECTIVE_FLAGS, OBJECTIVE_USAGE))

test('objective flags map to revisable fields', () => {
  expect(flags()).toEqual({})
  expect(
    flags(
      '--threshold',
      '35',
      '--epsilon',
      '2',
      '--max-attempts',
      '90',
      '--max-hours',
      '1.5',
      '--plateau',
      '8',
      '--stop-mode',
      'drain',
      '--concurrency',
      '3',
    ),
  ).toEqual({
    threshold: 35,
    epsilon: { absolute: 2 },
    maxAttempts: 90,
    maxHours: 1.5,
    plateau: 8,
    stopMode: 'drain',
    concurrency: 3,
  })
  expect(flags('--epsilon', '3%')).toEqual({ epsilon: { relative: 0.03 } })
  expect(() => flags('--threshold', 'fast')).toThrow('--threshold must be a number')
  expect(() => flags('--stop-mode', 'pause')).toThrow('--stop-mode must be abort or drain')
})

test('stop flags select the mode and refuse misuse', () => {
  const stop = (...argv: string[]) =>
    objectiveStopFromFlags(parseArgs(['node', ...argv], OBJECTIVE_FLAGS, OBJECTIVE_USAGE))
  expect(stop()).toBeUndefined()
  expect(stop('--stop')).toEqual({})
  expect(stop('--stop', '--drain')).toEqual({ mode: 'drain' })
  expect(stop('--stop', '--abort')).toEqual({ mode: 'abort' })
  expect(() => stop('--drain')).toThrow('--drain requires --stop')
  expect(() => stop('--abort')).toThrow('--abort requires --stop')
  expect(() => stop('--stop', '--drain', '--abort')).toThrow('--drain and --abort are exclusive')
  expect(() => stop('--stop', '--threshold', '30')).toThrow(
    '--stop cannot be combined with a revision',
  )
})

test('a stopped node renders what still blocks completion', () => {
  const builder = new OptimizationLogBuilder()
    .accept(commandObjective(), 1)
    .propose('r', ['a'])
    .stop('operator', 'drain')
  const render = () =>
    renderObjective(
      objectiveView('node', optimizationReducer.reduce(builder.events)!, new Date()),
    ).filter((line) => line.includes('stopped:') || line.includes('completion:'))
  expect(render()).toEqual([
    expect.stringContaining('stopped: operator (drain)'),
    '  completion: attempts still in flight: T-a',
  ])
  builder.settle('a', 'stopped')
  expect(render()[1]).toBe('  completion: ready for node verification')
  const running = new OptimizationLogBuilder().accept(commandObjective(), 1)
  expect(
    renderObjective(
      objectiveView('node', optimizationReducer.reduce(running.events)!, new Date()),
    ).some((line) => line.includes('completion:')),
  ).toBe(false)
})

test('the ticket tree labels only node tickets carrying exactly one objective block', () => {
  const ticket = (id: string, kind: 'work' | 'node', body: string): Ticket => ({
    revision: 'r',
    ref: { source: 'fake', id },
    title: id,
    body,
    state: 'Ready',
    resolved: false,
    labels: [],
    kind,
  })
  const block = '```autobuild-objective\npurpose = "x"\n```'
  const tree = projectTicketTree(
    [
      ticket('OPT', 'node', block),
      ticket('PLAIN', 'node', '## Objective\n\n```toml\npurpose = "x"\n```'),
      ticket('TWO', 'node', `${block}\n${block}`),
      ticket('WORK', 'work', block),
    ],
    'main',
  )
  expect(
    Object.fromEntries(tree.children.map((entry) => [entry.ticket.ref.id, entry.optimization])),
  ).toEqual({
    OPT: true,
    PLAIN: undefined,
    TWO: undefined,
    WORK: undefined,
  })
})

test('settle flags require an explicit policy and stand alone', () => {
  const settle = (...argv: string[]) =>
    objectiveSettleFromFlags(parseArgs(['node', ...argv], OBJECTIVE_FLAGS, OBJECTIVE_USAGE))
  expect(settle()).toBeUndefined()
  expect(settle('--settle-unmeasured', 'p1', '--policy', 'release-unmeasured')).toEqual({
    attempt: 'p1',
    policy: 'release-unmeasured',
  })
  expect(
    settle('--settle-unmeasured', 'b', '--policy', 'release-unmeasured', '--note', 'why'),
  ).toEqual({ attempt: 'b', policy: 'release-unmeasured', note: 'why' })
  expect(() => settle('--settle-unmeasured', 'p1')).toThrow('requires an explicit --policy')
  expect(() => settle('--policy', 'release-unmeasured')).toThrow(
    '--policy requires --settle-unmeasured',
  )
  expect(() => settle('--note', 'x')).toThrow('--note requires --settle-unmeasured')
  expect(() =>
    settle('--settle-unmeasured', 'p1', '--policy', 'release-unmeasured', '--stop'),
  ).toThrow('cannot be combined with --stop')
  expect(() =>
    settle('--settle-unmeasured', 'p1', '--policy', 'release-unmeasured', '--threshold', '3'),
  ).toThrow('cannot be combined with a revision')
})

test('unmeasured merges and pending branch cleanups render with why the slot is held', () => {
  const builder = new OptimizationLogBuilder()
    .accept(commandObjective(), 1)
    .propose('r', ['a', 'b', 'c'])
    .markUnmeasured('a', 'stale-head', 'd'.repeat(40), 'c'.repeat(40))
    .markUnmeasured('b', 'unresolvable', undefined)
    .settle('c', 'declined', undefined, undefined, { branch: 'ab/attempt-c' })
    .branchCleanup('c', 'ab/attempt-c', 'forge down')
  const lines = renderObjective(
    objectiveView('node', optimizationReducer.reduce(builder.events)!, new Date()),
  )
  expect(lines).toContain(
    `  unmeasured merge: a (attempt-a) merged ${'d'.repeat(40)}, its landing measurement measured ${'c'.repeat(40)}; holds a concurrency slot until settled with --settle-unmeasured a --policy release-unmeasured`,
  )
  expect(lines).toContain(
    '  unmeasured merge: b (attempt-b) has no recorded merged head, its merged head was never recorded; holds a concurrency slot until settled with --settle-unmeasured b --policy release-unmeasured',
  )
  expect(lines).toContain('  branch cleanup pending: ab/attempt-c (attempt-c): forge down')
  builder.settle('a', 'merged-unmeasured', undefined, undefined, { policy: 'release-unmeasured' })
  expect(
    renderObjective(
      objectiveView('node', optimizationReducer.reduce(builder.events)!, new Date()),
    ).find((line) => line.startsWith('  attempts:')),
  ).toBe('  attempts: 3 filed, 0 accepted, 1 rejected, 1 running, 1 merged unmeasured')
})
