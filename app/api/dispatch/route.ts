// The hosted dispatcher's cron route (AUT-303): Vercel Cron issues plain GET
// requests with `Authorization: Bearer <CRON_SECRET>`; the endpoint runs one
// bounded dispatcher tick per configured repository. maxDuration is Vercel's
// Pro default (300 s); raise it together with AB_DISPATCHER_BUDGET_SECONDS —
// see docs/hosted-dispatcher.md.
import { dispatcherEndpoint } from '@autobuild/hosted-store-service/web/runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request: Request): Promise<Response> {
  return dispatcherEndpoint().fetch(request)
}
