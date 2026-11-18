import { expect, test } from 'bun:test'
import { projectTicketTree } from '../ports/tickets/tree'
import type { Ticket } from '../ports/types'
import { parseArgs } from './args'
import { OBJECTIVE_FLAGS, OBJECTIVE_USAGE, objectiveChangesFromFlags } from './objective'

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
