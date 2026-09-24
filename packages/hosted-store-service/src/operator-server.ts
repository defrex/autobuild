import type { ZodType } from 'zod'
import { systemClock, type BuildStore, type Clock } from '@defrex/autobuild/plugin-sdk'
import {
  tokenResource,
  verifyToken,
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
} from '@defrex/autobuild/remote-store'
import {
  answerRequestSchema,
  buildControlRequestSchema,
  BuildControlError,
  type BuildControlAction,
  buildListScopeSchema,
  buildRegistry,
  bulkControlRequestSchema,
  bulkControlRepository,
  BulkWalkError,
  controlBuild,
  controlHarvestRun,
  effectiveStatus,
  getHarvestStatus,
  getOperatorBuild,
  getOperatorDashboard,
  getOperatorTicket,
  getRepositoryStatus,
  harvestControlRequestSchema,
  listOperatorBuilds,
  listOperatorTickets,
  mutateOperatorTicket,
  OperatorControlError,
  OperatorQueryError,
  reduceBuild,
  RegistryError,
  type OperatorToolRegistry,
  sessionApprovalRequestSchema,
  sessionCreateRequestSchema,
  sessionMessageRequestSchema,
  sessionWakeRequestSchema,
  setRepositorySetting,
  settingRequestSchema,
  type OperatorSandboxService,
  type OperatorTicketBackend,
  TicketOperationError,
  ticketBlockerRequestSchema,
  ticketCreateRequestSchema,
  ticketMoveRequestSchema,
  ticketUpdateRequestSchema,
  toggleHarvestGate,
  toggleRepositorySetting,
  type Via,
} from '@defrex/autobuild/operator'
import {
  answerOperatorApproval,
  archiveOperatorSession,
  createOperatorSession,
  getOperatorSession,
  listOperatorSessions,
  OperatorSessionError,
  postOperatorMessage,
  readOperatorTurnStream,
  setOperatorWake,
} from './operator-sessions'
import { reduceSession } from './session-reducer'
import { orchestratorConfig } from '@defrex/autobuild/operator'
import type { Config } from '@defrex/autobuild/operator'
import { orchestratorWakeGlobs, type OrchestratorTurnRunner } from '@defrex/autobuild/operator'

/** The request-scoped Vercel SDK credential the routes thread into the
 * sandbox backend composition (AUT-584): the same shape the hosted
 * dispatcher threads. A Vercel Function carries its OIDC token on the
 * request's `x-vercel-oidc-token` header, never in `process.env`. */
export interface OperatorRequestCredentials {
  oidcToken?: string
}

/** The embedded orchestrator's hosted wiring (AUT-342): a per-request turn
 * runner factory over the deployment's in-process registry, and the
 * background scheduler that lets a turn outlive the HTTP response. When the
 * option is absent the orchestrator is inert — message posting behaves
 * exactly as it did before this feature. */
export interface OperatorOrchestratorOptions {
  /** Build the turn runner for one repository under one resolved effective
   * config. Called only for enabled repositories on the start/resume paths.
   * The third parameter carries the request's Vercel OIDC token when the
   * request carried one (AUT-584); the runner's sandbox backend captures it
   * at creation for the background loop. May be async. */
  createRunner(
    config: Config,
    repo: string,
    credentials?: OperatorRequestCredentials,
  ): OrchestratorTurnRunner | Promise<OrchestratorTurnRunner>
  /** Schedule the turn loop to continue after the HTTP response resolves
   * (Next's `after()` in the machine route's request context). Default: a
   * fire-and-forget detached promise reporting failures through
   * `onInternalError`. */
  scheduleBackground(fn: () => Promise<void>): void
}

