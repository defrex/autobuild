import {
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  mintToken,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
} from 'autobuild/remote-store'
import { isAllowedEmail, normalizeEmail, parseWebAuthEnv, type WebEnv } from './config'

export interface GatewaySession {
  user: { email: string }
  session?: { expiresAt?: Date | string }
}
export interface WebGatewayOptions {
  env?: WebEnv
  getSession: (headers: Headers) => Promise<GatewaySession | null>
  delegate: (request: Request) => Promise<Response>
  now?: () => Date
}

function failure(status: number, kind: 'auth' | 'validation' | 'not-found', error: string) {
  return Response.json({ kind, error }, { status })
}

function operatorSuffix(method: string, parts: string[]): boolean {
  const tail = parts.join('/')
  if (method === 'GET' && ['dashboard', 'status', 'builds', 'harvest/status'].includes(tail))
    return true
  if (method === 'POST' && ['bulk-control', 'harvest/control'].includes(tail)) return true
  if (parts[0] === 'settings' && ['intake', 'auto-merge-default'].includes(parts[1] ?? '')) {
    return (
      (method === 'PUT' && parts.length === 2) ||
      (method === 'POST' && parts.length === 3 && parts[2] === 'toggle')
    )
  }
  if (parts[0] !== 'builds' || !parts[1]) return false
  if (method === 'GET' && parts.length === 2) return true
  if (method === 'GET' && parts.length === 4 && parts[2] === 'artifacts' && parts[3]) return true
  return method === 'POST' && parts.length === 3 && ['control', 'answer'].includes(parts[2] ?? '')
}

function secured(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('cache-control', 'private, no-store')
  headers.set('pragma', 'no-cache')
  headers.set('x-content-type-options', 'nosniff')
  headers.set('referrer-policy', 'no-referrer')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/** Cookie-session gateway to the existing attributed operator protocol. */
export function createWebGateway(options: WebGatewayOptions): {
  fetch(request: Request): Promise<Response>
} {
  const env = options.env ?? process.env
  const config = parseWebAuthEnv(env)
  const storeSecret = env.AB_STORE_SECRET?.trim()
  if (!storeSecret) throw new Error('AB_STORE_SECRET is required and must be nonblank')
  const now = options.now ?? (() => new Date())
  return {
    async fetch(request) {
      const respond = (response: Response) => secured(response)
      const session = await options.getSession(request.headers)
      if (!session) return respond(failure(401, 'auth', 'sign in required'))
      const expiry = session.session?.expiresAt
      if (expiry !== undefined && new Date(expiry).getTime() <= now().getTime()) {
        return respond(failure(401, 'auth', 'session expired'))
      }
      const email = normalizeEmail(session.user.email)
      if (!isAllowedEmail(config.allowedEmails, email)) {
        return respond(failure(403, 'auth', 'this identity is not allowed'))
      }

      const incoming = new URL(request.url)
      let parts: string[]
      try {
        parts = incoming.pathname.split('/').filter(Boolean).slice(2).map(decodeURIComponent)
      } catch {
        return respond(failure(400, 'validation', 'malformed web route'))
      }
      if (parts[0] !== 'repos' || !parts[1])
        return respond(failure(404, 'not-found', 'unknown web route'))
      const repo = parts[1]
      const suffix = parts.slice(2)
      if (!config.repositories.includes(repo))
        return respond(failure(404, 'not-found', 'unknown repository'))
      if (!operatorSuffix(request.method, suffix))
        return respond(failure(404, 'not-found', 'unknown web route'))

      if (!['GET', 'HEAD'].includes(request.method)) {
        const origin = request.headers.get('origin')
        if (origin !== config.baseURL)
          return respond(failure(403, 'auth', 'cross-origin control refused'))
        if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
          return respond(failure(400, 'validation', 'controls require application/json'))
        }
      }

      const headers = new Headers()
      const accept = request.headers.get('accept')
      if (accept) headers.set('accept', accept)
      const contentType = request.headers.get('content-type')
      if (contentType) headers.set('content-type', contentType)
      headers.set(AUTOBUILD_VERSION_HEADER, AUTOBUILD_VERSION)
      headers.set(REMOTE_STORE_PROTOCOL_VERSION_HEADER, REMOTE_STORE_PROTOCOL_VERSION)
      const token = mintToken(storeSecret, {
        operator: { user: email },
        exp: now().getTime() + 30_000,
      })
      headers.set('authorization', `Bearer ${token}`)
      const delegatedURL = new URL(
        `/operator/v1/repos/${encodeURIComponent(repo)}/${suffix.map(encodeURIComponent).join('/')}${incoming.search}`,
        config.baseURL,
      )
      const body = ['GET', 'HEAD'].includes(request.method)
        ? undefined
        : await request.arrayBuffer()
      try {
        return respond(
          await options.delegate(
            new Request(delegatedURL, { method: request.method, headers, body }),
          ),
        )
      } catch {
        return respond(
          Response.json(
            { kind: 'internal', error: 'operator service is unavailable' },
            { status: 500 },
          ),
        )
      }
    },
  }
}
