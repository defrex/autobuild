import { describe, expect, test } from 'bun:test'
import {
  PLUGIN_API_VERSION,
  parsePluginManifest,
  pluginApiCompatibility,
  PluginApiCompatibilityError,
  type AutobuildPluginManifest,
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
    expect(PLUGIN_API_VERSION).toBe('1.1.0')
  })

  test('accepts legacy factories and strict contract descriptors on every port', () => {
    const contractFactory = (() => async () => ({})) as never
    const portFactory = (() => ({})) as never
    const manifest = {
      name: 'contract-bearing',
      apiVersion: '^1.1.0',
      ticketSources: {
        legacy: factory,
        jira: { factory, contract: { factory: contractFactory } },
      },
      agentRuntimes: {
        remote: { factory: portFactory, contract: { factory: contractFactory, live: true } },
      },
      workspaceProviders: {
        container: { factory: portFactory, contract: { factory: contractFactory } },
      },
      forges: {
        gitlab: { factory: portFactory, contract: { factory: contractFactory } },
      },
    } satisfies AutobuildPluginManifest
    const parsed = parsePluginManifest(manifest)
    expect(typeof parsed.ticketSources?.legacy).toBe('function')
    expect(parsed.agentRuntimes?.remote).toEqual(manifest.agentRuntimes.remote)
  })

  test('contract descriptor validation is nested, strict, and actionable', () => {
    expect(() => parsePluginManifest({
      name: 'bad-contract',
      apiVersion: '^1.1.0',
      ticketSources: {
        jira: { factory, contract: { live: false } },
      },
    })).toThrow(/factory function/i)
    expect(() => parsePluginManifest({
      name: 'extra-contract',
      apiVersion: '^1.1.0',
      forges: {
        gitlab: { factory, contract: { factory, unsafe: true } },
      },
    })).toThrow(/unrecognized key/i)
  })

  test('returns structured compatibility status', () => {
    expect(pluginApiCompatibility('^1.0.0')).toMatchObject({
      hostVersion: '1.1.0',
      status: 'compatible',
    })
    expect(pluginApiCompatibility('not-semver').status).toBe('invalid')
    try {
      parsePluginManifest({ name: 'future', apiVersion: '^2.0.0' })
      throw new Error('expected incompatibility')
    } catch (error) {
      expect(error).toBeInstanceOf(PluginApiCompatibilityError)
      expect((error as PluginApiCompatibilityError).compatibility.status).toBe('incompatible')
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
