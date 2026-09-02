import { createHostedStoreService } from '../service'
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
