import { expect, test } from 'bun:test'
import { orderStates, resolveState, validateStateName, validateStatePurpose } from './states'

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
