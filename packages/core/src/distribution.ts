import { resolve } from 'node:path'

/** Root of the installable `autobuild` compatibility distribution. */
export function distributionRoot(): string {
  return resolve(import.meta.dir, '..', '..', '..')
}

/** Resolve a path owned by the root distribution. */
export function distributionPath(...segments: string[]): string {
  return resolve(distributionRoot(), ...segments)
}
