/**
 * Client-load check: every operator web app page's real client code, bundled
 * for the browser and mounted in headless Chromium over fixture data.
 *
 * Repository-local verification tooling. The capture (`web-dashboard-capture.tsx`)
 * screenshots static markup rendered under Bun, so a client bundle that throws
 * in the browser cannot appear in its frames: #951 shipped a dashboard that
 * died with "Bun is not defined" while every verify step passed. This module
 * closes that gap for two callers:
 *
 * - `bun run check:app-load` (the path-gated `app-load` verify step) mounts
 *   every `page.tsx` under the app, so a kernel-only diff that changes what
 *   the client bundle pulls in still meets a browser.
 * - The capture mounts every page its frames depict, over its own fixture
 *   models, before it screenshots anything.
 *
 * Each page has a checked-in harness module under `client-pages/` that renders
 * the page's real top-level client component with the props its server tree
 * passes. A new page fails the check until it has one.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DashboardModel } from '@defrex/autobuild/operator-presentation'
import { getOperatorDashboard, type OperatorDashboardSnapshot } from '../../core/src/operator/query'
import { MemoryBuildStore } from '../../core/src/store/memory'
import type { Ticket } from '../../core/src/ports/types'
import type { Discovery, Snapshot } from '../../hosted-store-service/app/access/api'
import type { FixtureResponses } from './client-harness'
import {
  ALTERNATE_FIXTURE_REPO,
  FIXTURE_BUILD_SLUG,
  FIXTURE_ORGANIZATION,
  FIXTURE_REPO,
  FIXTURE_TICKET_ID,
} from './client-pages/fixtures'
import { chromiumBinary, clientLoadErrors, loadClientPage } from './full-document'
import { settingsData } from './settings-fixtures'

export type { FixtureResponses }

const REPO_ROOT = resolve(import.meta.dir, '../../..')
export const APP_DIR = join(REPO_ROOT, 'packages', 'hosted-store-service', 'app')
export const HARNESS_DIR = join(import.meta.dir, 'client-pages')

/** Same directive test as `app/client-bundle.integration.test.ts`. */
const USE_CLIENT = /^['"]use client['"]/

export interface ClientPage {
  /** The app route, with route groups dropped and dynamic segments literal. */
  route: string
  /** The page module, absolute. */
  file: string
  /** The `'use client'` modules the page's server tree renders, absolute. */
  clientModules: string[]
}

export interface ClientPageResult {
  route: string
  /** The page's top-level client component modules, repo-relative. */
  component: string
  clientModules: string[]
  errors: string[]
}

const transpiler = new Bun.Transpiler({ loader: 'tsx' })

function resolveRelative(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined
  const base = resolve(dirname(from), specifier)
  for (const candidate of [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    join(base, 'index.tsx'),
    join(base, 'index.ts'),
  ])
    if (existsSync(candidate) && /\.tsx?$/.test(candidate)) return candidate
  return undefined
}

function relativeImports(file: string): string[] {
  return transpiler
    .scanImports(readFileSync(file, 'utf8'))
    .map((entry) => resolveRelative(file, entry.path))
    .filter((path): path is string => path !== undefined)
}

const isClient = (file: string) => USE_CLIENT.test(readFileSync(file, 'utf8'))

function pageFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return pageFiles(path)
    return entry.name === 'page.tsx' ? [path] : []
  })
}

/**
 * Every Next page under `appDir` and the client modules its server tree
 * renders: the page's own `'use client'` imports, plus those of any non-client
 * module it imports (one level, e.g. `Consent.tsx` → `ConsentForm.tsx`).
 */
export function discoverClientPages(appDir = APP_DIR): ClientPage[] {
  const pages = pageFiles(appDir)
    .map((file) => {
      const segments = relative(appDir, dirname(file))
        .split(/[\\/]/)
        .filter((segment) => segment !== '' && !/^\(.*\)$/.test(segment))
      const clientModules = new Set<string>()
      for (const imported of relativeImports(file)) {
        if (isClient(imported)) clientModules.add(imported)
        else
          for (const nested of relativeImports(imported))
            if (isClient(nested)) clientModules.add(nested)
      }
      return { route: `/${segments.join('/')}`, file, clientModules: [...clientModules].sort() }
    })
    .sort((a, b) => a.route.localeCompare(b.route))
  if (pages.length === 0) throw new Error(`client load: no pages found under ${appDir}`)
  return pages
}

