import { webAuth } from '@autobuild/hosted-store-service/web/auth'
import {
  isAllowedEmail,
  parseWebAuthEnv,
  safeWebConfig,
} from '@autobuild/hosted-store-service/web/config'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { DashboardClient } from './dashboard/DashboardClient'

export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  const requestHeaders = await headers()
  const session = await webAuth().api.getSession({ headers: requestHeaders })
  if (!session) redirect('/sign-in')
  const config = parseWebAuthEnv(process.env)
  if (!isAllowedEmail(config.allowedEmails, session.user.email))
    redirect('/sign-in?error=access_denied')
  const safe = safeWebConfig(config)
  return (
    <DashboardClient identity={session.user.email.toLowerCase()} repositories={safe.repositories} />
  )
}
