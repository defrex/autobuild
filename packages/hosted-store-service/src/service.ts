import {
  openPostgresBuildStoreFromEnv,
  openPostgresTicketDatabase,
  type PostgresTicketDatabase,
} from '@autobuild/postgres-store'
import type { BuildStore, Clock, TicketSource } from 'autobuild/plugin-sdk'
import {
  createTicketServer,
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
}

const internalError = (): Response =>
  new Response(JSON.stringify({ error: 'hosted store is unavailable', kind: 'internal' }), {
    status: 500,
    headers: { 'content-type': 'application/json' },
  })

/** Host-neutral Fetch handler. Persistence opens once, on the first machine request. */
export function createHostedStoreService(options: HostedStoreServiceOptions = {}): {
  fetch(req: Request): Promise<Response>
} {
  const env = options.env ?? process.env
  const opener = options.openStore ?? openPostgresBuildStoreFromEnv
  const ticketOpener = options.openTicketDatabase ?? openPostgresTicketDatabase
  let storeHandlerPromise: Promise<(req: Request) => Promise<Response>> | undefined
  let ticketHandlerPromise: Promise<(req: Request) => Promise<Response>> | undefined

  const openStoreHandler = () => {
    if (storeHandlerPromise === undefined) {
      const attempt = (async () => {
        const config = parseHostedStoreEnv(env)
        let store: BuildStore
        try {
          store = await opener(env, options.clock === undefined ? {} : { clock: options.clock })
        } catch {
          throw new Error('hosted store is unavailable')
        }
        return createStoreServer({
          store,
          secret: config.secret,
          maxArtifactBytes: HOSTED_ARTIFACT_MAX_BYTES,
          ...(options.clock === undefined ? {} : { clock: options.clock }),
        }).fetch
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
      if (
        url.pathname.startsWith('/builds') ||
        url.pathname.startsWith('/repos') ||
        url.pathname.startsWith('/tickets')
      ) {
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
      }
      try {
        return url.pathname.startsWith('/tickets')
          ? await (await openTicketHandler())(req)
          : await (await openStoreHandler())(req)
      } catch {
        return internalError()
      }
    },
  }
}
