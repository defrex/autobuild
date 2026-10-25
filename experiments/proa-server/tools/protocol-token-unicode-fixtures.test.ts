import { expect, test } from 'bun:test'
import { checkTokenUnicodeFixtures, tokenUnicodeFixtures } from './protocol-token-unicode-fixtures'
test('signed Unicode token claims use independent source oracles', () => {
  checkTokenUnicodeFixtures()
  const fixture = tokenUnicodeFixtures()
  expect(fixture.verify).toHaveLength(100)
  expect(fixture.mint).toHaveLength(100)
  expect(fixture.targets).toHaveLength(20)
})
