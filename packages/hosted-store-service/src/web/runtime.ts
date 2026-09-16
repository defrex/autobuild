import { createHostedStoreService } from '../service'
import { createDispatcherEndpoint } from '../dispatcher'
import { parseWebAuthEnv } from './config'
import { webAuth } from './auth'
import { createWebGateway } from './gateway'
import { createMcpEndpoint } from './mcp'

let service: ReturnType<typeof createHostedStoreService> | undefined
export function hostedService() {
  service ??= createHostedStoreService({ env: process.env })
  return service
}

let gateway: ReturnType<typeof createWebGateway> | undefined
export function webGateway() {
  gateway ??= createWebGateway({
    env: process.env,
    getSession: async (headers) => webAuth().api.getSession({ headers }),
    delegate: (request) => hostedService().fetch(request),
  })
  return gateway
}

let dispatcher: ReturnType<typeof createDispatcherEndpoint> | undefined
/** The cron endpoint (AUT-303) — its own small surface beside the
 * store/ticket/operator protocols, authorized by the deployment's
 * CRON_SECRET rather than a minted token or a browser session. */
export function dispatcherEndpoint() {
  dispatcher ??= createDispatcherEndpoint({ env: process.env })
  return dispatcher
}

let mcp: ReturnType<typeof createMcpEndpoint> | undefined
/** The MCP endpoint (AUT-341) — the tool registry over Streamable HTTP on
 * the same origin, authorized by Better Auth's MCP plugin and executed
 * through the operator protocol in-process. */
export function mcpEndpoint() {
  mcp ??= createMcpEndpoint({
    config: parseWebAuthEnv(process.env),
    auth: webAuth(),
    storeSecret: process.env.AB_STORE_SECRET?.trim() ?? '',
    delegate: (request) => hostedService().fetch(request),
  })
  return mcp
}
