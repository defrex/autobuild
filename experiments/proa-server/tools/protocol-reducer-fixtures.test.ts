import { test, expect } from 'bun:test'
import { checkReducerFixtures, readReducerFixtures } from './protocol-reducer-fixtures'
test('reducer catalog and native replay oracles remain fresh', () => {
  checkReducerFixtures()
  const fixtures = readReducerFixtures()
  expect(fixtures.replay.length).toBeGreaterThan(1000)
  expect(Number(fixtures.supported.length)).toBe(
    Object.values(fixtures.catalog).filter((entry) => !('excluded' in entry)).length,
  )
})
