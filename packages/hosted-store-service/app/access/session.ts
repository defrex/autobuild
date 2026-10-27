import 'server-only'
import { humanAccess, validSession } from '@defrex/autobuild-hosted-store-service/web/access'
import { webAuth } from '@defrex/autobuild-hosted-store-service/web/auth'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
export async function accessSession() {
  const session = await webAuth().api.getSession({ headers: await headers() })
  if (!session || !validSession(session)) redirect('/sign-in')
  const principal = await humanAccess.principal(session.user.email)
  if (!principal) redirect('/sign-in?error=access_denied')
  const organizations = await (await humanAccess.store()).organizations(principal)
  return {
    isOwner: organizations.some((org) => org.membershipRole === 'owner'),
    identity: principal.email,
    isSuperUser: principal.isSuperUser(),
  }
}
