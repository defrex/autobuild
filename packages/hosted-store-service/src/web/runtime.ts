import { createHostedStoreService } from '../service'
import { parseWebAuthEnv } from './config'
import { webAuth } from './auth'
import { createWebGateway } from './gateway'
import { createMcpEndpoint } from './mcp'
import { after } from 'next/server'

let service: ReturnType<typeof createHostedStoreService> | undefined
export function hostedService() {
  service ??= createHostedStoreService({
    env: process.env,
    // The embedded orchestrator's turn loops must outlive the HTTP response
    // (AUT-342): `after()` keeps the work in the machine route's request
    // context, which is live because `hostedService().fetch` runs inside it.
    scheduleBackground: (fn) => after(fn),
  })
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
