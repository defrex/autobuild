import { expect, test } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { appLoadScratch, checkClientPages, type ClientPageResult } from './client-load'
import { FIXTURE_REPO, FIXTURE_TICKET_ID } from './client-pages/fixtures'
import { chromiumBinary, fullDocumentScreenshot } from './full-document'
import { fontFaceCss } from './web-dashboard-capture'

// Real-Chromium proofs for the client-load check. They run only inside
// `bun run check:app-load` (the path-gated app-load verify step), which sets
// AB_APP_LOAD_BROWSER_TEST=1; the unconditional integration suite never
// launches a browser for them. With the flag set, a missing browser fails.
// Like the check itself, each proof keeps its bundles and Chromium profiles in
// the temporary root (`appLoadScratch`): verify:build packs the checkout
// concurrently and must not walk a live profile (#1043).
const enabled = process.env.AB_APP_LOAD_BROWSER_TEST === '1'

function requireChromium(): string {
  const chromium = chromiumBinary()
  if (!chromium) throw Error('the app-load browser proofs require Chromium; set CHROMIUM_BIN')
  return chromium
}

/**
 * Fixture client modules live in the temporary root, outside any package, so they import React by
 * its resolved path (the same file the harness bundles) and avoid JSX, whose
 * automatic runtime would resolve `react/jsx-runtime` from their directory.
 */
const REACT = JSON.stringify(Bun.resolveSync('react', import.meta.dir))
const HARNESS = JSON.stringify(join(import.meta.dir, 'client-harness.tsx'))

const POLL_OK = (ms: number) => `export function Page() {
  const [text, setText] = useState('loading')
  useEffect(() => {
    const load = () =>
      void fetch('/api/web/ok').then((response) => response.json()).then((value) => setText(value.text))
    load()
    const timer = setInterval(load, ${ms})
    return () => clearInterval(timer)
  }, [])
  return createElement('p', null, text)
}`

const CASES: Record<string, { body: string; expected?: string }> = {
  'top-level': {
    body: `const hasher = new Bun.CryptoHasher('sha256')
export function Page() { return createElement('p', null, String(hasher)) }`,
    expected: 'ReferenceError: Bun is not defined',
  },
  'render-throw': {
    body: `export function Page() { throw Error('render failed') }`,
    expected: 'render failed',
  },
  'effect-throw': {
    body: `export function Page() {
  useEffect(() => { throw Error('effect failed') }, [])
  return createElement('p', null, 'mounted')
}`,
    expected: 'effect failed',
  },
  'effect-reject': {
    body: `export function Page() {
  useEffect(() => { void Promise.reject(Error('load rejected')) }, [])
  return createElement('p', null, 'mounted')
}`,
    expected: 'load rejected',
  },
  unserved: {
    body: `export function Page() {
  useEffect(() => { void fetch('/api/web/missing') }, [])
  return createElement('p', null, 'mounted')
}`,
    expected: 'unserved request GET /api/web/missing',
  },
  ok: {
    body: `export function Page() {
  const [text, setText] = useState('loading')
  useEffect(() => {
    void fetch('/api/web/ok').then((response) => response.json()).then((value) => setText(value.text))
  }, [])
  return createElement('p', null, text)
}`,
  },
  // A busy but healthy page: repeat polls, late frames and late timers model a
  // loaded verify host, and each one starved the old tick-count settle check.
  'steady-poll': { body: POLL_OK(100) },
  'slow-frames': {
    body: `const raf = globalThis.requestAnimationFrame.bind(globalThis)
globalThis.requestAnimationFrame = (callback) => { setTimeout(() => raf(callback), 1_000); return 0 }
${POLL_OK(300)}`,
  },
  'slow-timers': {
    body: `const later = globalThis.setTimeout.bind(globalThis)
globalThis.setTimeout = (callback, ms = 0, ...args) => later(callback, ms + 400, ...args)
${POLL_OK(300)}`,
  },
  // Pages that never settle: each fails within its bound and names the wait.
  'new-requests': {
    body: `export function Page() {
  useEffect(() => {
    let i = 0
    const timer = setInterval(() => void fetch(\`/api/web/ok?n=\${i++}\`), 100)
    return () => clearInterval(timer)
  }, [])
  return createElement('p', null, 'polling')
}`,
    expected:
      'harness did not settle within 3000 ms: still waiting for quiet after new request GET /api/web/ok?n=',
  },
  'no-frames': {
    body: `globalThis.requestAnimationFrame = () => 0
export function Page() { return createElement('p', null, 'no frames') }`,
    expected: 'harness did not settle within 3000 ms: still waiting for animation frame',
  },
}
const UNSETTLED = ['new-requests', 'no-frames']
const UNSETTLED_BOUND_MS = 3_000
// Bundling, Chromium launch and teardown on a loaded host; under the 10 s
// debugger request timeout a drain waiting on the page's frames would hit.
const UNSETTLED_TOLERANCE_MS = 7_000

