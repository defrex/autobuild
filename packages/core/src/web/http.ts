import { BuildFeedValidationError } from '../store/build-feed'
import {
  AnalyticsQueryError,
  parseAnalyticsQuery,
  type WebAnalyticsSource,
} from './analytics-source'
import type { WebModelHub } from './hub'
import { renderPage } from './page'
import { PAGE_FRAME_WAIT_MS, WEB_EVENTS, type WebAssetManifest } from './protocol'

/** The comment line that keeps an idle event stream open through proxies. */
export const HEARTBEAT_MS = 15_000

export interface HeartbeatTimer {
  set(callback: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realHeartbeat: HeartbeatTimer = {
  set: (callback, ms) => setInterval(callback, ms),
  clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
}

const realTimeout: HeartbeatTimer = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface WebHandlerOptions {
  hub: WebModelHub
  repositoryLabel: string
  manifest: WebAssetManifest
  /** Body of a manifest file; only called for names the manifest lists. */
  readAsset(path: string): BodyInit
  /** Host names a request may address, or `any` when `--host` widened the bind. */
  allowedHosts: ReadonlySet<string> | 'any'
  nonce?: () => string
  heartbeat?: HeartbeatTimer
  /** How long a page request waits for the hub's first frame, and the timer
   * that bounds it. Defaults to `PAGE_FRAME_WAIT_MS` on real timers. */
  pageWait?: { ms: number; timer: HeartbeatTimer }
  /** The analytics and timeline reads; absent, or answering undefined while
   * a dispatcher's store is not open yet, makes those routes answer 503. */
  analytics?: () => WebAnalyticsPort | undefined
}

/** What the JSON routes call: `WebAnalyticsSource`, or a test double. */
export type WebAnalyticsPort = Pick<WebAnalyticsSource, 'analytics' | 'timeline'>

/** The slice of Bun's server the handler uses. */
export interface WebServerHandle {
  timeout(request: Request, seconds: number): void
}

export type WebHandler = (
  request: Request,
  server?: WebServerHandle,
) => Response | Promise<Response>

export function mintNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64')
}

/** The Host header's name: port stripped, IPv6 unbracketed, lowercased. */
export function requestHostName(host: string | null): string | undefined {
  if (host === null || host === '') return undefined
  const value = host.trim().toLowerCase()
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end > 0 ? value.slice(1, end) : undefined
  }
  const colon = value.indexOf(':')
  if (colon === -1) return value
  // A bare IPv6 address without brackets carries no port.
  return value.indexOf(':', colon + 1) === -1 ? value.slice(0, colon) : value
}

/** The hosts a loopback server answers to. */
export function loopbackHosts(bindHost: string): ReadonlySet<string> {
  return new Set([requestHostName(bindHost) ?? bindHost, 'localhost', '127.0.0.1'])
}

const common = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }

export function pageCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `style-src 'self' 'nonce-${nonce}'`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}

function pageHeaders(nonce: string): HeadersInit {
  return {
    ...common,
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': pageCsp(nonce),
  }
}

function assetHeaders(type: string): HeadersInit {
  return { ...common, 'Content-Type': type, 'Cache-Control': 'no-cache' }
}

function eventHeaders(): HeadersInit {
  return {
    ...common,
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  }
}

