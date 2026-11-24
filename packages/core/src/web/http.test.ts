import { expect, test } from 'bun:test'
import { createWebHandler, loopbackHosts, requestHostName, type WebHandlerOptions } from './http'
import { WebModelHub } from './hub'
import type { WebAssetManifest, WebFrameSource } from './protocol'
import { FakeRefreshScheduler } from '../testing/refresh-scheduler'

const manifest: WebAssetManifest = {
  files: [
    { path: 'app.js', type: 'text/javascript; charset=utf-8' },
    { path: 'app.css', type: 'text/css; charset=utf-8' },
    { path: 'theme.js', type: 'text/javascript; charset=utf-8' },
    { path: 'sans.woff2', type: 'font/woff2' },
  ],
  script: 'app.js',
  stylesheet: 'app.css',
  themeScript: 'theme.js',
  fonts: ['sans.woff2'],
}

function setup(overrides: Partial<WebHandlerOptions> = {}) {
  const source = { reads: 0 }
  const frameSource: WebFrameSource = {
    read: async () => {
      source.reads++
      return { frame: { notice: 'hello' }, live: false }
    },
  }
  const hub = new WebModelHub({
    source: frameSource,
    networkReads: false,
    scheduler: new FakeRefreshScheduler(),
  })
  const timers = new Set<number>()
  let nextTimer = 0
  const ticks = new Map<number, () => void>()
  const assetReads: string[] = []
  const timeouts: number[] = []
  const handler = createWebHandler({
    hub,
    repositoryLabel: 'github.com/acme/<app>',
    manifest,
    readAsset: (path) => {
      assetReads.push(path)
      return `body of ${path}`
    },
    allowedHosts: loopbackHosts('127.0.0.1'),
    heartbeat: {
      set: (callback) => {
        const id = ++nextTimer
        timers.add(id)
        ticks.set(id, callback)
        return id
      },
      clear: (handle) => {
        timers.delete(handle as number)
      },
    },
    ...overrides,
  })
  const server = { timeout: (_: Request, seconds: number) => void timeouts.push(seconds) }
  const request = (path: string, init: RequestInit & { host?: string | null } = {}) => {
    const headers = new Headers(init.headers)
    if (init.host !== null) headers.set('host', init.host ?? '127.0.0.1:4173')
    return handler(new Request(`http://127.0.0.1:4173${path}`, { ...init, headers }), server)
  }
  return { hub, source, timers, ticks, assetReads, timeouts, request }
}

test('host names parse with ports, brackets and case', () => {
  expect(requestHostName('127.0.0.1:4173')).toBe('127.0.0.1')
  expect(requestHostName('LocalHost:80')).toBe('localhost')
  expect(requestHostName('[::1]:4173')).toBe('::1')
  expect(requestHostName('example.test')).toBe('example.test')
  expect(requestHostName(null)).toBeUndefined()
})

test('loopback names and the bind host are accepted; others are refused', async () => {
  const { request } = setup()
  for (const host of ['127.0.0.1:4173', 'localhost:4173', 'localhost'])
    expect((await request('/', { host })).status).toBe(200)
  const evil = await request('/', { host: 'evil.example:4173' })
  expect(evil.status).toBe(403)
  expect(await evil.text()).toContain('ab web refuses Host evil.example')
  expect((await request('/', { host: null })).status).toBe(403)
  const v6 = setup({ allowedHosts: loopbackHosts('::1') })
  expect((await v6.request('/', { host: '[::1]:4173' })).status).toBe(200)
})

test('a widened bind accepts any host', async () => {
  const { request } = setup({ allowedHosts: 'any' })
  expect((await request('/', { host: 'build-box.lan:4173' })).status).toBe(200)
})

test('the page carries a fresh CSP nonce that matches its meta tag', async () => {
  const { request } = setup()
  const nonces: string[] = []
  for (let i = 0; i < 2; i++) {
    const response = await request('/')
    const csp = response.headers.get('content-security-policy')!
    expect(csp.startsWith("default-src 'self'; style-src 'self' 'nonce-")).toBe(true)
    const nonce = /'nonce-([^']+)'/.exec(csp)![1]!
    const html = await response.text()
    expect(html).toContain(`<meta property="csp-nonce" nonce="${nonce}">`)
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('cache-control')).toBe('no-store')
    nonces.push(nonce)
  }
  expect(nonces[0]).not.toBe(nonces[1])
})

