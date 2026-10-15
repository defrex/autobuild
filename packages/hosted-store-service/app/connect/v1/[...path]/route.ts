import { connectionEndpoint } from '@defrex/autobuild-hosted-store-service/web/runtime'
export const dynamic = 'force-dynamic'
export const GET = (request: Request) => connectionEndpoint()(request)
export const POST = (request: Request) => connectionEndpoint()(request)
