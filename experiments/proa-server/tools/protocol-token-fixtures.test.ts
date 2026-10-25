import { expect, test } from 'bun:test'
import { checkTokenFixtures, tokenFixtures } from './protocol-token-fixtures'
test('signed token and delegation target oracles remain fresh', () => {
  checkTokenFixtures()
  const f = tokenFixtures()
  expect(f.cases).toHaveLength(107)
  expect(f.mint).toHaveLength(4)
  expect(f.targets).toHaveLength(9)
})
