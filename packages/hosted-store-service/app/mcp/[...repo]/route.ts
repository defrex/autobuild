// Per-repository MCP URLs (#1224): `/mcp/<host>/<path>` serves exactly one
// registered repository through the same endpoint as app/mcp/route.ts, which
// routes on the request path. Same runtime and duration pairing as that
// route (MCP_MAX_WAIT_SECONDS bounds tool waits below maxDuration).
import { mcpEndpoint } from '@defrex/autobuild-hosted-store-service/web/runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const route = (request: Request): Promise<Response> => mcpEndpoint().fetch(request)
export const GET = route
export const POST = route
export const DELETE = route
export const OPTIONS = route
