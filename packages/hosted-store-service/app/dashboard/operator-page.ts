import { humanAccess, validSession } from '@defrex/autobuild-hosted-store-service/web/access'
import { webAuth } from '@defrex/autobuild-hosted-store-service/web/auth'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { selectedProject } from './project-selection'

export type OperatorSearchParams = Promise<Record<string, string | string[] | undefined>>

/**
 * The signed-in operator and the project an operator page shows. A missing or
 * unreachable `repo` redirects to `canonical(selected, query)` so every page
 * URL names the project it renders.
 */
export async function operatorPage(
  searchParams: OperatorSearchParams,
  canonical: (repo: string, query: string) => string,
) {
  const requestHeaders = await headers()
  const session = await webAuth().api.getSession({ headers: requestHeaders })
  if (!session || !validSession(session)) redirect('/sign-in')
  const principal = await humanAccess.principal(session.user.email)
  if (!principal) redirect('/sign-in?error=access_denied')
  const repositories = await humanAccess.projects(principal)
  const query = await searchParams
  const requested = typeof query.repo === 'string' ? query.repo : undefined
  const initialSelection = selectedProject(repositories, requested)
  if (requested !== (initialSelection || undefined) || Array.isArray(query.repo)) {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (Array.isArray(value)) for (const item of value) params.append(key, item)
      else if (value !== undefined) params.set(key, value)
    }
    redirect(canonical(initialSelection, params.toString()))
  }
  const organizations = await (await humanAccess.store()).organizations(principal)
  return {
    isOwner: organizations.some((org) => org.membershipRole === 'owner'),
    identity: session.user.email.toLowerCase(),
    isSuperUser: principal.isSuperUser(),
    repositories,
    initialSelection,
  }
}
