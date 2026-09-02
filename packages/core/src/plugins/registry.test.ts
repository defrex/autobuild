import { describe, expect, test } from 'bun:test'
import type { AutobuildPluginManifest } from './manifest'
import { parsePluginManifest } from './manifest'
import { PluginRegistry } from './registry'

const factory = (() => ({})) as never

function plugin(
  name: string,
  registrations: Partial<AutobuildPluginManifest> = {},
): AutobuildPluginManifest {
  return { name, apiVersion: '^1.0.0', ...registrations }
}

describe('PluginRegistry', () => {
  test('registers one plugin across ports and permits the same name on different ports', () => {
    const registry = new PluginRegistry()
    registry.register(
      plugin('acme', {
        ticketSources: {
          shared: { factory, requiredEnv: ['SHARED_TOKEN'] },
        },
        agentRuntimes: { shared: factory },
        workspaceProviders: { container: factory },
        forges: { gitlab: factory },
      }),
    )

    expect(registry.ticketSources.get('shared')?.owner).toEqual({
      kind: 'plugin',
      name: 'acme',
    })
    expect(registry.ticketSources.get('shared')?.factory).toBe(factory)
    expect(registry.ticketSources.get('shared')?.requiredEnv).toEqual(['SHARED_TOKEN'])
    expect(registry.agentRuntimes.has('shared')).toBe(true)
    expect(registry.workspaceProviders.has('container')).toBe(true)
    expect(registry.forges.has('gitlab')).toBe(true)
    expect(registry.ticketSources.get('shared')?.factory).toBe(factory)
  })

  test('normalizes contract metadata and exposes a stable provenance projection', () => {
    const registry = new PluginRegistry()
    const contractFactory = (() => async () => ({})) as never
    registry.register(
      plugin('acme', {
        ticketSources: {
          jira: {
            factory,
            requiredEnv: ['JIRA_TOKEN'],
            contract: { factory: contractFactory, live: true },
          },
        },
      }),
      {
        module: '@acme/plugin',
        resolved: '/repo/node_modules/@acme/plugin/index.ts',
        resolutionKind: 'package',
      },
    )

    expect(registry.ticketSources.get('jira')?.requiredEnv).toEqual(['JIRA_TOKEN'])
    expect(registry.ticketSources.get('jira')?.contract).toEqual({
      factory: contractFactory,
      live: true,
    })
    expect(registry.adapters('ticket-source')).toEqual([
      expect.objectContaining({ name: 'file', source: { kind: 'builtin' } }),
      expect.objectContaining({ name: 'hosted', source: { kind: 'builtin' } }),
      expect.objectContaining({ name: 'linear', source: { kind: 'builtin' } }),
      expect.objectContaining({
        port: 'ticket-source',
        name: 'jira',
        hasContract: true,
        live: true,
        source: expect.objectContaining({
          module: '@acme/plugin',
          resolutionKind: 'package',
          pluginName: 'acme',
          api: expect.objectContaining({ status: 'compatible' }),
        }),
      }),
    ])
  })

  test('reserves every builtin runtime including Codex', () => {
    const registry = new PluginRegistry()
    expect(registry.adapters('agent-runtime').map((adapter) => adapter.name)).toEqual([
      'claude',
      'codex',
      'pi',
      'split',
    ])
    expect(() => registry.register(plugin('bad', { agentRuntimes: { codex: factory } }))).toThrow(
      /agent runtime.*codex.*bad.*builtin/,
    )
  })

  test('rejects builtin and prior-plugin collisions with ownership diagnostics', () => {
    const registry = new PluginRegistry()
    expect(() => registry.register(plugin('bad', { ticketSources: { linear: factory } }))).toThrow(
      /ticket source.*linear.*bad.*builtin/,
    )
    expect(() =>
      registry.register(plugin('bad-runtime', { agentRuntimes: { split: factory } })),
    ).toThrow(/agent runtime.*split.*bad-runtime.*builtin/)

    registry.register(plugin('first', { forges: { gitlab: factory } }))
    expect(() => registry.register(plugin('second', { forges: { gitlab: factory } }))).toThrow(
      /forge.*gitlab.*second.*first/,
    )
  })

  test('a collision leaves every registration from the incoming plugin unapplied', () => {
    const registry = new PluginRegistry()
    expect(() =>
      registry.register(
        plugin('atomic', {
          ticketSources: { jira: factory },
          forges: { github: factory },
        }),
      ),
    ).toThrow(/github/)
    expect(registry.ticketSources.has('jira')).toBe(false)
  })
})

// Driven through `parsePluginManifest` rather than a hand-built manifest
// object on purpose: validation is the step that used to lose the name, so a
// literal `{ forges: { ['__proto__']: fn } }` handed straight to `register`
// would pass while the real path stayed broken.
function parsedPlugin(
  name: string,
  registrations: Record<string, unknown>,
): AutobuildPluginManifest {
  return parsePluginManifest({ name, apiVersion: '^1.0.0', ...registrations })
}

describe('PluginRegistry with a preserved adapter name', () => {
  test('registers a name that collides with an inherited object member on every port', () => {
    const registry = new PluginRegistry()
    registry.register(
      parsedPlugin('proto-plugin', {
        ticketSources: { ['__proto__']: factory },
        agentRuntimes: { ['__proto__']: factory },
        workspaceProviders: { ['__proto__']: factory },
        forges: { ['__proto__']: factory },
      }),
    )

    for (const port of [
      registry.ticketSources,
      registry.agentRuntimes,
      registry.workspaceProviders,
      registry.forges,
    ]) {
      expect(port.get('__proto__')?.owner).toEqual({ kind: 'plugin', name: 'proto-plugin' })
      expect(port.get('__proto__')?.factory).toBe(factory)
    }
  })

  test('the projection ab plugin list prints carries the name verbatim', () => {
    const registry = new PluginRegistry()
    registry.register(parsedPlugin('proto-plugin', { forges: { ['__proto__']: factory } }))
    expect(registry.adapters('forge')).toContainEqual(
      expect.objectContaining({ port: 'forge', name: '__proto__' }),
    )
    expect(registry.registration('forge', '__proto__')?.factory).toBe(factory)
  })

  test('collision rules still hold for such a name, per port', () => {
    const registry = new PluginRegistry()
    registry.register(parsedPlugin('first', { forges: { ['__proto__']: factory } }))
    expect(() =>
      registry.register(parsedPlugin('second', { forges: { ['__proto__']: factory } })),
    ).toThrow(/forge.*__proto__.*second.*first/)
    // The same name on a different port remains a distinct registration.
    registry.register(parsedPlugin('second', { agentRuntimes: { ['__proto__']: factory } }))
    expect(registry.agentRuntimes.get('__proto__')?.owner).toEqual({
      kind: 'plugin',
      name: 'second',
    })
  })
})
