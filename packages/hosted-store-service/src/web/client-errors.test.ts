import { describe, expect, test } from 'bun:test'
import { AUTOBUILD_VERSION } from '@defrex/autobuild/remote-store'
import { MemoryBuildStore } from '@defrex/autobuild/plugin-sdk'
import { countStoreRequests } from '@defrex/autobuild/testing'
import { createHostedStoreService } from '../service'
import {
  BROWSER_ERROR_ENDPOINT,
  BROWSER_ERROR_LIMITS,
  BROWSER_ERROR_MARKER,
  browserErrorBootstrap,
  deploymentIdentity,
  handleBrowserErrorReport,
} from './client-errors'

const report = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: 'error',
    message: 'ReferenceError: Bun is not defined',
    stack: 'ReferenceError: Bun is not defined\n    at /_next/static/chunks/a.js:62:130626',
    path: '/dashboard',
    deployment: 'dpl_client',
    ...overrides,
  })

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request(`https://ops.example${BROWSER_ERROR_ENDPOINT}`, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json', 'user-agent': 'TestAgent/1.0', ...headers },
  })

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 4096) controller.enqueue(bytes.slice(i, i + 4096))
      controller.close()
    },
  })
}

describe('POST /client-errors through the hosted service', () => {
  test('logs one line per report and reads no store, ticket, auth or registry rows', async () => {
    const store = new MemoryBuildStore()
    await store.createBuild({ slug: 'seeded', repo: 'acme/app' })
    const opened: Record<string, number> = {}
    const counted =
      <T>(name: string, value: () => T) =>
      async () => {
        opened[name] = (opened[name] ?? 0) + 1
        return value()
      }
    const lines: string[] = []
    const service = createHostedStoreService({
      env: { AB_STORE_SECRET: 'secret', VERCEL_DEPLOYMENT_ID: 'dpl_server' },
      openStore: counted('store', () => store),
      openProjectRegistry: counted('projects', () => {
        throw new Error('registry opened')
      }),
      openCredentials: counted('credentials', () => {
        throw new Error('credentials opened')
      }),
      openSecrets: counted('secrets', () => {
        throw new Error('secrets opened')
      }),
      openTicketDatabase: counted('tickets', () => {
        throw new Error('tickets opened')
      }),
      openTicketPolicy: counted('policy', () => {
        throw new Error('policy opened')
      }),
      openTicketGrants: counted('grants', () => {
        throw new Error('grants opened')
      }),
      logBrowserError: (line) => lines.push(line),
    })

    const statuses: number[] = []
    const requests = await countStoreRequests(store, async () => {
      // No authorization header and no cookie: reports need no session.
      statuses.push((await service.fetch(post(report()))).status)
      statuses.push(
        (await service.fetch(post(report({ kind: 'unhandledrejection', message: 'second' }))))
          .status,
      )
    })

    expect(statuses).toEqual([204, 204])
    expect(requests).toEqual({})
    expect(opened).toEqual({})
    expect(lines).toHaveLength(2)
    const line = JSON.parse(lines[0]!)
    expect(line).toEqual({
      type: BROWSER_ERROR_MARKER,
      kind: 'error',
      message: 'ReferenceError: Bun is not defined',
      stack: 'ReferenceError: Bun is not defined\n    at /_next/static/chunks/a.js:62:130626',
      path: '/dashboard',
      userAgent: 'TestAgent/1.0',
      deployment: 'dpl_client',
      serverDeployment: 'dpl_server',
    })
    expect(JSON.parse(lines[1]!).kind).toBe('unhandledrejection')
  })
})

