import { expect, test } from 'bun:test'
import { checkBlobProviderFixtures } from './protocol-blob-fixtures'

test('pinned whole-Buffer provider request oracle remains fresh', () => {
  expect(checkBlobProviderFixtures().cases.length).toBe(8)
})
