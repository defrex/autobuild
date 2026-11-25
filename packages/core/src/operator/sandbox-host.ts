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
 * On a deployment only the `vercel-sandbox` builtin can host a checkout-less
 * sandbox, so a project whose own provider is anything else gets its operator
 * sandbox from the deployment's Vercel Sandbox provider instead
 * (`hostedOperatorSandboxComposition`), with the deployment's forge token as
 * the git read credential, placed only in the upload-pack egress transform.
 *
 * Containment contract: every construction failure THROWS. The callers (the
 * hosted store service's runner factory and the dispatcher tick) contain it —
 * a broken or unsupported config degrades the sandbox tools of one binding,
 * never the orchestrator itself.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../config/schema'
import type { Forge } from '../ports/types'
import { createForge } from '../ports/forge/create'
import { GitHubApiError, githubTokenFromEnv } from '../ports/forge/github-transport'
import { createWorkspaceProvider } from '../ports/workspace/create'
import { createPluginRegistry } from '../plugins/registry'
import type { BuildStore, Clock } from '../store/types'
import { createOperatorSandboxService, type OperatorSandboxService } from './sandbox'
import { SandboxUnavailableError } from './sandbox-resolver'

export interface HostedOperatorSandboxOptions {
  store: BuildStore
  /** The repository identity — already the normalized HTTPS origin the
   * sandbox providers parse with `cleanGithubOrigin`; passed through as the
   * provider's `origin` seam so no host git is ever probed. */
  repo: string
  /** The repository's effective config (the deposited
   * `dispatcher-effective-config` artifact, or the checkout's parsed config).
   * `[orchestrator].enabled` is the CALLER's gate; this helper composes the
   * backend for any config handed to it, substituting the deployment's
   * Vercel Sandbox provider when the configured one cannot host a sandbox
   * here (`hostedOperatorSandboxComposition`). */
  config: Config
  /** The serving process's environment. The Vercel SDK credential must be
   * reachable here for a `vercel-sandbox` workspace or the fallback (`VERCEL_OIDC_TOKEN`, or
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
   * directory, removed on construction failure or dispose(). A supplied root
   * remains caller-owned. The builtin providers only touch these paths through host-git
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

/** The only builtin that can host a checkout-less sandbox on a deployment:
 * `git-worktree` would build a local worktree inside the serving process's
 * scratch, and the hosted registry is builtin-only, so a plugin provider can
 * never host one there. Every other provider falls back to the deployment's
 * Vercel Sandbox provider. */
const HOSTED_SANDBOX_PROVIDER = 'vercel-sandbox'

/** The fallback's Vercel Sandbox config: 45 minutes fits every Vercel plan;
 * no `gitUsernameEnv`/`gitPasswordEnv`, so the configured-clone path and its
 * schema guard stay untouched. Everything else takes schema defaults. */
const FALLBACK_VERCEL_SANDBOX_CONFIG = { timeoutSeconds: 2700, runtimeProvisioning: {} }

export interface HostedOperatorSandboxComposition {
  /** The config to compose: the deposited one, or a copy whose `workspace`
   * is the deployment's Vercel Sandbox provider. */
  config: Config
  fallback: boolean
  /** The deployment's git read credential for the fallback; the provider
   * places it only in the upload-pack egress transform. */
  egressReadCredential?: { username: string; password: string }
}

function nonblank(env: Readonly<Record<string, string | undefined>>, name: string): boolean {
  const value = env[name]
  return value !== undefined && value.trim() !== ''
}

/** Decide what the hosted operator sandbox composes for `config`. A
 * `vercel-sandbox` project passes through unchanged. Any other provider gets
 * the deployment's Vercel Sandbox provider, which needs the deployment's
 * Vercel credential (`VERCEL_OIDC_TOKEN`, after the request header is
 * merged, or the durable `VERCEL_TOKEN`/`VERCEL_TEAM_ID`/`VERCEL_PROJECT_ID`
 * triple) and its forge token (`GITHUB_TOKEN` or `GH_TOKEN`); without them it
 * throws `SandboxUnavailableError('credentials-missing')` naming every missing
 * group, never a value. Pure: reads `env`, never mutates it. */
export function hostedOperatorSandboxComposition(
  config: Config,
  env: Readonly<Record<string, string | undefined>>,
): HostedOperatorSandboxComposition {
  if (config.workspace.provider === HOSTED_SANDBOX_PROVIDER) return { config, fallback: false }
  const missing: string[] = []
  const vercel =
    nonblank(env, 'VERCEL_OIDC_TOKEN') ||
    (nonblank(env, 'VERCEL_TOKEN') &&
      nonblank(env, 'VERCEL_TEAM_ID') &&
      nonblank(env, 'VERCEL_PROJECT_ID'))
  if (!vercel) {
    missing.push(
      'VERCEL_OIDC_TOKEN (or the x-vercel-oidc-token request header) or VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID',
    )
  }
  const token = githubTokenFromEnv(env)
  if (token === undefined || token.trim() === '') missing.push('GITHUB_TOKEN or GH_TOKEN')
  if (missing.length > 0) {
    throw new SandboxUnavailableError(
      'credentials-missing',
      `the hosted operator sandbox needs the deployment's Vercel and forge credentials; missing: ${missing.join('; ')}`,
    )
  }
  return {
    config: {
      ...config,
      workspace: {
        provider: HOSTED_SANDBOX_PROVIDER,
        config: { ...FALLBACK_VERCEL_SANDBOX_CONFIG },
      },
    },
    fallback: true,
    egressReadCredential: { username: 'x-access-token', password: token! },
  }
}

export interface HostedOperatorSandboxService extends OperatorSandboxService {
  dispose(): Promise<void>
}

/** Build the hosted operator-sandbox backend from the effective config and
 * injected seams, through `hostedOperatorSandboxComposition` (which may
 * substitute the deployment's Vercel provider, or refuse
 * `credentials-missing`). Throws on every construction failure (unknown provider or
 * forge, missing Vercel SDK credential, forbidden forwarded env name,
 * capability-less provider, forge without `remoteBranchSha`) — the caller
 * contains and degrades to serving without the sandbox tools. */
export async function createHostedOperatorSandboxService(
  options: HostedOperatorSandboxOptions,
): Promise<HostedOperatorSandboxService> {
  const ownsScratch = options.scratchRoot === undefined
  const scratch = options.scratchRoot ?? (await mkdtemp(join(tmpdir(), 'autobuild-sandbox-host-')))
  let disposal: Promise<void> | undefined
  const dispose = () => {
    disposal ??= ownsScratch ? rm(scratch, { recursive: true, force: true }) : Promise.resolve()
    return disposal
  }
  try {
    const { config, egressReadCredential } = hostedOperatorSandboxComposition(
      options.config,
      options.env,
    )
    const forge =
      options.forge ??
      (await createForge({
        name: config.forge,
        registry: createPluginRegistry(),
        env: options.env,
        repoRoot: scratch,
        repository: options.repo,
        // A deployment without a token must fail typed, never spend the
        // hosting platform's shared anonymous GitHub quota.
        requireCredential: 'hosted operator sandbox backend',
      }))
    if (forge.remoteBranchSha === undefined) {
      throw new Error(
        `the configured forge "${config.forge}" does not resolve remote branch heads; ` +
          'the hosted sandbox backend has no checkout to resolve base heads against',
      )
    }
    // Builtin-only registry: a plugin-provider config fails construction here
    // (unknown provider in the empty registry) and the caller contains it.
    const provider = await createWorkspaceProvider(config.workspace, {
      registry: createPluginRegistry(),
      worktreeRoot: scratch,
      repoRoot: scratch,
      env: options.env,
      storeRef: options.storeRef,
      storeToken: options.storeToken,
      origin: async () => options.repo,
      remoteBranchHead: remoteBranchHeadFromForge(forge),
      sandboxSetupCommand: config.commands.setup,
      sandboxRoot: join(scratch, 'orchestrator-sandboxes'),
      sandboxEnvironmentVariables: config.orchestrator.sandbox.environmentVariables,
      orchestratorSandboxEnabled: true,
      ...(egressReadCredential !== undefined
        ? { sandboxEgressReadCredential: egressReadCredential }
        : {}),
    })
    const service = await createOperatorSandboxService({
      store: options.store,
      repo: options.repo,
      provider,
      sandbox: config.orchestrator.sandbox,
      baseBranch: config.baseBranch,
      forge,
      ...(options.clock !== undefined ? { clock: options.clock } : {}),
    })
    return Object.assign(service, { dispose })
  } catch (error) {
    try {
      await dispose()
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Hosted sandbox construction and cleanup failed',
      )
    }
    throw error
  }
}
