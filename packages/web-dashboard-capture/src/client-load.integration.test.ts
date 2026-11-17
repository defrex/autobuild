import { expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  APP_DIR,
  clientFixtures,
  discoverClientPages,
  harnessImports,
  harnessModuleFor,
  pageForFrame,
  routeSlug,
} from './client-load'
import { FIXTURE_BUILD_SLUG, FIXTURE_REPO, FIXTURE_TICKET_ID } from './client-pages/fixtures'
import { WEB_FRAME_SPECS } from './web-dashboard-capture'

// Browser-free coverage for the client-load check. The Chromium proofs live in
// client-load.browser.integration.test.ts and run only inside `check:app-load`;
// tools/app-load-paths.integration.test.ts holds the step's path coverage.

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