/** `/` → `index`, `/build/[slug]` → `build-slug`, `/oauth/consent` → `oauth-consent`. */
export function routeSlug(route: string): string {
  return route === '/' ? 'index' : route.slice(1).replace(/[[\]]/g, '').replace(/\//g, '-')
}

/** The checked-in harness module that mounts `route`; a page without one fails. */
export function harnessModuleFor(route: string, harnessDir = HARNESS_DIR): string {
  const path = join(harnessDir, `${routeSlug(route)}.tsx`)
  if (!existsSync(path))
    throw new Error(
      `client load: page ${route} has no harness module; add ${relative(REPO_ROOT, path)} rendering its client component`,
    )
  return path
}

/** Every relative module a harness imports, absolute. */
export function harnessImports(route: string, harnessDir = HARNESS_DIR): string[] {
  return relativeImports(harnessModuleFor(route, harnessDir))
}

const FIXTURE_NOW = '2026-11-17T12:00:00.000Z'

function ticket(id: string, title: string, extra: Partial<Ticket> = {}): Ticket {
  return {
    ref: { source: 'database', id, title },
    revision: '1',
    kind: 'work',
    title,
    body: `# ${title}\n\n## Acceptance criteria\n\n- The page loads.`,
    state: 'triage',
    resolved: false,
    labels: [],
    ...extra,
  }
}

const TICKETS: Ticket[] = [
  ticket('CAP-12', 'Retry budget for verify steps', {
    labels: ['autobuild:proposal'],
    blockedBy: ['CAP-9'],
  }),
  ticket('CAP-21', 'Fix the stuck reconcile loop', { state: 'ready', priority: 'urgent' }),
  ticket(FIXTURE_TICKET_ID, 'Implement blocked dashboard', { state: 'ready' }),
  ticket('CAP-1', 'Ship the first build', { state: 'done', resolved: true }),
]

const ACME: Snapshot = {
  organization: {
    id: FIXTURE_ORGANIZATION,
    name: 'Acme Product',
    slug: FIXTURE_ORGANIZATION,
    ownerEmail: 'operator@example.com',
    membershipRole: 'owner',
  },
  projects: [`https://github.com/${FIXTURE_REPO}`],
  members: [
    { name: 'Operator', email: 'operator@example.com', role: 'owner', status: 'joined' },
    { name: null, email: 'pending@example.com', role: 'member', status: 'pending' },
  ],
}
const NORTHWIND: Snapshot = {
  organization: {
    id: 'northwind',
    name: 'Northwind Labs',
    slug: 'northwind',
    ownerEmail: null,
    membershipRole: null,
  },
  projects: [],
  members: [],
}

export interface ClientFixtureSource {
  /** The dashboard model to serve; defaults to an empty repository's. */
  model?: DashboardModel
}

/**
 * The fixture table the harness `fetch` answers from, keyed exactly as
 * `dashboard/api.ts` and `access/api.ts` build their requests. The capture
 * passes its own model so the mounted pages render the captured data.
 */
export async function clientFixtures(source: ClientFixtureSource = {}): Promise<FixtureResponses> {
  const empty = await getOperatorDashboard({
    store: new MemoryBuildStore(),
    repo: FIXTURE_REPO,
    clock: () => new Date(FIXTURE_NOW),
  })
  const responses: FixtureResponses['responses'] = {}
  const ok = (key: string, body: unknown) => {
    responses[key] = { status: 200, body }
  }
  for (const repo of [FIXTURE_REPO, ALTERNATE_FIXTURE_REPO]) {
    const base = `/api/web/repos/${encodeURIComponent(repo)}`
    const snapshot: OperatorDashboardSnapshot =
      source.model && repo === FIXTURE_REPO ? { ...empty, model: source.model } : empty
    ok(`GET ${base}/dashboard`, snapshot)
    // Every listing answers from the same tickets; the query only pages them.
    ok(`GET ${base}/tickets`, {
      states: ['triage', 'ready', 'done'],
      tickets: TICKETS,
      diagnostics: [],
      criteria: {},
      triageState: 'triage',
      readyState: 'ready',
      doneState: 'done',
      total: TICKETS.length,
    })
    ok(
      `GET ${base}/tickets/states`,
      ['triage', 'ready', 'done'].map((name) => ({
        name,
        tickets: TICKETS.filter((entry) => entry.state === name).length,
      })),
    )
    ok(`GET ${base}/tickets/${encodeURIComponent(FIXTURE_TICKET_ID)}`, {
      ticket: TICKETS.find((entry) => entry.ref.id === FIXTURE_TICKET_ID),
      blockers: [],
      build: {
        slug: FIXTURE_BUILD_SLUG,
        status: 'blocked',
        updatedAt: FIXTURE_NOW,
        link: `/build/${FIXTURE_BUILD_SLUG}`,
      },
    })
    ok(`GET ${base}/secrets`, settingsData('credentials'))
  }
  const discovery: Discovery = {
    isSuperUser: true,
    organizations: [ACME.organization, NORTHWIND.organization],
  }
  ok('GET /api/web/orgs', discovery)
  for (const org of [ACME, NORTHWIND]) {
    const path = `/api/web/orgs/${encodeURIComponent(org.organization.id)}`
    ok(`GET ${path}`, { organization: org.organization, projects: org.projects })
    ok(`GET ${path}/members`, { members: org.members })
  }
  ok('GET /api/web/projects/unassigned', { projects: ['https://github.com/example/unassigned'] })
  ok('GET /api/web/projects/deletions', { projects: [] })
  return { responses }
}

export interface BundledPage {
  route: string
  /** The bundle file name inside `outDir`. */
  script: string
  /** Every source file the bundle read, absolute. */
  inputs: string[]
}

/**
 * Bundle each page's harness for the browser the way Next's client build
 * would see it: real react, react-dom and next from node_modules, nothing
 * external, production React. IIFE because Chromium refuses module scripts
 * from `file://`.
 */
export async function bundleClientPages(
  pages: readonly Pick<ClientPage, 'route'>[],
  outDir: string,
  harnessDir = HARNESS_DIR,
): Promise<BundledPage[]> {
  await mkdir(join(outDir, 'entries'), { recursive: true })
  const bundled: BundledPage[] = []
  for (const page of pages) {
    const slug = routeSlug(page.route)
    const entry = join(outDir, 'entries', `${slug}.ts`)
    await writeFile(entry, `import ${JSON.stringify(harnessModuleFor(page.route, harnessDir))}\n`)
    const inputs = new Set<string>()
    const result = await Bun.build({
      entrypoints: [entry],
      outdir: outDir,
      naming: `${slug}.js`,
      target: 'browser',
      format: 'iife',
      minify: false,
      throw: false,
      define: { 'process.env.NODE_ENV': '"production"' },
      // Next's client runtime polyfills `process`; mirror its shape so
      // bundled next modules that read `process.env` keys load as they do there.
      banner: 'var process = globalThis.process || { env: {} };',
      plugins: [
        {
          name: 'record-inputs',
          setup(build) {
            build.onLoad({ filter: /.*/ }, (args) => {
              inputs.add(args.path)
              return undefined
            })
          },
        },
      ],
    })
    if (!result.success)
      throw new Error(
        `client load: page ${page.route} failed to bundle: ${result.logs.map(String).join('\n')}`,
      )
    inputs.delete(entry)
    bundled.push({ route: page.route, script: `${slug}.js`, inputs: [...inputs].sort() })
  }
  return bundled
}

export interface CheckClientPagesOptions {
  chromium: string
  /** Bundles, HTML and browser profiles; the caller owns its lifetime. */
  outDir: string
  appDir?: string
  harnessDir?: string
  fixtures?: FixtureResponses
  /** Only these routes; defaults to every discovered page. */
  routes?: readonly string[]
  timeoutMs?: number
}

/** Mount every page in Chromium and report each page's browser errors. */
export async function checkClientPages(
  options: CheckClientPagesOptions,
): Promise<ClientPageResult[]> {
  const discovered = discoverClientPages(options.appDir)
  const pages = options.routes
    ? options.routes.map((route) => {
        const page = discovered.find((entry) => entry.route === route)
        if (!page) throw new Error(`client load: no page ${route} under the app`)
        return page
      })
    : discovered
  await mkdir(options.outDir, { recursive: true })
  const bundles = await bundleClientPages(pages, options.outDir, options.harnessDir)
  const fixtures = options.fixtures ?? (await clientFixtures())
  // `</` cannot end the JSON script element early.
  const payload = JSON.stringify(fixtures).replace(/<\//g, '<\\/')
  const results: ClientPageResult[] = []
  for (const [index, page] of pages.entries()) {
    const bundle = bundles[index]!
    const slug = routeSlug(page.route)
    const htmlPath = join(options.outDir, `${slug}.html`)
    await writeFile(
      htmlPath,
      `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="application/json" id="autobuild-fixtures">${payload}</script><script src="${bundle.script}"></script></body></html>`,
    )
    const loaded = await loadClientPage(
      options.chromium,
      pathToFileURL(htmlPath).href,
      join(options.outDir, `chromium-${slug}`),
      { timeoutMs: options.timeoutMs },
    )
    const root = options.appDir ?? APP_DIR
    results.push({
      route: page.route,
      component: harnessComponents(page, root),
      clientModules: page.clientModules.map((file) => relative(root, file)),
      errors: clientLoadErrors(loaded),
    })
  }
  return results
}

function harnessComponents(page: ClientPage, appDir: string): string {
  const direct = relativeImports(page.file).filter(isClient)
  return (direct.length ? direct : page.clientModules)
    .map((file) => relative(appDir, file))
    .join(', ')
}

/**
 * The app route each capture frame depicts. Frame ids are matched by prefix,
 * first match wins; an unmapped id throws so a new frame names its page.
 */
const FRAME_PAGES: readonly (readonly [string, string])[] = [
  ['settings-', '/settings'],
  ['access-members-', '/members'],
  ['access-orgs-', '/organizations'],
  ['access-projects-', '/projects'],
  ['access-connect-', '/connect'],
  ['connect-', '/connect'],
  ['signin-', '/sign-in'],
  ['consent-', '/oauth/consent'],
  ['tickets-triage-', '/triage'],
  ['tickets-queue-', '/queue'],
  ['tickets-empty-', '/queue'],
  ['ticket-page-', '/ticket/[id]'],
  // Frames that render a build's own page.
  ['build-page-', '/build/[slug]'],
  ['integration-detail-', '/build/[slug]'],
  ['builds-mixed-selected-', '/build/[slug]'],
  ['builds-mixed-paused-', '/build/[slug]'],
  ['builds-auto-merge-on-', '/build/[slug]'],
  ['builds-parked-no-consent-', '/build/[slug]'],
  ['builds-post-reconcile-policy-', '/build/[slug]'],
  ['builds-mixed-detail-', '/build/[slug]'],
  ['builds-mixed-answer-', '/build/[slug]'],
  ['builds-mixed-abort-', '/build/[slug]'],
  // Everything else renders the active builds list.
  ['builds-', '/'],
  ['integration-', '/'],
  ['capacity-', '/'],
  ['account-credentials-', '/'],
]

export function pageForFrame(frameId: string): string {
  const match = FRAME_PAGES.find(([prefix]) => frameId.startsWith(prefix))
  if (!match) throw new Error(`client load: capture frame ${frameId} maps to no app page`)
  return match[1]
}

/** One stderr line per failing page, naming the page, its client code and the browser errors. */
export function formatClientFailure(result: ClientPageResult, prefix = 'app-load'): string {
  return `${prefix}: page ${result.route} failed to load in Chromium (${result.component}; client modules: ${result.clientModules.join(', ')}): ${result.errors.join('; ')}`
}

if (import.meta.main) {
  const chromium = chromiumBinary()
  if (!chromium) {
    console.error('app-load: no Chromium binary found. Install chromium or set CHROMIUM_BIN.')
    process.exit(1)
  }
  const outDir = join(REPO_ROOT, '.ab', 'app-load')
  await rm(outDir, { recursive: true, force: true })
  try {
    const results = await checkClientPages({ chromium, outDir })
    for (const result of results)
      if (result.errors.length === 0) console.log(`ok ${result.route} (${result.component})`)
      else console.error(formatClientFailure(result))
    if (results.some((result) => result.errors.length > 0)) process.exitCode = 1
  } catch (error) {
    console.error(`app-load: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
