import { webGateway } from '@defrex/autobuild-hosted-store-service/web/runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const route = (request: Request) => webGateway().fetch(request)
export const GET = route
export const POST = route
export const PUT = route
export const PATCH = route

export const DELETE = route
