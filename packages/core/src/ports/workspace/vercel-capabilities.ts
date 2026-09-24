/**
 * The single shared capability object for the `vercel-sandbox` workspace
 * provider (AUT-517). During the transitional state in which the builtin
 * hosts the provider implementation, both the builtin registration (in
 * `builtin-capabilities.ts`) and the `@defrex/autobuild-vercel-sandbox`
 * plugin reference THIS object, so the two declarations cannot drift: any
 * future divergence is a compile-time split, not a silently duplicated
 * closure.
 *
 * The parse-time subset comes from `BUILTIN_WORKSPACE_PROVIDER_CONFIG` in
 * `config/schema.ts`; the registry-seam behaviors and the closures
 * (`validateOrigin`, `guestEnvNames`, `describeEnvironment`,
 * `validateReadiness`) are assembled here once.
 *
 * Import graph discipline: this module imports `config/schema.ts`,
 * `github-origin.ts`, and `init-readiness-remote.ts`; nothing imports it
 * from `schema.ts`, so no cycle exists.
 */
import { BUILTIN_WORKSPACE_PROVIDER_CONFIG, type VercelSandboxConfig } from '../../config/schema'
import { validateRemoteReadiness } from '../../cli/init-readiness-remote'
import type {
  WorkspaceProviderCapabilities,
  WorkspaceReadinessContext,
} from './provider-capabilities'
import { validateVercelGithubOrigin } from './github-origin'

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

export const VERCEL_SANDBOX_CAPABILITIES: WorkspaceProviderCapabilities = {
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
    storeRefMessage: 'vercel-sandbox requires AB_STORE to be an HTTPS URL reachable from Vercel',
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
  validateReadiness: (ctx: WorkspaceReadinessContext) => validateRemoteReadiness(ctx),
}
