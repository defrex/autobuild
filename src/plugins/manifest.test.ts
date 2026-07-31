import { describe, expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
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

  // Preserving every declared name must not come at the cost of accepting a
  // container that declares nothing. A `Map` is the case that stings: it looks
  // like a map of named adapters, has no own string-keyed entries, and would
  // otherwise parse to an empty registration set — the same silent drop this
  // change exists to eliminate, reached from the other side.
  test.each([
    ['null', null],
    ['a string', 'forges'],
    ['a number', 1],
    ['an array', [factory]],
    ['a Map', new Map([['acme', factory]])],
    ['a Set', new Set([factory])],
    ['a Date', new Date(0)],
    [
      'a class instance',
      new (class AdapterBag {
        acme = factory
      })(),
    ],
  ])('%s is rejected as an adapter map, not read as an empty one', (_label, container) => {
    for (const map of ADAPTER_MAPS) {
      expect(() =>
        parsePluginManifest({ name: 'p', apiVersion: '^1.0.0', [map]: container }),
      ).toThrow(new RegExp(`${map} must be an object of named adapter registrations`))
    }
  })

  // Every plain-record shape the replaced `z.record` accepted, so that
  // narrowing the container above cannot narrow what a manifest may declare.
  // The custom-prototype cases are the ones a plugin reaches for when it
  // composes its adapter map instead of writing one literal.
  test.each([
    ['an object literal', () => ({ acme: factory })],
    ['a null-prototype record', () => Object.assign(Object.create(null), { acme: factory })],
    [
      'a record built on a plain prototype',
      () => Object.assign(Object.create({ shared: factory }), { acme: factory }),
    ],
    [
      'a record built on a null-prototype one',
      () => Object.assign(Object.create(Object.create(null)), { acme: factory }),
    ],
    [
      'a record whose prototype declares a non-function constructor',
      () => Object.assign(Object.create({ constructor: null }), { acme: factory }),
    ],
    [
      'a record whose prototype declares a numeric constructor',
      () => Object.assign(Object.create({ constructor: 42 }), { acme: factory }),
    ],
    [
      'a record whose constructor prototype owns isPrototypeOf',
      () => {
        function Composed(this: Record<string, unknown>) {}
        Composed.prototype.isPrototypeOf = () => false
        return Object.assign(new (Composed as unknown as new () => object)(), { acme: factory })
      },
    ],
    [
      // A plugin loaded into its own realm hands over an object whose prototype
      // is that realm's `Object.prototype`, never this one's.
      'a plain object from another realm',
      () => Object.assign(runInNewContext('({})') as object, { acme: factory }),
    ],
  ])('%s registers its own ordinary adapter', (_label, build) => {
    for (const map of ADAPTER_MAPS) {
      const parsed = parseAdapters(map, build() as Record<string, unknown>)
      expect(read(parsed, 'acme')).toBe(factory)
      // Only what the container declares as its OWN entry: an inherited member
      // is not a declared adapter, however plain the prototype it sits on.
      expect(Object.getOwnPropertyNames(parsed)).toEqual(['acme'])
      expect(read(parsed, 'shared')).toBeUndefined()
    }
  })

  // `z.record` reads `constructor` off the container to decide it is a record,
  // so an adapter named `constructor` shadowed that read and the whole map was
  // rejected — the module's own hazard, applied to the shape check. The name
  // is registered here instead; `preservation is general` pins the lookup.
  test('an adapter named constructor does not disqualify its container', () => {
    for (const map of ADAPTER_MAPS) {
      expect(Object.getOwnPropertyNames(parseAdapters(map, { constructor: factory }))).toEqual([
        'constructor',
      ])
    }
  })

  // A symbol cannot name an entry in the map validation produces, so passing
  // over one silently would be the same drop this change exists to eliminate.
  // `z.record` ran every own key through its string key schema and rejected the
  // container; so does this.
  test('an own enumerable symbol key is an error, not a skipped entry', () => {
    for (const map of ADAPTER_MAPS) {
      expect(() => parseAdapters(map, { acme: factory, [Symbol('adapter')]: factory })).toThrow(
        /entry names must be strings; Symbol\(adapter\) cannot name an entry/,
      )
    }
  })

  // The other half of `z.record`'s key set: own and ENUMERABLE. Bookkeeping a
  // plugin hides from enumeration is not a declaration, and was collected by
  // neither schema.
  test('non-enumerable own properties are not declarations', () => {
    for (const map of ADAPTER_MAPS) {
      const container: Record<string, unknown> = { acme: factory }
      Object.defineProperty(container, 'hidden', { value: factory, enumerable: false })
      Object.defineProperty(container, Symbol('internal'), {
        value: factory,
        enumerable: false,
      })
      const parsed = parseAdapters(map, container)
      expect(Object.getOwnPropertyNames(parsed)).toEqual(['acme'])
    }
  })
})
