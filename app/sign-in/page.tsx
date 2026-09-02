import { parseWebAuthEnv, safeWebConfig } from '@autobuild/hosted-store-service/web/config'
import { SignIn } from './SignIn'

export const dynamic = 'force-dynamic'

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const safe = safeWebConfig(parseWebAuthEnv(process.env))
  const query = await searchParams
  return <SignIn providers={safe.providers} error={query.error} />
}
