import { expect, test } from 'bun:test'
import { readJsonFixtures } from './protocol-read-json-fixtures'
import { resolve } from 'node:path'
test('persisted inner JSON grammar retains Bun code-unit diagnostics', async () => {
  const fixture = readJsonFixtures()
  expect(fixture.cases).toHaveLength(1342)
  expect(fixture).toEqual(
    await Bun.file(resolve(import.meta.dir, '../fixtures/protocol-read-json.json')).json(),
  )
})
