// The hosted MCP endpoint (AUT-341): the tool registry over Streamable HTTP,
// authorized by Better Auth's MCP plugin. maxDuration is Vercel's Pro default
// (300 s); the binding clamps tool-requested bounded waits to
// MCP_MAX_WAIT_SECONDS (240 s) so no single request outlives this limit — the
// same pairing the dispatcher cron route documents
// (docs/hosted-dispatcher.md, docs/mcp.md).
import { mcpEndpoint } from '@autobuild/hosted-store-service/web/runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const route = (request: Request): Promise<Response> => mcpEndpoint().fetch(request)
export const GET = route
export const POST = route
export const DELETE = route
export const OPTIONS = route