describe('handleBrowserErrorReport', () => {
  const handle = async (req: Request) => {
    const lines: string[] = []
    const response = await handleBrowserErrorReport(req, {
      log: (line) => lines.push(line),
      serverDeployment: 'dpl_server',
    })
    return { response, lines, text: await response.text() }
  }

  test('truncates every field to its bound', async () => {
    const { response, lines } = await handle(
      post(
        report({
          message: 'm'.repeat(2_000),
          stack: 's'.repeat(9_000),
          path: `/${'p'.repeat(600)}`,
          deployment: 'd'.repeat(200),
        }),
        { 'user-agent': 'u'.repeat(600) },
      ),
    )
    expect(response.status).toBe(204)
    const line = JSON.parse(lines[0]!)
    expect(line.message).toHaveLength(BROWSER_ERROR_LIMITS.message)
    expect(line.stack).toHaveLength(BROWSER_ERROR_LIMITS.stack)
    expect(line.path).toHaveLength(BROWSER_ERROR_LIMITS.path)
    expect(line.userAgent).toHaveLength(BROWSER_ERROR_LIMITS.userAgent)
    expect(line.deployment).toHaveLength(BROWSER_ERROR_LIMITS.deployment)
  })

  const sentinel = 'SENTINEL-7f3a91'
  const rejected: [string, () => Request, number][] = [
    ['non-JSON', () => post(`not json ${sentinel}`), 400],
    ['an unknown kind', () => post(report({ kind: sentinel })), 400],
    ['a missing message', () => post(report({ message: undefined, path: sentinel })), 400],
    [
      'an oversized body with content-length',
      () => post(report({ stack: `${sentinel}${'x'.repeat(20_000)}` })),
      413,
    ],
    [
      'an oversized streamed body without content-length',
      () => post(streamOf(report({ stack: `${sentinel}${'x'.repeat(20_000)}` }))),
      413,
    ],
  ]
  for (const [name, request, status] of rejected) {
    test(`rejects ${name} without logging or echoing it`, async () => {
      const req = request()
      if (name.includes('without content-length'))
        expect(req.headers.get('content-length')).toBeNull()
      const { response, lines, text } = await handle(req)
      expect(response.status).toBe(status)
      expect(lines).toEqual([])
      expect(text).not.toContain(sentinel)
      expect(text).not.toContain('SENTINEL')
    })
  }

  test('a failing log sink answers a fixed 500', async () => {
    const response = await handleBrowserErrorReport(post(report({ message: sentinel })), {
      log: () => {
        throw new Error(sentinel)
      },
      serverDeployment: 'dpl_server',
    })
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain(sentinel)
  })
})

test('deploymentIdentity prefers deployment ids, then the commit, then the version', () => {
  expect(
    deploymentIdentity({
      VERCEL_DEPLOYMENT_ID: 'dpl_a',
      NEXT_DEPLOYMENT_ID: 'next_b',
      VERCEL_GIT_COMMIT_SHA: 'abc',
    }),
  ).toBe('dpl_a')
  expect(deploymentIdentity({ NEXT_DEPLOYMENT_ID: 'next_b', VERCEL_GIT_COMMIT_SHA: 'abc' })).toBe(
    'next_b',
  )
  expect(deploymentIdentity({ VERCEL_DEPLOYMENT_ID: ' ', VERCEL_GIT_COMMIT_SHA: 'abc' })).toBe(
    'abc',
  )
  expect(deploymentIdentity({})).toBe(AUTOBUILD_VERSION)
})

type Listener = (event: unknown) => void

function fakeWindow(
  options: { beacon?: (url: string, body: unknown) => boolean; fetch?: () => unknown } = {},
) {
  const listeners: Record<string, Listener[]> = {}
  const beacons: string[] = []
  const fetches: { url: string; init: Record<string, unknown> }[] = []
  class FakeBlob {
    constructor(
      readonly parts: string[],
      readonly options: { type: string },
    ) {}
  }
  const window: Record<string, unknown> = {
    location: { pathname: '/dashboard', search: '?code=secret', hash: '#token' },
    navigator: {
      sendBeacon: (url: string, blob: FakeBlob) => {
        const accepted = options.beacon ? options.beacon(url, blob) : true
        if (accepted) beacons.push(blob.parts.join(''))
        return accepted
      },
    },
    fetch: (url: string, init: Record<string, unknown>) => {
      fetches.push({ url, init })
      return options.fetch ? options.fetch() : Promise.resolve({ ok: true })
    },
    Blob: FakeBlob,
    addEventListener: (type: string, listener: Listener) => {
      listeners[type] = [...(listeners[type] ?? []), listener]
    },
  }
  new Function('window', browserErrorBootstrap('dpl_x'))(window)
  const dispatch = (type: string, event: unknown) => {
    for (const listener of listeners[type] ?? []) listener(event)
  }
  return {
    window,
    beacons,
    fetches,
    dispatch,
    sent: () =>
      [...beacons, ...fetches.map((f) => f.init.body as string)].map((b) => JSON.parse(b)),
  }
}

