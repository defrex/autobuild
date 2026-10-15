import { parseWebAuthEnv, safeWebConfig } from '@defrex/autobuild-hosted-store-service/web/config'
import { SignIn } from './SignIn'

export const dynamic = 'force-dynamic'

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; returnTo?: string }>
}) {
  const safe = safeWebConfig(parseWebAuthEnv(process.env))
  const query = await searchParams
  return <SignIn providers={safe.providers} error={query.error} returnTo={query.returnTo} />
}
