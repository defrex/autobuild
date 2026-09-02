import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import type { PluginFactoryContext } from '../../plugins/manifest'
import { parsePluginManifest } from '../../plugins/manifest'
import { createPluginRegistry } from '../../plugins/registry'
import { FakeForge } from './fake'
import { GitHubForge } from './github'
import { LocalGitForge } from './local-git'
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

  test('constructs the reserved local-git builtin', async () => {
    const forge = await createForge({
      name: 'local-git',
      registry: createPluginRegistry(),
      env: {},
      repoRoot: '.',
    })
    expect(forge).toBeInstanceOf(LocalGitForge)
    expect(forge.name).toBe('local-git')
    expect(forge.prAttachments).toBeUndefined()
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
      'unknown forge adapter "missing"; available forges: alpha, github, local-git, zeta',
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

  test('selects an adapter whose declared name collides with an inherited object member', async () => {
    const registry = createPluginRegistry()
    const selected = new FakeForge()
    registry.register(
      parsePluginManifest({
        name: 'proto-plugin',
        apiVersion: '^1.0.0',
        forges: { ['__proto__']: () => selected },
      }),
    )

    expect(await createForge({ name: '__proto__', registry, env: {}, repoRoot: '.' })).toBe(
      selected,
    )
    expect(() => resolveForgeRegistration('missing', registry)).toThrow(
      'unknown forge adapter "missing"; available forges: __proto__, github, local-git',
    )
  })
})
