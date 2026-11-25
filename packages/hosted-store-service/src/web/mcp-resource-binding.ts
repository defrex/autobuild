/**
 * RFC 8707 resource binding for MCP access tokens (#1224).
 *
 * The pinned Better Auth 1.4.18 MCP plugin ignores the `resource` parameter
 * MCP clients send on the code exchange and every refresh: it stores no
 * audience, so a token issued for one per-repository URL would otherwise be
 * accepted at any other. These hooks on `/mcp/token` record the audience
 * ourselves:
 *
 * - before: a requested `resource` must be absent, the deployment resource,
 *   or a canonical per-repository resource under it; anything else is
 *   refused with `invalid_target`. A refresh of a bound token keeps its
 *   audience whether it omits `resource` or names the deployment resource;
 *   naming a different repository resource is refused the same way. A
 *   refresh of an unbound token may narrow it to one repository resource.
 * - after: on a successful response, a per-repository audience is written as
 *   a `verification` row keyed by the new token row's id. Absent or
 *   deployment-wide means unbound. A failed write fails the request, so an
 *   unbound token is never delivered for a per-repository request.
 *
 * The binding lives in Better Auth's existing `verification` table, so it
 * needs no auth-schema migration. It is read with a single `findOne` by
 * identifier — never `internalAdapter.findVerificationValue`, which deletes
 * every expired verification row on each call and would add a table-wide
 * write to every MCP request. Expired bindings are removed by Better Auth's
 * own cleanup when another flow calls it.
 */
import { APIError, type BetterAuthPlugin } from 'better-auth'
import { createAuthMiddleware } from 'better-auth/api'
import { MCP_RESOURCE_BINDING_PREFIX, parseRepositoryMcpResource } from './mcp-resource'

/** The slice of Better Auth's typed adapter the binding uses. */
export interface BindingAdapter {
  findOne(query: { model: string; where: { field: string; value: string }[] }): Promise<unknown>
  create?(query: { model: string; data: Record<string, unknown> }): Promise<unknown>
}

/** A token row's recorded per-repository audience, or undefined when the
 * token is unbound (legacy, or issued for the deployment-wide resource). */
export async function readResourceBinding(
  adapter: BindingAdapter,
  tokenRowId: string,
  now: Date = new Date(),
): Promise<string | undefined> {
  const row = (await adapter.findOne({
    model: 'verification',
    where: [{ field: 'identifier', value: `${MCP_RESOURCE_BINDING_PREFIX}${tokenRowId}` }],
  })) as { value?: unknown; expiresAt?: unknown } | null
  if (!row || typeof row.value !== 'string') return undefined
  const expires = new Date(row.expiresAt as string | Date).getTime()
  if (!Number.isFinite(expires) || expires <= now.getTime()) return undefined
  return row.value
}

/** Whether a token with `binding` is accepted at `endpointResource`. An
 * unbound or deployment-wide token covers the whole deployment (repository
 * access is still checked on every call); a bound token only its own URL. */
export function tokenAccepted(
  binding: string | undefined,
  deploymentResource: string,
  endpointResource: string,
): boolean {
  return binding === undefined || binding === deploymentResource || binding === endpointResource
}

function invalidTarget(description: string): APIError {
  return new APIError('BAD_REQUEST', { error: 'invalid_target', error_description: description })
}

function bodyOf(body: unknown): Record<string, unknown> {
  if (body instanceof FormData) return Object.fromEntries(body.entries())
  return body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {}
}

function accessTokenOf(returned: unknown): string | undefined {
  if (returned === null || typeof returned !== 'object' || returned instanceof APIError)
    return undefined
  const value =
    (returned as { access_token?: unknown }).access_token ??
    (returned as { body?: { access_token?: unknown } }).body?.access_token
  return typeof value === 'string' ? value : undefined
}

export function mcpResourceBindingPlugin(config: { mcpResource: string }): BetterAuthPlugin {
  const deployment = config.mcpResource.replace(/\/$/, '')
  /** The per-repository resource a request names, null for an absent or
   * deployment-wide one; throws `invalid_target` for anything else. */
  const requested = (body: Record<string, unknown>): string | null => {
    const resource = body.resource
    if (resource === undefined || resource === null || resource === '') return null
    if (typeof resource !== 'string') throw invalidTarget('resource must be a URL')
    if (resource === deployment || resource === `${deployment}/`) return null
    if (parseRepositoryMcpResource(deployment, resource) !== undefined) return resource
    throw invalidTarget(`resource "${resource}" is not served by this authorization server`)
  }
  type Adapter = BindingAdapter & {
    create(query: { model: string; data: Record<string, unknown> }): Promise<unknown>
  }
  const previousBinding = async (adapter: Adapter, body: Record<string, unknown>) => {
    if (body.grant_type !== 'refresh_token' || typeof body.refresh_token !== 'string')
      return undefined
    const row = (await adapter.findOne({
      model: 'oauthAccessToken',
      where: [{ field: 'refreshToken', value: body.refresh_token }],
    })) as { id?: unknown } | null
    return typeof row?.id === 'string' ? readResourceBinding(adapter, row.id) : undefined
  }
  const matcher = (context: { path?: string }) => context.path === '/mcp/token'
  return {
    id: 'mcp-resource-binding',
    hooks: {
      before: [
        {
          matcher,
          handler: createAuthMiddleware(async (ctx) => {
            const body = bodyOf(ctx.body)
            const resource = requested(body)
            const bound = await previousBinding(ctx.context.adapter as Adapter, body)
            if (bound !== undefined && resource !== null && resource !== bound)
              throw invalidTarget(`a refresh keeps its token's resource "${bound}"`)
          }),
        },
      ],
      after: [
        {
          matcher,
          handler: createAuthMiddleware(async (ctx) => {
            const accessToken = accessTokenOf(ctx.context.returned)
            if (accessToken === undefined) return
            const adapter = ctx.context.adapter as Adapter
            const body = bodyOf(ctx.body)
            const resource = (await previousBinding(adapter, body)) ?? requested(body)
            if (resource === null || resource === undefined) return
            const row = (await adapter.findOne({
              model: 'oauthAccessToken',
              where: [{ field: 'accessToken', value: accessToken }],
            })) as { id?: unknown; refreshTokenExpiresAt?: unknown } | null
            if (typeof row?.id !== 'string')
              throw new Error('issued MCP access token row was not found')
            const now = new Date()
            await adapter.create({
              model: 'verification',
              data: {
                identifier: `${MCP_RESOURCE_BINDING_PREFIX}${row.id}`,
                value: resource,
                expiresAt: new Date(row.refreshTokenExpiresAt as string | Date),
                createdAt: now,
                updatedAt: now,
              },
            })
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin
}
