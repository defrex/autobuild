import { createHash } from 'node:crypto'

/** The grammar of a build-creation key: a preparation attempt id. */
export const CREATION_KEY = /^[A-Za-z0-9_-]{1,128}$/

/** The slug base an allocating store suffixes: the requested slug's first 60
 * characters without trailing hyphens. */
export function projectBuildSlugBase(requestedSlug: string): string {
  return requestedSlug.slice(0, 60).replace(/-+$/, '')
}

/**
 * The canonical slug an allocating store gives a keyed creation. Client and
 * server share this derivation, so a client that lost the create response can
 * point-read the build its own key created and no other. Two keys collide only
 * with the same repository, requested slug and 96-bit digest prefix; a store
 * answers such a repeat with a conflict and never allocates a second identity.
 */
export function creationBuildSlug(
  repo: string,
  requestedSlug: string,
  creationKey: string,
): string {
  const digest = createHash('sha256')
    .update(`autobuild-build-creation\0${repo}\0${requestedSlug}\0${creationKey}`)
    .digest('hex')
    .slice(0, 24)
  return `${projectBuildSlugBase(requestedSlug)}-${digest}`
}
