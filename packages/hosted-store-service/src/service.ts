import { openPostgresBuildStoreFromEnv } from '@autobuild/postgres-store'
import type { BuildStore, Clock } from 'autobuild/plugin-sdk'
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
  let handlerPromise: Promise<(req: Request) => Promise<Response>> | undefined

  const openHandler = (): Promise<(req: Request) => Promise<Response>> => {
    handlerPromise ??= (async () => {
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
    return handlerPromise
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
      if (url.pathname.startsWith('/builds') || url.pathname.startsWith('/repos')) {
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
        return await (await openHandler())(req)
      } catch {
        return internalError()
      }
    },
  }
}
