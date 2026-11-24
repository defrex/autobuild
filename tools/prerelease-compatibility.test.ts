import { expect, test } from 'bun:test'
import {
  supportedPublishedLines,
  type ReleasedClient,
} from '../packages/core/src/store/remote/released-clients'

test('prerelease compatibility artifacts cannot retire stable clients or reset their clocks', () => {
  const release = (version: string, publishedAt: string): ReleasedClient => ({
    version,
    publishedAt,
    protocol: '6',
    contract: 'shared.json',
    provenance: { tag: `v${version}` },
  })
  const first = release('1.2.0', '2026-01-01T00:00:00.000Z')
  const successor = release('1.3.0', '2026-01-02T00:00:00.000Z')
  const preview = release('2.0.0-beta.0', '2026-01-03T00:00:00.000Z')
  const now = Date.parse('2026-04-02T00:00:00.000Z')
  expect(supportedPublishedLines('2.0.0-beta.0', now, [first, successor, preview])).toEqual([
    '1.2.0',
    '1.3.0',
  ])
  const stable = release('2.0.0', '2026-04-01T00:00:00.000Z')
  expect(supportedPublishedLines('2.0.0', now, [first, successor, preview, stable])).toEqual([
    '1.3.0',
    '2.0.0',
  ])
})
