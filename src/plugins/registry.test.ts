import { describe, expect, test } from 'bun:test'
import type { AutobuildPluginManifest } from './manifest'
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
        ticketSources: { shared: factory },
        agentRuntimes: { shared: factory },
        workspaceProviders: { container: factory },
        forges: { gitlab: factory },
      }),
    )

    expect(registry.ticketSources.get('shared')?.owner).toEqual({
      kind: 'plugin',
      name: 'acme',
    })
    expect(registry.agentRuntimes.has('shared')).toBe(true)
    expect(registry.workspaceProviders.has('container')).toBe(true)
    expect(registry.forges.has('gitlab')).toBe(true)
  })

  test('rejects builtin and prior-plugin collisions with ownership diagnostics', () => {
    const registry = new PluginRegistry()
    expect(() =>
      registry.register(plugin('bad', { ticketSources: { linear: factory } })),
    ).toThrow(/ticket source.*linear.*bad.*builtin/)

    registry.register(plugin('first', { forges: { gitlab: factory } }))
    expect(() =>
      registry.register(plugin('second', { forges: { gitlab: factory } })),
    ).toThrow(/forge.*gitlab.*second.*first/)
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
