import { hostedService } from '@defrex/autobuild-hosted-store-service/web/runtime'
import { selectedProject, projectLink } from './dashboard/project-selection'
import { webAuth } from '@defrex/autobuild-hosted-store-service/web/auth'
import { isAllowedEmail, parseWebAuthEnv } from '@defrex/autobuild-hosted-store-service/web/config'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { DashboardClient } from './dashboard/DashboardClient'

export const dynamic = 'force-dynamic'

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const requestHeaders = await headers()
  const session = await webAuth().api.getSession({ headers: requestHeaders })
  if (!session) redirect('/sign-in')
  const config = parseWebAuthEnv(process.env)
  if (!isAllowedEmail(config.allowedEmails, session.user.email))
    redirect('/sign-in?error=access_denied')
  const repositories = (await hostedService().projects.list()).map((entry) => entry.repo)
  const query = await searchParams
  const requested = typeof query.repo === 'string' ? query.repo : undefined
  const initialSelection = selectedProject(repositories, requested)
  if (requested !== (initialSelection || undefined) || Array.isArray(query.repo)) {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (Array.isArray(value)) for (const item of value) params.append(key, item)
      else if (value !== undefined) params.set(key, value)
    }
    redirect(projectLink(initialSelection, params.toString()))
  }
  return (
    <DashboardClient
      key={initialSelection}
      identity={session.user.email.toLowerCase()}
      repositories={repositories}
      initialSelection={initialSelection}
    />
  )
}
