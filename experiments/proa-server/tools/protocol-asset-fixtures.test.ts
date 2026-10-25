import { expect, test } from 'bun:test'
import { assetFixtures, checkAssetFixtures } from './protocol-asset-fixtures'
test('ticket asset structure oracle remains fresh', () => {
  checkAssetFixtures()
  expect(assetFixtures().cases.length).toBeGreaterThan(50)
})