export interface OperatorServerOptions {
  store: BuildStore
  secret: string
  clock?: Clock
  /** Hosted ticket capability. Omitted deployments retain build-only operator routes. */
  ticketBackend?: OperatorTicketBackend
  /** Operator-sandbox backend (AUT-340): archiving an operator's last open
   * session for a repository releases their sandbox environment. The hosted
   * service does not pass one directly — it supplies `sandboxFor` (below).
   * When both are present `sandboxFor` wins. */
  sandbox?: OperatorSandboxService
  /** Per-request sandbox-backend resolution (AUT-584): the deployment's own
   * composition closure (the service owns the env, secret, and public origin
   * it needs). Resolved per archive request with the request's credentials;
   * `undefined` (disabled, unresolvable, or contained construction failure)
   * degrades only — no release, and the archive still succeeds. When set,
   * this wins over the static `sandbox` option. */
  sandboxFor?: (
    repo: string,
    credentials?: OperatorRequestCredentials,
  ) => Promise<OperatorSandboxService | undefined>
  /** The embedded orchestrator (AUT-342). Absent → inert. */
  orchestrator?: OperatorOrchestratorOptions
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

/** The registry failure kinds map onto HTTP statuses deterministically; the
 * failure body itself round-trips unchanged (same shape as every route's). */
export const REGISTRY_ERROR_STATUS: Record<string, number> = {
  validation: 400,
  auth: 403,
  'not-found': 404,
  conflict: 409,
  refusal: 409,
  internal: 500,
}

function json(status: number, value: unknown): Response {
  return Response.json(value, { status })
}

/** The request's Vercel OIDC token, when the invocation carried one (a Vercel
 * Function receives it as a header, never as process state). Blank is absent. */
function requestCredentials(req: Request): OperatorRequestCredentials | undefined {
  const oidcToken = req.headers.get('x-vercel-oidc-token')?.trim()
  return oidcToken ? { oidcToken } : undefined
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
  // The registry executes over the same store and ticket backend the typed
  // routes use; the generic tools route is its protocol face. Built once so
  // every tool call shares one closed table.
  const registry: OperatorToolRegistry = buildRegistry({
    store: opts.store,
    clock,
    ...(opts.ticketBackend !== undefined ? { tickets: opts.ticketBackend } : {}),
  })

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

  function operator(req: Request): { user: string; via?: Via } {
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
    return { user: scope.operator.user, via: scope.via }
  }

  async function requireRouteBuild(repo: string, slug: string): Promise<void> {
    const record = await opts.store.getBuild(slug)
    if (record === null || record.repo !== repo) {
      throw new HttpError(404, 'not-found', `unknown build "${slug}"`)
    }
  }

  /** The repository's orchestrator config: `null` when disabled or when no
   * orchestrator wiring exists; a `Config` when enabled. A deposited but
   * unreadable/invalid artifact throws `OrchestratorConfigError` — the outer
   * handler maps it to a 500 `internal`, never a silent disable. */
  async function resolveOrchestratorConfig(repo: string): Promise<Config | null> {
    if (opts.orchestrator === undefined) return null
    return orchestratorConfig(opts.store, repo)
  }

  /** Start a turn for a freshly posted message: only when the repository is
   * enabled and the session is idle. Awaits only `turn.started`; the loop
   * continues via `scheduleBackground`. Returns the turn/stream ids, or
   * undefined when no turn started. */
  async function startTurnForMessage(
    repo: string,
    sid: string,
    messageSeq: number,
    credentials?: OperatorRequestCredentials,
  ): Promise<{ turn: string; stream: string } | undefined> {
    const config = await resolveOrchestratorConfig(repo)
    if (config === null || opts.orchestrator === undefined) return undefined
    const state = reduceSession(await opts.store.getSessionEvents(sid))
    if (state.status !== 'idle') return undefined
    const runner = await opts.orchestrator.createRunner(config, repo, credentials)
    const start = await runner.startTurn(sid, { kind: 'message', messageSeq })
    if (!start.started || start.outcome === undefined) return undefined
    const outcome = start.outcome
    opts.orchestrator.scheduleBackground(async () => {
      await outcome
    })
    return { turn: start.turn!, stream: start.stream! }
  }

  /** Resume a turn whose approval was just answered in this same invocation;
   * the dispatcher tick is the fallback when this invocation dies. */
  async function resumeAnsweredApproval(
    repo: string,
    sid: string,
    turn: string,
    answer: { decision: 'approve' | 'deny'; toolCallId: string },
    credentials?: OperatorRequestCredentials,
  ): Promise<void> {
    const config = await resolveOrchestratorConfig(repo)
    if (config === null || opts.orchestrator === undefined) return
    const state = reduceSession(await opts.store.getSessionEvents(sid))
    if (state.status !== 'suspended' || state.suspendedCause !== 'approval') return
    if (state.openTurn === undefined || state.openTurn.turn !== turn) return
    const runner = await opts.orchestrator.createRunner(config, repo, credentials)
    const resumed = await runner.resumeTurn(sid, {
      approval: { decision: answer.decision, toolCallId: answer.toolCallId },
    })
    if (resumed.resumed && resumed.outcome !== undefined) {
      const outcome = resumed.outcome
      opts.orchestrator.scheduleBackground(async () => {
        await outcome
      })
    }
  }

  async function route(req: Request): Promise<Response> {
    identity(req)
    const scope = operator(req)
    const user = scope.user
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

    // The registry's protocol face: one generic route for the whole closed
    // table. The body IS the tool's validated input (repo included); the
    // registry enforces schema, identity, and failure mapping, so this route
    // adds no authority of its own and no per-tool branch.
    if (rest[0] === 'tools' && rest[1] && req.method === 'POST' && rest.length === 2) {
      const tool = rest[1]
      let input: unknown
      try {
        input = await req.json()
      } catch {
        throw new HttpError(400, 'validation', 'request body is not valid JSON')
      }
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw new HttpError(400, 'validation', 'tool input must be a JSON object')
      }
      const bodyRepo = (input as { repo?: unknown }).repo
      if (bodyRepo !== repo) {
        throw new HttpError(400, 'validation', `body repo must match the path repository "${repo}"`)
      }
      try {
        const result = await registry.call(tool, input, {
          identity: user,
          ...(scope.via !== undefined ? { via: scope.via } : {}),
        })
        return json(200, result)
      } catch (error) {
        if (error instanceof RegistryError) {
          // The failure body round-trips byte-for-byte: same kind union,
          // error text, code, and progress as a typed route's refusal.
          return failure(
            REGISTRY_ERROR_STATUS[error.body.kind] ?? 500,
            error.body.kind,
            error.body.error,
            {
              ...(error.body.code !== undefined ? { code: error.body.code } : {}),
              ...(error.body.progress !== undefined ? { progress: error.body.progress } : {}),
            },
          )
        }
        throw error
      }
    }

    if (rest[0] === 'tickets') {
      if (opts.ticketBackend === undefined) {
        throw new HttpError(409, 'conflict', 'ticket operator backend is not configured')
      }
      if (req.method === 'GET' && rest.length === 1) {
        const state = url.searchParams.get('state')
        const hasLabels = url.searchParams.has('label')
        return json(
          200,
          await listOperatorTickets({
            store: opts.store,
            repo,
            backend: opts.ticketBackend,
            ...(state !== null ? { state } : {}),
            ...(hasLabels ? { labels: url.searchParams.getAll('label') } : {}),
          }),
        )
      }
      if (req.method === 'POST' && rest.length === 1) {
        const request = await body(req, ticketCreateRequestSchema)
        return json(
          201,
          await mutateOperatorTicket({
            store: opts.store,
            repo,
            backend: opts.ticketBackend,
            operation: { kind: 'create', ...request },
          }),
        )
      }
      const id = rest[1]
      if (id && req.method === 'GET' && rest.length === 2) {
        return json(
          200,
          await getOperatorTicket({ store: opts.store, repo, backend: opts.ticketBackend, id }),
        )
      }
      if (id && req.method === 'PATCH' && rest.length === 2) {
        const patch = await body(req, ticketUpdateRequestSchema)
        return json(
          200,
          await mutateOperatorTicket({
            store: opts.store,
            repo,
            backend: opts.ticketBackend,
            operation: { kind: 'update', id, patch },
          }),
        )
      }
      if (id && req.method === 'POST' && rest.length === 3 && rest[2] === 'move') {
        const request = await body(req, ticketMoveRequestSchema)
        return json(
          200,
          await mutateOperatorTicket({
            store: opts.store,
            repo,
            backend: opts.ticketBackend,
            operation: { kind: 'move', id, state: request.state },
          }),
        )
      }
      if (
        id &&
        req.method === 'POST' &&
        rest.length === 3 &&
        (rest[2] === 'block' || rest[2] === 'unblock')
      ) {
        const request = await body(req, ticketBlockerRequestSchema)
        return json(
          200,
          await mutateOperatorTicket({
            store: opts.store,
            repo,
            backend: opts.ticketBackend,
            operation: { kind: rest[2], id, blockerIds: request.blockerIds },
          }),
        )
      }
    }

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

    if (rest[0] === 'sessions') {
      if (rest.length === 1) {
        if (req.method === 'GET') {
          return json(200, await listOperatorSessions(opts.store, repo))
        }
        if (req.method === 'POST') {
          const request = await body(req, sessionCreateRequestSchema)
          // A new session on an enabled repository inherits the configured
          // default wake set (the attention set unless the repo overrides
          // `wake`); disabled or absent → no wake-set fact (message-only).
          const resolved = await resolveOrchestratorConfig(repo)
          const record = await createOperatorSession(
            opts.store,
            repo,
            user,
            request.title,
            resolved === null ? undefined : orchestratorWakeGlobs(resolved.orchestrator),
          )
          return json(201, record)
        }
        throw new HttpError(404, 'not-found', `no route: ${req.method} ${url.pathname}`)
      }
      const sid = rest[1]!
      if (rest.length === 2 && req.method === 'GET') {
        return json(200, await getOperatorSession(opts.store, repo, sid))
      }
      if (req.method === 'POST' && rest.length === 3 && rest[2] === 'messages') {
        const request = await body(req, sessionMessageRequestSchema)
        const messageSeq = await postOperatorMessage(opts.store, repo, sid, user, request.text)
        // Same-invocation turn start (AUT-342): await only `turn.started`
        // (fast), return the turn and stream, and continue the agent loop as
        // background work. A message posted while a turn is open is durable
        // and enters the conversation at the next resume/turn — no second
        // turn (concurrent turns are out of scope).
        const turn = await startTurnForMessage(repo, sid, messageSeq, requestCredentials(req))
        return json(200, turn === undefined ? { ok: true } : { ok: true, ...turn })
      }
      if (req.method === 'PUT' && rest.length === 3 && rest[2] === 'wake') {
        const request = await body(req, sessionWakeRequestSchema)
        await setOperatorWake(opts.store, repo, sid, user, request.globs)
        return json(200, { ok: true })
      }
      if (req.method === 'POST' && rest.length === 3 && rest[2] === 'approvals') {
        const request = await body(req, sessionApprovalRequestSchema)
        await answerOperatorApproval(
          opts.store,
          repo,
          sid,
          user,
          request.turn,
          request.toolCallId,
          request.decision,
        )
        // Same-invocation resume of the answered approval; the dispatcher
        // tick is the fallback when this invocation dies.
        await resumeAnsweredApproval(repo, sid, request.turn, request, requestCredentials(req))
        return json(200, { ok: true })
      }
      if (req.method === 'POST' && rest.length === 3 && rest[2] === 'archive') {
        const sandbox = opts.sandboxFor
          ? await opts.sandboxFor(repo, requestCredentials(req))
          : opts.sandbox
        await archiveOperatorSession(opts.store, repo, sid, user, sandbox)
        return json(200, { ok: true })
      }
      if (
        req.method === 'GET' &&
        rest.length === 5 &&
        rest[2] === 'turns' &&
        rest[4] === 'stream'
      ) {
        const since = url.searchParams.get('since')
        const wait = url.searchParams.get('wait')
        let sinceSeq: number | undefined
        if (since !== null) {
          if (!/^[0-9]+$/.test(since)) {
            throw new HttpError(400, 'validation', 'since must be a nonnegative integer')
          }
          sinceSeq = Number(since)
        }
        let waitSeconds: number | undefined
        if (wait !== null) {
          if (!/^-?[0-9]+$/.test(wait)) {
            throw new HttpError(400, 'validation', 'wait must be an integer number of seconds')
          }
          waitSeconds = Number(wait)
        }
        return json(
          200,
          await readOperatorTurnStream(opts.store, repo, sid, rest[3]!, {
            ...(sinceSeq !== undefined ? { since: sinceSeq } : {}),
            ...(waitSeconds !== undefined ? { waitSeconds } : {}),
          }),
        )
      }
    }

    if (rest[0] === 'builds' && rest[1]) {
      const slug = rest[1]
      if (req.method === 'GET' && rest.length === 2) {
        return json(200, await getOperatorBuild({ store: opts.store, repo, slug, now: clock() }))
      }
      if (req.method === 'GET' && rest[2] === 'artifacts' && rest[3] && rest.length === 4) {
        const rawRev = url.searchParams.get('rev')
        let rev: number | undefined
        if (rawRev !== null) {
          if (!/^[0-9]+$/.test(rawRev)) {
            throw new HttpError(400, 'validation', 'rev must be a nonnegative integer')
          }
          rev = Number(rawRev)
          if (!Number.isSafeInteger(rev)) {
            throw new HttpError(400, 'validation', 'rev must be a nonnegative integer')
          }
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
        if (error instanceof TicketOperationError) {
          return failure(
            error.code === 'not-found' ? 404 : 409,
            error.code === 'not-found' ? 'not-found' : 'refusal',
            error.message,
            { code: error.code },
          )
        }
        if (error instanceof OperatorSessionError) {
          return failure(
            error.code === 'not-found' ? 404 : error.code === 'forbidden' ? 403 : 409,
            error.code === 'not-found'
              ? 'not-found'
              : error.code === 'forbidden'
                ? 'auth'
                : 'refusal',
            error.message,
          )
        }
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