test('the page loads only same-origin assets and escapes the label', async () => {
  const html = await (await setup().request('/builds/anything')).text()
  const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]!)
  expect(urls.length).toBeGreaterThan(2)
  for (const url of urls) expect(url.startsWith('/assets/')).toBe(true)
  expect(html).toContain('content="github.com/acme/&lt;app&gt;"')
  expect(html).not.toContain('<style')
  expect(html).not.toMatch(/<script>/)
})

test('writes are refused on every path', async () => {
  const { request, assetReads, hub } = setup()
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH'])
    for (const path of ['/', '/events', '/assets/app.js']) {
      const response = await request(path, { method })
      expect(response.status).toBe(405)
      expect(response.headers.get('allow')).toBe('GET, HEAD')
    }
  expect(assetReads).toEqual([])
  expect(hub.subscribers).toBe(0)
})

test('assets come only from the manifest', async () => {
  const { request, assetReads } = setup()
  const js = await request('/assets/app.js')
  expect(js.status).toBe(200)
  expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
  expect(js.headers.get('cache-control')).toBe('no-cache')
  expect(await js.text()).toBe('body of app.js')
  expect((await request('/assets/manifest.json')).status).toBe(404)
  expect((await request('/assets/..%2fhttp.ts')).status).toBe(404)
  expect((await request('/assets/%E0%A4%A')).status).toBe(404)
  expect(assetReads).toEqual(['app.js'])
})

test('HEAD /events sends the stream headers and never joins the loop', async () => {
  const { request, hub, timers, source, timeouts } = setup()
  const response = await request('/events', { method: 'HEAD' })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('text/event-stream')
  expect(response.body).toBeNull()
  await hub.join()
  expect(hub.subscribers).toBe(0)
  expect(timers.size).toBe(0)
  expect(source.reads).toBe(0)
  expect(timeouts).toEqual([])
})

test('HEAD on the page and an asset builds headers only', async () => {
  const { request, assetReads } = setup()
  const page = await request('/', { method: 'HEAD' })
  expect(page.body).toBeNull()
  expect(page.headers.get('content-security-policy')).toContain("default-src 'self'")
  const asset = await request('/assets/app.css', { method: 'HEAD' })
  expect(asset.body).toBeNull()
  expect(asset.headers.get('content-type')).toBe('text/css; charset=utf-8')
  expect(assetReads).toEqual([])
})

test('the event stream sends the model, keeps alive, and unsubscribes on cancel', async () => {
  const { request, hub, timers, ticks, timeouts } = setup()
  const response = await request('/events')
  expect(response.headers.get('content-type')).toBe('text/event-stream')
  expect(timeouts).toEqual([0])
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  expect(hub.subscribers).toBe(1)
  await hub.join()
  expect(decoder.decode((await reader.read()).value)).toBe(
    `event: model\ndata: ${JSON.stringify({ notice: 'hello' })}\n\n`,
  )
  expect(timers.size).toBe(1)
  for (const tick of ticks.values()) tick()
  expect(decoder.decode((await reader.read()).value)).toBe(': keep-alive\n\n')
  await reader.cancel()
  expect(hub.subscribers).toBe(0)
  expect(timers.size).toBe(0)
})

test('an aborted request unsubscribes, and an already aborted one never subscribes', async () => {
  const { request, hub, timers } = setup()
  const controller = new AbortController()
  const response = await request('/events', { signal: controller.signal })
  expect(response.body).not.toBeNull()
  expect(hub.subscribers).toBe(1)
  controller.abort()
  expect(hub.subscribers).toBe(0)
  expect(timers.size).toBe(0)
  const gone = new AbortController()
  gone.abort()
  const late = await request('/events', { signal: gone.signal })
  expect(late.body).not.toBeNull()
  expect(hub.subscribers).toBe(0)
  expect(timers.size).toBe(0)
})
