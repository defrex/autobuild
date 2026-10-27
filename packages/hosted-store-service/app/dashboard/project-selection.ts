export function selectedProject(
  repositories: readonly string[],
  requested: string | undefined,
): string {
  return requested !== undefined && repositories.includes(requested)
    ? requested
    : (repositories[0] ?? '')
}

/** `path` with the project named in its query, keeping any other parameters. */
function withProject(path: string, repo: string, query = ''): string {
  const params = new URLSearchParams(query)
  if (repo) params.set('repo', repo)
  else params.delete('repo')
  const suffix = params.toString()
  return suffix ? `${path}?${suffix}` : path
}

export function projectLink(repo: string, query: string): string {
  return withProject('/', repo, query)
}
/** A build's own page within a project. */
export function buildLink(repo: string, slug: string, query = ''): string {
  return withProject(`/build/${encodeURIComponent(slug)}`, repo, query)
}

/** The operator's top-level views: ticket lifecycle tabs around the active builds. */
export type ViewTab = 'triage' | 'queue' | 'active' | 'done'
export type TicketTab = Exclude<ViewTab, 'active'>
export const VIEW_TABS: readonly ViewTab[] = ['triage', 'queue', 'active', 'done']

export function tabLink(repo: string, tab: ViewTab, query = ''): string {
  return withProject(tab === 'active' ? '/' : `/${tab}`, repo, query)
}
/** A ticket's own page within a project. */
export function ticketLink(repo: string, id: string, query = ''): string {
  return withProject(`/ticket/${encodeURIComponent(id)}`, repo, query)
}
