import { expect, test } from 'bun:test'
import {
  matchStateNames,
  orderStates,
  resolveState,
  triageStateCount,
  validateStateName,
  validateStatePurpose,
} from './states'

test('custom state names and purposes share file rules', () => {
  for (const name of ['a', 'a'.repeat(40), 'icebox-2'])
    expect(() => validateStateName(name)).not.toThrow()
  for (const name of ['', 'A', 'a'.repeat(41), '-a', 'a/b', 'a b', 'é'])
    expect(() => validateStateName(name)).toThrow('invalid state name')
  expect(validateStatePurpose('  Deferred  ')).toBe('Deferred')
  for (const about of ['', ' ', 'a\nb', 'a\rb'])
    expect(() => validateStatePurpose(about)).toThrow('one nonblank line')
})

test('ordering follows supplied lifecycle and folded lookup requires a unique match', () => {
  expect(
    orderStates(
      ['icebox', 'ready', 'Todo', 'Backlog', 'Done', 'aaa'],
      ['Backlog', 'Todo', 'Todo', 'Done'],
    ),
  ).toEqual(['Backlog', 'Todo', 'Done', 'aaa', 'icebox', 'ready'])
  expect(resolveState('todo', ['Todo'])).toBe('Todo')
  expect(resolveState('Todo', ['Todo', 'TODO'])).toBe('Todo')
  expect(() => resolveState('todo', ['Todo', 'TODO'])).toThrow('ambiguous')
  expect(() => resolveState('missing', ['Todo'])).toThrow('Todo')
})

test('triage count matches like resolveState and reports unknown without a unique match', () => {
  const states = [
    { name: 'triage', tickets: 3 },
    { name: 'ready', tickets: 0 },
  ]
  expect(triageStateCount(states, 'triage')).toBe(3)
  expect(triageStateCount(states, 'Triage')).toBe(3)
  expect(triageStateCount(states, 'ready')).toBe(0)
  expect(triageStateCount(states, 'inbox')).toBeUndefined()
  expect(
    triageStateCount(
      [
        { name: 'Triage', tickets: 1 },
        { name: 'TRIAGE', tickets: 2 },
      ],
      'triage',
    ),
  ).toBeUndefined()
  expect(
    triageStateCount(
      [
        { name: 'Triage', tickets: 1 },
        { name: 'triage', tickets: 2 },
      ],
      'triage',
    ),
  ).toBe(2)
})

test('matchStateNames resolves canonical names in request order and drops misses', () => {
  const existing = ['Triage', 'Ready', 'icebox', 'Done', 'DONE']
  expect(matchStateNames(['triage', 'ICEBOX', 'Triage', 'missing'], existing)).toEqual([
    'Triage',
    'icebox',
  ])
  expect(matchStateNames(['done'], existing)).toEqual([])
  expect(matchStateNames(['Done'], existing)).toEqual(['Done'])
})
