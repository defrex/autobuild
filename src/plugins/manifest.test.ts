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
    expect(PLUGIN_API_VERSION).toBe('1.2.0')
  })

  test('ticket descriptor validation is strict and environment names are nonblank and unique', () => {
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

  test('accepts legacy factories and strict contract descriptors on every port', () => {
    const contractFactory = (() => async () => ({})) as never
    const portFactory = (() => ({})) as never
    const manifest = {
      name: 'contract-bearing',
      apiVersion: '^1.1.0',
      ticketSources: {
        legacy: factory,
        jira: {
          factory,
          requiredEnv: ['JIRA_TOKEN'],
          contract: { factory: contractFactory },
        },
      },
      agentRuntimes: {
        remote: {
          factory: portFactory,
          contract: { factory: contractFactory, live: true },
        },
      },
      workspaceProviders: {
        container: {
          factory: portFactory,
          contract: { factory: contractFactory },
        },
      },
      forges: {
        gitlab: {
          factory: portFactory,
          contract: { factory: contractFactory },
        },
      },
    } satisfies AutobuildPluginManifest
    const parsed = parsePluginManifest(manifest)
    expect(typeof parsed.ticketSources?.legacy).toBe('function')
    expect(parsed.ticketSources?.jira).toEqual(manifest.ticketSources.jira)
    expect(parsed.agentRuntimes?.remote).toEqual(manifest.agentRuntimes.remote)
  })

  test('contract descriptor validation is nested, strict, and actionable', () => {
    expect(() =>
      parsePluginManifest({
        name: 'bad-contract',
        apiVersion: '^1.1.0',
        ticketSources: {
          jira: { factory, contract: { live: false } },
        },
      }),
    ).toThrow(/factory function/i)
    expect(() =>
      parsePluginManifest({
        name: 'extra-contract',
        apiVersion: '^1.1.0',
        forges: {
          gitlab: { factory, contract: { factory, unsafe: true } },
        },
      }),
    ).toThrow(/unrecognized key/i)
  })

  test('returns structured compatibility status', () => {
    expect(pluginApiCompatibility('^1.0.0')).toMatchObject({
      hostVersion: '1.2.0',
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
      /invalid plugin API range.*host provides 1\.2\.0/,
    )
    expect(() => parsePluginManifest({ name: 'future', apiVersion: '^2.0.0' })).toThrow(
      /future.*\^2\.0\.0.*1\.2\.0/,
    )
  })
})

// Every fixture below declares `__proto__` with a COMPUTED key. Both
// `{ __proto__: fn }` and `{ '__proto__': fn }` in an object literal invoke the
// special prototype-setter form and create no own key at all, so a fixture
// written that way asserts nothing while looking correct.
const ADAPTER_MAPS = [
  'ticketSources',
  'agentRuntimes',
  'workspaceProviders',
  'forges',
] as const satisfies readonly (keyof AutobuildPluginManifest)[]

type AdapterMap = (typeof ADAPTER_MAPS)[number]

function manifestWith(map: AdapterMap, adapters: Record<string, unknown>): unknown {
  return { name: 'proto-plugin', apiVersion: '^1.0.0', [map]: adapters }
}

function parseAdapters(
  map: AdapterMap,
  adapters: Record<string, unknown>,
): Record<string, unknown> {
  return parsePluginManifest(manifestWith(map, adapters))[map] as unknown as Record<string, unknown>
}

/** A plain property read, spelled so the name stays a runtime string: written
 * as a literal, TypeScript would resolve `parsed.toString` against
 * `Object.prototype` and type the very lookup this pins as a method. */
function read(parsed: Record<string, unknown>, name: string): unknown {
  return parsed[name]
}

describe('plugin manifest adapter-name preservation', () => {
  test('every declared name survives, including one that names an inherited member', () => {
    for (const map of ADAPTER_MAPS) {
      const parsed = parseAdapters(map, { ['__proto__']: factory, ordinary: factory })
      expect(Object.getOwnPropertyNames(parsed)).toEqual(['__proto__', 'ordinary'])
      expect(Object.getPrototypeOf(parsed)).toBeNull()
      expect(read(parsed, '__proto__')).toBe(factory)
      expect(read(parsed, 'ordinary')).toBe(factory)
    }
  })

  test('an undeclared name cannot be answered by an inherited member', () => {
    for (const map of ADAPTER_MAPS) {
      const parsed = parseAdapters(map, { ordinary: factory })
      for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
        expect(read(parsed, name)).toBeUndefined()
      }
    }
  })

  test('preservation is general, not a __proto__ special case', () => {
    for (const map of ADAPTER_MAPS) {
      const parsed = parseAdapters(map, { constructor: factory, toString: factory })
      expect(Object.getOwnPropertyNames(parsed)).toEqual(['constructor', 'toString'])
      expect(read(parsed, 'constructor')).toBe(factory)
      expect(read(parsed, 'toString')).toBe(factory)
    }
  })

  test('a preserved name still carries descriptor registrations verbatim', () => {
    const parsed = parseAdapters('ticketSources', {
      ['__proto__']: { factory, requiredEnv: ['ACME_TOKEN'] },
    })
    expect(read(parsed, '__proto__')).toEqual({ factory, requiredEnv: ['ACME_TOKEN'] })
  })

  test('a blank or whitespace-only adapter name is still rejected on every map', () => {
    for (const map of ADAPTER_MAPS) {
      for (const name of ['', '   ', '\t']) {
        expect(() => parseAdapters(map, { [name]: factory })).toThrow(
          /entry names must be nonblank/,
        )
      }
    }
  })

  test('a port declaring no adapters, and a manifest declaring none, stay valid', () => {
    for (const map of ADAPTER_MAPS) {
      const parsed = parseAdapters(map, {})
      expect(Object.getOwnPropertyNames(parsed)).toEqual([])
      expect(Object.getPrototypeOf(parsed)).toBeNull()
    }
    const bare = parsePluginManifest({ name: 'bare', apiVersion: '^1.0.0' })
    for (const map of ADAPTER_MAPS) expect(bare[map]).toBeUndefined()
  })

  test('an own accessor entry still registers the adapter it returns', () => {
    for (const map of ADAPTER_MAPS) {
      const parsed = parseAdapters(map, {
        get acme() {
          return factory
        },
      })
      expect(parsed.acme).toBe(factory)
    }
  })
})
