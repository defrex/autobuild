/**
 * The full capability objects for the builtin workspace providers (AUT-516).
 * The parse-time subset lives in `config/schema.ts`'s
 * `BUILTIN_WORKSPACE_PROVIDER_CONFIG` because config validation must be
 * statically reachable without the registry; this module assembles the FULL
 * declarations — including the registry-seam behaviors — and is attached to
 * the builtin registrations by `plugins/registry.ts`.
 *
 * Import graph discipline: this module imports `config/schema.ts`,
 * `git-worktree.ts`, `vercel-sandbox.ts`, and the remote readiness module;
 * nothing imports it from `schema.ts`, so no cycle exists. The
 * construction-site `configRefusal` for git-worktree is set EXPLICITLY here,
 * not copied from the table's parse-site `configRefusalMessage` — the two
 * strings differ by design (the parse-site message adds the remediation
 * clause; the construction-site one does not).
 */
import { join, resolve } from 'node:path'
import {
  BUILTIN_WORKSPACE_PROVIDER_CONFIG,
  type VercelSandboxConfig,
  type WorkspaceConfig,
} from '../../config/schema'
import { validateRemoteReadiness } from '../../cli/init-readiness-remote'
import type {
  WorkspaceProviderCapabilities,
  WorkspaceReadinessContext,
} from './provider-capabilities'
import type { CreateWorkspaceProviderOptions } from './create'
import { GitWorktreeProvider } from './git-worktree'
import { validateVercelGithubOrigin } from './github-origin'
import { VercelSandboxProvider } from './vercel-sandbox'
import type { WorkspaceProvider } from '../types'

/** The git-worktree construction-site refusal: no remediation clause, unlike
 * the parse-site message in the config table. */
const GIT_WORKTREE_CONSTRUCTION_REFUSAL =
  '[workspace.config] is not supported by the builtin "git-worktree" provider'

interface BuiltinWorkspaceProviderDeclaration {
  capabilities: WorkspaceProviderCapabilities
  builtinFactory: (
    config: WorkspaceConfig,
    opts: CreateWorkspaceProviderOptions,
    parsed: unknown,
  ) => WorkspaceProvider | Promise<WorkspaceProvider>
}

const vercelReadiness = (ctx: WorkspaceReadinessContext) => validateRemoteReadiness(ctx)

