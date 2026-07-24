import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import type { PluginFactoryContext } from '../../plugins/manifest'
import { createPluginRegistry } from '../../plugins/registry'
import { FakeForge } from './fake'
import { GitHubForge } from './github'
import { createForge, resolveForgeRegistration } from './create'

describe('createForge', () => {
  test('constructs the reserved GitHub builtin by default', async () => {
    const forge = await createForge({
      name: 'github',
      registry: createPluginRegistry(),
      env: {},
      repoRoot: '.',
    })
    expect(forge).toBeInstanceOf(GitHubForge)
    expect(forge.name).toBe('github')
  })

  test('lazily awaits a plugin factory with exact context and preserves identity', async () => {
    const registry = createPluginRegistry()
    const selected = new FakeForge({ prAttachments: true })
    let received: PluginFactoryContext | undefined
    registry.register({
      name: 'acme-forges',
      apiVersion: '^1.0.0',
      forges: {
        gitlab: async (context) => {
          received = context
          return selected
        },
      },
    })
    const env = { GITLAB_TOKEN: 'secret', OPTIONAL: undefined }
    const forge = await createForge({
      name: 'gitlab',
      registry,
      env,
      repoRoot: '.',
    })

    expect(forge).toBe(selected)
    expect(forge.prAttachments).toBe(selected.prAttachments)
    expect(received).toEqual({ config: {}, env, repoRoot: resolve('.') })
  })

  test('preserves absence of the optional attachment-hosting capability', async () => {
    const registry = createPluginRegistry()
    const selected = new FakeForge()
    registry.register({
      name: 'text-only',
      apiVersion: '1.x',
      forges: { gitea: () => selected },
    })
    const forge = await createForge({
      name: 'gitea',
      registry,
      env: {},
      repoRoot: '.',
    })
    expect(forge).toBe(selected)
    expect(forge.prAttachments).toBeUndefined()
  })

  test('unknown names fail deterministically with builtin and plugin choices', () => {
    const registry = createPluginRegistry()
    registry.register({
      name: 'extra',
      apiVersion: '*',
      forges: { zeta: () => new FakeForge(), alpha: () => new FakeForge() },
    })
    expect(() => resolveForgeRegistration('missing', registry)).toThrow(
      'unknown forge adapter "missing"; available forges: alpha, github, zeta',
    )
  })

  test('contextualizes plugin factory failures', async () => {
    const registry = createPluginRegistry()
    registry.register({
      name: 'broken-plugin',
      apiVersion: '^1',
      forges: {
        broken: () => {
          throw new Error('credentials unavailable')
        },
      },
    })
    await expect(createForge({ name: 'broken', registry, env: {}, repoRoot: '.' })).rejects.toThrow(
      'forge adapter "broken" from plugin "broken-plugin" failed to initialize: credentials unavailable',
    )
  })
})
