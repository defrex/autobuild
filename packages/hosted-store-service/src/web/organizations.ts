import { normalizeProjectRepository } from '@defrex/autobuild-postgres-store/projects'
import type { ProjectDeletion } from '@defrex/autobuild-postgres-store/project-deletion'
import { AccessError } from '@defrex/autobuild-postgres-store/organizations'
import { type HumanAccess, validSession } from './access'
import { parseWebAuthEnv } from './config'
import type { GatewaySession } from './gateway'

/** Browser-only management contract. No stock organization endpoints are exposed. */
export function createOrganizationHandler(options: {
  deletion?: () => Promise<ProjectDeletion>
  access: HumanAccess
  getSession(headers: Headers): Promise<GatewaySession | null>
  now?: () => Date
}) {
  return async (request: Request): Promise<Response> => {
    const respond = (body: unknown, status = 200) =>
      Response.json(body, {
        status,
        headers: {
          'cache-control': 'private, no-store',
          pragma: 'no-cache',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        },
      })
    try {
      const session = await options.getSession(request.headers)
      if (!validSession(session, options.now?.()))
        return respond({ error: 'sign in required' }, 401)
      const actor = await options.access.principal(session!.user.email)
      if (!actor) return respond({ error: 'this identity is not allowed' }, 403)
      const store = await options.access.store()
      const parts = new URL(request.url).pathname
        .split('/')
        .filter(Boolean)
        .slice(2)
        .map(decodeURIComponent)
      const method = request.method
      let body: Record<string, unknown> = {}
      if (!['GET', 'HEAD'].includes(method)) {
        if (request.headers.get('origin') !== parseWebAuthEnv(options.access.env).baseURL)
          return respond({ error: 'cross-origin control refused' }, 403)
        if (
          request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
          'application/json'
        )
          return respond({ error: 'application/json required' }, 400)
        const text = await request.text()
        if (text.length > 8192) return respond({ error: 'request too large' }, 400)
        try {
          body = JSON.parse(text)
        } catch {
          return respond({ error: 'invalid JSON' }, 400)
        }
        if (!body || typeof body !== 'object' || Array.isArray(body))
          return respond({ error: 'invalid request' }, 400)
      }
      const fields = (...keys: string[]) => {
        if (
          Object.keys(body).some((key) => !keys.includes(key)) ||
          keys.some((key) => !(key in body))
        )
          throw new AccessError(400, 'invalid fields')
      }
      const string = (key: string): string => {
        if (typeof body[key] !== 'string') throw new AccessError(400, `invalid ${key}`)
        return body[key]
      }
      if (parts.join('/') === 'projects/deletions' && method === 'GET' && options.deletion)
        return respond({ projects: await (await options.deletion()).pending(actor) })
      if (parts.join('/') === 'projects/deletion' && options.deletion) {
        let repo: string
        const normalize = (value: string) => {
          try {
            return normalizeProjectRepository(value)
          } catch {
            throw new AccessError(400, 'invalid repository')
          }
        }
        const deletion = await options.deletion()
        if (method === 'GET') {
          const query = new URL(request.url).searchParams
          if (query.getAll('repo').length !== 1 || [...query.keys()].some((key) => key !== 'repo'))
            throw new AccessError(400, 'invalid fields')
          repo = normalize(query.get('repo')!)
          return respond(await deletion.preview(actor, repo))
        }
        if (method === 'DELETE') {
          fields('repo')
          repo = normalize(string('repo'))
          await deletion.delete(actor, repo, request.headers.get('if-match'))
          return respond({ deleted: true })
        }
      }
      if (parts.join('/') === 'projects/unassigned' && method === 'GET')
        return respond({ projects: await store.unassigned(actor) })
      if (parts[0] !== 'orgs') return respond({ error: 'unknown web route' }, 404)
      if (parts.length === 1) {
        if (method === 'GET')
          return respond({
            isSuperUser: actor.isSuperUser(),
            organizations: await store.organizations(actor),
          })
        if (method === 'POST') {
          fields('name', 'slug')
          return respond(
            { organization: await store.create(actor, string('name'), string('slug')) },
            201,
          )
        }
      }
      const id = parts[1]!
      if (parts.length === 2 && method === 'GET') return respond(await store.inspect(actor, id))
      if (parts.length === 3) {
        if (parts[2] === 'members') {
          if (method === 'GET') return respond({ members: await store.members(actor, id) })
          if (method === 'POST') {
            fields('email')
            return respond({ member: await store.addMember(actor, id, string('email')) })
          }
          if (method === 'DELETE') {
            fields('email')
            await store.removeMember(actor, id, string('email'))
            return respond({ removed: true })
          }
        }
        if (parts[2] === 'owner' && method === 'PUT') {
          fields('email')
          return respond({
            organization: await store.setOwner(
              actor,
              id,
              body.email === null ? null : string('email'),
            ),
          })
        }
        if (parts[2] === 'projects' && method === 'PUT') {
          fields('repo')
          return respond(await store.assign(actor, id, string('repo')))
        }
      }
      return respond({ error: 'method not allowed' }, 405)
    } catch (error) {
      if (error instanceof AccessError) return respond({ error: error.message }, error.status)
      if (error instanceof URIError) return respond({ error: 'malformed route' }, 400)
      return respond({ error: 'access service is unavailable' }, 503)
    }
  }
}
