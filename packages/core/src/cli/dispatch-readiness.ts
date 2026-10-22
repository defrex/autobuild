import type { Config } from '../config/schema'
import type { PluginRegistry } from '../plugins/registry'
import type { Exec } from '../ports/workspace/git-worktree'

/** Shared validation without opening workspaces, claims, runners or polling. */
export async function validateWorkspaceDispatchConfiguration(
  config: Config,
  opts: {
    repository?: string
    targetRepo: string
    env: Record<string, string | undefined>
    exec: Exec
  },
  plugins: PluginRegistry,
): Promise<void> {
  // Dispatch preflight is capability-driven (AUT-516): forge support, origin
  // validation, and required environment all read the selected provider's
  // registration declarations — builtin and plugin alike — instead of naming
  // a provider.
  const workspaceCaps = plugins.workspaceProviders.get(config.workspace.provider)?.capabilities
  if (workspaceCaps?.supportedForges !== undefined) {
    if (!workspaceCaps.supportedForges.includes(config.forge)) {
      throw new Error(
        workspaceCaps.forgeDispatchMessage ??
          `workspace provider "${config.workspace.provider}" does not support forge "${config.forge}"`,
      )
    }
  }
  if (workspaceCaps?.validateOrigin !== undefined && !opts.repository) {
    const origin = await opts.exec(['git', 'remote', 'get-url', 'origin'], {
      cwd: opts.targetRepo,
    })
    if (origin.exitCode !== 0)
      throw new Error(
        workspaceCaps.originReadFailureMessage ??
          `workspace provider "${config.workspace.provider}" requires a readable Git origin`,
      )
    workspaceCaps.validateOrigin(origin.stdout.trim())
  }
  for (const group of workspaceCaps?.requiredEnv ?? []) {
    if (group.dispatchMessage === undefined) continue
    const satisfied = group.alternatives.some((names) =>
      names.every((name) => opts.env[name] !== undefined && opts.env[name] !== ''),
    )
    if (!satisfied) throw new Error(group.dispatchMessage)
  }
}
