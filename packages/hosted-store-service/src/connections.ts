import { ConnectionError, type ConnectionStore } from '@defrex/autobuild-postgres-store/connections'
import type { CredentialStore } from '@defrex/autobuild-postgres-store/credentials'
import type { MachineAuth } from './machine-auth'
import { MachineAuthError } from './machine-auth'
import type { GatewaySession } from './web/gateway'
import { normalizeEmail } from './web/config'
import { type HumanAccess, validSession } from './web/access'
import { AccessError, type HumanActor } from '@defrex/autobuild-postgres-store/organizations'

export function createConnectionHandler(options: {
  store: () => Promise<ConnectionStore>
  credentials: () => Promise<Pick<CredentialStore, 'revoke'>>
  machineAuth: () => MachineAuth
  baseURL: string
  browser?: {
    getSession: (headers: Headers) => Promise<GatewaySession | null>
    access: HumanAccess
  }
  now?: () => Date
}) {
  return async (request: Request): Promise<Response> => {
    const respond = (body: unknown, status = 200) =>
      Response.json(body, {
        status,
        headers: {
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
          ...(status === 429 ? { 'retry-after': '5' } : {}),
        },
      })
    try {
      const path = new URL(request.url).pathname
      if (path === '/connect/v1/status' || path === '/connect/v1/revoke') {
        if (request.method !== (path.endsWith('status') ? 'GET' : 'POST'))
          return respond({ error: 'method not allowed' }, 405)
        const principal = await options.machineAuth().authenticate(request)
        if (principal.kind !== 'project')
          return respond({ error: 'project credential required' }, 403)
        if (path.endsWith('revoke'))
          await (await options.credentials()).revoke(
            principal.repo,
            principal.credential.id,
            principal.user,
          )
        return respond({
          repo: principal.repo,
          credentialId: principal.credential.id,
          accepted: true,
        })
      }
      if (request.method !== 'POST') return respond({ error: 'method not allowed' }, 405)
      if (
        request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
        'application/json'
      )
        return respond({ error: 'application/json required' }, 400)
      const browser = path.startsWith('/connect/v1/browser/')
      let actor: string | undefined
      let principal: HumanActor | undefined
      if (browser) {
        if (!options.browser)
          return respond({ error: 'approval requires the web-enabled service origin' }, 503)
        if (request.headers.get('origin') !== new URL(options.baseURL).origin)
          return respond({ error: 'cross-origin approval refused' }, 403)
        const session = await options.browser.getSession(request.headers)
        if (!validSession(session, (options.now ?? (() => new Date()))()))
          return respond({ error: 'sign in required' }, 401)
        actor = normalizeEmail(session!.user.email)
        principal = (await options.browser.access.principal(actor)) ?? undefined
        if (!principal) return respond({ error: 'this identity is not allowed' }, 403)
      }
      const text = await request.text()
      if (text.length > 8192) return respond({ error: 'request too large' }, 413)
      let body: Record<string, unknown>
      try {
        body = JSON.parse(text)
      } catch {
        return respond({ error: 'invalid JSON' }, 400)
      }
      if (!body || typeof body !== 'object' || Array.isArray(body))
        return respond({ error: 'invalid request' }, 400)
      const store = await options.store()
      if (path === '/connect/v1/requests') {
        if (
          typeof body.repo !== 'string' ||
          typeof body.credentialId !== 'string' ||
          typeof body.digest !== 'string'
        )
          return respond({ error: 'invalid proposal' }, 400)
        const started = await store.start({
          repo: body.repo,
          credentialId: body.credentialId,
          digest: body.digest,
        })
        return respond({
          ...started,
          interval: 5,
          verificationURL: `${options.baseURL}/connect?code=${started.code}`,
        })
      }
      if (path === '/connect/v1/poll' || path === '/connect/v1/cancel') {
        if (typeof body.id !== 'string' || typeof body.capability !== 'string')
          return respond({ error: 'invalid capability' }, 400)
        return respond(await store.poll(body.id, body.capability, path.endsWith('cancel')))
      }
      if (browser && typeof body.code === 'string') {
        const code = body.code.trim().toUpperCase()
        if (path.endsWith('/lookup'))
          return respond({ connection: await store.lookup(code, actor!, principal) })
        if (path.endsWith('/decide') && typeof body.approve === 'boolean') {
          if (
            body.organizationId !== undefined &&
            (typeof body.organizationId !== 'string' || !body.organizationId)
          )
            return respond({ error: 'invalid organizationId' }, 400)
          return respond({
            connection: await store.decide(
              code,
              actor!,
              body.approve,
              principal,
              body.organizationId as string | undefined,
            ),
          })
        }
      }
      return respond({ error: 'unknown connection route' }, 404)
    } catch (error) {
      if (
        error instanceof AccessError ||
        error instanceof ConnectionError ||
        error instanceof MachineAuthError
      )
        return respond({ error: error.message }, error.status)
      return respond({ error: 'connection service is unavailable; retry' }, 503)
    }
  }
}
