import manifest from '../../../../../package.json'

/** Release-synchronized identity sent by every remote-store client. */
export const AUTOBUILD_VERSION = manifest.version

/** Wire compatibility version for the remote BuildStore protocol.
 * Version 3 (AUT-521): the build-digest wire shape gains per-occurrence
 * observation timestamps and the `merged` fact — a breaking shape change,
 * so stale peers are rejected at handshake instead of failing mid-request
 * at schema parse. */
export const REMOTE_STORE_PROTOCOL_VERSION = '3'

export const AUTOBUILD_VERSION_HEADER = 'x-autobuild-version'
export const REMOTE_STORE_PROTOCOL_VERSION_HEADER = 'x-autobuild-protocol-version'
