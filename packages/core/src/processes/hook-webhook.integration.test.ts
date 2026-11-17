import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { HookConfig } from '../config/schema'
import { runWebhookHook } from './hook-webhook'

const SECRET = 'loopback-secret'
const LINE = '{"id":"repo:7","type":"ticket.handed-back"}\n'

/** The receiver algorithm `docs/configuration.md` documents. */
function verify(request: { headers: Headers; body: string }, now: number): boolean {
  const timestamp = request.headers.get('autobuild-timestamp') ?? ''
  const signature = request.headers.get('autobuild-signature') ?? ''
  const expected = `v1=${createHmac('sha256', SECRET).update(`${timestamp}.${request.body}`).digest('hex')}`
  const fresh = Math.abs(now - Number(timestamp)) <= 300
  return (
    fresh &&
    signature.length === expected.length &&
    timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  )
}

describe('webhook hooks over loopback', () => {
  let server: ReturnType<typeof Bun.serve>
  const received: { path: string; headers: Headers; body: string }[] = []

  beforeAll(() => {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        received.push({ path, headers: request.headers, body: await request.text() })
        if (path === '/redirect')
          return new Response(null, { status: 302, headers: { Location: '/target' } })
        if (path === '/hang') return new Promise<Response>(() => {})
        return new Response('ok')
      },
    })
  })
  afterAll(() => server.stop(true))

  const hook = (path: string, timeoutSeconds = 30): { name: string; config: HookConfig } => ({
    name: 'relay',
    config: {
      url: `http://127.0.0.1:${server.port}${path}`,
      secretEnv: 'RELAY_SECRET',
      timeoutSeconds,
    },
  })
  const deliver = (path: string, timeoutSeconds?: number) =>
    runWebhookHook(hook(path, timeoutSeconds), LINE, new AbortController().signal, undefined, {
      env: { RELAY_SECRET: SECRET },
      clock: () => new Date(),
    })

  test('delivers a record the documented receiver verifies', async () => {
    received.length = 0
    expect(await deliver('/hook')).toEqual({ ok: true })
    expect(received).toHaveLength(1)
    const request = received[0]!
    expect(request.body).toBe(LINE.trimEnd())
    expect(request.headers.get('autobuild-delivery')).toBe('repo:7')
    expect(request.headers.get('content-type')).toBe('application/json')
    expect(verify(request, Math.floor(Date.now() / 1000))).toBe(true)
    expect(verify({ ...request, body: `${request.body} ` }, Math.floor(Date.now() / 1000))).toBe(
      false,
    )
  })

  test('does not follow a redirect', async () => {
    received.length = 0
    expect(await deliver('/redirect')).toEqual({
      ok: false,
      error: 'redirect (HTTP 302) not followed',
    })
    expect(received.map((request) => request.path)).toEqual(['/redirect'])
  })

  test('fails a receiver that does not answer within the timeout', async () => {
    expect(await deliver('/hang', 1)).toEqual({ ok: false, error: 'timed out after 1s' })
  })

  test('fails a closed port without naming the endpoint', async () => {
    const closed = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
    const port = closed.port
    await closed.stop(true)
    const result = await runWebhookHook(
      {
        name: 'relay',
        config: {
          url: `http://127.0.0.1:${port}/hook?key=query-secret`,
          secretEnv: 'RELAY_SECRET',
          timeoutSeconds: 5,
        },
      },
      LINE,
      new AbortController().signal,
      undefined,
      { env: { RELAY_SECRET: SECRET }, clock: () => new Date() },
    )
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toStartWith('request failed: ')
    expect(JSON.stringify(result)).not.toContain('query-secret')
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })
})
