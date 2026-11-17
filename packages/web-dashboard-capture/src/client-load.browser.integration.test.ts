import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkClientPages, type ClientPageResult } from './client-load'
import { FIXTURE_REPO, FIXTURE_TICKET_ID } from './client-pages/fixtures'
import { chromiumBinary, fullDocumentScreenshot } from './full-document'
import { fontFaceCss } from './web-dashboard-capture'

// Real-Chromium proofs for the client-load check. They run only inside
// `bun run check:app-load` (the path-gated app-load verify step), which sets
// AB_APP_LOAD_BROWSER_TEST=1; the unconditional integration suite never
// launches a browser for them. With the flag set, a missing browser fails.
const enabled = process.env.AB_APP_LOAD_BROWSER_TEST === '1'
const REPO_ROOT = resolve(import.meta.dir, '../../..')

function requireChromium(): string {
  const chromium = chromiumBinary()
  if (!chromium) throw Error('the app-load browser proofs require Chromium; set CHROMIUM_BIN')
  return chromium
}

async function scratch(prefix: string): Promise<string> {
  await mkdir(join(REPO_ROOT, '.ab'), { recursive: true })
  return mkdtemp(join(REPO_ROOT, '.ab', prefix))
}

/**
 * Fixture client modules live outside any package, so they import React by
 * its resolved path (the same file the harness bundles) and avoid JSX, whose
 * automatic runtime would resolve `react/jsx-runtime` from their directory.
 */
const REACT = JSON.stringify(Bun.resolveSync('react', import.meta.dir))
const HARNESS = JSON.stringify(join(import.meta.dir, 'client-harness.tsx'))

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
}

test.skipIf(!enabled)(
  'a page that throws while loading fails with the browser error, and a clean page passes',
  async () => {
    const chromium = requireChromium()
    const root = await scratch('app-load-test-')
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
      const results = await checkClientPages({
        chromium,
        outDir: join(root, 'out'),
        appDir,
        harnessDir,
        fixtures: { responses: { 'GET /api/web/ok': { status: 200, body: { text: 'served' } } } },
        timeoutMs: 10_000,
      })
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
    const root = await scratch('app-load-real-')
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
  'the shared browser lifetime still captures a plain document',
  async () => {
    const chromium = requireChromium()
    const root = await scratch('app-load-screenshot-')
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
