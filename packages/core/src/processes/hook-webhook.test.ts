import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import type { HookConfig } from '../config/schema'
import { hookInvoker, runWebhookHook, signHookBody, webhookRequest } from './hook-webhook'

const URL_WITH_QUERY = 'https://hooks.example/autobuild?token=query-secret'
const SECRET = 'whsec-sentinel'
const NOW = new Date('2026-11-17T10:00:00.250Z')
const LINE = '{"id":"c1.0","type":"escalation.raised"}\n'

const hook: { name: string; config: HookConfig } = {
  name: 'relay',
  config: { url: URL_WITH_QUERY, secretEnv: 'RELAY_SECRET', timeoutSeconds: 30 },
}

type Call = { url: string; init: RequestInit }

function fetchReturning(response: Response | Error, calls: Call[] = []) {
  return async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init })
    if (response instanceof Error) throw response
    return response
  }
}

function run(
  response: Response | Error,
  opts: { env?: Record<string, string | undefined>; signal?: AbortSignal; calls?: Call[] } = {},
) {
  return runWebhookHook(
    hook,
    LINE,
    opts.signal ?? new AbortController().signal,
    { id: 'c1.0' },
    {
      env: opts.env ?? { RELAY_SECRET: SECRET },
      clock: () => NOW,
      fetch: fetchReturning(response, opts.calls),
    },
  )
}

describe('webhook hooks', () => {
  test('the request is a signed JSON POST of the record line', () => {
    const { url, init } = webhookRequest(hook, { id: 'c1.0' }, LINE, SECRET, NOW)
    const body = '{"id":"c1.0","type":"escalation.raised"}'
    expect(url).toBe(URL_WITH_QUERY)
    expect(init).toEqual({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'autobuild-hook',
        'Autobuild-Hook': 'relay',
        'Autobuild-Delivery': 'c1.0',
        'Autobuild-Timestamp': '1794909600',
        'Autobuild-Signature': `v1=${createHmac('sha256', SECRET).update(`1794909600.${body}`).digest('hex')}`,
      },
      body,
    })
  })

  test('the documented test vector', () => {
    expect(signHookBody('example-secret', 1794909600, '{"id":"c1.0"}')).toBe(
      'v1=8c513d8d2b28c00d3c4f56b8afacc447ba1bd294e1df5f1b60b0ea1fe7d57a54',
    )
  })

  test('posts without following redirects and succeeds on 2xx', async () => {
    const calls: Call[] = []
    expect(await run(new Response(null, { status: 200 }), { calls })).toEqual({ ok: true })
    expect(await run(new Response('accepted', { status: 204 }))).toEqual({ ok: true })
    expect(calls[0]?.url).toBe(URL_WITH_QUERY)
    expect(calls[0]?.init.method).toBe('POST')
    expect(calls[0]?.init.redirect).toBe('manual')
    expect(calls[0]?.init.body).toBe('{"id":"c1.0","type":"escalation.raised"}')
  })

  test('any other outcome is a failure whose text carries no request or response detail', async () => {
    const results = [
      await run(new Response(`leaked ${SECRET}`, { status: 500 })),
      await run(new Response(null, { status: 404 })),
      await run(new Response(null, { status: 302, headers: { Location: 'https://elsewhere/' } })),
      await run(new TypeError(`Unable to connect to ${URL_WITH_QUERY}`)),
    ]
    expect(results).toEqual([
      { ok: false, error: 'HTTP 500' },
      { ok: false, error: 'HTTP 404' },
      { ok: false, error: 'redirect (HTTP 302) not followed' },
      { ok: false, error: 'request failed: TypeError: Unable to connect to <url>' },
    ])
    for (const result of results) {
      const text = JSON.stringify(result)
      expect(text).not.toContain(SECRET)
      expect(text).not.toContain('query-secret')
    }
  })

  test('a stopped attempt and a missing secret fail without throwing', async () => {
    const stopped = new AbortController()
    stopped.abort()
    const calls: Call[] = []
    expect(await run(new Response(null), { signal: stopped.signal, calls })).toEqual({
      ok: false,
      error: 'stopped',
    })
    expect(calls).toHaveLength(0)
    expect(await run(new Response(null), { env: {} })).toEqual({
      ok: false,
      error: 'signing secret variable RELAY_SECRET is unset or empty',
    })
  })

  test('the identity falls back to the record line', async () => {
    const calls: Call[] = []
    await runWebhookHook(hook, LINE, new AbortController().signal, undefined, {
      env: { RELAY_SECRET: SECRET },
      clock: () => NOW,
      fetch: fetchReturning(new Response(null), calls),
    })
    expect((calls[0]!.init.headers as Record<string, string>)['Autobuild-Delivery']).toBe('c1.0')
  })

  test('the dispatcher invoker routes url hooks to the webhook transport', async () => {
    const calls: Call[] = []
    const invoke = hookInvoker({
      checkout: '/nonexistent',
      env: { RELAY_SECRET: SECRET },
      clock: () => NOW,
      fetch: fetchReturning(new Response(null, { status: 202 }), calls),
    })
    expect(await invoke(hook, LINE, new AbortController().signal, { id: 'c1.0' })).toEqual({
      ok: true,
    })
    expect(calls).toHaveLength(1)
  })
})
