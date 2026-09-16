/**
 * npm registry addressing shared by self-update (version lookup) and the
 * guest distribution source (tarball download). Pure URL arithmetic; the
 * callers own their transport seams.
 */

export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org'

/** The registry to read: the operator's configured `NPM_CONFIG_REGISTRY`
 * when set, else the public registry, without a trailing slash. */
export function registryBaseUrl(
  env: Readonly<Record<string, string | undefined>> | undefined,
): string {
  const configured = env?.NPM_CONFIG_REGISTRY?.trim()
  return (
    configured !== undefined && configured !== '' ? configured : DEFAULT_NPM_REGISTRY
  ).replace(/\/+$/, '')
}

/** `<registry>/<encoded name>/<version|latest>` — the registry's version
 * document endpoint, with the scope separator encoded as npm clients do. */
export function registryVersionUrl(base: string, packageName: string, version?: string): string {
  return `${base}/${packageName.replace('/', '%2f')}/${version ?? 'latest'}`
}