const BUILTINS: Record<string, BuiltinWorkspaceProviderDeclaration> = {
  'git-worktree': {
    capabilities: {
      configRefusal: GIT_WORKTREE_CONSTRUCTION_REFUSAL,
    },
    builtinFactory(_config, opts) {
      // Its provider config is always `{}`: the refusal (parse site and
      // construction site alike) has already rejected anything else.
      return new GitWorktreeProvider({
        root: resolve(opts.worktreeRoot),
        sandboxRoot:
          opts.sandboxRoot ?? resolve(join(opts.worktreeRoot, '..', 'orchestrator-sandboxes')),
        setupCommand: opts.sandboxSetupCommand,
        sandboxEnvironmentVariables: opts.sandboxEnvironmentVariables,
        envSource: opts.env,
      })
    },
  },
  'vercel-sandbox': {
    capabilities: {
      // Parse-time subset comes from the config table; the capability carries
      // no configRefusal because the provider accepts [workspace.config]
      // through its schema.
      ...pickConfigDeclaration('vercel-sandbox'),
      supportedForges: ['github'],
      forgeDispatchMessage: 'vercel-sandbox requires the builtin github forge',
      forgeValidationMessage:
        'vercel-sandbox supports forge = "github" only; configure GitHub publication before validating',
      requiredEnv: [
        {
          alternatives: [['GITHUB_TOKEN'], ['GH_TOKEN']],
          dispatchMessage:
            'vercel-sandbox publication requires GITHUB_TOKEN or GH_TOKEN in the dispatcher environment',
          validationMessage:
            'vercel-sandbox publication requires push-capable GITHUB_TOKEN or GH_TOKEN',
        },
        {
          alternatives: [
            ['VERCEL_OIDC_TOKEN'],
            ['VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID'],
          ],
          validationMessage:
            'Vercel authentication requires VERCEL_OIDC_TOKEN or the durable VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID set',
        },
      ],
      processEnvOnly: [
        {
          name: 'VERCEL_OIDC_TOKEN',
          message:
            'VERCEL_OIDC_TOKEN loaded only from the target .env is unavailable to the Vercel SDK; export it in the launcher environment or configure VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID',
        },
      ],
      storeRequirements: {
        constructionMessage:
          'vercel-sandbox requires an HTTPS BuildStore and scoped AB_TOKEN authority',
        storeRefMessage:
          'vercel-sandbox requires AB_STORE to be an HTTPS URL reachable from Vercel',
        storeTokenMessage: 'vercel-sandbox requires nonempty AB_TOKEN for the hosted Store',
      },
      validateOrigin: validateVercelGithubOrigin,
      originReadFailureMessage: 'vercel-sandbox requires a readable Git origin',
      guestEnvNames: (raw) => {
        const config = raw as VercelSandboxConfig
        return [
          ...config.environmentVariables,
          ...(config.gitUsernameEnv === undefined ? [] : [config.gitUsernameEnv]),
          ...(config.gitPasswordEnv === undefined ? [] : [config.gitPasswordEnv]),
        ]
      },
      describeEnvironment: (raw, env) => {
        const config = raw as VercelSandboxConfig
        return [
          `Vercel auth: ${env.VERCEL_OIDC_TOKEN ? 'OIDC' : 'access token'}; team=${env.VERCEL_TEAM_ID ?? '(linked)'}; project=${env.VERCEL_PROJECT_ID ?? '(linked)'}`,
          `Private clone variables: ${
            config.gitUsernameEnv === undefined
              ? '(public repository)'
              : `${config.gitUsernameEnv}, ${config.gitPasswordEnv}`
          }`,
          `Guest environment variable names: ${config.environmentVariables.join(', ') || '(none)'}`,
          `Runtime provisioning names: ${
            Object.keys(config.runtimeProvisioning ?? {})
              .sort()
              .join(', ') || '(none)'
          }`,
        ]
      },
      validateReadiness: vercelReadiness,
    },
    builtinFactory(_config, opts, parsed) {
      // storeRef/storeToken are guaranteed present: the pre-split
      // storeRequirements check in createWorkspaceProvider ran before
      // construction.
      return new VercelSandboxProvider({
        config: parsed as VercelSandboxConfig,
        env: opts.env,
        storeRef: opts.storeRef!,
        storeToken: opts.storeToken!,
        repo: resolve(opts.repoRoot),
        runtimeReferences: opts.runtimeReferences ?? [],
        setupCommand: opts.sandboxSetupCommand,
        sandboxEnvironmentVariables: opts.sandboxEnvironmentVariables,
        ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
        ...(opts.remoteBranchHead !== undefined ? { remoteBranchHead: opts.remoteBranchHead } : {}),
      })
    },
  },
}

/** The parse-time declaration subset from the config table, without the
 * parse-site refusal text (which never belongs on the capability). */
function pickConfigDeclaration(name: string): WorkspaceProviderCapabilities {
  const declaration = BUILTIN_WORKSPACE_PROVIDER_CONFIG.get(name)
  if (declaration === undefined) return {}
  return {
    ...(declaration.configSchema !== undefined ? { configSchema: declaration.configSchema } : {}),
    ...(declaration.requireRuntimeProvisioning === true
      ? { requireRuntimeProvisioning: true }
      : {}),
    ...(declaration.sandboxForbiddenEnv !== undefined
      ? { sandboxForbiddenEnv: declaration.sandboxForbiddenEnv }
      : {}),
  }
}

/** The FULL capability object of a builtin workspace provider, `undefined`
 * for any other name. Used by pre-registry seams (guest probe, init
 * preflight) that cannot consult the plugin registry. */
export function builtinWorkspaceProviderCapabilities(
  name: string,
): WorkspaceProviderCapabilities | undefined {
  return BUILTINS[name]?.capabilities
}

/** The builtin registration extras for `plugins/registry.ts`: the capability
 * object plus the host-owned construction closure. */
export function builtinWorkspaceProviderRegistration(
  name: string,
): BuiltinWorkspaceProviderDeclaration | undefined {
  const builtin = BUILTINS[name]
  return builtin === undefined
    ? undefined
    : { capabilities: builtin.capabilities, builtinFactory: builtin.builtinFactory }
}
