import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  APP_DIR,
  appLoadScratch,
  type ClientPageResult,
  clientFixtures,
  discoverClientPages,
  harnessImports,
  harnessModuleFor,
  pageForFrame,
  routeSlug,
  runAppLoad,
  withAppLoadScratch,
} from './client-load'
import { FIXTURE_BUILD_SLUG, FIXTURE_REPO, FIXTURE_TICKET_ID } from './client-pages/fixtures'
import { WEB_FRAME_SPECS } from './web-dashboard-capture'

// Browser-free coverage for the client-load check. The Chromium proofs live in
// client-load.browser.integration.test.ts and run only inside `check:app-load`;
// tools/app-load-paths.integration.test.ts holds the step's path coverage.
// The scratch tests pin #1043's isolation contract without a browser: app-load
// keeps bundles and Chromium profiles outside the checkout that verify:build's
// `bun pm pack --dry-run` walks concurrently, removes them only after the check
// settles, on success and failure, and refuses a temporary root in the checkout.

const REPO_ROOT = resolve(import.meta.dir, '../../..')

const app = (path: string) => join(APP_DIR, path)

test('discovery finds every page and the client components its server tree renders', () => {
  const pages = discoverClientPages()
  const byRoute = new Map(pages.map((page) => [page.route, page.clientModules]))
  expect([...byRoute.keys()]).toEqual(
    expect.arrayContaining([
      '/',
      '/queue',
      '/triage',
      '/done',
      '/build/[slug]',
      '/ticket/[id]',
      '/settings',
      '/members',
      '/organizations',
      '/projects',
      '/connect',
      '/sign-in',
      '/oauth/consent',
    ]),
  )
  expect(byRoute.get('/settings')).toContain(app('settings/SettingsClient.tsx'))
  for (const route of ['/', '/queue', '/triage', '/done', '/build/[slug]', '/ticket/[id]'])
    expect(byRoute.get(route)).toContain(app('dashboard/DashboardClient.tsx'))
  // A server component's client child is followed one level.
  expect(byRoute.get('/oauth/consent')).toContain(app('oauth/consent/ConsentForm.tsx'))
  expect(routeSlug('/')).toBe('index')
  expect(routeSlug('/build/[slug]')).toBe('build-slug')
  expect(routeSlug('/oauth/consent')).toBe('oauth-consent')
})

test('every page has a harness that mounts each client module discovery found', () => {
  for (const page of discoverClientPages()) {
    expect(() => harnessModuleFor(page.route)).not.toThrow()
    const imports = harnessImports(page.route)
    for (const module of page.clientModules)
      expect({ route: page.route, module, mounted: imports.includes(module) }).toEqual({
        route: page.route,
        module,
        mounted: true,
      })
  }
  expect(() => harnessModuleFor('/no-such-page')).toThrow('has no harness module')
})

test('every capture frame names a discovered page', () => {
  const routes = new Set(discoverClientPages().map((page) => page.route))
  for (const spec of WEB_FRAME_SPECS) expect(routes.has(pageForFrame(spec.id))).toBe(true)
  expect(() => pageForFrame('unmapped-frame')).toThrow('maps to no app page')
})

test('fixture responses serialize and serve the fixture repository', async () => {
  const fixtures = await clientFixtures()
  const parsed = JSON.parse(JSON.stringify(fixtures)) as typeof fixtures
  expect(parsed).toEqual(fixtures)
  const dashboard = parsed.responses[
    `GET /api/web/repos/${encodeURIComponent(FIXTURE_REPO)}/dashboard`
  ]?.body as { model: { repo: string; builds: { slug: string; ticketId?: string }[] } } | undefined
  expect(dashboard?.model.repo).toBe(FIXTURE_REPO)
  // The standalone check's build page and lists render a real build row.
  expect(dashboard?.model.builds).toContainEqual(
    expect.objectContaining({ slug: FIXTURE_BUILD_SLUG, ticketId: FIXTURE_TICKET_ID }),
  )
  expect(parsed.responses['GET /api/web/orgs']?.status).toBe(200)
})

