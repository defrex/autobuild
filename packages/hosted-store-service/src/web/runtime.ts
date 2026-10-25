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
    getSession: (headers) => webAuth().api.getSession({ headers }),
  })
  return {
    fetch: (request: Request) => {
      const path = new URL(request.url).pathname
      return /^\/api\/web\/(orgs(?:\/|$)|projects\/unassigned(?:\/|$))/.test(path)
        ? management(request)
        : gateway!.fetch(request)
    },
  }
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