test.skipIf(!enabled)(
  'a page that throws while loading fails with the browser error, and a clean page passes',
  async () => {
    const chromium = requireChromium()
    const root = await appLoadScratch('app-load-test-')
    try {
      const appDir = join(root, 'app')
      const harnessDir = join(root, 'harness')
      await mkdir(harnessDir, { recursive: true })
      await mkdir(appDir, { recursive: true })
      await writeFile(join(appDir, 'layout.tsx'), 'export default function Layout() {}\n')
      for (const [name, { body }] of Object.entries(CASES)) {
        await mkdir(join(appDir, name), { recursive: true })
        await writeFile(
          join(appDir, name, 'Client.tsx'),
          `'use client'\nimport { createElement, useEffect, useState } from ${REACT}\n${body}\n`,
        )
        await writeFile(
          join(appDir, name, 'page.tsx'),
          `import { Page } from './Client'\nexport default function Route() { return Page }\n`,
        )
        await writeFile(
          join(harnessDir, `${name}.tsx`),
          `import { createElement } from ${REACT}
import { mountClientPage } from ${HARNESS}
import { Page } from ${JSON.stringify(join(appDir, name, 'Client.tsx'))}
mountClientPage({ route: '/${name}', pathname: '/${name}', render: () => createElement(Page) })
`,
        )
      }
      const fixtures = {
        responses: { 'GET /api/web/ok': { status: 200, body: { text: 'served' } } },
      }
      const results = await checkClientPages({
        chromium,
        outDir: join(root, 'out'),
        appDir,
        harnessDir,
        fixtures,
        routes: Object.keys(CASES)
          .filter((name) => !UNSETTLED.includes(name))
          .map((name) => `/${name}`),
        timeoutMs: 10_000,
      })
      for (const name of UNSETTLED) {
        const started = performance.now()
        const unsettled = await checkClientPages({
          chromium,
          outDir: join(root, `out-${name}`),
          appDir,
          harnessDir,
          fixtures,
          routes: [`/${name}`],
          timeoutMs: UNSETTLED_BOUND_MS,
        })
        const elapsed = performance.now() - started
        expect({ name, within: elapsed < UNSETTLED_BOUND_MS + UNSETTLED_TOLERANCE_MS }).toEqual({
          name,
          within: true,
        })
        results.push(...unsettled)
      }
      const byRoute = new Map(results.map((result) => [result.route, result]))
      for (const [name, { expected }] of Object.entries(CASES)) {
        const result = byRoute.get(`/${name}`) as ClientPageResult
        if (expected === undefined)
          expect({ name, errors: result.errors }).toEqual({ name, errors: [] })
        else
          expect({ name, errors: result.errors.join('\n') }).toEqual({
            name,
            errors: expect.stringContaining(expected),
          })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  180_000,
)

test.skipIf(!enabled)(
  'every real app page mounts in Chromium without a browser error',
  async () => {
    const chromium = requireChromium()
    const root = await appLoadScratch('app-load-real-')
    try {
      const results = await checkClientPages({ chromium, outDir: root })
      expect(results.length).toBeGreaterThan(0)
      expect(results.filter((result) => result.errors.length > 0)).toEqual([])
      // The build page found its build in the default fixture: only a resolved
      // build row makes it fetch the ticket the build was claimed from.
      const repo = encodeURIComponent(FIXTURE_REPO)
      const buildPage = results.find((result) => result.route === '/build/[slug]')
      expect(buildPage?.requests).toContain(
        `GET /api/web/repos/${repo}/tickets/${encodeURIComponent(FIXTURE_TICKET_ID)}`,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  300_000,
)

test.skipIf(!enabled)(
  'real polling pages settle under CPU contention',
  async () => {
    const chromium = requireChromium()
    const root = await appLoadScratch('app-load-contention-')
    try {
      const results = await checkClientPages({
        chromium,
        outDir: root,
        routes: ['/done', '/'],
        cpuThrottlingRate: 6,
      })
      expect(results.map((result) => result.route).sort()).toEqual(['/', '/done'])
      expect(results.filter((result) => result.errors.length > 0)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  120_000,
)

test.skipIf(!enabled)(
  'the shared browser lifetime still captures a plain document',
  async () => {
    const chromium = requireChromium()
    const root = await appLoadScratch('app-load-screenshot-')
    try {
      const html = join(root, 'plain.html')
      await writeFile(
        html,
        `<!doctype html><html><head><style>${fontFaceCss()} body { font-family: var(--font-sans) }</style></head><body><p>plain</p></body></html>`,
      )
      const png = join(root, 'plain.png')
      const result = await fullDocumentScreenshot(
        chromium,
        pathToFileURL(html).href,
        png,
        390,
        600,
        join(root, 'profile'),
      )
      expect(result).toMatchObject({ width: 390, height: 600, confirmations: [] })
      expect((await readFile(png)).subarray(1, 4).toString('ascii')).toBe('PNG')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  120_000,
)
