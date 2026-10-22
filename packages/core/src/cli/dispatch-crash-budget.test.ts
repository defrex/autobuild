import { expect, test } from 'bun:test'
import { DispatchCrashBudget } from './dispatch-crash-budget'
const anchor = '2026-01-01T00:00:00.000Z'
const now = Date.parse(anchor)
test('three distinct failures use the original takeover anchor, inclusive at ten minutes', () => {
  const budget = new DispatchCrashBudget(anchor)
  expect(budget.failed('one', now)).toBe('restart')
  expect(budget.failed('one', now + 1)).toBeUndefined()
  expect(budget.failed('two', now + 59_999)).toBe('restart')
  expect(budget.failed('three', now + 600_000)).toBe('rollback')
})
test('expired and invalid clocks never roll back or refresh the anchor', () => {
  const budget = new DispatchCrashBudget(anchor)
  expect(budget.failed('negative', now - 1)).toBeUndefined()
  expect(budget.failed('one', now)).toBe('restart')
  expect(budget.failed('two', now + 599_999)).toBe('restart')
  expect(budget.failed('three', now + 600_001)).toBeUndefined()
  expect(budget.failed('four', now + 700_000)).toBeUndefined()
})
