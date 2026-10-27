import { parseWebAuthEnv } from '@defrex/autobuild-hosted-store-service/web/config'
import { accessSession } from '../access/session'
import { MembersClient } from './MembersClient'
export const dynamic = 'force-dynamic'
export default async function MembersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await accessSession()
  const query = await searchParams
  return (
    <MembersClient
      {...session}
      initialOrg={typeof query.org === 'string' ? query.org : undefined}
      signInUrl={`${parseWebAuthEnv(process.env).baseURL}/sign-in`}
    />
  )
}
