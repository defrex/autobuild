import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { WorkspaceProvider } from '../types'
import { FakeWorkspaceProvider } from './fake'
import { GitWorktreeProvider } from './git-worktree'
import { createPluginRegistry } from '../../plugins/registry'
import manifest from '@defrex/autobuild-vercel-sandbox'
import { parseConfig } from '../../config/load'
import {
  createWorkspaceProvider,
  createWorkspaceRuntime,
  type CreateWorkspaceProviderOptions,
} from './create'
import type { BuildExecution } from './build-execution'
import { LocalBuildExecution } from './local-build-execution'

const baseOpts = () => ({
  registry: createPluginRegistry(),
  worktreeRoot: './state/worktrees',
  repoRoot: './repo',
  env: { TOKEN: 'secret', EMPTY: undefined },
})

describe('createWorkspaceProvider', () => {
  test('constructs the git-worktree builtin by default with the selected scratch root', async () => {
    const provider = await createWorkspaceProvider(
      { provider: 'git-worktree', config: {} },
      baseOpts(),
    )
    expect(provider).toBeInstanceOf(GitWorktreeProvider)
    expect(provider.name).toBe('git-worktree')
    expect((provider as unknown as { root: string }).root).toBe(resolve('./state/worktrees'))
  })

  test('plugin factories stay lazy and receive exact config, env, and absolute repo root', async () => {
    const opts = baseOpts()
    const selected = new FakeWorkspaceProvider({ mode: 'logical' })
    const calls: unknown[] = []
    opts.registry.register({
      name: 'containers',
      apiVersion: '^1.0.0',
      workspaceProviders: {
        podman: (context) => {
          calls.push(context)
          return selected
        },
      },
    })
    expect(calls).toEqual([])

    const provider = await createWorkspaceProvider(
      {
        provider: 'podman',
        config: { image: 'bun:latest', nested: { writable: true } },
      },
      opts,
    )
    expect(provider).toBe(selected)
    expect(calls).toEqual([
      {
        config: { image: 'bun:latest', nested: { writable: true } },
        env: opts.env,
        repoRoot: resolve('./repo'),
      },
    ])
  })

  test('a config key named for an inherited property survives parsing into the factory', async () => {
    // The end-to-end claim, and it must start at `parseConfig`: every other
    // test in this file hands `createWorkspaceProvider` a config object built
    // by hand, which bypasses the parse step that used to eat the entry.
    const opts = baseOpts()
    const selected = new FakeWorkspaceProvider({ mode: 'logical' })
    const calls: { config: Record<string, unknown> }[] = []
    opts.registry.register({
      name: 'containers',
      apiVersion: '^1.0.0',
      workspaceProviders: {
        podman: (context) => {
          calls.push(context)
          return selected
        },
      },
    })

    const parsed = parseConfig(
      `[workspace]
provider = "podman"

[workspace.config]
"__proto__" = "kept"
image = "bun:latest"

[tickets]
source = "file"
readyState = "ready"
`,
    )
    await createWorkspaceProvider(parsed.workspace, opts)

    const received = calls[0]?.config as Record<string, unknown>
    expect(Object.getOwnPropertyDescriptor(received, '__proto__')?.value).toBe('kept')
    expect(received.image).toBe('bun:latest')
    // Nothing between the parse and the factory clones the map, so the
    // inherited-read guarantee holds where the plugin actually reads it.
    expect(Object.getPrototypeOf(received)).toBeNull()
  })

  test('pairs local providers with the shipped executor and lets providers substitute it', async () => {
    const local = await createWorkspaceRuntime({ provider: 'git-worktree', config: {} }, baseOpts())
    expect(local.execution).toBeInstanceOf(LocalBuildExecution)

    const opts = baseOpts()
    const execution: BuildExecution = {
      async start() {
        return {
          supervision: 'local-parent',
          completion: Promise.resolve({ exitCode: 0 }),
          async stop() {},
          async detach() {},
        }
      },
    }
    const selected = Object.assign(new FakeWorkspaceProvider({ mode: 'logical' }), {
      buildExecution: execution,
    })
    opts.registry.register({
      name: 'remote-sandbox',
      apiVersion: '^1.0.0',
      workspaceProviders: { remote: () => selected },
    })
    const remote = await createWorkspaceRuntime({ provider: 'remote', config: {} }, opts)
    expect(remote.provider).toBe(selected)
    expect(remote.execution).toBe(execution)
  })

  test('unknown selectors list every available provider deterministically', async () => {
    const opts = baseOpts()
    const factory = (): WorkspaceProvider => new FakeWorkspaceProvider({ mode: 'logical' })
    opts.registry.register({
      name: 'extra',
      apiVersion: '^1.0.0',
      workspaceProviders: { zeta: factory, alpha: factory },
    })
    await expect(
      createWorkspaceProvider({ provider: 'missing', config: {} }, opts),
    ).rejects.toThrow(
      'unknown workspace provider "missing"; add the plugin package that provides it to the plugins list in autobuild.toml (available providers: alpha, git-worktree, zeta)',
    )
  })

  test('selected plugin initialization failures retain selector context', async () => {
    const opts = baseOpts()
    opts.registry.register({
      name: 'broken',
      apiVersion: '^1.0.0',
      workspaceProviders: {
        container: () => {
          throw new Error('daemon unavailable')
        },
      },
    })
    await expect(
      createWorkspaceProvider({ provider: 'container', config: {} }, opts),
    ).rejects.toThrow('workspace provider "container" failed to initialize: daemon unavailable')
  })

  test('a plugin-declared configRefusal is enforced at construction before the factory runs', async () => {
    const opts = baseOpts()
    let constructed = 0
    opts.registry.register({
      name: 'containers',
      apiVersion: '^1.6.0',
      workspaceProviders: {
        podman: {
          factory: () => {
            constructed += 1
            return new FakeWorkspaceProvider({ mode: 'logical' })
          },
          capabilities: { configRefusal: '[workspace.config] is not supported by podman' },
        },
      },
    })
    await expect(
      createWorkspaceProvider({ provider: 'podman', config: { image: 'bun:latest' } }, opts),
    ).rejects.toThrow('[workspace.config] is not supported by podman')
    expect(constructed).toBe(0)
    // Empty provider config passes through to the factory.
    await createWorkspaceProvider({ provider: 'podman', config: {} }, opts)
    expect(constructed).toBe(1)
  })

  test('a plugin-declared configSchema is parsed before construction', async () => {
    const opts = baseOpts()
    let constructed = 0
    opts.registry.register({
      name: 'containers',
      apiVersion: '^1.6.0',
      workspaceProviders: {
        podman: {
          factory: () => {
            constructed += 1
            return new FakeWorkspaceProvider({ mode: 'logical' })
          },
          capabilities: { configSchema: z.strictObject({ image: z.string() }) },
        },
      },
    })
    await expect(
      createWorkspaceProvider({ provider: 'podman', config: { image: 4 } }, opts),
    ).rejects.toThrow('invalid podman config:')
    expect(constructed).toBe(0)
    await createWorkspaceProvider({ provider: 'podman', config: { image: 'bun:latest' } }, opts)
    expect(constructed).toBe(1)
  })

  test('a plugin-declared storeRequirements.constructionMessage refuses before the factory runs', async () => {
    const opts = baseOpts()
    let constructed = 0
    opts.registry.register({
      name: 'containers',
      apiVersion: '^1.6.0',
      workspaceProviders: {
        podman: {
          factory: () => {
            constructed += 1
            return new FakeWorkspaceProvider({ mode: 'logical' })
          },
          capabilities: {
            storeRequirements: {
              constructionMessage: 'podman requires an HTTPS store and token',
              storeRefMessage: 'podman requires an HTTPS AB_STORE',
              storeTokenMessage: 'podman requires nonempty AB_TOKEN',
            },
          },
        },
      },
    })
    await expect(createWorkspaceProvider({ provider: 'podman', config: {} }, opts)).rejects.toThrow(
      'podman requires an HTTPS store and token',
    )
    expect(constructed).toBe(0)
    await createWorkspaceProvider(
      { provider: 'podman', config: {} },
      { ...opts, storeRef: 'https://store.example', storeToken: 'token' },
    )
    expect(constructed).toBe(1)
  })

  test('a plugin-declared sandboxForbiddenEnv is honored only when the orchestrator sandbox is enabled', async () => {
    const register = (opts: CreateWorkspaceProviderOptions) => {
      opts.registry.register({
        name: 'containers',
        apiVersion: '^1.6.0',
        workspaceProviders: {
          podman: {
            factory: () => new FakeWorkspaceProvider({ mode: 'logical' }),
            capabilities: { sandboxForbiddenEnv: ['ACME_SECRET'] },
          },
        },
      })
      return opts
    }
    const enabled = register({
      ...baseOpts(),
      sandboxEnvironmentVariables: ['ACME_SECRET'],
      orchestratorSandboxEnabled: true,
    })
    await expect(
      createWorkspaceProvider({ provider: 'podman', config: {} }, enabled),
    ).rejects.toThrow(
      'environment variable "ACME_SECRET" is a store, forge, ticket-provider, model, or workspace-provider credential and may never be forwarded into an operator sandbox',
    )
    // The parse-time rule is reproduced exactly: with the orchestrator
    // disabled the declaration is not enforced at construction.
    const disabled = register({
      ...baseOpts(),
      sandboxEnvironmentVariables: ['ACME_SECRET'],
    })
    await createWorkspaceProvider({ provider: 'podman', config: {} }, disabled)
  })

  test('a plugin-declared requireRuntimeProvisioning is honored at construction', async () => {
    const opts = baseOpts()
    opts.registry.register({
      name: 'containers',
      apiVersion: '^1.6.0',
      workspaceProviders: {
        podman: {
          factory: () => new FakeWorkspaceProvider({ mode: 'logical' }),
          capabilities: { requireRuntimeProvisioning: true },
        },
      },
    })
    const withReferences = {
      ...opts,
      runtimeReferences: [
        {
          runtime: 'node',
          references: ['role author'],
          models: [],
          usesRuntimeDefaultModel: false,
        },
      ],
    }
    await expect(
      createWorkspaceProvider({ provider: 'podman', config: {} }, withReferences),
    ).rejects.toThrow(
      'runtime "node" is selected by role author but has no sandbox provisioning; add [workspace.config.runtimeProvisioning.node] with nonblank install and preflight commands',
    )
    await createWorkspaceProvider(
      { provider: 'podman', config: { runtimeProvisioning: { node: {} } } },
      withReferences,
    )
  })

  test('the registered vercel-sandbox plugin refuses a missing store with its construction message', async () => {
    const opts = baseOpts()
    opts.registry.register(manifest)
    await expect(
      createWorkspaceProvider(
        { provider: 'vercel-sandbox', config: { timeoutSeconds: 600 } },
        opts,
      ),
    ).rejects.toThrow('vercel-sandbox requires an HTTPS BuildStore and scoped AB_TOKEN authority')
  })

  test('the registered vercel-sandbox plugin enforces requireRuntimeProvisioning at construction', async () => {
    const opts = {
      ...baseOpts(),
      runtimeReferences: [
        {
          runtime: 'node',
          references: ['role author'],
          models: [],
          usesRuntimeDefaultModel: false,
        },
      ],
    }
    opts.registry.register(manifest)
    await expect(
      createWorkspaceProvider(
        { provider: 'vercel-sandbox', config: { timeoutSeconds: 600 } },
        opts,
      ),
    ).rejects.toThrow(
      'runtime "node" is selected by role author but has no sandbox provisioning; add [workspace.config.runtimeProvisioning.node] with nonblank install and preflight commands',
    )
  })

  test('the registered vercel-sandbox plugin enforces its declared sandboxForbiddenEnv extras at construction', async () => {
    // Migrated from config.test.ts (AUT-505): the four credential names left
    // the shared SANDBOX_FORBIDDEN_ENV with the builtin, so their forwarding
    // refusal is enforced here through the plugin's declared extras.
    const opts = {
      ...baseOpts(),
      env: {
        ...baseOpts().env,
        VERCEL_TOKEN: 'tok',
        VERCEL_TEAM_ID: 'team',
        VERCEL_PROJECT_ID: 'proj',
      },
      storeRef: 'https://store.example',
      storeToken: 'token',
      sandboxEnvironmentVariables: ['VERCEL_TOKEN'],
      orchestratorSandboxEnabled: true,
    }
    opts.registry.register(manifest)
    await expect(
      createWorkspaceProvider(
        { provider: 'vercel-sandbox', config: { timeoutSeconds: 600 } },
        opts,
      ),
    ).rejects.toThrow(
      'environment variable "VERCEL_TOKEN" is a store, forge, ticket-provider, model, or workspace-provider credential and may never be forwarded into an operator sandbox',
    )
    // With the orchestrator disabled the declaration is not enforced at
    // construction, mirroring the parse-time gate it replaces.
    const disabled = {
      ...baseOpts(),
      env: {
        ...baseOpts().env,
        VERCEL_TOKEN: 'tok',
        VERCEL_TEAM_ID: 'team',
        VERCEL_PROJECT_ID: 'proj',
      },
      storeRef: 'https://store.example',
      storeToken: 'token',
      sandboxEnvironmentVariables: ['VERCEL_TOKEN'],
    }
    disabled.registry.register(manifest)
    await createWorkspaceProvider(
      { provider: 'vercel-sandbox', config: { timeoutSeconds: 600 } },
      disabled,
    )
  })
})
