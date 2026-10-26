import { expect, test } from 'bun:test'
import {
  checkPersistedReducerFixtures,
  persistedReducerFixtures,
} from './protocol-persisted-reducer-fixtures'
test('all named reducers retain source persisted Unicode values', () => {
  checkPersistedReducerFixtures()
  const fixture = persistedReducerFixtures()
  expect(fixture.cases).toHaveLength(25895)
  expect(new Set(fixture.cases.map((row) => row.reducer)).size).toBe(42)
})