function json(status: number, body: unknown, head = false): Response {
  return new Response(head ? null : JSON.stringify(body), {
    status,
    headers: { ...common, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

const API_PREFIX = '/api/'
const TIMELINE_ROUTE = /^\/api\/builds\/([^/]+)\/timeline$/u

/**
 * The read-only JSON routes. `HEAD` builds headers only and reads nothing.
 * Validation failures answer 400, an unknown build or route 404, a server
 * without a store 503, and any store failure, including a typed remote
 * incompatibility, 502 with its message: nothing falls back to another read.
 */
async function api(
  url: URL,
  head: boolean,
  source: (() => WebAnalyticsPort | undefined) | undefined,
): Promise<Response> {
  const path = url.pathname
  const timeline = TIMELINE_ROUTE.exec(path)
  let slug: string | undefined
  if (timeline !== null) {
    try {
      slug = decodeURIComponent(timeline[1]!)
    } catch {
      return json(404, { error: 'not found' }, head)
    }
    if (slug === '') return json(404, { error: 'not found' }, head)
  } else if (path !== '/api/analytics') return json(404, { error: 'not found' }, head)
  const reads = source?.()
  if (reads === undefined)
    return json(503, { error: 'Analytics are unavailable until the store is open.' }, head)
  try {
    if (slug === undefined) {
      const query = parseAnalyticsQuery(url.searchParams)
      if (head) return json(200, null, true)
      return json(200, await reads.analytics(query))
    }
    if (head) return json(200, null, true)
    const row = await reads.timeline(slug)
    return row === null ? json(404, { error: `no build ${slug}` }) : json(200, { row })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof AnalyticsQueryError || error instanceof BuildFeedValidationError)
      return json(400, { error: message }, head)
    return json(502, { error: `Store read failed: ${message}` })
  }
}

function text(status: number, body: string, extra: HeadersInit = {}): Response {
  return new Response(body, {
    status,
    headers: { ...common, 'Content-Type': 'text/plain; charset=utf-8', ...extra },
  })
}

/**
 * The read-only request handler: the page, the committed assets, one event
 * stream and the analytics JSON routes. Only `GET` and `HEAD` are accepted, and `HEAD` builds
 * headers only, so it never reads an asset or joins the refresh loop.
 */
export function createWebHandler(opts: WebHandlerOptions): WebHandler {
  const nonce = opts.nonce ?? mintNonce
  const heartbeat = opts.heartbeat ?? realHeartbeat
  const pageWait = opts.pageWait ?? { ms: PAGE_FRAME_WAIT_MS, timer: realTimeout }
  const assets = new Map(opts.manifest.files.map((file) => [file.path, file.type]))

  return (request, server) => {
    if (opts.allowedHosts !== 'any') {
      const host = requestHostName(request.headers.get('host'))
      if (host === undefined || !opts.allowedHosts.has(host))
        return text(403, `ab web refuses Host ${host ?? '(none)'}; open the printed URL`)
    }
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return text(405, 'ab web is read-only', { Allow: 'GET, HEAD' })
    const head = request.method === 'HEAD'
    const url = new URL(request.url)
    const path = url.pathname

    if (path.startsWith(API_PREFIX)) return api(url, head, opts.analytics)

    if (path.startsWith('/assets/')) {
      let name: string
      try {
        name = decodeURIComponent(path.slice('/assets/'.length))
      } catch {
        return text(404, 'not found')
      }
      const type = assets.get(name)
      if (type === undefined) return text(404, 'not found')
      return new Response(head ? null : opts.readAsset(name), { headers: assetHeaders(type) })
    }

    if (path === '/events') {
      if (head) return new Response(null, { headers: eventHeaders() })
      return eventStream(request, server, opts.hub, heartbeat)
    }

    const minted = nonce()
    if (head) return new Response(null, { headers: pageHeaders(minted) })
    const page = (frame: string | undefined) =>
      new Response(
        renderPage({
          nonce: minted,
          repositoryLabel: opts.repositoryLabel,
          manifest: opts.manifest,
          ...(frame !== undefined ? { frame } : {}),
        }),
        { headers: pageHeaders(minted) },
      )
    const held = opts.hub.current
    if (held !== undefined) return page(held)
    return firstFrame(opts.hub, pageWait, request.signal).then(page)
  }
}

/**
 * The hub's first frame, for a page request that arrives before it has one.
 * Subscribing joins or starts the hub's one shared read, the same read the
 * page's event stream starts a moment later. The hub delivers a frame for
 * every finished read, data or its failure notice, so the wait ends at that
 * frame; the bound covers only a hung read, and an aborted request stops
 * waiting. Every path unsubscribes.
 */
function firstFrame(
  hub: WebModelHub,
  wait: { ms: number; timer: HeartbeatTimer },
  signal: AbortSignal,
): Promise<string | undefined> {
  if (signal.aborted) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    let settled = false
    let unsubscribe: (() => void) | undefined
    let timer: unknown
    const finish = (frame: string | undefined) => {
      if (settled) return
      settled = true
      unsubscribe?.()
      if (timer !== undefined) wait.timer.clear(timer)
      signal.removeEventListener('abort', abort)
      resolve(frame)
    }
    const abort = () => finish(undefined)
    signal.addEventListener('abort', abort)
    unsubscribe = hub.subscribe((json) => finish(json))
    if (settled) unsubscribe()
    else timer = wait.timer.set(() => finish(undefined), wait.ms)
  })
}

function eventStream(
  request: Request,
  server: WebServerHandle | undefined,
  hub: WebModelHub,
  heartbeat: HeartbeatTimer,
): Response {
  // Bun closes a connection idle for 10 s by default; a stream must outlive that.
  server?.timeout(request, 0)
  const encoder = new TextEncoder()
  let cleanup: (() => void) | undefined
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (request.signal.aborted) {
        controller.close()
        return
      }
      let done = false
      let unsubscribe: (() => void) | undefined
      let timer: unknown
      const finish = () => {
        if (done) return
        done = true
        unsubscribe?.()
        if (timer !== undefined) heartbeat.clear(timer)
        request.signal.removeEventListener('abort', finish)
      }
      cleanup = finish
      const send = (chunk: string) => {
        if (done) return
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          finish()
        }
      }
      request.signal.addEventListener('abort', finish)
      unsubscribe = hub.subscribe((json) => send(`event: ${WEB_EVENTS.model}\ndata: ${json}\n\n`))
      if (done) unsubscribe()
      else timer = heartbeat.set(() => send(': keep-alive\n\n'), HEARTBEAT_MS)
    },
    cancel() {
      cleanup?.()
    },
  })
  return new Response(body, { headers: eventHeaders() })
}
