/** The web UI's pages, each at its own URL. Navigation is plain links. */
export type Route =
  | { page: 'overview' }
  | { page: 'analytics' }
  | { page: 'build'; slug: string }
  | { page: 'unknown' }

export const ANALYTICS_PATH = '/analytics'

const BUILD_PREFIX = '/builds/'

export function route(path: string): Route {
  if (path === '/') return { page: 'overview' }
  if (path === ANALYTICS_PATH) return { page: 'analytics' }
  if (!path.startsWith(BUILD_PREFIX)) return { page: 'unknown' }
  let slug: string
  try {
    slug = decodeURIComponent(path.slice(BUILD_PREFIX.length))
  } catch {
    return { page: 'unknown' }
  }
  return slug === '' ? { page: 'unknown' } : { page: 'build', slug }
}

export function buildHref(slug: string): string {
  return `${BUILD_PREFIX}${encodeURIComponent(slug)}`
}
