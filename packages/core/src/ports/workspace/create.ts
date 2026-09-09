import { resolve } from 'node:path'
import type { RuntimeReferenceGroup } from '../../config/roles'
import { vercelSandboxConfigSchema, type WorkspaceConfig } from '../../config/schema'
import type { PluginRegistry } from '../../plugins/registry'
import type { WorkspaceProvider } from '../types'
import type { BuildExecution } from './build-execution'
import { GitWorktreeProvider } from './git-worktree'
import { LocalBuildExecution } from './local-build-execution'
import { VercelSandboxProvider } from './vercel-sandbox'

export interface CreateWorkspaceProviderOptions {
  registry: PluginRegistry
  /** Selected local scratch root. Remote stores pass the repository default. */
  worktreeRoot: string
  /** Absolute repository root supplied to plugin factories. */
  repoRoot: string
  env: Record<string, string | undefined>
  /** Required only by remote builtins. */
  storeRef?: string
  storeToken?: string
  /** Host-derived effective routes; consumed only by the built-in sandbox. */
  runtimeReferences?: readonly RuntimeReferenceGroup[]
}

export interface WorkspaceRuntime {
  provider: WorkspaceProvider
  execution: BuildExecution
}

/** Resolve and lazily construct the configured WorkspaceProvider. Builtin
 * construction remains host-owned because its scratch root comes from store
 * selection rather than plugin configuration. */
export async function createWorkspaceProvider(
  config: WorkspaceConfig,
  opts: CreateWorkspaceProviderOptions,
): Promise<WorkspaceProvider> {
  const available = [...opts.registry.workspaceProviders.keys()].sort()
  const registration = opts.registry.workspaceProviders.get(config.provider)
  if (registration === undefined) {
    throw new Error(
      `unknown workspace provider "${config.provider}"; available providers: ${available.join(', ')}`,
    )
  }

  if (registration.owner.kind === 'builtin') {
    if (config.provider === 'git-worktree') {
      if (Object.keys(config.config).length > 0) {
        throw new Error(
          '[workspace.config] is not supported by the builtin "git-worktree" provider',
        )
      }
      return new GitWorktreeProvider({ root: resolve(opts.worktreeRoot) })
    }
    if (config.provider === 'vercel-sandbox') {
      const parsed = vercelSandboxConfigSchema.safeParse(config.config)
      if (!parsed.success) throw new Error(`invalid vercel-sandbox config: ${parsed.error.message}`)
      if (opts.storeRef === undefined || opts.storeToken === undefined) {
        throw new Error('vercel-sandbox requires an HTTPS BuildStore and scoped AB_TOKEN authority')
      }
      return new VercelSandboxProvider({
        config: parsed.data,
        env: opts.env,
        storeRef: opts.storeRef,
        storeToken: opts.storeToken,
        repo: resolve(opts.repoRoot),
        runtimeReferences: opts.runtimeReferences ?? [],
      })
    }
    throw new Error(
      `workspace provider "${config.provider}" is registered as a builtin but has no constructor`,
    )
  }

  const factory = registration.factory
  if (factory === undefined) {
    throw new Error(
      `workspace provider "${config.provider}" from plugin "${registration.owner.name}" has no factory`,
    )
  }

  try {
    return await factory({
      config: config.config,
      env: opts.env,
      repoRoot: resolve(opts.repoRoot),
    })
  } catch (error) {
    throw new Error(
      `workspace provider "${config.provider}" failed to initialize: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    )
  }
}

/** Resolve provisioning and execution as one workspace-owned runtime. Existing
 * providers remain source-compatible: locally reachable implementations that
 * omit execution receive the shipped child-process capability, while a future
 * sandbox provider can replace it without a local proxy process. */
export async function createWorkspaceRuntime(
  config: WorkspaceConfig,
  opts: CreateWorkspaceProviderOptions,
): Promise<WorkspaceRuntime> {
  const provider = await createWorkspaceProvider(config, opts)
  return {
    provider,
    execution: provider.buildExecution ?? new LocalBuildExecution({ env: opts.env }),
  }
}
