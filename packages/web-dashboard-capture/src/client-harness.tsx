/**
 * Browser-side mount harness for the client-load check (`client-load.ts`).
 *
 * Bundled into every per-route entry under `client-pages/` and run in headless
 * Chromium. It mounts a page's real top-level client component the way the
 * Next app router would: inside the root layout's `ThemeProvider`, under the
 * router, pathname and search-params contexts `next/navigation` hooks read,
 * with `fetch` answering the page's data requests from a fixture table. React
 * errors are re-reported through `reportError`, so every render, commit and
 * effect failure reaches the debugger as an uncaught exception. Nothing here
 * catches or hides an error: the loader judges the page by what the browser
 * reported.
 */
import type { AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import {
  PathnameContext,
  PathParamsContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { type ReactElement, type ReactNode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from '../../hosted-store-service/app/ThemeProvider'
import type { ClientHarnessState } from './full-document'

export interface ClientPageHarness {
  /** The app route this harness stands for, as discovery names it. */
  route: string
  /** The concrete pathname the page renders at. */
  pathname: string
  /** Search parameters, without the leading `?`. */
  query?: string
  /** Dynamic route parameters `useParams` returns. */
  params?: Record<string, string>
  /** The element the route's `page.tsx` renders, with fixture props. */
  render: () => ReactElement
}

/** Fixture responses keyed by `METHOD /path?query`, then `METHOD /path`. */
export interface FixtureResponses {
  responses: Record<string, { status: number; body: unknown }>
}

declare global {
  var __autobuildHarness: ClientHarnessState | undefined
}

const QUIET_TICKS = 3
const TICK_MS = 50

function Mounted({ state, children }: { state: ClientHarnessState; children: ReactNode }) {
  useEffect(() => {
    state.mounted = true
  }, [state])
  return children
}

/** Navigation is recorded, never performed: the harness page stays put. */
function stubRouter(navigations: string[]): AppRouterInstance {
  const record = (kind: string) => (href?: string) => {
    navigations.push(href === undefined ? kind : `${kind} ${href}`)
  }
  return {
    back: record('back'),
    forward: record('forward'),
    refresh: record('refresh'),
    push: record('push'),
    replace: record('replace'),
    prefetch: record('prefetch'),
  }
}

function frames(count: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (left: number) =>
      left === 0 ? resolve() : requestAnimationFrame(() => step(left - 1))
    step(count)
  })
}

export function mountClientPage(page: ClientPageHarness): void {
  const fixtures = JSON.parse(
    document.getElementById('autobuild-fixtures')?.textContent ?? '{"responses":{}}',
  ) as FixtureResponses
  const state: ClientHarnessState = {
    mounted: false,
    settled: false,
    rendered: false,
    unserved: [],
    requests: [],
  }
  globalThis.__autobuildHarness = state
  let inFlight = 0
  const fixtureFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(raw, 'http://harness.invalid')
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const path = `${url.pathname}${url.search}`
    const key = `${method} ${path}`
    state.requests.push(key)
    const fixture = fixtures.responses[key] ?? fixtures.responses[`${method} ${url.pathname}`]
    inFlight += 1
    try {
      // Answer asynchronously, like the network would.
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (!fixture) {
        if (!state.unserved.includes(key)) state.unserved.push(key)
        return new Response(JSON.stringify({ error: `no fixture for ${key}` }), {
          status: 501,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify(fixture.body), {
        status: fixture.status,
        headers: { 'content-type': 'application/json' },
      })
    } finally {
      inFlight -= 1
    }
  }
  window.fetch = fixtureFetch as typeof fetch

  const root = document.getElementById('root')
  if (!root) throw new Error('client harness: the page has no #root element')
  const navigations: string[] = []
  createRoot(root, {
    // Hand React-handled errors back to the browser so the debugger sees them.
    onUncaughtError: (error) => reportError(error),
    onCaughtError: (error) => reportError(error),
    onRecoverableError: (error) => reportError(error),
  }).render(
    <AppRouterContext.Provider value={stubRouter(navigations)}>
      <SearchParamsContext.Provider value={new URLSearchParams(page.query ?? '')}>
        <PathnameContext.Provider value={page.pathname}>
          <PathParamsContext.Provider value={page.params ?? {}}>
            <ThemeProvider>
              <Mounted state={state}>{page.render()}</Mounted>
            </ThemeProvider>
          </PathParamsContext.Provider>
        </PathnameContext.Provider>
      </SearchParamsContext.Provider>
    </AppRouterContext.Provider>,
  )

  // Settled: mounted, nothing in flight, no new request for a few ticks, and
  // two frames painted. Polling intervals keep running; the loader stops here.
  let quiet = 0
  let seen = 0
  const tick = async () => {
    const fresh = state.requests.length !== seen
    seen = state.requests.length
    quiet = state.mounted && inFlight === 0 && !fresh ? quiet + 1 : 0
    if (quiet < QUIET_TICKS) {
      setTimeout(tick, TICK_MS)
      return
    }
    await frames(2)
    if (inFlight !== 0 || state.requests.length !== seen) {
      quiet = 0
      setTimeout(tick, TICK_MS)
      return
    }
    state.rendered = root.childElementCount > 0 && (root.textContent ?? '').trim().length > 0
    state.settled = true
  }
  setTimeout(tick, TICK_MS)
}
