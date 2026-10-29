import { validateForgeDegradation } from '@defrex/autobuild/remote-store'
import { AccessError } from '@defrex/autobuild-postgres-store/organizations'
import { operatorPresenceBodySchema } from '@defrex/autobuild/remote-store'
import { CATALOG_IDENTITY_HEADER } from '@defrex/autobuild/remote-store'
import { AsyncLocalStorage } from 'node:async_hooks'
import { withRepositoryReads } from '@defrex/autobuild-postgres-store/request-context'
import {
  clientSupportsIntegrationAuditPending,
  assertPublicSnapshotReducer,
} from '@defrex/autobuild/remote-store'
import {
  REDUCER_VALUE_PROJECTION_HEADER,
  reducerValueForClient,
  reducerValueRequestSchema,
  resolveReducerValue,
} from '@defrex/autobuild/remote-store'
import { createDelegationHandler } from './delegated-authority'
import { randomBytes } from 'node:crypto'
import {
  createMachineAuth,
  MachineAuthError,
  requireMachineAccess,
  requireProject,
  type MachineAuth,
  type MachinePrincipal,
} from './machine-auth'
/**
 * The remote BuildStore's HTTP face (SPEC §7.2 adapter 2): a small
 * self-hosted API over any backing BuildStore. Routes are REST and boring;
 * the properties that matter ride on top:
 *
 * - D6: an `EventValidationError` from the backing store crosses the wire
 *   as 422 `{kind: 'validation'}` with the message intact — validation
 *   failures stay agent feedback, never opaque 500s.
 * - D8: the shared machine gate checks a stored project credential on each
 *   request. Explicit repository paths must match; builds, sessions and
 *   streams resolve their actual owning project before reads or writes. Only
 *   the explicit owner admin can cross projects. No auth/secret keeps the
 *   intentional open local-test mode; health is always public.
 *
 * Atomic deposits (POST …/deposits) implement the wire convention in
 * protocol.ts: the request payload embeds negative placeholder refs, and
 * this server substitutes the real revisions *inside* the backing store's
 * `appendWithArtifacts` callback — atomicity is the backing store's, not
 * re-implemented here.
 */
import { z, type ZodType } from 'zod'
import type { AbEvent, EventWrite } from '@defrex/autobuild/plugin-sdk'
import {
  EventValidationError,
  type RepositoryEvent,
  type RepositoryEventWrite,
  type SessionEvent,
  type SessionEventWrite,
  type Via,
} from '@defrex/autobuild/remote-store'
import {
  effectiveTicketAssetLimits,
  MAX_STREAM_WAIT_SECONDS,
  StreamBatchTooLargeError,
  StreamClosedError,
  systemClock,
  TicketAssetValidationError,
  validateTicketAssetInput,
  type BuildStore,
  type Clock,
  type NewBuildInput,
  type StreamOutcome,
  type StreamPart,
  type StreamRead,
  type StreamScope,
} from '@defrex/autobuild/plugin-sdk'
import {
  artifactMetaWireSchema,
  finishRepoTickBodySchema,
  appendStreamBodySchema,
  closeStreamBodySchema,
  conditionalEventBodySchema,
  conditionalSessionEventBodySchema,
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
  putTicketAssetBodySchema,
  reducerSnapshotPutBodySchema,
  SNAPSHOT_REDUCER_NAME,
  type SnapshotScope,
  removeTicketAssetBodySchema,
  substitutePlaceholderRefs,
  type ErrorBody,
  type ErrorKind,
} from '@defrex/autobuild/remote-store'
import {
  AUTOBUILD_VERSION,
  clientIdentityError,
  supportedClientRange,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
} from '@defrex/autobuild/remote-store'

export interface StoreServerOptions {
  requireRegistered?: (repo: string) => Promise<void>
  store: BuildStore
  /** Test seam for release-line compatibility before the release-owned version bump. */
  identity?: { autobuildVersion: string; protocolVersion: string }
  /** When set, all /builds routes require a scoped Bearer token (D8). */
  secret?: string
  auth?: MachineAuth
  /** Time source for token expiry checks; defaults to the system clock. */
  clock?: Clock
  /** Maximum decoded size of each artifact. Unlimited when omitted. */
  maxArtifactBytes?: number
  /** The largest request or response body, in bytes, this deployment can
   * carry on the ticket-asset routes (a platform may reject larger bodies
   * before application code runs). Unbounded when omitted. The server
   * advertises the effective per-asset limits derived from it, and checks
   * every ticket-asset body against it itself. */
  maxTicketAssetRequestBytes?: number
  /** Ceiling for a held event read (`wait` on the two event routes), in
   * whole seconds. Larger requested values clamp to this, never reject;
   * the default is the stream-wait ceiling (30). Hosted deployments set a
   * smaller ceiling to fit the routes' function-duration limit. */
  maxEventWaitSeconds?: number
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

/**
 * The `wait` parameter's own grammar (AUT-334): one or more ASCII digits —
 * deliberately stricter than the lenient `since`/`rev` parse above; anything
 * else (empty, whitespace, hex, signs, decimals) is `400 validation`. Values
 * above the server's documented ceiling clamp to it; magnitudes beyond a
 * safe integer are simply above the ceiling. Absence is the immediate form.
 */
function digitsParam(url: URL, name: string, ceiling: number): number | undefined {
  const raw = url.searchParams.get(name)
  if (raw === null) return undefined
  if (!/^[0-9]+$/.test(raw)) {
    throw new RequestError(
      400,
      'validation',
      `query parameter "${name}" must be a whole number of seconds, got "${raw}"`,
    )
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value > ceiling) return ceiling
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
  const identity = opts.identity ?? {
    autobuildVersion: AUTOBUILD_VERSION,
    protocolVersion: REMOTE_STORE_PROTOCOL_VERSION,
  }
  const clock = opts.clock ?? systemClock
  const maxEventWaitSeconds = opts.maxEventWaitSeconds ?? MAX_STREAM_WAIT_SECONDS

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
    const mismatch = clientIdentityError(
      clientAutobuild,
      clientProtocol,
      identity.autobuildVersion,
      identity.protocolVersion,
    )
    if (mismatch !== undefined) {
      throw new RequestError(409, 'conflict', mismatch)
    }
  }

