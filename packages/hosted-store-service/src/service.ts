import {
  openPostgresBuildStoreFromEnv,
  openPostgresTicketDatabase,
  type PostgresTicketDatabase,
} from '@autobuild/postgres-store'
import { createOperatorServer } from 'autobuild/operator-api'
import type { BuildStore, Clock, TicketSource } from 'autobuild/plugin-sdk'
import {
  createTicketServer,
  HOSTED_TICKET_OPERATIONS,
  type HostedTicketContext,
  LinearTicketSource,
} from 'autobuild/remote-tickets'
import {
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  createStoreServer,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
} from 'autobuild/remote-store'
import { HOSTED_ARTIFACT_MAX_BYTES, parseHostedStoreEnv, type HostedStoreEnv } from './config'

type HostedBackend = 'store' | 'tickets' | 'operator'

export interface HostedStoreErrorContext {
  backend: HostedBackend
  method: string
  pathname: string
}

export interface HostedStoreServiceOptions {
  env?: HostedStoreEnv
  clock?: Clock
  openStore?: (env: HostedStoreEnv, options: { clock?: Clock }) => Promise<BuildStore>
  /** Context-aware backend seam. Production chooses one deployment backend;
   * tests inject a fake while exercising the real authenticated protocol. */
  sourceFor?: (context: HostedTicketContext) => TicketSource | Promise<TicketSource>
  openTicketDatabase?: (
    url: string,
    lifecycle: { triage: string; ready: string; doing: string; done: string },
  ) => Promise<PostgresTicketDatabase>
  /** Receives original failures and safe request metadata. Never exposed to clients. */
  reportInternalError?: (
    error: unknown,
    context: HostedStoreErrorContext,
  ) => unknown | Promise<unknown>
}

const internalError = (): Response =>
  new Response(JSON.stringify({ error: 'hosted store is unavailable', kind: 'internal' }), {
    status: 500,
    headers: { 'content-type': 'application/json' },
  })

function notFound(req: Request, pathname: string): Response {
  return Response.json(
    { error: `no route: ${req.method} ${pathname}`, kind: 'not-found' },
    { status: 404 },
  )
}

const ticketOperations = new Set<string>(HOSTED_TICKET_OPERATIONS)
const storeResourceRoutes = new Set([
  'GET events',
  'POST events',
  'POST deposits',
  'GET artifacts',
  'POST artifacts',
  'GET artifact-list',
  'POST lease/claim',
  'POST lease/heartbeat',
  'POST lease/release',
])

/** Classify only route shapes implemented by the delegated protocol servers. */
function hostedBackend(req: Request, pathname: string): HostedBackend | undefined {
  let segments: string[]
  try {
    segments = pathname
      .split('/')
      .filter((part) => part.length > 0)
      .map(decodeURIComponent)
  } catch {
    return undefined
  }

  if (segments[0] === 'operator') {
    if (segments[1] !== 'v1' || segments[2] !== 'repos' || segments.length < 5) return undefined
    const rest = segments.slice(4)
    if (
      req.method === 'GET' &&
      rest.length === 1 &&
      (rest[0] === 'builds' || rest[0] === 'dashboard' || rest[0] === 'status')
    ) {
      return 'operator'
    }
    if (req.method === 'GET' && rest.join('/') === 'harvest/status') return 'operator'
    if (
      req.method === 'POST' &&
      (rest.join('/') === 'bulk-control' || rest.join('/') === 'harvest/control')
    ) {
      return 'operator'
    }
    const setting = rest[1] === 'intake' || rest[1] === 'auto-merge-default'
    if (rest[0] === 'settings' && setting) {
      if (req.method === 'PUT' && rest.length === 2) return 'operator'
      if (req.method === 'POST' && rest.length === 3 && rest[2] === 'toggle') return 'operator'
    }
    if (rest[0] === 'builds' && rest[1]) {
      if (req.method === 'GET' && rest.length === 2) return 'operator'
      if (req.method === 'GET' && rest.length === 4 && rest[2] === 'artifacts' && rest[3]) {
        return 'operator'
      }
      if (
        req.method === 'POST' &&
        rest.length === 3 &&
        (rest[2] === 'control' || rest[2] === 'answer')
      ) {
        return 'operator'
      }
    }
    return undefined
  }

  if (segments[0] === 'tickets') {
    return req.method === 'POST' && segments.length === 2 && ticketOperations.has(segments[1]!)
      ? 'tickets'
      : undefined
  }

  const root = segments[0]
  if (root !== 'builds' && root !== 'repos') return undefined
  if (segments.length === 1) {
    const allowed =
      root === 'builds' ? req.method === 'GET' || req.method === 'POST' : req.method === 'POST'
    return allowed ? 'store' : undefined
  }
  if (segments.length === 2) return req.method === 'GET' ? 'store' : undefined

  const route = `${req.method} ${segments.slice(2).join('/')}`
  if (root === 'builds' && route === 'POST events/conditional') return 'store'
  return storeResourceRoutes.has(route) ? 'store' : undefined
}

