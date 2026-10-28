import { withHostedProjectContext } from '@defrex/autobuild-postgres-store/request-context'
import { openPostgresProjectSecretsFromEnv } from '@defrex/autobuild-postgres-store/project-secrets'
import { openPostgresBuildStoreFromEnv } from '@defrex/autobuild-postgres-store'
import { createWebProjectSecretsHandler } from './project-secrets'
import { openPostgresProjectDeletionFromEnv } from '@defrex/autobuild-postgres-store/project-deletion'
import { humanAccess } from './access'
import { createOrganizationHandler } from './organizations'
import { openPostgresConnectionStoreFromEnv } from '@defrex/autobuild-postgres-store/connections'
import { openPostgresCredentialStoreFromEnv } from '@defrex/autobuild-postgres-store/credentials'
import { createConnectionHandler } from '../connections'
import { createHostedStoreService } from '../service'
import { parseWebAuthEnv } from './config'
import { webAuth } from './auth'
import { createWebGateway } from './gateway'
import { createMcpEndpoint } from './mcp'

let service: ReturnType<typeof createHostedStoreService> | undefined
export function hostedService() {
  service ??= createHostedStoreService({
    env: process.env,
  })
  return service
}

let secrets: ReturnType<typeof openPostgresProjectSecretsFromEnv> | undefined
let settingsStore: ReturnType<typeof openPostgresBuildStoreFromEnv> | undefined
let deletion: ReturnType<typeof openPostgresProjectDeletionFromEnv> | undefined
let gateway: ReturnType<typeof createWebGateway> | undefined
export function webGateway() {
  gateway ??= createWebGateway({
    env: process.env,
    projects: hostedService().projects,
    getSession: async (headers) => webAuth().api.getSession({ headers }),
    delegate: (request) => hostedService().fetch(request),
  })
  const management = createOrganizationHandler({
    access: humanAccess,
    deletion: () =>
      (deletion ??= openPostgresProjectDeletionFromEnv(process.env).catch((error) => {
        deletion = undefined
        throw error
      })),
    getSession: (headers) => webAuth().api.getSession({ headers }),
  })
  const projectSecrets = createWebProjectSecretsHandler({
    access: humanAccess,
    projects: hostedService().projects,
    baseURL: parseWebAuthEnv(process.env).baseURL,
    getSession: (headers) => webAuth().api.getSession({ headers }),
    secrets: () =>
      (secrets ??= openPostgresProjectSecretsFromEnv(process.env).catch((error) => {
        secrets = undefined
        throw error
      })),
    store: () =>
      (settingsStore ??= openPostgresBuildStoreFromEnv(process.env).catch((error) => {
        settingsStore = undefined
        throw error
      })),
  })
  return {
    fetch: (request: Request) =>
      routeWebRequest(request, {
        projectSecrets,
        management,
        operator: (request) => gateway!.fetch(request),
      }),
  }
}

/** Browser secrets have session authority and never enter the machine gateway. */
export function routeWebRequest(
  request: Request,
  handlers: {
    projectSecrets: (request: Request) => Promise<Response>
    management: (request: Request) => Promise<Response>
    operator: (request: Request) => Promise<Response>
  },
) {
  const path = new URL(request.url).pathname
  if (/^\/api\/web\/repos\/[^/]+\/secrets(?:\/|$)/.test(path))
    return withHostedProjectContext(() => handlers.projectSecrets(request))
  return /^\/api\/web\/(orgs(?:\/|$)|projects\/(?:unassigned|deletions?)(?:\/|$))/.test(path)
    ? handlers.management(request)
    : handlers.operator(request)
}

let mcp: ReturnType<typeof createMcpEndpoint> | undefined
/** The MCP endpoint (AUT-341) — the tool registry over Streamable HTTP on
 * the same origin, authorized by Better Auth's MCP plugin and executed
 * through the operator protocol in-process. */
export function mcpEndpoint() {
  mcp ??= createMcpEndpoint({
    config: parseWebAuthEnv(process.env),
    projects: hostedService().projects,
    auth: webAuth(),
    storeSecret: process.env.AB_STORE_SECRET?.trim() ?? '',
    delegate: (request) => hostedService().fetch(request),
  })
  return mcp
}

let connectionStore: ReturnType<typeof openPostgresConnectionStoreFromEnv> | undefined
let connectionCredentials: ReturnType<typeof openPostgresCredentialStoreFromEnv> | undefined
export function connectionEndpoint() {
  const config = parseWebAuthEnv(process.env)
  return createConnectionHandler({
    store: () =>
      (connectionStore ??= openPostgresConnectionStoreFromEnv(process.env).catch((error) => {
        connectionStore = undefined
        throw error
      })),
    credentials: () =>
      (connectionCredentials ??= openPostgresCredentialStoreFromEnv(process.env).catch((error) => {
        connectionCredentials = undefined
        throw error
      })),
    machineAuth: hostedService().machineAuth,
    baseURL: config.baseURL,
    browser: {
      getSession: (headers) => webAuth().api.getSession({ headers }),
      access: humanAccess,
    },
  })
}
