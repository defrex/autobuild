export function selectedProject(
  repositories: readonly string[],
  requested: string | undefined,
): string {
  return requested !== undefined && repositories.includes(requested)
    ? requested
    : (repositories[0] ?? '')
}
export function projectLink(repo: string, query: string): string {
  const params = new URLSearchParams(query)
  if (repo) params.set('repo', repo)
  else params.delete('repo')
  const suffix = params.toString()
  return suffix ? `/?${suffix}` : '/'
}
/** A build's own page within a project. */
export function buildLink(repo: string, slug: string, query = ''): string {
  const params = new URLSearchParams(query)
  if (repo) params.set('repo', repo)
  else params.delete('repo')
  const suffix = params.toString()
  return `/build/${encodeURIComponent(slug)}${suffix ? `?${suffix}` : ''}`
}
