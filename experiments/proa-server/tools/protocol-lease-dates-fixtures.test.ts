import { test, expect } from 'bun:test'
import { leaseDateFixtures } from './protocol-lease-dates-fixtures'
test('full JS Date range matches current Bun', async () => {
  const stored = await Bun.file(
    new URL('../fixtures/protocol-lease-dates.json', import.meta.url),
  ).json()
  expect(leaseDateFixtures()).toEqual(stored)
})
