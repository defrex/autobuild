import { DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT } from '../../machine'
import { ORCHESTRATOR_ROUTE_LIMIT_SECONDS } from '@defrex/autobuild/operator'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// The operator route executes orchestrator turns in this function (message
// posts and approval answers start the loop here; the tick resumes inside
// the dispatch route). The invocation budget clamps to this same constant,
// so one number is cited by the config, the route, and the docs. Vercel/Next
// route limits are not inherited across routes — mirroring
// app/api/dispatch/route.ts and app/mcp/route.ts, which pin 300 explicitly.
export const maxDuration = ORCHESTRATOR_ROUTE_LIMIT_SECONDS
export { DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT }
