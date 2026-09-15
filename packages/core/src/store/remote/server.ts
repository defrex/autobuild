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
import type { RepositoryEventWrite } from '../../events/repository'
import type { SessionEventWrite } from '../../events/sessions'
import type { Via } from '../../events/envelope'
import { systemClock, type BuildStore, type Clock } from '../types'
import type { StreamOutcome, StreamPart, StreamScope } from '../streams/types'
import { StreamBatchTooLargeError, StreamClosedError } from '../streams/types'
import {
  appendStreamBodySchema,
  closeStreamBodySchema,
  conditionalEventBodySchema,
  createStreamBodySchema,
  decodeBase64,
  depositsBodySchema,
  encodeBase64,
  ensureRepoBodySchema,
  eventWriteWireSchema,
  leaseClaimBodySchema,
  leaseHolderBodySchema,
  newBuildBodySchema,
  newSessionBodySchema,
  putArtifactBodySchema,
  substitutePlaceholderRefs,
  type ErrorBody,
  type ErrorKind,
} from './protocol'
import { tokenResource, verifyToken, type TokenScope } from './token'
import {
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
} from './version'

export interface StoreServerOptions {
  store: BuildStore
  /** When set, all /builds routes require a scoped Bearer token (D8). */
  secret?: string
  /** Time source for token expiry checks; defaults to the system clock. */
  clock?: Clock
  /** Maximum decoded size of each artifact. Unlimited when omitted. */
  maxArtifactBytes?: number
  /** Observes unexpected backing-store failures without changing their wire response. */
  onInternalError?: (error: unknown, request: Request) => unknown | Promise<unknown>
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
    throw new RequestError(400, 'validation', `invalid request body: ${parsed.error.message}`)
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

function streamScopesEqual(a: StreamScope, b: StreamScope): boolean {
  return (
    a.kind === b.kind &&
    (a.kind === 'build'
      ? b.kind === 'build' && a.build === b.build
      : a.kind === 'repo'
        ? b.kind === 'repo' && a.repo === b.repo
        : b.kind === 'session' && a.session === b.session)
  )
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
  function validateIdentity(req: Request): void {
    const clientAutobuild = req.headers.get(AUTOBUILD_VERSION_HEADER)
    const clientProtocol = req.headers.get(REMOTE_STORE_PROTOCOL_VERSION_HEADER)
    if (clientAutobuild !== AUTOBUILD_VERSION || clientProtocol !== REMOTE_STORE_PROTOCOL_VERSION) {
      throw new RequestError(
        409,
        'conflict',
        `remote store version mismatch: client Autobuild ${clientAutobuild ?? '(missing)'} protocol ${clientProtocol ?? '(missing)'}; server Autobuild ${AUTOBUILD_VERSION} protocol ${REMOTE_STORE_PROTOCOL_VERSION}`,
      )
    }
  }

  function decodeArtifact(contentBase64: string): Uint8Array {
    let content: Uint8Array
    try {
      content = decodeBase64(contentBase64)
    } catch {
      throw new RequestError(400, 'validation', 'artifact content is not valid base64')
    }
    if (opts.maxArtifactBytes !== undefined && content.byteLength > opts.maxArtifactBytes) {
      throw new RequestError(
        413,
        'validation',
        `artifact exceeds decoded byte ceiling of ${opts.maxArtifactBytes} bytes`,
      )
    }
    return content
  }

  function authorize(
    req: Request,
    kind: 'build' | 'repo' | 'session' | 'admin',
    id: string,
  ): TokenScope | null {
    if (opts.secret === undefined) return null
    const header = req.headers.get('authorization')
    const match = header === null ? null : /^Bearer\s+(.+)$/i.exec(header)
    if (!match) throw new RequestError(401, 'auth', 'missing bearer token')
    const scope = verifyToken(opts.secret, match[1]!, clock())
    if (scope === null) {
      throw new RequestError(401, 'auth', 'invalid or expired token')
    }
    const resource = tokenResource(scope)
    const allowed =
      resource.kind === 'deployment' ||
      resource.kind === 'admin' ||
      (kind !== 'admin' && resource.kind === kind && resource.id === id)
    if (!allowed) {
      const target = kind === 'admin' ? 'admin operations' : `${kind} "${id}"`
      throw new RequestError(
        403,
        'auth',
        `token scoped to ${resource.kind} "${resource.id}" may not access ${target}`,
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
    if (scope === null || !('session' in scope) || scope.session === '*') return
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

  /**
   * Delegated-write attribution (§15.1) on every event-bearing write, applied
   * after token verification and before catalog validation (the backing
   * store's EventValidationError is the ontology's voice; a mismatched via is
   * an authority failure and must be 403 so a caller can distinguish "not
   * your delegate" from "malformed event"). With no secret (open local-dev
   * mode) there is no token to be authoritative and writes pass through
   * unchanged. A human actor claiming a via the token does not carry → 403;
   * a token carrying a via stamps it onto human actors (the token is
   * authoritative); a non-human actor carrying via falls through to the
   * backing store's validation.
   */
  function enforceVia(scope: TokenScope | null, actor: unknown): unknown {
    if (scope === null) return actor
    const tokenVia: Via | undefined = 'via' in scope ? scope.via : undefined
    const candidate = actor as { kind?: unknown; via?: Via } | null
    if (typeof candidate !== 'object' || candidate === null || candidate.kind !== 'human') {
      return actor
    }
    if (candidate.via !== undefined && tokenVia === undefined) {
      throw new RequestError(403, 'auth', 'token carries no via; it may not write delegated events')
    }
    if (
      candidate.via !== undefined &&
      tokenVia !== undefined &&
      JSON.stringify(candidate.via) !== JSON.stringify(tokenVia)
    ) {
      throw new RequestError(
        403,
        'auth',
        `token carries via ${JSON.stringify(tokenVia)}; it may not write events claiming via ${JSON.stringify(candidate.via)}`,
      )
    }
    if (tokenVia !== undefined) {
      return { ...candidate, via: tokenVia }
    }
    return actor
  }

  async function adminRoute(req: Request): Promise<Response> {
    authorize(req, 'admin', '*')
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

  async function repoAdminRoute(req: Request): Promise<Response> {
    authorize(req, 'admin', '*')
    if (req.method !== 'POST') {
      return fail(404, 'not-found', `no route: ${req.method} /repos`)
    }
    const body = await readBody(req, ensureRepoBodySchema)
    return json(200, await store.ensureRepo(body.repo))
  }

  async function repoRoute(
    req: Request,
    url: URL,
    repo: string,
    rest: string,
    scope: TokenScope | null,
  ): Promise<Response> {
    const segments = rest.split('/')
    if (segments[0] === 'streams') {
      return streamRoute(req, url, { kind: 'repo', repo }, segments.slice(1))
    }
    switch (`${req.method} ${rest}`) {
      case 'POST events': {
        const body = await readBody(req, eventWriteWireSchema)
        authorizeSession(scope, body.actor)
        const actor = enforceVia(scope, body.actor)
        return json(201, await store.appendRepo(repo, { ...body, actor } as RepositoryEventWrite))
      }
      case 'GET events':
        return json(200, await store.getRepoEvents(repo, intParam(url, 'since') ?? 0))
      case 'POST deposits': {
        const body = await readBody(req, depositsBodySchema)
        authorizeSession(scope, body.event.actor)
        const actor = enforceVia(scope, body.event.actor)
        const inputs = body.artifacts.map((artifact) => ({
          kind: artifact.kind,
          content: decodeArtifact(artifact.contentBase64),
          ...(artifact.metadata !== undefined ? { metadata: artifact.metadata } : {}),
        }))
        const result = await store.appendRepoWithArtifacts(
          repo,
          inputs,
          (deposited) =>
            ({
              actor,
              type: body.event.type,
              payload: substitutePlaceholderRefs(body.event.payload, deposited),
            }) as RepositoryEventWrite,
        )
        return json(201, result)
      }
      case 'POST artifacts': {
        const body = await readBody(req, putArtifactBodySchema)
        return json(
          201,
          await store.putRepoArtifact(repo, {
            kind: body.kind,
            content: decodeArtifact(body.contentBase64),
            ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
          }),
        )
      }
      case 'GET artifacts': {
        const kind = url.searchParams.get('kind')
        if (kind === null || kind === '') {
          throw new RequestError(400, 'validation', 'query parameter "kind" is required')
        }
        const artifact = await store.getRepoArtifact(repo, kind, intParam(url, 'rev'))
        return artifact === null
          ? json(200, null)
          : json(200, {
              meta: artifact.meta,
              contentBase64: encodeBase64(artifact.content),
            })
      }
      case 'GET artifact-list':
        return json(
          200,
          await store.listRepoArtifacts(repo, url.searchParams.get('kind') ?? undefined),
        )
      case 'POST lease/claim': {
        const body = await readBody(req, leaseClaimBodySchema)
        return json(200, {
          ok: await store.claimRepoLease(repo, body.holder, body.ttlMs),
        })
      }
      case 'POST lease/heartbeat': {
        const body = await readBody(req, leaseHolderBodySchema)
        return json(200, {
          ok: await store.heartbeatRepo(repo, body.holder),
        })
      }
      case 'POST lease/release': {
        const body = await readBody(req, leaseHolderBodySchema)
        await store.releaseRepoLease(repo, body.holder)
        return json(200, { ok: true })
      }
      default:
        return fail(404, 'not-found', `no route: ${req.method} /repos/:repo/${rest}`)
    }
  }

  /**
   * Session family routes (SPEC §7.1.1), mirroring the repository-journal
   * family: a session resource token gates exactly its own `/sessions/{id}`
   * operations; collection routes live under `/repos/{repo}/sessions` and
   * keep the repo/admin matrix. A wrong-scope token gets `403 auth` before
   * resource lookup (no existence leak).
   */
  async function sessionCollectionRoute(req: Request, repo: string): Promise<Response> {
    if (req.method === 'POST') {
      const body = await readBody(req, newSessionBodySchema)
      if (body.repo !== repo) {
        return fail(
          400,
          'validation',
          `session body repo ${JSON.stringify(body.repo)} does not match the path`,
        )
      }
      return json(201, await store.createSession(body))
    }
    if (req.method === 'GET') {
      return json(200, await store.listSessions(repo))
    }
    return fail(404, 'not-found', `no route: ${req.method} /repos/:repo/sessions`)
  }

  async function sessionRoute(req: Request, url: URL, id: string, rest: string): Promise<Response> {
    const segments = rest.split('/')
    if (segments[0] === 'streams') {
      return streamRoute(req, url, { kind: 'session', session: id }, segments.slice(1))
    }
    switch (`${req.method} ${rest}`) {
      case 'GET record':
        return json(200, await store.getSession(id))
      case 'POST events': {
        const body = await readBody(req, eventWriteWireSchema)
        return json(201, await store.appendSessionEvent(id, body as SessionEventWrite))
      }
      case 'GET events': {
        const since = intParam(url, 'since') ?? 0
        const wait = intParam(url, 'wait')
        return json(
          200,
          await store.getSessionEvents(id, since, {
            ...(wait !== undefined ? { waitSeconds: wait } : {}),
          }),
        )
      }
      case 'POST deposits': {
        const body = await readBody(req, depositsBodySchema)
        const inputs = body.artifacts.map((artifact) => ({
          kind: artifact.kind,
          content: decodeArtifact(artifact.contentBase64),
          ...(artifact.metadata !== undefined ? { metadata: artifact.metadata } : {}),
        }))
        const result = await store.appendSessionWithArtifacts(
          id,
          inputs,
          (deposited) =>
            ({
              actor: body.event.actor,
              type: body.event.type,
              payload: substitutePlaceholderRefs(body.event.payload, deposited),
            }) as SessionEventWrite,
        )
        return json(201, result)
      }
      case 'POST artifacts': {
        const body = await readBody(req, putArtifactBodySchema)
        return json(
          201,
          await store.putSessionArtifact(id, {
            kind: body.kind,
            content: decodeArtifact(body.contentBase64),
            ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
          }),
        )
      }
      case 'GET artifacts': {
        const kind = url.searchParams.get('kind')
        if (kind === null || kind === '') {
          throw new RequestError(400, 'validation', 'query parameter "kind" is required')
        }
        const artifact = await store.getSessionArtifact(id, kind, intParam(url, 'rev'))
        return artifact === null
          ? json(200, null)
          : json(200, {
              meta: artifact.meta,
              contentBase64: encodeBase64(artifact.content),
            })
      }
      case 'GET artifact-list':
        return json(
          200,
          await store.listSessionArtifacts(id, url.searchParams.get('kind') ?? undefined),
        )
      default:
        return fail(404, 'not-found', `no route: ${req.method} /sessions/:id/${rest}`)
    }
  }

  async function buildRoute(
    req: Request,
    url: URL,
    slug: string,
    rest: string,
    scope: TokenScope | null,
  ): Promise<Response> {
    const segments = rest.split('/')
    if (segments[0] === 'streams') {
      return streamRoute(req, url, { kind: 'build', build: slug }, segments.slice(1))
    }
    switch (`${req.method} ${rest}`) {
      case 'POST events': {
        const body = await readBody(req, eventWriteWireSchema)
        authorizeSession(scope, body.actor)
        const actor = enforceVia(scope, body.actor)
        return json(201, await store.append(slug, { ...body, actor } as EventWrite))
      }
      case 'POST events/conditional': {
        const body = await readBody(req, conditionalEventBodySchema)
        authorizeSession(scope, body.event.actor)
        const actor = enforceVia(scope, body.event.actor)
        const event = await store.appendIfCurrent(slug, body.expectedSeq, {
          ...body.event,
          actor,
        } as EventWrite)
        return json(event === null ? 200 : 201, event)
      }
      case 'GET events': {
        return json(200, await store.getEvents(slug, intParam(url, 'since') ?? 0))
      }
      case 'POST deposits': {
        const body = await readBody(req, depositsBodySchema)
        authorizeSession(scope, body.event.actor)
        const actor = enforceVia(scope, body.event.actor)
        const inputs = body.artifacts.map((artifact) => ({
          kind: artifact.kind,
          content: decodeArtifact(artifact.contentBase64),
          ...(artifact.metadata !== undefined ? { metadata: artifact.metadata } : {}),
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
              actor,
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
          content: decodeArtifact(body.contentBase64),
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

  /**
   * Stream routes (SPEC §7.6), shared by the build and repository families:
   * `rest` is the segments after `streams`, the scope comes from the path.
   * Addressed operations verify the stream actually belongs to this scope —
   * an unknown stream and one scoped elsewhere are the same 404, so no
   * cross-scope existence leaks.
   */
  async function streamRoute(
    req: Request,
    url: URL,
    scope: StreamScope,
    rest: string[],
  ): Promise<Response> {
    if (rest.length === 0) {
      if (req.method === 'POST') {
        const body = await readBody(req, createStreamBodySchema)
        return json(201, await store.createStream(scope, body.label))
      }
      if (req.method === 'GET') return json(200, await store.listStreams(scope))
      return fail(404, 'not-found', `no route: ${req.method} streams`)
    }
    const [streamId, leaf, ...extra] = rest
    if (extra.length > 0 || streamId === undefined) {
      return fail(404, 'not-found', `no route: ${req.method} streams/${rest.join('/')}`)
    }
    const record = await store.getStream(streamId)
    if (record === null || !streamScopesEqual(record.scope, scope)) {
      return fail(404, 'not-found', `unknown stream "${streamId}"`)
    }
    if (leaf === undefined || leaf === '') {
      if (req.method === 'GET') return json(200, record)
      return fail(404, 'not-found', `no route: ${req.method} streams/${streamId}`)
    }
    if (leaf === 'chunks') {
      if (req.method === 'POST') {
        const body = await readBody(req, appendStreamBodySchema)
        return json(201, await store.appendStreamParts(streamId, body.parts as StreamPart[]))
      }
      if (req.method === 'GET') {
        const since = intParam(url, 'since') ?? 0
        const wait = intParam(url, 'wait')
        const read = await store.readStream(streamId, {
          since,
          ...(wait !== undefined ? { waitSeconds: wait } : {}),
        })
        return json(200, read)
      }
      return fail(404, 'not-found', `no route: ${req.method} streams/${streamId}/chunks`)
    }
    if (leaf === 'close') {
      if (req.method !== 'POST') {
        return fail(404, 'not-found', `no route: ${req.method} streams/${streamId}/close`)
      }
      const body = await readBody(req, closeStreamBodySchema)
      return json(200, await store.closeStream(streamId, body.outcome as StreamOutcome))
    }
    return fail(404, 'not-found', `no route: ${req.method} streams/${rest.join('/')}`)
  }

  /**
   * Top-level addressed stream routes. A stream id is globally unique but
   * carries no scope, so the client (which addresses streams by id alone)
   * uses these: the server resolves the stream's own scope and authorizes
   * against it, exactly like the family routes authorize by path. An
   * unknown stream and a scope the token does not cover are both 404 — the
   * same no-existence-leak rule the family routes apply.
   */
  async function globalStreamRoute(req: Request, url: URL, segments: string[]): Promise<Response> {
    const streamId = segments[1]
    if (streamId === undefined || streamId === '') {
      return fail(404, 'not-found', `no route: ${req.method} ${url.pathname}`)
    }
    const record = await store.getStream(streamId)
    if (record === null) return fail(404, 'not-found', `unknown stream "${streamId}"`)
    const scopeId =
      record.scope.kind === 'build'
        ? record.scope.build
        : record.scope.kind === 'repo'
          ? record.scope.repo
          : record.scope.session
    authorize(req, record.scope.kind, scopeId)
    return streamRoute(req, url, record.scope, segments.slice(1))
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
      return json(200, {
        ok: true,
        autobuildVersion: AUTOBUILD_VERSION,
        protocolVersion: REMOTE_STORE_PROTOCOL_VERSION,
      })
    }
    if (segments[0] === 'repos' || segments[0] === 'builds' || segments[0] === 'streams') {
      validateIdentity(req)
    }
    if (segments[0] === 'streams') {
      return globalStreamRoute(req, url, segments)
    }
    if (segments[0] === 'sessions' && segments.length >= 2) {
      const id = segments[1]!
      authorize(req, 'session', id)
      if (segments.length === 2) {
        if (req.method === 'GET') return sessionRoute(req, url, id, 'record')
        return fail(404, 'not-found', `no route: ${req.method} ${url.pathname}`)
      }
      return sessionRoute(req, url, id, segments.slice(2).join('/'))
    }

    if (segments[0] === 'repos') {
      if (segments.length === 1) return repoAdminRoute(req)
      const repo = segments[1]!
      const scope = authorize(req, 'repo', repo)
      if (segments.length === 3 && segments[2] === 'sessions') {
        return sessionCollectionRoute(req, repo)
      }
      const record = await store.getRepo(repo)
      if (record === null) {
        return fail(404, 'not-found', `unknown repo "${repo}"`)
      }
      if (segments.length === 2) {
        if (req.method === 'GET') return json(200, record)
        return fail(404, 'not-found', `no route: ${req.method} ${url.pathname}`)
      }
      return repoRoute(req, url, repo, segments.slice(2).join('/'), scope)
    }

    if (segments[0] !== 'builds') {
      return fail(404, 'not-found', `no route: ${req.method} ${url.pathname}`)
    }
    if (segments.length === 1) return adminRoute(req)

    const slug = segments[1]!
    const scope = authorize(req, 'build', slug)
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
    if (error instanceof StreamBatchTooLargeError) {
      return fail(413, 'validation', error.message)
    }
    if (error instanceof StreamClosedError) {
      return fail(409, 'conflict', error.message)
    }
    if (error instanceof Error && error.message.includes('already exists')) {
      return fail(409, 'conflict', error.message)
    }
    if (
      error instanceof Error &&
      (error.message.startsWith('unknown build') ||
        error.message.startsWith('unknown repo') ||
        error.message.startsWith('unknown session') ||
        error.message.startsWith('unknown stream'))
    ) {
      return fail(404, 'not-found', error.message)
    }
    return fail(500, 'internal', error instanceof Error ? error.message : String(error))
  }

  return {
    fetch: async (req: Request): Promise<Response> => {
      try {
        return await route(req)
      } catch (error) {
        const response = errorResponse(error)
        if (response.status >= 500 && opts.onInternalError !== undefined) {
          try {
            await opts.onInternalError(error, req)
          } catch {
            // Diagnostics must never replace the protocol response.
          }
        }
        return response
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
