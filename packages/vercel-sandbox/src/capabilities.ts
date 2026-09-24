/**
 * The `vercel-sandbox` workspace provider's capability declaration (AUT-516).
 * The registry-seam behaviors and the closures (`validateOrigin`,
 * `guestEnvNames`, `describeEnvironment`, `validateReadiness`) are assembled
 * here once; the parse-time subset is gone with the builtin config table
 * (AUT-505) — `[workspace.config]` is validated through `configSchema` at the
 * registry-aware construction seam instead.
 *
 * The four Vercel credential names are declared as `sandboxForbiddenEnv`
 * extras: they left core's shared `SANDBOX_FORBIDDEN_ENV` with the builtin's
 * removal, and the two registry-aware forwarding gates (construction and
 * init validation) enforce them for `vercel-sandbox` selections exactly as
 * the AUT-536 deferral designed.
 *
 * Import graph discipline: this module imports `schema.ts`, `github-origin.ts`,
 * and `readiness.ts` from this package plus the plugin-sdk surface; nothing
 * imports it from `schema.ts`, so no cycle exists.
 */
import type {
  WorkspaceProviderCapabilities,
  WorkspaceReadinessContext,
} from '@defrex/autobuild/plugin-sdk'
import { vercelSandboxConfigSchema, type VercelSandboxConfig } from './schema'
import { validateRemoteReadiness } from './readiness'
import { validateVercelGithubOrigin } from './github-origin'

export const VERCEL_SANDBOX_CAPABILITIES: WorkspaceProviderCapabilities = {
  configSchema: vercelSandboxConfigSchema,
  requireRuntimeProvisioning: true,
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
  sandboxForbiddenEnv: ['VERCEL_OIDC_TOKEN', 'VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID'],
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
