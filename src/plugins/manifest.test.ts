import { describe, expect, test } from 'bun:test'
import {
  PLUGIN_API_VERSION,
  parsePluginManifest,
  type TicketSourcePluginFactory,
} from './manifest'

const factory = (() => ({})) as unknown as TicketSourcePluginFactory

describe('plugin manifest', () => {
  test('accepts legacy and descriptor ticket sources in a compatible manifest', () => {
    const parsed = parsePluginManifest({
      name: 'acme-tools',
      apiVersion: '^1.0.0',
      ticketSources: {
        legacy: factory,
        jira: { factory, requiredEnv: ['JIRA_TOKEN', 'JIRA_SITE'] },
      },
      forges: { gitlab: factory },
    })
    expect(parsed.name).toBe('acme-tools')
    expect(Object.keys(parsed.ticketSources ?? {})).toEqual(['legacy', 'jira'])
    expect(parsed.ticketSources?.jira).toEqual({
      factory,
      requiredEnv: ['JIRA_TOKEN', 'JIRA_SITE'],
    })
    expect(PLUGIN_API_VERSION).toBe('1.1.0')
  })

  test('descriptor validation is strict and environment names are nonblank and unique', () => {
    for (const descriptor of [
      { factory, extra: true },
      { factory, requiredEnv: [''] },
      { factory, requiredEnv: ['TOKEN', 'TOKEN'] },
      { factory: 'not-a-function' },
    ]) {
      expect(() =>
        parsePluginManifest({
          name: 'bad-ticket-source',
          apiVersion: '^1.1.0',
          ticketSources: { jira: descriptor },
        }),
      ).toThrow()
    }
  })

  test('rejects malformed, invalid-range, and incompatible manifests', () => {
    expect(() => parsePluginManifest({ name: 'x', apiVersion: '^1', extra: true })).toThrow()
    expect(() => parsePluginManifest({ name: 'x', apiVersion: 'not-semver' })).toThrow(
      /invalid plugin API range.*host provides 1\.1\.0/,
    )
    expect(() => parsePluginManifest({ name: 'future', apiVersion: '^2.0.0' })).toThrow(
      /future.*\^2\.0\.0.*1\.1\.0/,
    )
  })
})
