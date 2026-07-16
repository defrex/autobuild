/**
 * The remote BuildStore's HTTP face (SPEC §7.2 adapter 2): a small
 * self-hosted API over any backing BuildStore. Routes are REST and boring;
 * the properties that matter ride on top:
 *
 * - D6: an `EventValidationError` from the backing store crosses the wire
 *   as 422 `{kind: 'validation'}` with the message intact — validation
 *   failures stay agent feedback, never opaque 500s.
 * - D8: when `secret` is set, every /builds route requires a Bearer token
 *   whose scope covers the addressed build (`'*'` = admin). Missing or
 *   expired token → 401; a token for another build → 403. No secret → open
 *   (local dev). `/health` is always open. The scope's session dimension
 *   (§8.1: "scoped to this build *and* session") gates event writes: a
 *   session-scoped token may only append events attributed to that agent
 *   session.
 *
 * Atomic deposits (POST …/deposits) implement the wire convention in
 * protocol.ts: the request payload embeds negative placeholder refs, and
 * this server substitutes the real revisions *inside* the backing store's
 * `appendWithArtifacts` callback — atomicity is the backing store's, not
 * re-implemented here.
 */
import type { ZodType } from 'zod'
import { EventValidationError, type EventWrite } from '../../events/catalog'
import { systemClock, type BuildStore, type Clock } from '../types'
import {
  decodeBase64,
  depositsBodySchema,
  encodeBase64,
  eventWriteWireSchema,
  leaseClaimBodySchema,
  leaseHolderBodySchema,
  newBuildBodySchema,
  putArtifactBodySchema,
  substitutePlaceholderRefs,
  type ErrorBody,
  type ErrorKind,
} from './protocol'
import { verifyToken, type TokenScope } from './token'

export interface StoreServerOptions {
  store: BuildStore
  /** When set, all /builds routes require a scoped Bearer token (D8). */
  secret?: string
  /** Time source for token expiry checks; defaults to the system clock. */
  clock?: Clock
}

export interface StoreServer {
  fetch: (req: Request) => Promise<Response>
}

/** Thrown by route helpers; the top-level handler maps it to a response. */
class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly kind: ErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'RequestError'
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function fail(status: number, kind: ErrorKind, error: string): Response {
  return json(status, { error, kind } satisfies ErrorBody)
}

async function readBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    throw new RequestError(400, 'validation', 'request body is not valid JSON')
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    throw new RequestError(
      400,
      'validation',
      `invalid request body: ${parsed.error.message}`,
    )
  }
  return parsed.data
}

function intParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name)
  if (raw === null) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value)) {
    throw new RequestError(
      400,
      'validation',
      `query parameter "${name}" must be an integer, got "${raw}"`,
    )
  }
  return value
}

