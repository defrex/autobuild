import { expect, test } from 'bun:test'
import {
  checkReducerUnicodeFixtures,
  reducerUnicodeFixtures,
} from './protocol-reducer-unicode-fixtures'
test('Unicode reducer argument, replay and Bun syntax oracles stay fresh', () => {
  checkReducerUnicodeFixtures()
  const fixture = reducerUnicodeFixtures()
  expect(fixture.cases).toHaveLength(64)
  expect(fixture.replay).toHaveLength(34)
  expect(fixture.syntax).toHaveLength(9)
})
