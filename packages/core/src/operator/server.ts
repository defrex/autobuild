import type { ZodType } from 'zod'
import { controlBuild, BuildControlError, type BuildControlAction } from '../cli/build-control'
import { bulkControlRepository, BulkWalkError } from '../cli/bulk-control'
import { effectiveStatus } from '../cli/dashboard/model'
import { reduceBuild } from '../kernel/reducer'
import { systemClock, type BuildStore, type Clock } from '../store/types'
import { tokenResource, verifyToken } from '../store/remote/token'
import {
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
} from '../store/remote/version'
import {
  answerRequestSchema,
  buildControlRequestSchema,
  buildListScopeSchema,
  bulkControlRequestSchema,
  harvestControlRequestSchema,
  settingRequestSchema,
} from './protocol'
import {
  controlHarvestRun,
  OperatorControlError,
  setRepositorySetting,
  toggleHarvestGate,
  toggleRepositorySetting,
} from './control'
import {
  getHarvestStatus,
  getOperatorBuild,
  getOperatorDashboard,
  getRepositoryStatus,
  listOperatorBuilds,
  OperatorQueryError,
} from './query'

export interface OperatorServerOptions {
  store: BuildStore
  secret: string
  clock?: Clock
  /** Observes unexpected backing-store failures without exposing them over HTTP. */
  onInternalError?: (error: unknown, request: Request) => unknown | Promise<unknown>
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly kind: 'validation' | 'auth' | 'not-found' | 'conflict',
    message: string,
  ) {
    super(message)
  }
}

function json(status: number, value: unknown): Response {
  return Response.json(value, { status })
}
function failure(status: number, kind: string, error: string, extra: object = {}): Response {
  return json(status, { kind, error, ...extra })
}
async function body<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let value: unknown
  try {
    value = await req.json()
  } catch {
    throw new HttpError(400, 'validation', 'request body is not valid JSON')
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new HttpError(400, 'validation', `invalid request body: ${parsed.error.message}`)
  }
  return parsed.data
}