/** Host-neutral Fetch handler. Persistence opens once, on the first recognized machine request. */
export function createHostedStoreService(options: HostedStoreServiceOptions = {}): {
  fetch(req: Request): Promise<Response>
} {
  const env = options.env ?? process.env
  const opener = options.openStore ?? openPostgresBuildStoreFromEnv
  const ticketOpener = options.openTicketDatabase ?? openPostgresTicketDatabase
  const reporter =
    options.reportInternalError ??
    ((error: unknown, context: HostedStoreErrorContext) => {
      console.error('Hosted store internal error', context, error)
    })
  let storeHandlerPromise: Promise<(req: Request) => Promise<Response>> | undefined
  let ticketHandlerPromise: Promise<(req: Request) => Promise<Response>> | undefined
  const requestsWithInternalFailures = new WeakSet<Request>()

  const report = async (error: unknown, req: Request, backend: HostedBackend) => {
    try {
      await reporter(error, {
        backend,
        method: req.method,
        pathname: new URL(req.url).pathname,
      })
    } catch {
      // Diagnostics must never alter the public response.
    }
  }

  const reportProtocolFailure = (error: unknown, req: Request, backend: HostedBackend) => {
    requestsWithInternalFailures.add(req)
    return report(error, req, backend)
  }

  const openStoreHandler = () => {
    if (storeHandlerPromise === undefined) {
      const attempt = (async () => {
        const config = parseHostedStoreEnv(env)
        const store = await opener(env, options.clock === undefined ? {} : { clock: options.clock })
        const shared = options.clock === undefined ? {} : { clock: options.clock }
        const storeServer = createStoreServer({
          store,
          secret: config.secret,
          maxArtifactBytes: HOSTED_ARTIFACT_MAX_BYTES,
          onInternalError: (error, req) => reportProtocolFailure(error, req, 'store'),
          ...shared,
        })
        const operatorServer = createOperatorServer({
          store,
          secret: config.secret,
          onInternalError: (error, req) => reportProtocolFailure(error, req, 'operator'),
          ...shared,
        })
        return (req: Request) =>
          new URL(req.url).pathname.startsWith('/operator/v1/')
            ? operatorServer.fetch(req)
            : storeServer.fetch(req)
      })()
      storeHandlerPromise = attempt
      void attempt.catch(() => {
        if (storeHandlerPromise === attempt) storeHandlerPromise = undefined
      })
    }
    return storeHandlerPromise
  }

  const openTicketHandler = () => {
    ticketHandlerPromise ??= (async () => {
      const config = parseHostedStoreEnv(env)
      let sourceFor = options.sourceFor
      if (sourceFor === undefined && config.ticketBackend === 'database') {
        const database = await ticketOpener(config.postgres.url, config.ticketLifecycle)
        sourceFor = (context) => database.source(context)
      }
      if (sourceFor === undefined) {
        // The parser guarantees this credential for the linear backend. It is
        // captured here and is never represented in request context or output.
        const apiKey = config.linearApiKey!
        sourceFor = (context) =>
          new LinearTicketSource({
            apiKey,
            teamKey: context.teamKey,
            ...(context.claimedState !== undefined ? { claimedState: context.claimedState } : {}),
            ...(context.createState !== undefined ? { createState: context.createState } : {}),
          })
      }
      return createTicketServer({
        secret: config.secret,
        sourceFor,
        onInternalError: (error, req) => reportProtocolFailure(error, req, 'tickets'),
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      }).fetch
    })()
    return ticketHandlerPromise
  }

  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url)
      if (req.method === 'GET' && url.pathname === '/health') {
        return Response.json({
          ok: true,
          autobuildVersion: AUTOBUILD_VERSION,
          protocolVersion: REMOTE_STORE_PROTOCOL_VERSION,
        })
      }

      const backend = hostedBackend(req, url.pathname)
      if (backend === undefined) return notFound(req, url.pathname)

      const clientAutobuild = req.headers.get(AUTOBUILD_VERSION_HEADER)
      const clientProtocol = req.headers.get(REMOTE_STORE_PROTOCOL_VERSION_HEADER)
      if (
        clientAutobuild !== AUTOBUILD_VERSION ||
        clientProtocol !== REMOTE_STORE_PROTOCOL_VERSION
      ) {
        return Response.json(
          {
            error: `remote store version mismatch: client Autobuild ${clientAutobuild ?? '(missing)'} protocol ${clientProtocol ?? '(missing)'}; server Autobuild ${AUTOBUILD_VERSION} protocol ${REMOTE_STORE_PROTOCOL_VERSION}`,
            kind: 'conflict',
          },
          { status: 409 },
        )
      }

      try {
        const response =
          backend === 'tickets'
            ? await (await openTicketHandler())(req)
            : await (await openStoreHandler())(req)
        return response.status >= 500 && requestsWithInternalFailures.has(req)
          ? internalError()
          : response
      } catch (error) {
        await report(error, req, backend)
        return internalError()
      }
    },
  }
}
