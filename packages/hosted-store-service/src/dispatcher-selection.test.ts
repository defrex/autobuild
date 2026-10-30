import { expect, test } from 'bun:test'
import {
  dispatcherSelection,
  parseDispatcherRepositories,
  dispatcherOrigin,
} from './dispatcher-selection'
const one = 'https://github.com/acme/one',
  two = 'https://github.com/acme/two'
test('shared selection normalizes, deduplicates and intersects only registered projects', () => {
  const values = parseDispatcherRepositories(`git@github.com:acme/one.git, ${one}, ${two}`)
  expect(values).toEqual([one, two])
  expect(dispatcherSelection(values).filter([two])).toEqual([two])
  expect(dispatcherSelection(undefined).filter([one])).toEqual([one])
  expect(dispatcherSelection(undefined).filter([one, two])).toEqual([one, two])
  expect(dispatcherSelection([one]).includes(two)).toBe(false)
  expect(dispatcherSelection(undefined).includes(two)).toBe(true)
  for (const raw of ['', ',', `${one},`, 'file:///tmp'])
    expect(() => parseDispatcherRepositories(raw)).toThrow()
  expect(() => dispatcherOrigin({ AB_DISPATCHER_ORIGIN: 'https://user:pass@host' })).toThrow()
})