export function createOperatorServer(opts: OperatorServerOptions): {
  fetch(req: Request): Promise<Response>
} {
  const clock = opts.clock ?? systemClock

  function identity(req: Request): void {
    const app = req.headers.get(AUTOBUILD_VERSION_HEADER)
    const protocol = req.headers.get(REMOTE_STORE_PROTOCOL_VERSION_HEADER)
    if (app !== AUTOBUILD_VERSION || protocol !== REMOTE_STORE_PROTOCOL_VERSION) {
      throw new HttpError(
        409,
        'conflict',
        `remote store version mismatch: client Autobuild ${app ?? '(missing)'} protocol ${protocol ?? '(missing)'}; server Autobuild ${AUTOBUILD_VERSION} protocol ${REMOTE_STORE_PROTOCOL_VERSION}`,
      )
    }
  }

  function operator(req: Request): string {
    const match = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')
    if (match === null) throw new HttpError(401, 'auth', 'missing bearer token')
    const scope = verifyToken(opts.secret, match[1]!, clock())
    if (scope === null) throw new HttpError(401, 'auth', 'invalid or expired token')
    const resource = tokenResource(scope)
    if (resource.kind !== 'operator' || !('operator' in scope) || scope.operator === true) {
      throw new HttpError(
        403,
        'auth',
        `token scoped to ${resource.kind} "${resource.id}" may not access operator operations`,
      )
    }
    return scope.operator.user
  }

  async function requireRouteBuild(repo: string, slug: string): Promise<void> {
    const record = await opts.store.getBuild(slug)
    if (record === null || record.repo !== repo) {
      throw new HttpError(404, 'not-found', `unknown build "${slug}"`)
    }
  }

  async function route(req: Request): Promise<Response> {
    identity(req)
    const user = operator(req)
    const url = new URL(req.url)
    let parts: string[]
    try {
      parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    } catch {
      throw new HttpError(400, 'validation', `malformed path: ${url.pathname}`)
    }
    if (parts[0] !== 'operator' || parts[1] !== 'v1' || parts[2] !== 'repos' || !parts[3]) {
      throw new HttpError(404, 'not-found', `no route: ${req.method} ${url.pathname}`)
    }
    const repo = parts[3]
    const rest = parts.slice(4)

    if (req.method === 'GET' && rest.length === 1 && rest[0] === 'builds') {
      const parsed = buildListScopeSchema.safeParse(url.searchParams.get('scope') ?? 'active')
      if (!parsed.success)
        throw new HttpError(400, 'validation', 'scope must be active, queued, or all')
      return json(
        200,
        await listOperatorBuilds({ store: opts.store, repo, scope: parsed.data, now: clock() }),
      )
    }
    if (req.method === 'GET' && rest.length === 1 && rest[0] === 'dashboard') {
      return json(200, await getOperatorDashboard({ store: opts.store, repo, clock }))
    }
    if (req.method === 'GET' && rest.length === 1 && rest[0] === 'status') {
      return json(200, await getRepositoryStatus(opts.store, repo))
    }
    if (req.method === 'GET' && rest.join('/') === 'harvest/status') {
      return json(200, await getHarvestStatus(opts.store, repo))
    }
    if (req.method === 'POST' && rest.join('/') === 'bulk-control') {
      const request = await body(req, bulkControlRequestSchema)
      return json(
        200,
        await bulkControlRepository({ store: opts.store, repo, user, direction: request.action }),
      )
    }
    if (req.method === 'POST' && rest.join('/') === 'harvest/control') {
      const request = await body(req, harvestControlRequestSchema)
      return json(
        200,
        request.action === 'toggle-gate'
          ? await toggleHarvestGate({ store: opts.store, repo, user })
          : await controlHarvestRun({ store: opts.store, repo, user, run: request.run }),
      )
    }

    if (rest[0] === 'settings' && rest[1] && rest.length >= 2) {
      const setting =
        rest[1] === 'intake'
          ? ('intake' as const)
          : rest[1] === 'auto-merge-default'
            ? ('auto-merge-default' as const)
            : undefined
      if (setting !== undefined && req.method === 'PUT' && rest.length === 2) {
        const request = await body(req, settingRequestSchema)
        return json(
          200,
          await setRepositorySetting({
            store: opts.store,
            repo,
            user,
            setting,
            enabled: request.enabled,
          }),
        )
      }
      if (
        setting !== undefined &&
        req.method === 'POST' &&
        rest[2] === 'toggle' &&
        rest.length === 3
      ) {
        return json(200, await toggleRepositorySetting({ store: opts.store, repo, user, setting }))
      }
    }

    if (rest[0] === 'builds' && rest[1]) {
      const slug = rest[1]
      if (req.method === 'GET' && rest.length === 2) {
        return json(200, await getOperatorBuild({ store: opts.store, repo, slug, now: clock() }))
      }
      if (req.method === 'GET' && rest[2] === 'artifacts' && rest[3] && rest.length === 4) {
        const rawRev = url.searchParams.get('rev')
        const rev = rawRev === null ? undefined : Number(rawRev)
        if (rev !== undefined && (!Number.isInteger(rev) || rev < 0)) {
          throw new HttpError(400, 'validation', 'rev must be a nonnegative integer')
        }
        const record = await opts.store.getBuild(slug)
        if (record === null || record.repo !== repo)
          throw new HttpError(404, 'not-found', `unknown build "${slug}"`)
        const artifact = await opts.store.getArtifact(slug, rest[3], rev)
        if (artifact === null)
          throw new HttpError(
            404,
            'not-found',
            `artifact ${rest[3]}${rev === undefined ? '' : `@${rev}`} not found`,
          )
        return new Response(Uint8Array.from(artifact.content), {
          status: 200,
          headers: {
            'content-type': 'application/octet-stream',
            'content-disposition': `attachment; filename="${encodeURIComponent(slug)}-${encodeURIComponent(rest[3])}-${artifact.meta.revision}"`,
            'x-autobuild-artifact-kind': artifact.meta.kind,
            'x-autobuild-artifact-revision': String(artifact.meta.revision),
            'x-autobuild-artifact-blob-ref': artifact.meta.blobRef,
          },
        })
      }
      if (req.method === 'POST' && rest[2] === 'control' && rest.length === 3) {
        const request = await body(req, buildControlRequestSchema)
        await requireRouteBuild(repo, slug)
        if (request.action === 'pause' || request.action === 'cancel-pause') {
          const state = reduceBuild(await opts.store.getEvents(slug))
          const display = effectiveStatus(state)
          if (request.action === 'pause' && display === 'pausing') {
            throw new BuildControlError(
              'inactive',
              `build "${slug}" cannot pause (status: pausing); pause is already pending`,
            )
          }
          if (request.action === 'cancel-pause' && display !== 'pausing') {
            throw new BuildControlError(
              'inactive',
              `build "${slug}" cannot cancel pause (status: ${state.status}); cancel pause requires a pending pause`,
            )
          }
        }
        const action: BuildControlAction =
          request.action === 'pause' || request.action === 'cancel-pause'
            ? { kind: 'dashboard-pause' }
            : request.action === 'resume'
              ? { kind: 'dashboard-resume' }
              : { kind: request.action }
        return json(200, await controlBuild({ store: opts.store, repo, slug, user, action }))
      }
      if (req.method === 'POST' && rest[2] === 'answer' && rest.length === 3) {
        const request = await body(req, answerRequestSchema)
        await requireRouteBuild(repo, slug)
        const action: BuildControlAction =
          request.resolution === 'guidance'
            ? { kind: 'answer', text: request.text }
            : request.resolution === 'retry'
              ? { kind: 'answer' }
              : request.resolution === 'dismiss'
                ? { kind: 'answer', text: request.text, resolve: { kind: 'dismiss-finding' } }
                : request.resolution === 'review-round-ceiling'
                  ? { kind: 'answer', text: request.text, reviewRoundCeiling: request.ceiling }
                  : {
                      kind: 'answer',
                      text: request.text,
                      ...(request.ceiling !== undefined
                        ? { reviewRoundCeiling: request.ceiling }
                        : {}),
                      resolve: {
                        kind: 'revise-spec',
                        body:
                          request.origin === 'body'
                            ? {
                                kind: 'supplied',
                                origin: 'operator API body',
                                read: async () => request.body,
                              }
                            : { kind: 'ticket' },
                      },
                    }
        return json(
          200,
          await controlBuild({
            store: opts.store,
            repo,
            slug,
            user,
            action,
            ...(request.resolution === 'revise-spec' && request.origin === 'ticket'
              ? { readTicketBody: async () => request.body }
              : {}),
          }),
        )
      }
    }
    throw new HttpError(404, 'not-found', `no route: ${req.method} ${url.pathname}`)
  }

  return {
    async fetch(req: Request): Promise<Response> {
      try {
        return await route(req)
      } catch (error) {
        if (error instanceof HttpError) return failure(error.status, error.kind, error.message)
        if (error instanceof BuildControlError || error instanceof OperatorControlError) {
          return failure(409, 'refusal', error.message, { code: error.code })
        }
        if (error instanceof BulkWalkError) {
          return failure(409, 'refusal', error.message, {
            code: 'bulk-partial',
            progress: error.progress,
          })
        }
        if (error instanceof OperatorQueryError) {
          return failure(
            error.code === 'not-found' ? 404 : 409,
            error.code === 'not-found' ? 'not-found' : 'conflict',
            error.message,
            { code: error.code },
          )
        }
        if (opts.onInternalError !== undefined) {
          try {
            await opts.onInternalError(error, req)
          } catch {
            // Diagnostics must never replace the protocol response.
          }
        }
        return failure(500, 'internal', 'operator API is unavailable')
      }
    },
  }
}
