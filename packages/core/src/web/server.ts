import { createWebHandler, type WebHandlerOptions } from './http'
import type { WebAssetManifest } from './protocol'

const assetsDir = new URL('./assets/', import.meta.url)

/** The committed client bundle's manifest. */
export async function loadWebManifest(): Promise<WebAssetManifest> {
  return (await Bun.file(new URL('manifest.json', assetsDir)).json()) as WebAssetManifest
}

export function readWebAsset(path: string): BodyInit {
  return Bun.file(new URL(path, assetsDir))
}

export interface StartedWebServer {
  url: string
  port: number
  stop(): Promise<void>
}

/** The URL a person opens: wildcard binds print loopback, IPv6 is bracketed. */
export function webServerUrl(hostname: string, port: number): string {
  const host = hostname === '0.0.0.0' || hostname === '::' ? '127.0.0.1' : hostname
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}/`
}

export class WebPortInUseError extends Error {
  constructor(hostname: string, port: number) {
    super(
      `ab web: port ${port} is already in use on ${hostname}; choose another --port, or omit it for a free port`,
    )
    this.name = 'WebPortInUseError'
  }
}

export async function startWebServer(
  opts: Omit<WebHandlerOptions, 'manifest' | 'readAsset'> &
    Partial<Pick<WebHandlerOptions, 'manifest' | 'readAsset'>> & {
      hostname: string
      port: number
    },
): Promise<StartedWebServer> {
  const handler = createWebHandler({
    ...opts,
    manifest: opts.manifest ?? (await loadWebManifest()),
    readAsset: opts.readAsset ?? readWebAsset,
  })
  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve({
      hostname: opts.hostname,
      port: opts.port,
      development: false,
      // Without this, Bun's production mode shares a taken port instead of
      // failing, and two servers would split one URL's requests.
      reusePort: false,
      fetch: (request, bun) => handler(request, bun),
      error: () =>
        new Response('ab web: internal error', {
          status: 500,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        }),
    })
  } catch (error) {
    const code = (error as { code?: unknown }).code
    const message = error instanceof Error ? error.message : String(error)
    if (code === 'EADDRINUSE' || /EADDRINUSE|address already in use|in use/i.test(message))
      throw new WebPortInUseError(opts.hostname, opts.port)
    throw error
  }
  const port = server.port ?? opts.port
  return {
    url: webServerUrl(opts.hostname, port),
    port,
    stop: () => server.stop(true),
  }
}
