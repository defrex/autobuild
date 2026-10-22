import { expect, test } from 'bun:test'
import { forgeHotspot, forgeRequestCountsSchema } from './forge-telemetry'

test('request hotspots require at least two requests and a strict majority of attributed traffic', () => {
  expect(forgeHotspot(undefined)).toBeUndefined()
  const counts = {
    total: 10,
    unattributed: 6,
    complete: true,
    builds: [
      { build: 'a', requests: 2 },
      { build: 'b', requests: 2 },
    ],
  }
  expect(forgeHotspot(counts)).toBeUndefined()
  expect(
    forgeHotspot({
      ...counts,
      builds: [
        { build: 'a', requests: 3 },
        { build: 'b', requests: 1 },
      ],
    }),
  ).toBe('a')
  expect(
    forgeHotspot({ ...counts, total: 7, builds: [{ build: 'a', requests: 1 }] }),
  ).toBeUndefined()
  expect(forgeRequestCountsSchema.safeParse({ ...counts, total: -1 }).success).toBe(false)
  expect(
    forgeRequestCountsSchema.safeParse({
      ...counts,
      builds: Array.from({ length: 11 }, (_, i) => ({ build: String(i), requests: 1 })),
    }).success,
  ).toBe(false)
})

test('historical counts retain unknown categories and new counts round trip', () => {
  const old = { total: 5, unattributed: 5, builds: [], complete: true }
  expect(forgeRequestCountsSchema.parse(old)).toEqual(old)
  const current = { ...old, restPrimary: 1, restNotModified: 2, graphql: 1 }
  expect(forgeRequestCountsSchema.parse(JSON.parse(JSON.stringify(current)))).toEqual(current)
  for (const key of ['restPrimary', 'restNotModified', 'graphql']) {
    expect(forgeRequestCountsSchema.safeParse({ ...current, [key]: -1 }).success).toBe(false)
  }
})