  const assetLimits = effectiveTicketAssetLimits(opts.maxTicketAssetRequestBytes)
  const utf8 = new TextEncoder()

  /** Serialize one ticket-asset response, refusing a body the deployment
   * could not carry (the platform would otherwise reject it first, opaquely). */
  function assetJson(status: number, body: unknown, describe: string): Response {
    const text = JSON.stringify(body)
    checkAssetResponse(text, describe)
    return new Response(text, { status, headers: { 'content-type': 'application/json' } })
  }

  function checkAssetResponse(text: string, describe: string): void {
    const max = opts.maxTicketAssetRequestBytes
    if (max === undefined) return
    const bytes = utf8.encode(text).length
    if (bytes > max) {
      throw new RequestError(
        413,
        'validation',
        `ticket asset ${describe} is ${bytes} bytes encoded, over this deployment's ${max}-byte response ceiling; it can only be fetched from a store with a higher ceiling`,
      )
    }
  }

  async function readAssetBody(req: Request): Promise<z.infer<typeof putTicketAssetBodySchema>> {
    const text = await req.text()
    const max = opts.maxTicketAssetRequestBytes
    if (max !== undefined) {
      const bytes = utf8.encode(text).length
      if (bytes > max) {
        throw new RequestError(
          413,
          'validation',
          `ticket asset exceeds this store's ${assetLimits.maxBytes}-byte limit (deployment request ceiling ${max} bytes): request is ${bytes} bytes`,
        )
      }
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      throw new RequestError(400, 'validation', 'request body is not valid JSON')
    }
    const parsed = putTicketAssetBodySchema.safeParse(raw)
    if (!parsed.success) {
      throw new RequestError(400, 'validation', `invalid request body: ${parsed.error.message}`)
    }
    return parsed.data
  }

  async function ticketAssetRoute(
    req: Request,
    url: URL,
    repo: string,
    ticketId: string,
    rest: string,
  ): Promise<Response> {
    const label = (kind: string, name: string) => `${kind}/${name}`
    switch (`${req.method} ${rest}`) {
      case 'POST ': {
        const body = await readAssetBody(req)
        const entries = body.entries.map((entry) => {
          if (entry.type === 'dir') return entry
          let content: Uint8Array
          try {
            content = decodeBase64(entry.contentBase64)
          } catch {
            throw new RequestError(400, 'validation', 'ticket asset content is not valid base64')
          }
          return { type: 'file' as const, path: entry.path, content }
        })
        const input = { kind: body.kind, name: body.name, layout: body.layout, entries }
        validateTicketAssetInput(input, assetLimits)
        // The response carries the manifest: size it (worst case revision and
        // timestamp, real sizes, 64-hex content addresses) BEFORE committing,
        // so an unreturnable response never follows a stored revision.
        checkAssetResponse(
          JSON.stringify({
            repo,
            ticketId,
            kind: body.kind,
            name: body.name,
            revision: 999_999_999,
            layout: body.layout,
            size: entries.reduce((sum, e) => sum + (e.type === 'file' ? e.content.length : 0), 0),
            entries: entries.map((e) =>
              e.type === 'dir'
                ? { type: 'dir', path: e.path }
                : { type: 'file', path: e.path, size: e.content.length, blobRef: '0'.repeat(64) },
            ),
            createdAt: '2026-01-01T00:00:00.000Z',
          }),
          `${label(body.kind, body.name)} manifest`,
        )
        const meta = await store.putTicketAsset(repo, ticketId, input)
        return assetJson(201, meta, `${label(body.kind, body.name)} manifest`)
      }
      case 'GET ': {
        const { kind, name } = assetIdentity(url)
        const asset = await store.getTicketAsset(repo, ticketId, kind, name, intParam(url, 'rev'))
        return asset === null
          ? json(200, null)
          : assetJson(200, asset.meta, `${label(kind, name)} manifest`)
      }
      case 'GET file': {
        const { kind, name } = assetIdentity(url)
        const path = url.searchParams.get('path')
        if (path === null || path === '') {
          throw new RequestError(400, 'validation', 'query parameter "path" is required')
        }
        const asset = await store.getTicketAsset(repo, ticketId, kind, name, intParam(url, 'rev'))
        if (asset === null) return json(200, null)
        const entry = asset.entries.find((candidate) => candidate.path === path)
        if (entry === undefined || entry.type !== 'file') {
          throw new RequestError(
            404,
            'not-found',
            `ticket asset ${label(kind, name)} has no file "${path}"`,
          )
        }
        return assetJson(
          200,
          { contentBase64: encodeBase64(entry.content) },
          `file "${path}" of ${label(kind, name)} (${entry.content.byteLength} bytes)`,
        )
      }
      case 'GET list': {
        const summaries = await store.listTicketAssets(repo, ticketId, {
          revisions: url.searchParams.get('revisions') === '1',
        })
        return assetJson(200, summaries, `list for ticket "${ticketId}"`)
      }
      case 'POST remove': {
        const body = await readBody(req, removeTicketAssetBodySchema)
        // The response is the removed manifest: check it fits before the
        // tombstone is written, so a refused response leaves nothing mutated.
        const live = await store.getTicketAsset(repo, ticketId, body.kind, body.name)
        if (live !== null) {
          checkAssetResponse(JSON.stringify(live.meta), `${label(body.kind, body.name)} manifest`)
        }
        return json(200, await store.removeTicketAsset(repo, ticketId, body.kind, body.name))
      }
      default:
        return fail(
          404,
          'not-found',
          `no route: ${req.method} /repos/:repo/tickets/:id/assets/${rest}`,
        )
    }
  }

