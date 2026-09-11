import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Directory of this module. Bun exposes `import.meta.dir`; bundlers that
 * embed the module (Next.js/Turbopack for the hosted service) provide only
 * `import.meta.url`, so fall back to it rather than resolving from undefined
 * at module evaluation time.
 */
function moduleDir(): string {
  const dir = (import.meta as { dir?: unknown }).dir
  if (typeof dir === 'string' && dir !== '') return dir
  return dirname(fileURLToPath(import.meta.url))
}

/** Root of the installable `autobuild` compatibility distribution. */
export function distributionRoot(): string {
  return resolve(moduleDir(), '..', '..', '..')
}

/** Resolve a path owned by the root distribution. */
export function distributionPath(...segments: string[]): string {
  return resolve(distributionRoot(), ...segments)
}
