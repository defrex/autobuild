import { createHostedStoreService } from '../service'
import { createDispatcherEndpoint } from '../dispatcher'
import { webAuth } from './auth'
import { createWebGateway } from './gateway'

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