export function createStoreServer(opts: StoreServerOptions): StoreServer {
  const { store } = opts
  const clock = opts.clock ?? systemClock

  /**
   * D8 gate. `buildScope` is the slug being addressed, or `'*'` for admin
   * routes (create/list). Runs before build lookup, so an out-of-scope
   * token learns nothing about which builds exist. Returns the verified
   * scope (null in open local-dev mode) so event-write routes can enforce
   * the session dimension.
   */
  function authorize(req: Request, buildScope: string): TokenScope | null {
    if (opts.secret === undefined) return null
    const header = req.headers.get('authorization')
    const match = header === null ? null : /^Bearer\s+(.+)$/i.exec(header)
    if (!match) throw new RequestError(401, 'auth', 'missing bearer token')
    const scope = verifyToken(opts.secret, match[1]!, clock())
    if (scope === null) {
      throw new RequestError(401, 'auth', 'invalid or expired token')
    }
    if (scope.build !== '*' && scope.build !== buildScope) {
      throw new RequestError(
        403,
        'auth',
        buildScope === '*'
          ? `token scoped to build "${scope.build}" may not perform admin operations`
          : `token scoped to build "${scope.build}" may not access build "${buildScope}"`,
      )
    }
    return scope
  }

  /** Loose agent-session extraction — full actor validation stays in the
   * backing store so its D6 feedback survives the wire (protocol.ts keeps
   * the event schema deliberately loose). */
  function agentSession(actor: unknown): string | null {
    if (typeof actor !== 'object' || actor === null) return null
    const { kind, session } = actor as { kind?: unknown; session?: unknown }
    return kind === 'agent' && typeof session === 'string' ? session : null
  }

  /**
   * The session half of D8 (§8.1: the token is scoped to this build *and
   * session*): a session-scoped token may only write events attributed to
   * the agent session it was minted for. `'*'` (admin/runner tokens) is
   * unrestricted, and reads are gated by build scope alone — the session
   * dimension is write attribution.
   */
  function authorizeSession(scope: TokenScope | null, actor: unknown): void {
    if (scope === null || scope.session === '*') return
    const session = agentSession(actor)
    if (session !== scope.session) {
      throw new RequestError(
        403,
        'auth',
        `token scoped to session "${scope.session}" may not write events attributed to ${
          session === null ? 'a non-agent actor' : `session "${session}"`
        }`,
      )
    }
  }

  async function adminRoute(req: Request): Promise<Response> {
    authorize(req, '*')
    if (req.method === 'POST') {
      const body = await readBody(req, newBuildBodySchema)
      if ((await store.getBuild(body.slug)) !== null) {
        return fail(409, 'conflict', `build "${body.slug}" already exists`)
      }
      return json(201, await store.createBuild(body))
    }
    if (req.method === 'GET') {
      return json(200, await store.listBuilds())
    }
    return fail(404, 'not-found', `no route: ${req.method} /builds`)
  }

  async function buildRoute(
    req: Request,
    url: URL,
    slug: string,
    rest: string,
    scope: TokenScope | null,
  ): Promise<Response> {
    switch (`${req.method} ${rest}`) {
      case 'POST events': {
        const body = await readBody(req, eventWriteWireSchema)
        authorizeSession(scope, body.actor)
        return json(201, await store.append(slug, body as EventWrite))
      }
      case 'GET events': {
        return json(200, await store.getEvents(slug, intParam(url, 'since') ?? 0))
      }
      case 'POST deposits': {
        const body = await readBody(req, depositsBodySchema)
        authorizeSession(scope, body.event.actor)
        const inputs = body.artifacts.map((artifact) => ({
          kind: artifact.kind,
          content: decodeBase64(artifact.contentBase64),
          ...(artifact.metadata !== undefined
            ? { metadata: artifact.metadata }
            : {}),
        }))
        // The wire's makeEvent: substitute the deposited revisions for the
        // payload's negative placeholders (protocol.ts). Runs inside the
        // backing store's atomic appendWithArtifacts, so an invalid event
        // rolls the whole deposit back (D6).
        const result = await store.appendWithArtifacts(
          slug,
          inputs,
          (deposited) =>
            ({
              actor: body.event.actor,
              type: body.event.type,
              payload: substitutePlaceholderRefs(body.event.payload, deposited),
            }) as EventWrite,
        )
        return json(201, { event: result.event, artifacts: result.artifacts })
      }
      case 'POST artifacts': {
        const body = await readBody(req, putArtifactBodySchema)
        const meta = await store.putArtifact(slug, {
          kind: body.kind,
          content: decodeBase64(body.contentBase64),
          ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
        })
        return json(201, meta)
      }
      case 'GET artifacts': {
        const kind = url.searchParams.get('kind')
        if (kind === null || kind === '') {
          throw new RequestError(400, 'validation', 'query parameter "kind" is required')
        }
        const artifact = await store.getArtifact(slug, kind, intParam(url, 'rev'))
        if (artifact === null) return json(200, null)
        return json(200, {
          meta: artifact.meta,
          contentBase64: encodeBase64(artifact.content),
        })
      }
      case 'GET artifact-list': {
        const kind = url.searchParams.get('kind') ?? undefined
        return json(200, await store.listArtifacts(slug, kind))
      }
      case 'POST lease/claim': {
        const body = await readBody(req, leaseClaimBodySchema)
        return json(200, { ok: await store.claimLease(slug, body.holder, body.ttlMs) })
      }
      case 'POST lease/heartbeat': {
        const body = await readBody(req, leaseHolderBodySchema)
        return json(200, { ok: await store.heartbeat(slug, body.holder) })
      }
      case 'POST lease/release': {
        const body = await readBody(req, leaseHolderBodySchema)
        await store.releaseLease(slug, body.holder)
        return json(200, { ok: true })
      }
      default:
        return fail(404, 'not-found', `no route: ${req.method} /builds/:slug/${rest}`)
    }
  }

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url)
    let segments: string[]
    try {
      segments = url.pathname
        .split('/')
        .filter((part) => part.length > 0)
        .map(decodeURIComponent)
    } catch {
      throw new RequestError(400, 'validation', `malformed path: ${url.pathname}`)
    }

    if (segments.length === 1 && segments[0] === 'health' && req.method === 'GET') {
      return json(200, { ok: true })
    }
    if (segments[0] !== 'builds') {
      return fail(404, 'not-found', `no route: ${req.method} ${url.pathname}`)
    }
    if (segments.length === 1) return adminRoute(req)

    const slug = segments[1]!
    const scope = authorize(req, slug)
    const record = await store.getBuild(slug)
    if (record === null) {
      return fail(404, 'not-found', `unknown build "${slug}"`)
    }
    if (segments.length === 2) {
      if (req.method === 'GET') return json(200, record)
      return fail(404, 'not-found', `no route: ${req.method} ${url.pathname}`)
    }
    return buildRoute(req, url, slug, segments.slice(2).join('/'), scope)
  }

  function errorResponse(error: unknown): Response {
    if (error instanceof RequestError) {
      return fail(error.status, error.kind, error.message)
    }
    // D6: validation feedback must survive the wire with its message intact.
    if (error instanceof EventValidationError) {
      return fail(422, 'validation', error.message)
    }
    if (error instanceof Error && error.message.includes('already exists')) {
      return fail(409, 'conflict', error.message)
    }
    if (error instanceof Error && error.message.startsWith('unknown build')) {
      return fail(404, 'not-found', error.message)
    }
    return fail(500, 'internal', error instanceof Error ? error.message : String(error))
  }

  return {
    fetch: async (req: Request): Promise<Response> => {
      try {
        return await route(req)
      } catch (error) {
        return errorResponse(error)
      }
    },
  }
}

export interface StartStoreServerOptions extends StoreServerOptions {
  /** 0 (the default) lets the OS pick a free port — tests rely on this. */
  port?: number
  hostname?: string
}

/** Wrap the handler in Bun.serve; `stop` force-closes open connections. */
export function startStoreServer(opts: StartStoreServerOptions): {
  url: string
  stop: () => Promise<void>
} {
  const handler = createStoreServer(opts)
  const hostname = opts.hostname ?? '127.0.0.1'
  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname,
    fetch: handler.fetch,
  })
  return {
    url: `http://${hostname}:${server.port}`,
    stop: async () => {
      await server.stop(true)
    },
  }
}
