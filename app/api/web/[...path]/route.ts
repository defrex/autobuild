import { webGateway } from '@autobuild/hosted-store-service/web/runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const route = (request: Request) => webGateway().fetch(request)
export const GET = route
export const POST = route
export const PUT = route
