import { test, expect } from 'bun:test'
import {
  checkStreamDocumentFixtures,
  streamDocumentFixtures,
} from './protocol-stream-document-fixtures'
test('every pinned SDK stream chunk and assembly document remains covered', async () => {
  await checkStreamDocumentFixtures()
  const fixture = await streamDocumentFixtures()
  expect(fixture.classified.length).toBeGreaterThan(700)
  expect(fixture.assembled.length).toBeGreaterThan(200)
})
