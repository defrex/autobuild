import { describe, expect, test } from 'bun:test'
import {
  PLUGIN_API_VERSION,
  parsePluginManifest,
  type TicketSourcePluginFactory,
} from './manifest'

const factory = (() => ({})) as unknown as TicketSourcePluginFactory

describe('plugin manifest', () => {
  test('accepts a strict compatible multi-port manifest', () => {
    const parsed = parsePluginManifest({
      name: 'acme-tools',
      apiVersion: '^1.0.0',
      ticketSources: { jira: factory },
      forges: { gitlab: factory },
    })
    expect(parsed.name).toBe('acme-tools')
    expect(Object.keys(parsed.ticketSources ?? {})).toEqual(['jira'])
    expect(PLUGIN_API_VERSION).toBe('1.0.0')
  })

  test('rejects malformed, invalid-range, and incompatible manifests', () => {
    expect(() => parsePluginManifest({ name: 'x', apiVersion: '^1', extra: true })).toThrow()
    expect(() => parsePluginManifest({ name: 'x', apiVersion: 'not-semver' })).toThrow(
      /invalid plugin API range.*host provides 1\.0\.0/,
    )
    expect(() => parsePluginManifest({ name: 'future', apiVersion: '^2.0.0' })).toThrow(
      /future.*\^2\.0\.0.*1\.0\.0/,
    )
  })
})
