import { expect, test } from 'bun:test'
import { activeSection } from './docs-client'

test('section selection clamps boundaries and follows the reading offset', () => {
  expect(activeSection([], 24)).toBe(-1)
  expect(activeSection([100, 400, 800], 24)).toBe(0)
  expect(activeSection([-300, 24, 424], 24)).toBe(1)
  expect(activeSection([-400, -100, 40], 24)).toBe(1)
  expect(activeSection([-400, -100, 40], 24, true)).toBe(2)
  expect(activeSection([-800, -400, 20], 24)).toBe(2)
})
