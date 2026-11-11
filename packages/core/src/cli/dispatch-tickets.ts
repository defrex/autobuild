/**
 * The dispatcher's ticket source (SPEC §3.2): built once per dispatcher
 * process start, before the loop, against the repository's filesystem
 * location rather than its identity.
 */
import type { TicketsConfig } from '../config/schema'
import { normalizeGitRemoteUrl } from '../kernel/origin'
import type { PluginRegistry } from '../plugins/registry'
import type { GitHubRequest } from '../ports/forge/github-transport'
import { createTicketSource } from '../ports/tickets/create'
import type { TicketSource } from '../ports/types'
import type { Exec } from '../ports/workspace/git-worktree'
import type { RepoStatePaths } from './repo-state'

/**
 * Construct the dispatcher's ticket source. `state.checkout` is the checkout
 * (or origin mode's scratch root), never the repository identity, so a
 * `github` source resolves its coordinates from the checkout's `origin`.
 * Origin mode supplies its repository directly: its scratch root is no Git
 * checkout.
 *
 * Cost: in checkout mode the `github` and `hosted` sources spend one
 * `git remote get-url origin` spawn; origin mode spends none. It runs once
 * per dispatcher process start, never per tick or config reload, and makes
 * zero store reads.
 */
export function dispatcherTicketSource(
  config: TicketsConfig,
  opts: {
    env: Record<string, string | undefined>
    exec: Exec
    /** Origin mode's repository (`--repository` / `AB_REPOSITORY`). */
    repository?: string
  },
  state: Pick<RepoStatePaths, 'checkout'>,
  localStateRoot: string | undefined,
  plugins: PluginRegistry,
  seams: { transport?: GitHubRequest } = {},
): Promise<TicketSource> {
  return createTicketSource(config, opts.env, state.checkout, localStateRoot, plugins, {
    exec: opts.exec,
    ...(opts.repository !== undefined
      ? { repository: normalizeGitRemoteUrl(opts.repository) }
      : {}),
    ...seams,
  })
}
