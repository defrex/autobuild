import manifest from '../../../../../package.json'

/** Release-synchronized identity sent by every remote-store client. */
export const AUTOBUILD_VERSION = manifest.version

/** Wire compatibility version for the remote BuildStore protocol. */
export const REMOTE_STORE_PROTOCOL_VERSION = '2'

export const AUTOBUILD_VERSION_HEADER = 'x-autobuild-version'
export const REMOTE_STORE_PROTOCOL_VERSION_HEADER = 'x-autobuild-protocol-version'
