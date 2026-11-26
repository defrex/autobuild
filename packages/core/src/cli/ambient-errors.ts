/** Ambient-identity errors, free of the session resolvers so store openers can
 * raise them without initializing `./env`, which re-exports them. */
const BUILD_AMBIENT_TUPLE = 'AB_STORE/AB_BUILD/AB_PHASE/AB_SESSION'
const HARVEST_AMBIENT_TUPLE = 'AB_STORE/AB_REPO/AB_HARVEST/AB_PHASE/AB_SESSION'

/** Optional ambient identity is present but cannot safely select one scope. */
export class InvalidAmbientContextError extends Error {
  override readonly name = 'InvalidAmbientContextError'

  constructor(detail: string) {
    super(
      `invalid ambient context: ${detail}. Expected no agent identity markers, ` +
        `a complete build tuple (${BUILD_AMBIENT_TUPLE}), or a complete Harvest tuple ` +
        `(${HARVEST_AMBIENT_TUPLE})`,
    )
  }
}
