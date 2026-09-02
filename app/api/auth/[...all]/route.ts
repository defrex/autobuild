import { webAuth } from '@autobuild/hosted-store-service/web/auth'
import { toNextJsHandler } from 'better-auth/next-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const { GET, POST, PATCH, PUT, DELETE } = toNextJsHandler(webAuth())
