import { expect, test } from 'bun:test'
import { checkJsonNumberFixtures, jsonNumberFixtures } from './protocol-json-number-fixtures'
test('raw JSON IEEE-754 and nonfinite transport fixtures remain fresh', () => {
  checkJsonNumberFixtures()
  expect(jsonNumberFixtures().cases.length).toBeGreaterThan(50)
})