describe('browser error bootstrap', () => {
  test('reports an uncaught error once, with path but no query or hash', () => {
    const page = fakeWindow()
    const error = new ReferenceError('Bun is not defined')
    page.dispatch('error', { error, message: 'Uncaught ReferenceError: Bun is not defined' })
    page.dispatch('error', { error, message: 'Uncaught ReferenceError: Bun is not defined' })
    const sent = page.sent()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      kind: 'error',
      message: 'ReferenceError: Bun is not defined',
      path: '/dashboard',
      deployment: 'dpl_x',
    })
    expect(sent[0].stack).toContain('Bun is not defined')
    expect(JSON.stringify(sent)).not.toContain('secret')
    expect(JSON.stringify(sent)).not.toContain('token')
  })

  test('falls back to the event location when there is no error object', () => {
    const page = fakeWindow()
    page.dispatch('error', { message: 'Script error.', filename: '/a.js', lineno: 3, colno: 9 })
    expect(page.sent()[0]).toMatchObject({ message: 'Script error.', stack: '/a.js:3:9' })
  })

  test('reports unhandled rejections of errors and of other values', () => {
    const page = fakeWindow()
    page.dispatch('unhandledrejection', { reason: new TypeError('boom') })
    page.dispatch('unhandledrejection', { reason: 'plain reason' })
    expect(page.sent().map((r) => [r.kind, r.message])).toEqual([
      ['unhandledrejection', 'TypeError: boom'],
      ['unhandledrejection', 'plain reason'],
    ])
  })

  test(`sends at most ${BROWSER_ERROR_LIMITS.reportsPerPage} reports per page`, () => {
    const page = fakeWindow()
    for (let i = 0; i < 7; i++) page.dispatch('error', { error: new Error(`e${i}`) })
    expect(page.sent()).toHaveLength(BROWSER_ERROR_LIMITS.reportsPerPage)
  })

  test('falls back to fetch when the beacon is refused', () => {
    const page = fakeWindow({ beacon: () => false })
    page.dispatch('error', { error: new Error('refused') })
    expect(page.beacons).toEqual([])
    expect(page.fetches).toHaveLength(1)
    expect(page.fetches[0]!.url).toBe(BROWSER_ERROR_ENDPOINT)
    expect(page.fetches[0]!.init).toMatchObject({
      method: 'POST',
      keepalive: true,
      credentials: 'omit',
    })
  })

  test('reporting failures never throw or reject unhandled', async () => {
    let unhandled = 0
    const onUnhandled = () => {
      unhandled++
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const page = fakeWindow({
        beacon: () => {
          throw new Error('beacon broke')
        },
        fetch: () => Promise.reject(new Error('offline')),
      })
      expect(() => page.dispatch('error', { error: new Error('a') })).not.toThrow()
      const throwing = fakeWindow({
        beacon: () => false,
        fetch: () => {
          throw new Error('no fetch')
        },
      })
      expect(() => throwing.dispatch('error', { error: new Error('b') })).not.toThrow()
      await Promise.resolve()
      await Promise.resolve()
      expect(unhandled).toBe(0)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  test('explicit boundaries report through the exposed function', () => {
    const page = fakeWindow()
    ;(page.window.__autobuildReportBrowserError as (e: unknown) => void)(new Error('caught'))
    expect(page.sent()[0]).toMatchObject({ kind: 'boundary', message: 'Error: caught' })
  })

  test('shrinks the stack so a report fits the body bound', () => {
    const page = fakeWindow()
    const error = new Error('wide')
    error.stack = '一'.repeat(BROWSER_ERROR_LIMITS.stack)
    page.dispatch('error', { error })
    const body = page.beacons[0]!
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(
      BROWSER_ERROR_LIMITS.bodyBytes,
    )
    expect(JSON.parse(body).stack.length).toBeGreaterThan(0)
  })

  test('an embedded deployment id cannot close the script tag', () => {
    const script = browserErrorBootstrap('</script><script>alert(1)</script>')
    expect(script).not.toContain('</script')
    expect(script.toLowerCase()).not.toContain('<script')
  })
})
