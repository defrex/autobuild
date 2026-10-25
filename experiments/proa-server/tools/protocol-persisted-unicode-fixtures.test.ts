import { expect, test } from 'bun:test'
import {
  checkPersistedUnicodeFixtures,
  persistedUnicodeFixtures,
} from './protocol-persisted-unicode-fixtures'
test('permissive persisted payload Unicode oracles stay fresh', () => {
  checkPersistedUnicodeFixtures()
  const fixture = persistedUnicodeFixtures()
  expect(fixture.cases).toHaveLength(4103)
  expect(fixture.cases.filter((row) => row.expected !== undefined)).toHaveLength(2988)
  expect(new Set(fixture.cases.map((row) => row.scope))).toEqual(
    new Set(['build', 'repository', 'session']),
  )
})
