import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { WorkspaceProvider } from '../types'
import { FakeWorkspaceProvider } from './fake'
import { GitWorktreeProvider } from './git-worktree'
import { createPluginRegistry } from '../../plugins/registry'
import type {
  PluginFactoryContext,
  WorkspaceProviderPluginFactoryContext,
} from '../../plugins/manifest'
import { parseConfig } from '../../config/load'
import type { RuntimeReferenceGroup } from '../../config/roles'
import type { VercelSandboxConfig } from '../../config/schema'
import {
  createWorkspaceProvider,
  createWorkspaceRuntime,
  type CreateWorkspaceProviderOptions,
} from './create'
import type { BuildExecution } from './build-execution'
import { LocalBuildExecution } from './local-build-execution'
import {
  VercelSandboxProvider,
  type VercelSandboxFacade,
  type VercelSandboxProviderOptions,
} from './vercel-sandbox'
import { VERCEL_SANDBOX_CAPABILITIES } from './vercel-capabilities'

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
      'unknown workspace provider "missing"; available providers: alpha, git-worktree, vercel-sandbox, zeta',
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
      'environment variable "ACME_SECRET" is a store, forge, ticket-provider, model, or Vercel credential and may never be forwarded into an operator sandbox',
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

  test('the vercel-sandbox builtin refuses a missing store with its construction message', async () => {
    await expect(
      createWorkspaceProvider(
        { provider: 'vercel-sandbox', config: { timeoutSeconds: 600 } },
        baseOpts(),
      ),
    ).rejects.toThrow('vercel-sandbox requires an HTTPS BuildStore and scoped AB_TOKEN authority')
  })

  // ── AUT-560: the workspace-provider factory context carries the host-derived seams ──

  test('plugin workspace-provider factories receive the host-derived seams', async () => {
    const opts = baseOpts()
    const selected = new FakeWorkspaceProvider({ mode: 'logical' })
    const contexts: WorkspaceProviderPluginFactoryContext[] = []
    const origin = async () => 'https://github.com/acme/app.git'
    const remoteBranchHead = async () => undefined
    const runtimeReferences: RuntimeReferenceGroup[] = [
      {
        runtime: 'node',
        references: ['role author'],
        models: [],
        usesRuntimeDefaultModel: false,
      },
    ]
    opts.registry.register({
      name: 'seams',
      apiVersion: '^1.7.0',
      workspaceProviders: {
        podman: (context) => {
          contexts.push(context)
          return selected
        },
      },
    })

    await createWorkspaceProvider(
      { provider: 'podman', config: {} },
      {
        ...opts,
        storeRef: 'https://store.example.test',
        storeToken: 'scoped-token',
        runtimeReferences,
        origin,
        remoteBranchHead,
      },
    )

    expect(contexts).toHaveLength(1)
    const context = contexts[0]!
    expect(context.storeRef).toBe('https://store.example.test')
    expect(context.storeToken).toBe('scoped-token')
    // Seams are compared by captured reference, not toEqual: deep equality on
    // functions is brittle, and identity proves the host passes its own seam
    // through uncloned.
    expect(context.runtimeReferences).toBe(runtimeReferences)
    expect(context.origin).toBe(origin)
    expect(context.remoteBranchHead).toBe(remoteBranchHead)
  })

  test('a call site that supplies no seams constructs exactly the shared context', async () => {
    const opts = baseOpts()
    const contexts: WorkspaceProviderPluginFactoryContext[] = []
    opts.registry.register({
      name: 'seams',
      apiVersion: '^1.7.0',
      workspaceProviders: {
        podman: (context) => {
          contexts.push(context)
          return new FakeWorkspaceProvider({ mode: 'logical' })
        },
      },
    })
    await createWorkspaceProvider({ provider: 'podman', config: {} }, opts)
    const context = contexts[0]!
    for (const key of [
      'storeRef',
      'storeToken',
      'runtimeReferences',
      'origin',
      'remoteBranchHead',
    ]) {
      expect(Object.hasOwn(context, key)).toBe(false)
    }
  })

  test('a storeRequirements declaration guarantees both store seams reach the factory', async () => {
    // Pairs with the refusal test above: with the seams supplied the refusal
    // check passes and the factory runs, receiving both values as strings —
    // the documented guarantee a store-requiring provider relies on.
    const opts = baseOpts()
    const contexts: WorkspaceProviderPluginFactoryContext[] = []
    opts.registry.register({
      name: 'containers',
      apiVersion: '^1.7.0',
      workspaceProviders: {
        podman: {
          factory: (context) => {
            contexts.push(context)
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
    await createWorkspaceProvider(
      { provider: 'podman', config: {} },
      { ...opts, storeRef: 'https://store.example.test', storeToken: 'scoped-token' },
    )
    expect(contexts).toHaveLength(1)
    expect(contexts[0]!.storeRef).toBe('https://store.example.test')
    expect(contexts[0]!.storeToken).toBe('scoped-token')
  })

  test('a plugin factory constructs the real VercelSandboxProvider from the context seams', async () => {
    // The AUT-560 demonstration: the exact wiring the moved-in implementation
    // will use after AUT-505 — a plugin factory building the provider from the
    // context's seams. The constructor validates eagerly (an https:// storeRef,
    // a nonempty token, and — without a supplied facade — a Vercel SDK facade
    // built from env, which throws without Vercel credentials), so the test
    // supplies a stub facade with the four methods, the same recipe the
    // construction tests in vercel-sandbox.test.ts use.
    const facade: VercelSandboxFacade = {
      get: async () => null,
      create: async () => {
        throw new Error('not reached by this test')
      },
      listSnapshots: async () => [],
      deleteSnapshot: async () => {},
    }
    const origin = async () => 'https://github.com/acme/app.git'
    const remoteBranchHead = async () => undefined
    // Deliberately EMPTY, not the populated fixture: the vercel capabilities
    // declare requireRuntimeProvisioning, and construction enforces it
    // whenever opts.runtimeReferences is defined — a populated fixture would
    // throw the provisioning message before the factory ever ran. An empty
    // array passes enforcement while the seam still arrives as a value.
    const runtimeReferences: RuntimeReferenceGroup[] = []
    const opts = baseOpts()
    opts.registry.register({
      name: 'vercel-sandbox-plugin',
      apiVersion: '^1.7.0',
      workspaceProviders: {
        'vercel-sandbox-copy': {
          factory: (ctx) => {
            // The capability type declares `configSchema?: z.ZodType`, which
            // under zod 4 parses to `unknown` — narrow it, then assert the
            // shape the shared schema is known to produce.
            const schema = VERCEL_SANDBOX_CAPABILITIES.configSchema
            if (schema === undefined) {
              throw new Error('vercel-sandbox capabilities lost their config schema')
            }
            const parsed = schema.safeParse(ctx.config)
            if (!parsed.success) throw new Error(parsed.error.message)
            return new VercelSandboxProvider({
              config: parsed.data as VercelSandboxConfig,
              env: ctx.env,
              storeRef: ctx.storeRef!,
              storeToken: ctx.storeToken!,
              repo: resolve(ctx.repoRoot),
              runtimeReferences: ctx.runtimeReferences ?? [],
              origin: ctx.origin,
              remoteBranchHead: ctx.remoteBranchHead,
              facade,
            })
          },
          capabilities: VERCEL_SANDBOX_CAPABILITIES,
        },
      },
    })

    const provider = await createWorkspaceProvider(
      { provider: 'vercel-sandbox-copy', config: { timeoutSeconds: 600 } },
      {
        ...opts,
        storeRef: 'https://store.example.test',
        storeToken: 'scoped-token',
        runtimeReferences,
        origin,
        remoteBranchHead,
      },
    )
    expect(provider.name).toBe('vercel-sandbox')
    const options = (provider as unknown as { options: VercelSandboxProviderOptions }).options
    expect(options.storeRef).toBe('https://store.example.test')
    expect(options.storeToken).toBe('scoped-token')
    expect(options.repo).toBe(resolve('./repo'))
    expect(options.runtimeReferences).toBe(runtimeReferences)
    expect(options.origin).toBe(origin)
    expect(options.remoteBranchHead).toBe(remoteBranchHead)
    expect(options.facade).toBe(facade)
    expect((options.config as VercelSandboxConfig).timeoutSeconds).toBe(600)
  })

  test('a factory annotated with the base plugin context stays assignable to the workspace-provider port', async () => {
    // The bivariance claim, exercised in-repo: a legacy factory that
    // annotates its parameter as the plain PluginFactoryContext — aware of
    // none of the new seams — still typechecks and runs when the host passes
    // the extended context.
    const opts = baseOpts()
    const selected = new FakeWorkspaceProvider({ mode: 'logical' })
    const calls: PluginFactoryContext<Record<string, unknown>>[] = []
    opts.registry.register({
      name: 'legacy-typed',
      apiVersion: '^1.0.0',
      workspaceProviders: {
        podman: (context: PluginFactoryContext<Record<string, unknown>>) => {
          calls.push(context)
          return selected
        },
      },
    })
    await createWorkspaceProvider(
      { provider: 'podman', config: {} },
      { ...opts, storeRef: 'https://store.example.test', storeToken: 'scoped-token' },
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]!.repoRoot).toBe(resolve('./repo'))
  })

  test('the vercel-sandbox builtin enforces requireRuntimeProvisioning at construction', async () => {
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
    await expect(
      createWorkspaceProvider(
        { provider: 'vercel-sandbox', config: { timeoutSeconds: 600 } },
        opts,
      ),
    ).rejects.toThrow(
      'runtime "node" is selected by role author but has no sandbox provisioning; add [workspace.config.runtimeProvisioning.node] with nonblank install and preflight commands',
    )
  })
})
