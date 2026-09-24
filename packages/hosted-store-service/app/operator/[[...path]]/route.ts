import { DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT } from '../../machine'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// The operator route executes orchestrator turns in this function (message
// posts and approval answers start the loop here; the tick resumes inside
// the dispatch route). The invocation budget clamps to
// ORCHESTRATOR_ROUTE_LIMIT_SECONDS, so this limit must equal it. Next.js only
// accepts literal segment config values ("Invalid segment configuration
// export detected" fails `next build` for an imported constant), so the value
// is written out here and route.test.ts pins it to the constant. Vercel/Next
// route limits are not inherited across routes — mirroring
// app/api/dispatch/route.ts and app/mcp/route.ts, which pin 300 explicitly.
export const maxDuration = 300
export { DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT }
