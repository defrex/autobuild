/**
 * The checkout-less operator-sandbox composition helper (AUT-584): builds the
 * same `createOperatorSandboxService` backend `ab mcp` builds from a checkout,
 * but from a deposited effective config plus injected seams — for hosted
 * serving processes that hold no host checkout and never touch host git.
 *
 * The module is a SEPARATE subpath (`@defrex/autobuild/operator-sandbox-host`)
 * on purpose: it pulls the workspace-provider/forge construction closure, and
 * existing `./operator` consumers (the hosted operator server among them) must
 * not grow that closure. The hosted store service imports only this subpath.
 *
 * Containment contract: every construction failure THROWS. The callers (the
 * hosted store service's runner factory and the dispatcher tick) contain it —
 * a broken or unsupported config degrades the sandbox tools of one binding,
 * never the orchestrator itself.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../config/schema'
import type { Forge } from '../ports/types'
import { createForge } from '../ports/forge/create'
import { GitHubApiError } from '../ports/forge/github-transport'
import { createWorkspaceProvider } from '../ports/workspace/create'
import { createPluginRegistry } from '../plugins/registry'
import type { BuildStore, Clock } from '../store/types'
import { createOperatorSandboxService, type OperatorSandboxService } from './sandbox'

export interface HostedOperatorSandboxOptions {
  store: BuildStore
  /** The repository identity — already the normalized HTTPS origin the
   * sandbox providers parse with `cleanGithubOrigin`; passed through as the
   * provider's `origin` seam so no host git is ever probed. */
  repo: string
  /** The repository's effective config (the deposited
   * `dispatcher-effective-config` artifact, or the checkout's parsed config).
   * `[orchestrator].enabled` is the CALLER's gate; this helper composes the
   * backend for any config handed to it. */
  config: Config
  /** The serving process's environment. The Vercel SDK credential must be
   * reachable here for a `vercel-sandbox` workspace (`VERCEL_OIDC_TOKEN`, or
   * the durable `VERCEL_TOKEN`/`VERCEL_TEAM_ID`/`VERCEL_PROJECT_ID` triple);
   * a hosted caller merges the request's `x-vercel-oidc-token` under
   * `VERCEL_OIDC_TOKEN` before calling, with an explicit env token keeping
   * precedence. */
  env: Record<string, string | undefined>
  /** The provider's store authority: an HTTPS store ref reachable from the
   * sandbox plus a repo-scoped token. The guest environment is always built
   * from an empty record plus the configured forwarded names, so neither
   * value ever reaches the sandbox guest. */
  storeRef: string
  storeToken: string
  /** Scratch root for the composition's filesystem seams (worktree root,
   * repo root, sandbox root). Default: a fresh `mkdtemp` under the OS temp
   * directory. The builtin providers only touch these paths through host-git
   * or local-scratch paths the injected seams bypass; a plugin-provider config
   * fails construction before any path use. */
  scratchRoot?: string
  clock?: Clock
  /** Test seam: an already-constructed forge. Production passes nothing and
   * the configured forge is built here. The forge is REQUIRED either way —
   * unlike `ab mcp`, which degrades to `canPublish: false` because its
   * provider can fall back to host git, a hosted host has no checkout, so a
   * backend without a forge cannot resolve base heads at all. */
  forge?: Forge
}

/** Map a forge onto the provider's checkout-less `remoteBranchHead` seam:
 * a `GitHubApiError` with status 404 means the branch does not exist and
 * reads as `undefined`; every other error is rethrown (a transient GitHub
 * failure must never masquerade as an absent branch and refuse provision).
 * The forge must expose `remoteBranchSha`; the caller enforces that before
 * calling with a diagnostic that names the forge. */
export function remoteBranchHeadFromForge(
  forge: Forge,
): (branch: string) => Promise<string | undefined> {
  const remoteBranchSha = forge.remoteBranchSha
  if (remoteBranchSha === undefined) {
    throw new Error('forge does not resolve remote branch heads')
  }
  return async (branch: string): Promise<string | undefined> => {
    try {
      return await remoteBranchSha.call(forge, branch)
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return undefined
      throw error
    }
  }
}

/** Build the hosted operator-sandbox backend from the effective config and
 * injected seams. Throws on every construction failure (unknown provider or
 * forge, missing Vercel SDK credential, forbidden forwarded env name,
 * capability-less provider, forge without `remoteBranchSha`) — the caller
 * contains and degrades to serving without the sandbox tools. */
export async function createHostedOperatorSandboxService(
  options: HostedOperatorSandboxOptions,
): Promise<OperatorSandboxService> {
  const scratch = options.scratchRoot ?? (await mkdtemp(join(tmpdir(), 'autobuild-sandbox-host-')))
  const forge =
    options.forge ??
    (await createForge({
      name: options.config.forge,
      registry: createPluginRegistry(),
      env: options.env,
      repoRoot: scratch,
      repository: options.repo,
    }))
  if (forge.remoteBranchSha === undefined) {
    throw new Error(
      `the configured forge "${options.config.forge}" does not resolve remote branch heads; ` +
        'the hosted sandbox backend has no checkout to resolve base heads against',
    )
  }
  // Builtin-only registry: a plugin-provider config fails construction here
  // (unknown provider in the empty registry) and the caller contains it.
  const provider = await createWorkspaceProvider(options.config.workspace, {
    registry: createPluginRegistry(),
    worktreeRoot: scratch,
    repoRoot: scratch,
    env: options.env,
    storeRef: options.storeRef,
    storeToken: options.storeToken,
    origin: async () => options.repo,
    remoteBranchHead: remoteBranchHeadFromForge(forge),
    sandboxSetupCommand: options.config.commands.setup,
    sandboxRoot: join(scratch, 'orchestrator-sandboxes'),
    sandboxEnvironmentVariables: options.config.orchestrator.sandbox.environmentVariables,
    orchestratorSandboxEnabled: true,
  })
  return createOperatorSandboxService({
    store: options.store,
    repo: options.repo,
    provider,
    sandbox: options.config.orchestrator.sandbox,
    baseBranch: options.config.baseBranch,
    forge,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  })
}
