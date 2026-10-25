import { expect, test } from 'bun:test'
import { checkTickFixtures, tickFixtures } from './protocol-tick-fixtures'

test('atomic tick boundaries match the core validation oracle', () => {
  checkTickFixtures()
  const cases = tickFixtures().cases
  expect(cases.length).toBeGreaterThanOrEqual(25)
  expect(cases.filter((item) => 'accepted' in (item.oracle as object)).length).toBeGreaterThan(4)
})
