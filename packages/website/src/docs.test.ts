import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFiles, buildSite } from './build'
import {
  DOCS_PAGES,
  renderDocsPage,
  prepareHeadings,
  renderDocsNavigation,
  renderPager,
  REPO_REFERENCES,
} from './docs'
import { REPO_URL, SITE_URL } from './constants'

test('docs emit complete shared navigation and distinct metadata with rooted assets', async () => {
  const files = await buildFiles()
  expect(DOCS_PAGES.map((p) => p.path)).toEqual([
    '/docs/',
    '/docs/getting-started/',
    '/docs/builds/',
    '/docs/dispatcher/',
    '/docs/integration/',
    '/docs/tickets/',
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
    expect(html).toContain('<script type="module" src="/site.js"></script>')
    expect(html.match(/<h1[ >]/g)).toHaveLength(1)
    expect(html.match(/data-docs-copy/g)).toHaveLength(1)
    expect(html).toContain(
      'type="button" class="docs-copy" data-docs-copy data-markdown-exclude>Copy as Markdown</button>',
    )
    expect(html).toContain('role="status" aria-live="polite" aria-atomic="true"></span>')
    expect(html.match(/aria-current="page"/g)).toHaveLength(3)
    for (const label of ['Site', 'Documentation']) {
      const nav = html.match(new RegExp(`<nav[^>]*aria-label="${label}"[^>]*>[\\s\\S]*?</nav>`))![0]
      expect(nav.match(/aria-current="page"/g)).toHaveLength(label === 'Site' ? 2 : 1)
    }
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

// Baseline hashes captured from the pre-layout article strings, independent of rendered output.
const baseline: Record<string, string> = {
  '/docs/': '4c5ad4de703c3ed712e115a03052e016609e20e81140858e89aba7e459e4ba76',
  '/docs/getting-started/': '22f59774aedfcc978380bb4a82708b6e0c3ef5f0b5b20edf2b2b417bae352c2a',
  '/docs/builds/': '9501174b11a6ef474a81f347354f9a76894d731c2168936a8854b1da2d20fc93',
  '/docs/dispatcher/': 'd4a673bf44920c1938b22428a59bc66d1c9a45fd68db6005b0508961b062d738',
  '/docs/integration/': 'ab7d2800bb22df819550c51c6c4bb5608db28c95e239c81e122706a9281649c8',
  '/docs/tickets/': '8e95f4b3c594335b984a3bcb63865608137ece2dadc8ef90c8569a2327b67f2b',
  '/docs/operating/': '0e18c80f97f3fd051b9538645329c0b0bd0a11c31a4fa4f164f725ee8cc40040',
  '/docs/seams/': '271dee8c129105b2cc597c274a3671074c4e49a685b7984b22e9ec45d8d77387',
  '/docs/configuration/': '8d18dfa4ac50c8eed17686792ecac2ea25f5f7908158bc8a41289691fc50e982',
}

test('layout preserves every article byte except injected heading IDs', () => {
  for (const page of DOCS_PAGES) {
    expect(new Bun.CryptoHasher('sha256').update(page.content).digest('hex')).toBe(
      baseline[page.path]!,
    )
    const html = renderDocsPage(page)
    const article = html.split('aria-atomic="true"></span>')[1]!.split('</article>')[0]!
    expect(article.replace(/<h2 id="[^"]+">/g, '<h2>')).toBe(page.content)
    expect(html).toContain(`${page.group} · ${page.label.toLowerCase()}`)
    expect(html).toContain(`${REPO_URL}/blob/main/packages/website/src/docs.ts`)
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])
    expect(new Set(ids).size).toBe(ids.length)
    for (const [path] of REPO_REFERENCES) expect(html).toContain(`${REPO_URL}/blob/main/${path}`)
    const nav = renderDocsNavigation(page)
    expect(html.split(nav)).toHaveLength(3)
    expect([...nav.matchAll(/docs-group-label">([^<]+)/g)].map((m) => m[1])).toEqual([
      'start/',
      'concepts/',
      'guides/',
      'reference/',
      'repo/',
    ])
  }
})

test('heading preparation preserves markup and existing anchors and avoids collisions', () => {
  const source =
    '<h2 id="a-b">Existing</h2><h2>A &amp; <code>B</code>!</h2><h2>A &amp; B?</h2><h2>&#x43; &#68; &quot;E&quot;</h2>'
  const prepared = prepareHeadings(source)
  expect(prepared.headings).toEqual([
    { id: 'a-b', label: 'Existing' },
    { id: 'a-b-2', label: 'A & B!' },
    { id: 'a-b-3', label: 'A & B?' },
    { id: 'c-d-e', label: 'C D "E"' },
  ])
  expect(prepared.html).toContain('<h2 id="a-b-2">A &amp; <code>B</code>!</h2>')
})

test('pager boundaries and synthetic additions derive from the same registry', () => {
  expect(renderPager(DOCS_PAGES[0]!)).not.toContain('← previous')
  expect(renderPager(DOCS_PAGES.at(-1)!)).not.toContain('next →')
  const middle = renderPager(DOCS_PAGES[2]!)
  expect(middle).toContain('Getting started')
  expect(middle).toContain('Dispatcher')
  const extra = { ...DOCS_PAGES.at(-1)!, path: '/docs/new/', label: 'New page' }
  const pages = [...DOCS_PAGES, extra]
  expect(renderDocsNavigation(extra, pages)).toContain('New page')
  expect(renderPager(DOCS_PAGES.at(-1)!, pages)).toContain('New page')
  expect(renderPager(extra, pages)).toContain('Configuration')
})