  function assetIdentity(url: URL): { kind: string; name: string } {
    const kind = url.searchParams.get('kind')
    const name = url.searchParams.get('name')
    if (!kind || !name) {
      throw new RequestError(400, 'validation', 'query parameters "kind" and "name" are required')
    }
    return { kind, name }
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

  const auth =
    opts.auth ??
    (opts.secret === undefined
      ? undefined
      : createMachineAuth({
          secret: opts.secret,
          clock,
          credentials: { authenticate: async () => null },
          projects: { has: async () => false, list: async () => [] },
        }))
  const principals = new AsyncLocalStorage<Map<Request, Promise<MachinePrincipal>>>()
  async function principal(req: Request): Promise<MachinePrincipal | null> {
    if (!auth) return null
    const context = principals.getStore()!
    let pending = context.get(req)
    if (!pending) {
      pending = auth.authenticate(req)
      context.set(req, pending)
    }
    const value = await pending
    requireMachineAccess(value)
    return value
  }
  const unavailable = () =>
    new RequestError(404, 'not-found', 'resource unavailable: unknown resource or wrong project')
  async function authorize(
    req: Request,
    kind: 'build' | 'repo' | 'session' | 'admin',
    id: string,
  ): Promise<MachinePrincipal | null> {
    const value = await principal(req)
    if (!value) return null
    if (value.kind === 'admin') {
      const repo =
        kind === 'repo'
          ? id
          : kind === 'build'
            ? (await store.getBuild(id))?.repo
            : kind === 'session'
              ? (await store.getSession(id))?.repo
              : undefined
      if (repo) await opts.requireRegistered?.(repo)
      return value
    }
    if (kind === 'admin') {
      if (value.kind === 'delegated' && req.method !== 'GET')
        throw new MachineAuthError(403, 'delegated credential cannot administer repositories')
      return value
    }
    let repo: string | undefined
    if (kind === 'repo') repo = id
    else if (kind === 'build') repo = (await store.getBuild(id))?.repo
    else repo = (await store.getSession(id))?.repo
    if (kind !== 'repo' && (repo === undefined || repo !== value.repo)) throw unavailable()
    requireProject(value, repo!)
    const valueRead =
      req.method === 'POST' &&
      new URL(req.url).pathname.endsWith('/reducer-values') &&
      (kind === 'build' || kind === 'repo')
    if (value.kind === 'delegated' && req.method !== 'GET' && !valueRead) {
      const grant = value.delegation
      if (kind === 'build') {
        if (!grant.kind.startsWith('build') || grant.id !== id)
          throw new MachineAuthError(403, 'write outside delegated build')
      } else if (
        kind === 'repo' &&
        (grant.kind === 'build-runner' || grant.kind === 'build-phase') &&
        req.method === 'POST' &&
        new URL(req.url).pathname.split('/').slice(3).join('/') === 'events'
      ) {
        // The preceding requireProject binds this exception to the exact grant repository.
        // Kernel forge guards report newly observed limits through the journal.
        // Delegates cannot recover the forge, change leases, or append other facts.
        const body = eventWriteWireSchema.safeParse(await req.clone().json())
        if (
          !body.success ||
          !z.object({ kind: z.literal('kernel') }).safeParse(body.data.actor).success ||
          body.data.type !== 'dispatcher.forge-degraded'
        )
          throw new MachineAuthError(403, 'write outside delegated resource')
      } else if (kind === 'repo' && grant.kind.startsWith('harvest')) {
        await authorizeHarvestMutation(req, value)
      } else throw new MachineAuthError(403, 'write outside delegated resource')
    }
    return value
  }

  async function authorizeHarvestMutation(
    req: Request,
    principal: Extract<MachinePrincipal, { kind: 'delegated' }>,
  ): Promise<void> {
    const grant = principal.delegation
    const path = new URL(req.url).pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const rest = path.slice(2).join('/')
    const deny = () => {
      throw new MachineAuthError(403, 'write outside delegated harvest run')
    }
    const ownsStreamLabel = (label: string) =>
      grant.session
        ? label === `harvest:${grant.id}:${grant.execution}:session:${grant.session}`
        : label.startsWith(`harvest:${grant.id}:${grant.execution}:`)
    const body = (await req.clone().json()) as Record<string, unknown>
    if (rest === 'lease/heartbeat' || rest === 'lease/claim') {
      if (grant.kind !== 'harvest-runner' || body.holder !== grant.leaseHolder) deny()
      return
    }
    if (path[0] === 'streams') {
      const stream = await store.getStream(path[1]!)
      if (!stream || !ownsStreamLabel(stream.label)) deny()
      return
    }
    if (rest.startsWith('streams')) {
      // Run ownership is carried in the immutable label and checked on every addressed write.
      if (path.length === 3) {
        if (typeof body.label !== 'string' || !ownsStreamLabel(body.label)) deny()
      } else {
        const stream = await store.getStream(path[3]!)
        if (!stream || !ownsStreamLabel(stream.label)) deny()
      }
      return
    }
    if (rest === 'artifacts') {
      if (
        (body.metadata as { run?: string } | undefined)?.run !== grant.id ||
        typeof body.kind !== 'string' ||
        !['harvest-proposals', 'harvest-review', 'harvest-report', 'harvest-transcript'].includes(
          body.kind,
        )
      )
        deny()
      return
    }
    if (!['events', 'events/conditional', 'deposits'].includes(rest)) deny()
    const event = (rest === 'events' ? body : body.event) as {
      type?: string
      payload?: { run?: string; session?: string }
      actor?: unknown
    }
    if (
      rest === 'events' &&
      event?.type === 'harvest.execution.ended' &&
      grant.kind === 'harvest-runner' &&
      event.payload?.run === grant.id &&
      (event.payload as { execution?: string }).execution === grant.execution
    )
      return
    if (
      !event?.type?.startsWith('harvest.') ||
      event.payload?.run !== grant.id ||
      [
        'harvest.started',
        'harvest.resumed',
        'harvest.recovery-requested',
        'harvest.recovery-exhausted',
        'harvest.execution.started',
        'harvest.execution.released',
        'harvest.execution.authorized',
        'harvest.execution.ended',
      ].includes(event.type)
    )
      deny()
    if (grant.session && event.payload?.session && event.payload.session !== grant.session) deny()
    enforceVia(principal, event.actor)
    if (rest === 'deposits') {
      for (const artifact of body.artifacts as Array<{
        kind: string
        metadata?: { run?: string }
      }>) {
        if (
          artifact.metadata?.run !== grant.id ||
          !['harvest-proposals', 'harvest-review', 'harvest-report', 'harvest-transcript'].includes(
            artifact.kind,
          )
        )
          deny()
      }
    }
  }

  // Project credentials retain runner authority; delegated phase claims also
  // constrain agent attribution on the wire, independently of CLI handles.

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
  function enforceVia(scope: MachinePrincipal | null, actor: unknown): unknown {
    if (scope === null) return actor
    if (scope.kind === 'delegated' && scope.delegation.session) {
      const attributed = actor as { kind?: string; session?: string }
      if (attributed?.kind === 'agent' && attributed.session !== scope.delegation.session)
        throw new MachineAuthError(403, 'wrong delegated session')
    }
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
    const owner = await principal(req)
    if (owner?.kind === 'delegated' && req.method !== 'GET')
      throw new MachineAuthError(403, 'delegated credential cannot create builds')
    if (req.method === 'POST') {
      const body = await readBody(req, newBuildBodySchema)
      await opts.requireRegistered?.(body.repo)
      if (owner && owner.kind !== 'admin') {
        requireProject(owner, body.repo)
        for (let attempt = 0; attempt < 10; attempt++) {
          const slug = `${body.slug.slice(0, 60)}-${randomBytes(12).toString('hex')}`
          try {
            return json(
              201,
              await store.createBuild({ ...body, slug, branch: `ab/${slug}` } as NewBuildInput),
            )
          } catch (error) {
            const code = (error as { code?: string }).code
            if (
              code !== '23505' &&
              !(error instanceof Error && /^build .*already exists/.test(error.message))
            )
              throw error
          }
        }
        throw new Error('build identity allocation failed')
      }
      if ((await store.getBuild(body.slug)) !== null) {
        return fail(409, 'conflict', `build "${body.slug}" already exists`)
      }
      return json(201, await store.createBuild(body as NewBuildInput))
    }
    if (req.method === 'GET') {
      const records =
        owner && owner.kind !== 'admin' && store.listBuildsForRepo
          ? await store.listBuildsForRepo(owner.repo)
          : await store.listBuilds()
      return json(
        200,
        records.filter((record) => !owner || owner.kind === 'admin' || record.repo === owner.repo),
      )
    }
    return fail(404, 'not-found', `no route: ${req.method} /builds`)
  }

  async function repoAdminRoute(req: Request): Promise<Response> {
    await authorize(req, 'admin', '*')
    if (req.method !== 'POST') {
      return fail(404, 'not-found', `no route: ${req.method} /repos`)
    }
    const body = await readBody(req, ensureRepoBodySchema)
    await opts.requireRegistered?.(body.repo)
    const owner = await principal(req)
    if (owner) requireProject(owner, body.repo)
    return json(200, await store.ensureRepo(body.repo))
  }

  function validateRepoAdmission(event: { type: string; payload: unknown }): void {
    if (event.type !== 'dispatcher.forge-degraded') return
    try {
      validateForgeDegradation(event.payload, clock())
    } catch (error) {
      throw new RequestError(400, 'validation', (error as Error).message)
    }
  }

  async function repoRoute(
    req: Request,
    url: URL,
    repo: string,
    rest: string,
    scope: MachinePrincipal | null,
  ): Promise<Response> {
    const segments = rest.split('/')
    if (segments[0] === 'streams') {
      return streamRoute(req, url, { kind: 'repo', repo }, segments.slice(1))
    }
    if (segments[0] === 'snapshots' && segments.length === 2) {
      return snapshotRoute(req, url, { kind: 'repo', repo }, segments[1]!)
    }
    if (rest === 'reducer-values') return valueRoute(req, { kind: 'repo', repo })
    switch (`${req.method} ${rest}`) {
      case 'POST events': {
        const body = await readBody(req, eventWriteWireSchema)

        validateRepoAdmission(body)
        const actor = enforceVia(scope, body.actor)
        return json(201, await store.appendRepo(repo, { ...body, actor } as RepositoryEventWrite))
      }
      case 'GET events': {
        const since = intParam(url, 'since') ?? 0
        const wait = digitsParam(url, 'wait', maxEventWaitSeconds)
        return json(
          200,
          await withDisconnect(
            req,
            store.getRepoEvents(repo, since, {
              ...(wait !== undefined ? { waitSeconds: wait } : {}),
              signal: req.signal,
            }),
            (): RepositoryEvent[] => [],
          ),
        )
      }
      case 'GET high-water': {
        return json(200, { seq: await store.getRepoHighWater(repo) })
      }
      case 'GET state-events': {
        // The bounded repository-journal read (AUT-489), inside the same
        // repo-existence and authorization gates as `GET events` above: an
        // unknown repo answers the store server's 404, not a generic one.
        return json(
          200,
          await withDisconnect(req, store.getRepoStateEvents(repo), (): RepositoryEvent[] => []),
        )
      }
      case 'POST deposits': {
        const body = await readBody(req, depositsBodySchema)

        validateRepoAdmission(body.event)
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
              compatibility: body.event.compatibility,
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
      case 'POST tick/begin': {
        const body = await readBody(req, leaseHolderBodySchema)
        return json(200, await store.beginRepoTick(repo, body.holder))
      }
      case 'POST tick/finish': {
        const body = await readBody(req, finishRepoTickBodySchema)
        for (const event of body.events) validateRepoAdmission(event)
        const events = body.events.map((event) => ({
          ...event,
          actor: enforceVia(scope, event.actor),
        })) as RepositoryEventWrite[]
        return json(200, await store.finishRepoTick(repo, body.holder, body.completion, events))
      }
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
        return fail(403, 'auth', 'wrong project')
      }
      return json(201, await store.createSession(body))
    }
    if (req.method === 'GET') {
      return json(200, await store.listSessions(repo))
    }
    return fail(404, 'not-found', `no route: ${req.method} /repos/:repo/sessions`)
  }

  /**
   * The build-digest batch read (AUT-487). Keyed to build records, not the
   * repository journal record: a repo that has builds but no journal record,
   * and a repo the store has never seen, both answer `200` with the (possibly
   * empty) digests array rather than `404 not-found` — the same shape the
   * backing store's `getRepoBuildDigests` contract gives every adapter. The
   * route is therefore handled BEFORE the `store.getRepo` existence gate, like
   * `sessionCollectionRoute`, while `authorize(req, 'repo', repo)` has already
   * run, so a wrong-scope token is still rejected before any lookup and the
   * no-existence-leak rule holds.
   */
  async function buildDigestRoute(req: Request, repo: string): Promise<Response> {
    if (req.method !== 'GET') {
      return fail(404, 'not-found', `no route: ${req.method} /repos/:repo/build-digests`)
    }
    const digests = [...(await store.getRepoBuildDigests(repo)).values()]
    // Historical release lines predate the additive audit signal.
    const supportsAudit = clientSupportsIntegrationAuditPending(
      req.headers.get(AUTOBUILD_VERSION_HEADER),
    )
    const response = json(
      200,
      supportsAudit
        ? digests
        : digests.map(({ integrationAuditPending: _audit, ...digest }) => digest),
    )
    if (store.catalogIdentity) response.headers.set(CATALOG_IDENTITY_HEADER, store.catalogIdentity)
    return response
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
      case 'POST events/conditional': {
        const body = await readBody(req, conditionalSessionEventBodySchema)
        const event = await store.appendSessionEventIfCurrent(id, body.expectedSeq, {
          ...body.event,
        } as SessionEventWrite)
        return json(event === null ? 200 : 201, event)
      }
      case 'GET events': {
        const since = intParam(url, 'since') ?? 0
        const wait = digitsParam(url, 'wait', maxEventWaitSeconds)
        return json(
          200,
          await withDisconnect(
            req,
            store.getSessionEvents(id, since, {
              ...(wait !== undefined ? { waitSeconds: wait } : {}),
              signal: req.signal,
            }),
            (): SessionEvent[] => [],
          ),
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

  async function valueRoute(req: Request, scope: SnapshotScope): Promise<Response> {
    if (req.method !== 'POST')
      return fail(404, 'not-found', `no route: ${req.method} reducer-values`)
    const text = await req.text()
    if (utf8.encode(text).length > 4096)
      throw new RequestError(413, 'validation', 'reducer request exceeds 4 KiB')
    let body: ReturnType<typeof reducerValueRequestSchema.parse>
    try {
      body = reducerValueRequestSchema.parse(JSON.parse(text))
      resolveReducerValue(scope, body)
    } catch (error) {
      throw new RequestError(400, 'validation', String(error))
    }
    try {
      const result = reducerValueForClient(
        {
          version: req.headers.get(AUTOBUILD_VERSION_HEADER),
          projects: req.headers.get(REDUCER_VALUE_PROJECTION_HEADER) === '1',
        },
        body.reducer,
        await store.getReducerValue(scope, body),
      )
      const response = json(200, {
        version: result.version,
        cursor: result.cursor,
        value: result.value,
      })
      if (result.catalogIdentity)
        response.headers.set(CATALOG_IDENTITY_HEADER, result.catalogIdentity)
      return response
    } catch (error) {
      if (
        scope.kind === 'repo' &&
        error instanceof Error &&
        error.message === 'unknown reducer scope'
      )
        throw new Error(`unknown repo "${scope.repo}"`)
      throw error
    }
  }

  /** A body ceiling for one snapshot: generous for a long build's accumulator,
   * still a bound, so an oversized or hostile write is a 413 and never reaches
   * the store. */
  const MAX_SNAPSHOT_BODY_BYTES = 16 * 1024 * 1024

  /** `GET|PUT …/snapshots/:reducer` for one build or repository journal: a
   * cache beside the log (core `store/snapshots.ts`). The store enforces the
   * invariants (never-decreasing cursor, version and log-tail filtering); this
   * only parses, bounds, and delegates. */
  async function snapshotRoute(
    req: Request,
    url: URL,
    scope: SnapshotScope,
    reducer: string,
  ): Promise<Response> {
    try {
      assertPublicSnapshotReducer(reducer)
    } catch (error) {
      throw new RequestError(400, 'validation', (error as Error).message)
    }
    if (!SNAPSHOT_REDUCER_NAME.test(reducer)) {
      throw new RequestError(400, 'validation', `invalid reducer name "${reducer}"`)
    }
    if (req.method === 'GET') {
      const version = intParam(url, 'version')
      if (version === undefined || version < 1) {
        throw new RequestError(400, 'validation', 'query parameter "version" is required')
      }
      return json(200, await store.getReducerSnapshot(scope, reducer, version))
    }
    if (req.method === 'PUT') {
      const text = await req.text()
      if (utf8.encode(text).length > MAX_SNAPSHOT_BODY_BYTES) {
        throw new RequestError(413, 'validation', 'snapshot body is over the 16 MiB ceiling')
      }
      let raw: unknown
      try {
        raw = JSON.parse(text)
      } catch {
        throw new RequestError(400, 'validation', 'request body is not valid JSON')
      }
      const parsed = reducerSnapshotPutBodySchema.safeParse(raw)
      if (!parsed.success) {
        throw new RequestError(400, 'validation', `invalid request body: ${parsed.error.message}`)
      }
      const written = await store.putReducerSnapshot(scope, reducer, parsed.data)
      return json(200, { written })
    }
    return fail(404, 'not-found', `no route: ${req.method} snapshots/${reducer}`)
  }

  async function buildRoute(
    req: Request,
    url: URL,
    slug: string,
    rest: string,
    scope: MachinePrincipal | null,
  ): Promise<Response> {
    const segments = rest.split('/')
    if (segments[0] === 'streams') {
      return streamRoute(req, url, { kind: 'build', build: slug }, segments.slice(1))
    }
    if (segments[0] === 'snapshots' && segments.length === 2) {
      return snapshotRoute(req, url, { kind: 'build', slug }, segments[1]!)
    }
    if (rest === 'reducer-values') return valueRoute(req, { kind: 'build', slug })
    switch (`${req.method} ${rest}`) {
      // The build's frozen ticket assets (SPEC §6.3): read through the build's
      // own events, so a build-scoped token needs no ticket-asset authority.
      case 'GET ticket-assets': {
        const { kind, name } = assetIdentity(url)
        const asset = await store.getPinnedTicketAsset(slug, kind, name, intParam(url, 'rev'))
        return asset === null
          ? json(200, null)
          : assetJson(200, asset.meta, `${kind}/${name} manifest`)
      }
      case 'GET ticket-assets/file': {
        const { kind, name } = assetIdentity(url)
        const path = url.searchParams.get('path')
        if (path === null || path === '') {
          throw new RequestError(400, 'validation', 'query parameter "path" is required')
        }
        const asset = await store.getPinnedTicketAsset(slug, kind, name, intParam(url, 'rev'))
        if (asset === null) return json(200, null)
        const entry = asset.entries.find((candidate) => candidate.path === path)
        if (entry === undefined || entry.type !== 'file') {
          throw new RequestError(
            404,
            'not-found',
            `ticket asset ${kind}/${name} has no file "${path}"`,
          )
        }
        return assetJson(
          200,
          { contentBase64: encodeBase64(entry.content) },
          `file "${path}" of ${kind}/${name} (${entry.content.byteLength} bytes)`,
        )
      }
      case 'POST events': {
        const body = await readBody(req, eventWriteWireSchema)

        const actor = enforceVia(scope, body.actor)
        return json(201, await store.append(slug, { ...body, actor } as EventWrite))
      }
      case 'POST events/conditional': {
        const body = await readBody(req, conditionalEventBodySchema)

        const actor = enforceVia(scope, body.event.actor)
        const event = await store.appendIfCurrent(slug, body.expectedSeq, {
          ...body.event,
          actor,
        } as EventWrite)
        return json(event === null ? 200 : 201, event)
      }
      case 'GET events': {
        const since = intParam(url, 'since') ?? 0
        const wait = digitsParam(url, 'wait', maxEventWaitSeconds)
        return json(
          200,
          await withDisconnect(
            req,
            store.getEvents(slug, since, {
              ...(wait !== undefined ? { waitSeconds: wait } : {}),
              signal: req.signal,
            }),
            (): AbEvent[] => [],
          ),
        )
      }
      case 'POST deposits':
      case 'POST deposits/conditional': {
        const body = await readBody(req, depositsBodySchema)
        if (rest === 'deposits/conditional' && body.expectedSeq === undefined)
          throw new RequestError(400, 'validation', 'conditional deposits require expectedSeq')
        if (rest === 'deposits' && body.expectedSeq !== undefined)
          throw new RequestError(400, 'validation', 'use deposits/conditional for expectedSeq')

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
        const deposit = (deposited: import('@defrex/autobuild/store-adapter').ArtifactMeta[]) =>
          ({
            compatibility: body.event.compatibility,
            actor,
            type: body.event.type,
            payload: substitutePlaceholderRefs(body.event.payload, deposited),
          }) as EventWrite
        const result =
          body.expectedSeq === undefined
            ? await store.appendWithArtifacts(slug, inputs, deposit)
            : await store.appendWithArtifactsIfCurrent(slug, body.expectedSeq, inputs, deposit)
        return json(result === null ? 200 : 201, result)
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
      case 'GET artifact-meta': {
        const kind = url.searchParams.get('kind')
        if (kind === null || kind.trim() === '') {
          throw new RequestError(400, 'validation', 'query parameter "kind" is required')
        }
        if (!store.getLatestArtifactMeta) {
          return fail(501, 'unsupported-operation', 'latest artifact metadata is unsupported')
        }
        return json(
          200,
          artifactMetaWireSchema.nullable().parse(await store.getLatestArtifactMeta(slug, kind)),
        )
      }
      case 'GET artifact-list': {
        const kind = url.searchParams.get('kind') ?? undefined
        return json(200, await store.listArtifacts(slug, kind))
      }
      case 'POST node-writer/claim': {
        const body = await readBody(req, leaseClaimBodySchema)
        return json(200, { ok: await store.claimNodeWriter(slug, body.holder, body.ttlMs) })
      }
      case 'POST node-writer/heartbeat': {
        const body = await readBody(req, leaseHolderBodySchema)
        return json(200, { ok: await store.renewNodeWriter(slug, body.holder) })
      }
      case 'POST node-writer/release': {
        const body = await readBody(req, leaseHolderBodySchema)
        await store.releaseNodeWriter(slug, body.holder)
        return json(200, { ok: true })
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
      throw unavailable()
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
        // §9 grammar: `wait` is digits-only server-wide, clamped to the
        // 30-second stream ceiling (MAX_STREAM_WAIT_SECONDS, not the hosted
        // event ceiling of §6's hosted exception).
        const wait = digitsParam(url, 'wait', MAX_STREAM_WAIT_SECONDS)
        return json(
          200,
          await withDisconnect(
            req,
            store.readStream(streamId, {
              since,
              ...(wait !== undefined ? { waitSeconds: wait } : {}),
              signal: req.signal,
            }),
            // The empty read carries the already-fetched record's lifecycle
            // fields verbatim — the response to a disconnected client is
            // discarded either way, but the wire schema must still hold.
            (): StreamRead => ({
              chunks: [],
              status: record.status,
              ...(record.outcome !== undefined ? { outcome: record.outcome } : {}),
              ...(record.artifact !== undefined ? { artifact: record.artifact } : {}),
            }),
          ),
        )
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
    await principal(req)
    const record = await store.getStream(streamId)
    if (record === null) throw unavailable()
    const scopeId =
      record.scope.kind === 'build'
        ? record.scope.build
        : record.scope.kind === 'repo'
          ? record.scope.repo
          : record.scope.session
    try {
      await authorize(req, record.scope.kind, scopeId)
    } catch (error) {
      if (error instanceof MachineAuthError && error.status === 403) throw unavailable()
      throw error
    }
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
        autobuildVersion: identity.autobuildVersion,
        protocolVersion: identity.protocolVersion,
        supportedClientRange: supportedClientRange(identity.autobuildVersion),
      })
    }
    if (['credentials', 'repos', 'builds', 'streams', 'sessions'].includes(segments[0] ?? '')) {
      validateIdentity(req)
    }
    if (segments.join('/') === 'credentials/delegate' && req.method === 'POST') {
      if (!auth || !opts.secret) return fail(404, 'not-found', 'credential issuance unavailable')
      return createDelegationHandler({ store, auth, secret: opts.secret, clock })(req)
    }
    if (segments[0] === 'streams') {
      return globalStreamRoute(req, url, segments)
    }
    if (segments[0] === 'sessions' && segments.length >= 2) {
      const id = segments[1]!
      await authorize(req, 'session', id)
      if (segments.length === 2) {
        if (req.method === 'GET') return sessionRoute(req, url, id, 'record')
        return fail(404, 'not-found', `no route: ${req.method} ${url.pathname}`)
      }
      return sessionRoute(req, url, id, segments.slice(2).join('/'))
    }

    if (segments[0] === 'repos') {
      if (segments.length === 1) return repoAdminRoute(req)
      const repo = segments[1]!
      if (
        (segments.length === 3 || (segments.length === 4 && req.method === 'DELETE')) &&
        segments[2] === 'operator-presence'
      ) {
        if ((await principal(req))?.kind === 'delegated')
          throw new MachineAuthError(
            403,
            'operator presence requires repository operator authority',
          )
        await authorize(req, 'repo', repo)
        if (req.method === 'DELETE' && segments.length === 4) {
          await store.removeOperatorPresence(repo, segments[3]!)
          return json(200, { ok: true })
        }
        if (req.method === 'GET') return json(200, await store.listOperatorPresence(repo))
        if (req.method === 'POST')
          return json(
            200,
            await store.upsertOperatorPresence(
              repo,
              await readBody(req, operatorPresenceBodySchema),
              req.signal,
            ),
          )
        return fail(404, 'not-found', 'unknown operator presence route')
      }
      const scope = await authorize(req, 'repo', repo)
      if (segments.length === 3 && segments[2] === 'sessions') {
        return sessionCollectionRoute(req, repo)
      }
      if (segments.length === 3 && req.method === 'GET') {
        if (segments[2] === 'change-position')
          return json(200, { position: await store.getRepoChangePosition(repo) })
        if (segments[2] === 'builds') return json(200, await store.listBuildsForRepo(repo))
      }
      if (segments.length === 3 && segments[2] === 'build-digests') {
        return buildDigestRoute(req, repo)
      }
      // Ticket assets are keyed by repo and ticket, not by a journal row, so
      // they sit before the repository-existence gate like the session family.
      if (segments.length === 3 && segments[2] === 'ticket-asset-limits' && req.method === 'GET') {
        const own = await store.ticketAssetLimits(repo)
        return json(200, {
          maxBytes: Math.min(assetLimits.maxBytes, own.maxBytes),
          maxEntries: Math.min(assetLimits.maxEntries, own.maxEntries),
          ...(opts.maxTicketAssetRequestBytes !== undefined
            ? { maxRequestBytes: opts.maxTicketAssetRequestBytes }
            : {}),
        })
      }
      if (segments[2] === 'tickets' && segments.length >= 5 && segments[4] === 'assets') {
        return ticketAssetRoute(req, url, repo, segments[3]!, segments.slice(5).join('/'))
      }
      const rest = segments.slice(2).join('/')
      // Store reads/locks own existence for these operations. Streams only
      // check existence on creation; listing/addressing and snapshots need a gate.
      const storeGated = [
        'GET events',
        'POST events',
        'GET high-water',
        'GET state-events',
        'POST deposits',
        'POST artifacts',
        'GET artifacts',
        'GET artifact-list',
        'GET artifact-meta',
        'POST tick/begin',
        'POST tick/finish',
        'POST lease/claim',
        'POST lease/heartbeat',
        'POST lease/release',
        'POST streams',
        'POST reducer-values',
      ].includes(`${req.method} ${rest}`)
      if (!storeGated) {
        const record = await store.getRepo(repo)
        if (record === null) return fail(404, 'not-found', `unknown repo "${repo}"`)
        if (segments.length === 2) {
          if (req.method === 'GET') return json(200, record)
          return fail(404, 'not-found', `no route: ${req.method} ${url.pathname}`)
        }
      }
      return repoRoute(req, url, repo, segments.slice(2).join('/'), scope)
    }

    if (segments[0] !== 'builds') {
      return fail(404, 'not-found', `no route: ${req.method} ${url.pathname}`)
    }
    if (segments.length === 1) return adminRoute(req)

    const slug = segments[1]!
    const scope = await authorize(req, 'build', slug)
    if (segments[2] === 'node-writer' && scope?.kind === 'delegated')
      throw new MachineAuthError(403, 'delegated executions cannot acquire node writer authority')
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

  /** A held read must not outlive its client. When the peer disconnects, Bun
   * keeps the handler promise pending — which would stall `server.stop()` —
   * so a held read races the request's abort signal and resolves empty; the
   * response to a disconnected client is discarded either way. The held
   * routes also pass the same signal into the backing store read itself, so
   * the poll loop behind the request stops too (AUT-380) instead of polling
   * to its own wait bound; this guard remains for `server.stop()` and for
   * any read that completes between abort and loop exit. */
  function withDisconnect<T>(req: Request, read: Promise<T>, empty: () => T): Promise<T> {
    const signal = req.signal
    if (signal.aborted) return Promise.resolve(empty())
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => resolve(empty())
      signal.addEventListener('abort', onAbort, { once: true })
      read.then(
        (value) => {
          signal.removeEventListener('abort', onAbort)
          resolve(value)
        },
        (error) => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      )
    })
  }

  function errorResponse(error: unknown): Response {
    if (error instanceof MachineAuthError || error instanceof AccessError)
      return fail(error.status, 'auth', error.message)
    if (error instanceof RequestError) {
      return fail(error.status, error.kind, error.message)
    }
    // D6: validation feedback must survive the wire with its message intact.
    if (error instanceof EventValidationError) {
      return fail(422, 'validation', error.message)
    }
    if (error instanceof TicketAssetValidationError) {
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
    fetch: async (req: Request): Promise<Response> =>
      withRepositoryReads(() =>
        principals.run(new Map(), async () => {
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
        }),
      ),
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
