import { expect, test } from 'bun:test'
import { activeCounterText } from './configuration'

test('the Active counter shows occupancy against capacity once a run supplies one', () => {
  expect(activeCounterText({ active: { current: 2, limit: 5 } })).toBe('2/5')
})

test('the Active counter is a dash while no dispatcher has run', () => {
  expect(
    activeCounterText({ active: { current: 0, limit: 0 }, configuration: 'no-dispatcher-run' }),
  ).toBe('–')
})
