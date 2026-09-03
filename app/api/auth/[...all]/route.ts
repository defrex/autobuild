import { webAuth } from '@autobuild/hosted-store-service/web/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Better Auth is constructed on the first request rather than at module load,
 * so `next build` and machine-only deployments do not need the web/auth
 * configuration; a missing variable surfaces on the first sign-in request. */
const route = (request: Request): Promise<Response> => webAuth().handler(request)
export const GET = route
export const POST = route
export const PATCH = route
export const PUT = route
export const DELETE = route
