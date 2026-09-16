// Client half + shared wire vocabulary for the remote BuildStore (SPEC §7.2).
// The HTTP server half ships in `@defrex/autobuild-hosted-store-service`;
// this barrel is what a local CLI and the hosted package both build against.
export { AuthError, RemoteBuildStore } from './client'
export type { RemoteBuildStoreOptions, RemoteStoreIdentity } from './client'
export { mintToken, tokenResource, verifyToken } from './token'
export type { OperatorTokenScope, TokenScope } from './token'
export {
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
} from './version'
// The whole wire protocol: schemas, error vocabulary, and the placeholder-ref
// deposit convention. The protocol servers (hosted package) compose these;
// clients parse them for feedback.
export * from './protocol'
// Event vocabulary the wire envelopes and the server's D6 mapping rely on.
export { EventValidationError } from '../../events/catalog'
export type { Via } from '../../events/envelope'
export type { SessionEvent, SessionEventWrite } from '../../events/sessions'
export type { RepositoryEvent, RepositoryEventWrite } from '../../events/repository'
