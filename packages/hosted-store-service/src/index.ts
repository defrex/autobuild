export { HOSTED_ARTIFACT_MAX_BYTES, parseHostedStoreEnv } from './config'
export type { HostedStoreConfig, HostedStoreEnv } from './config'
export { createHostedStoreService } from './service'
export type { HostedStoreServiceOptions } from './service'
export { admittedUser, createWebAuth, webAuth } from './web/auth'
export type { WebAuth } from './web/auth'
export {
  isAllowedEmail,
  normalizeEmail,
  parseWebAuthEnv,
  safeWebConfig,
} from './web/config'
export type { WebAuthConfig, WebAuthProvider, WebEnv } from './web/config'
export { createWebGateway } from './web/gateway'
export type { GatewaySession, WebGatewayOptions } from './web/gateway'
export { hostedService, webGateway } from './web/runtime'
