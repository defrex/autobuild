import { normalizeProjectRepository } from '@defrex/autobuild-postgres-store/projects'

/** The cron and read-time publication share exactly one selection rule. */
export function parseDispatcherRepositories(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined
  const repositories: string[] = []
  for (const value of raw.split(',')) {
    let normalized: string
    try {
      normalized = normalizeProjectRepository(value.trim())
    } catch {
      throw new Error('AB_DISPATCHER_REPOSITORIES contains an unsafe repository name')
    }
    if (!repositories.includes(normalized)) repositories.push(normalized)
  }
  return repositories
}
export function dispatcherSelection(repositories: readonly string[] | undefined) {
  const members = repositories === undefined ? undefined : new Set(repositories)
  return {
    includes: (repo: string) => members === undefined || members.has(repo),
    filter: (registered: readonly string[]) => {
      const admitted = new Set(registered)
      return repositories?.filter((repo) => admitted.has(repo)) ?? [...registered]
    },
  }
}

export function dispatcherOrigin(env: Record<string, string | undefined>): string {
  let url: URL
  try {
    url = new URL(env.AB_DISPATCHER_ORIGIN?.trim() ?? '')
  } catch {
    throw new Error('AB_DISPATCHER_ORIGIN must be an absolute http(s) origin')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error(
      'AB_DISPATCHER_ORIGIN must be an absolute http(s) origin without credentials or a path',
    )
  if (env.NODE_ENV === 'production' && url.protocol !== 'https:')
    throw new Error('AB_DISPATCHER_ORIGIN must use https in production')
  return url.origin
}