function contains(parent: string, path: string): boolean {
  const rel = relative(parent, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

async function outsideCheckout(dir: string): Promise<boolean> {
  return !contains(await realpath(REPO_ROOT), await realpath(dir))
}

const IN_REPO_APP_LOAD = join(REPO_ROOT, '.ab', 'app-load')

test('app-load scratch lives outside the checkout and is removed on success', async () => {
  let seen = ''
  const value = await withAppLoadScratch('ab-app-load-test-', async (dir) => {
    seen = dir
    expect(existsSync(dir)).toBe(true)
    expect(await outsideCheckout(dir)).toBe(true)
    expect(contains(await realpath(tmpdir()), await realpath(dir))).toBe(true)
    return 'done'
  })
  expect(value).toBe('done')
  expect(seen).not.toBe('')
  expect(existsSync(seen)).toBe(false)
})

test('app-load scratch is removed when the run fails', async () => {
  let seen = ''
  const failure = withAppLoadScratch('ab-app-load-test-', async (dir) => {
    seen = dir
    await mkdir(join(dir, 'chromium-index', 'Default'), { recursive: true })
    await writeFile(join(dir, 'chromium-index', 'Default', 'Preferences'), '{}')
    throw new Error('browser failed')
  })
  await expect(failure).rejects.toThrow('browser failed')
  expect(seen).not.toBe('')
  expect(existsSync(seen)).toBe(false)
})

test('both app-load APIs refuse checkout-contained temporary roots without work', async () => {
  const checkout = await mkdtemp(join(tmpdir(), 'ab-app-load-checkout-'))
  try {
    const nested = join(checkout, 'nested')
    await mkdir(nested)
    for (const tempRoot of [checkout, nested]) {
      await expect(appLoadScratch('x-', { tempRoot, checkoutRoot: checkout })).rejects.toThrow(
        /inside the checkout.*bun pm pack/,
      )
      const error: string[] = []
      let called = false
      expect(
        await runAppLoad({
          chromium: '/unused/chromium',
          tempRoot,
          checkoutRoot: checkout,
          log: () => {},
          error: (line) => error.push(line),
          check: async () => {
            called = true
            return []
          },
        }),
      ).toBe(1)
      expect(called).toBe(false)
      expect(error).toEqual([
        expect.stringMatching(/^app-load: temporary root .* inside the checkout.*bun pm pack/),
      ])
      expect(await readdir(nested)).toEqual([])
      expect(await readdir(checkout)).toEqual(['nested'])
    }
  } finally {
    await rm(checkout, { recursive: true, force: true })
  }
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const pageResult = (errors: string[]): ClientPageResult => ({
  route: '/',
  component: 'dashboard/DashboardClient.tsx',
  clientModules: ['dashboard/DashboardClient.tsx'],
  errors,
  requests: [],
})

async function profileIn(outDir: string): Promise<string> {
  const profile = join(outDir, 'chromium-index', 'Default', 'x')
  await mkdir(join(outDir, 'chromium-index', 'Default'), { recursive: true })
  await writeFile(profile, 'profile')
  return profile
}

test('runAppLoad removes its scratch only after the check settles, on every outcome', async () => {
  const hadInRepoDir = existsSync(IN_REPO_APP_LOAD)
  const outcomes = [
    {
      name: 'pass',
      check: async () => [pageResult([])],
      code: 0,
      log: ['ok / (dashboard/DashboardClient.tsx)'],
      error: [] as string[],
    },
    {
      name: 'failing page',
      check: async () => [pageResult(['ReferenceError: Bun is not defined'])],
      code: 1,
      log: [] as string[],
      error: [expect.stringContaining('app-load: page / failed to load in Chromium')],
    },
    {
      name: 'thrown',
      check: async (): Promise<ClientPageResult[]> => {
        throw new Error('bundle failed')
      },
      code: 1,
      log: [] as string[],
      error: ['app-load: bundle failed'],
    },
  ]
  for (const outcome of outcomes) {
    const gate = deferred()
    const entered = deferred()
    let outDir = ''
    let profile = ''
    const log: string[] = []
    const error: string[] = []
    const running = runAppLoad({
      chromium: '/unused/chromium',
      log: (line) => log.push(line),
      error: (line) => error.push(line),
      check: async (dir) => {
        outDir = dir
        profile = await profileIn(dir)
        entered.resolve()
        await gate.promise
        return outcome.check()
      },
    })
    await entered.promise
    // The check (and with it, every browser lifetime) has not settled yet.
    expect({ name: outcome.name, outside: await outsideCheckout(outDir) }).toEqual({
      name: outcome.name,
      outside: true,
    })
    expect(existsSync(profile)).toBe(true)
    expect(contains(await realpath(tmpdir()), await realpath(outDir))).toBe(true)
    gate.resolve()
    expect({ name: outcome.name, code: await running, log, error }).toEqual({
      name: outcome.name,
      code: outcome.code,
      log: outcome.log,
      error: outcome.error,
    })
    expect({ name: outcome.name, removed: !existsSync(outDir) }).toEqual({
      name: outcome.name,
      removed: true,
    })
  }
  if (!hadInRepoDir) expect(existsSync(IN_REPO_APP_LOAD)).toBe(false)
})
