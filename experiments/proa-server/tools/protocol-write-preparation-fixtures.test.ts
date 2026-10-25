import { expect, test } from 'bun:test'
import {
  checkPreparationFixtures,
  preparationFixtures,
} from './protocol-write-preparation-fixtures'

test('prepared producer policy and strict metadata inputs remain fresh', () => {
  checkPreparationFixtures()
  const fixture = preparationFixtures()
  expect(Object.keys(fixture.policies.build).length).toBeGreaterThan(100)
  expect(Object.keys(fixture.policies.repository).length).toBeGreaterThan(50)
  expect(
    fixture.cases.some(
      (row) =>
        row.scope === 'created' && row.id === 'created/wrong-type' && 'rejected' in row.oracle,
    ),
  ).toBe(true)
  expect(
    fixture.cases.some((row) => row.id === 'build/metadata/historical' && 'accepted' in row.oracle),
  ).toBe(true)
})
