import { resolve } from 'node:path'
import type { WorkspaceConfig } from '../../config/schema'
import type { PluginRegistry } from '../../plugins/registry'
import type { WorkspaceProvider } from '../types'
import { GitWorktreeProvider } from './git-worktree'

export interface CreateWorkspaceProviderOptions {
  registry: PluginRegistry
  /** Selected local scratch root. Remote stores pass the repository default. */
  worktreeRoot: string
  /** Absolute repository root supplied to plugin factories. */
  repoRoot: string
  env: Record<string, string | undefined>
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
    if (config.provider !== 'git-worktree') {
      throw new Error(
        `workspace provider "${config.provider}" is registered as a builtin but has no constructor`,
      )
    }
    if (Object.keys(config.config).length > 0) {
      throw new Error(
        '[workspace.config] is not supported by the builtin "git-worktree" provider',
      )
    }
    return new GitWorktreeProvider({ root: resolve(opts.worktreeRoot) })
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
