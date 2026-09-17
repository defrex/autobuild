// The hosted dispatcher's cron route (AUT-303): Vercel Cron issues plain GET
// requests with `Authorization: Bearer <CRON_SECRET>`; the endpoint runs one
// bounded dispatcher tick per configured repository. The dispatcher is the
// optional `@defrex/autobuild-hosted-dispatcher` package — a deployment that
// only hosts state does not install it and never serves this route.
// maxDuration is Vercel's Pro default (300 s); raise it together with
// AB_DISPATCHER_BUDGET_SECONDS — see docs/hosted-dispatcher.md.
import { dispatcherEndpoint } from '@defrex/autobuild-hosted-dispatcher/runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request: Request): Promise<Response> {
  return dispatcherEndpoint().fetch(request)
}
