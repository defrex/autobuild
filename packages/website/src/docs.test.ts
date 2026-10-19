import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFiles, buildSite } from './build'
import { DOCS_PAGES, renderDocsPage } from './docs'
import { REPO_URL, SITE_URL } from './constants'

test('docs emit complete shared navigation and distinct metadata with rooted assets', async () => {
  const files = await buildFiles()
  expect(DOCS_PAGES.map((p) => p.path)).toEqual([
    '/docs/',
    '/docs/getting-started/',
    '/docs/operating/',
    '/docs/seams/',
    '/docs/configuration/',
  ])
  expect(new Set(DOCS_PAGES.map((p) => p.title)).size).toBe(DOCS_PAGES.length)
  expect(new Set(DOCS_PAGES.map((p) => p.description)).size).toBe(DOCS_PAGES.length)
  for (const page of DOCS_PAGES) {
    const html = files[page.file]!
    expect(html).toContain(`<title>${page.title} · Autobuild docs</title>`)
    expect(html).toContain(`<meta name="description" content="${page.description}">`)
    expect(html).toContain(`<link rel="canonical" href="${SITE_URL}${page.path}">`)
    expect(html).toContain(`<meta property="og:url" content="${SITE_URL}${page.path}">`)
    expect(html).toContain('href="/site.css"')
    expect(html).toContain(`content="${SITE_URL}/og.png"`)
    expect(html).not.toContain('<script')
    expect(html.match(/<h1[ >]/g)).toHaveLength(1)
    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
    expect(html).toContain(`href="${page.path}" aria-current="page"`)
    expect(html).toContain(`href="${REPO_URL}"`)
    expect(html).toContain('href="/"')
    for (const entry of DOCS_PAGES) expect(html).toContain(`href="${entry.path}"`)
  }
})

test('build writes all docs pages and cleans stale output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'website-docs-'))
  try {
    await Bun.write(join(dir, 'stale.html'), 'stale')
    await buildSite(dir)
    expect(await Bun.file(join(dir, 'stale.html')).exists()).toBe(false)
    for (const page of DOCS_PAGES)
      expect(await readFile(join(dir, page.file), 'utf8')).toBe(renderDocsPage(page))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('all generated local hrefs and fragments resolve to emitted files and IDs', async () => {
  const files = await buildFiles()
  for (const [name, html] of Object.entries(files)) {
    if (!name.endsWith('.html') || typeof html !== 'string') continue
    for (const match of html.matchAll(/href="([^"]+)"/g)) {
      const url = new URL(match[1]!, `${SITE_URL}/${name}`)
      if (url.origin !== SITE_URL) continue
      const target = url.pathname.endsWith('/')
        ? `${url.pathname.slice(1)}index.html`
        : url.pathname.slice(1)
      expect(target in files).toBe(true)
      if (url.hash) expect(files[target as `${string}.html`]).toContain(`id="${url.hash.slice(1)}"`)
    }
  }
})

test('docs renderer escapes page metadata', () => {
  const html = renderDocsPage({ ...DOCS_PAGES[0]!, title: '<unsafe>"&', description: '"<text>&' })
  expect(html).toContain('<title>&lt;unsafe&gt;&quot;&amp; · Autobuild docs</title>')
  expect(html).toContain('content="&quot;&lt;text&gt;&amp;"')
})

test('feature guides are text-only and link to repository references', () => {
  for (const page of DOCS_PAGES.slice(2)) {
    expect(page.content).toContain(`${REPO_URL}/blob/main/docs/`)
    expect(page.content).not.toMatch(/<figure|<svg|<img|<script/)
  }
})

test('landing links once to the seams guide from its seams section', async () => {
  const { 'index.html': html } = await buildFiles()
  expect(html.match(/href="\/docs\/seams\/"/g)).toHaveLength(1)
  const section = html.split('<section').find((part) => part.includes('autobuild · seams'))!
  expect(section.slice(0, section.indexOf('</section>'))).toContain(
    '<a href="/docs/seams/">Explore the infrastructure seams</a>',
  )
})
