import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFiles, buildSite } from './build'
import {
  renderDocsPage,
  prepareHeadings,
  renderDocsNavigation,
  renderPager,
  REPO_REFERENCES,
} from './docs'
import { loadDocsPages } from './docs-content'
import baseline from './docs-baseline.json'
const DOCS_PAGES = await loadDocsPages()

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
    '/docs/intake/',
    '/docs/skills/',
    '/docs/verification/',
    '/docs/operating/',
    '/docs/plugin-authoring/',
    '/docs/seams/',
    '/docs/configuration/',
    '/docs/forges/',
    '/docs/build-store/',
    '/docs/dispatcher-hosting/',
    '/docs/operator-surfaces/',
    '/docs/ticket-sources/',
    '/docs/agent-runtimes/',
    '/docs/workspaces/',
    '/docs/cli/',
    '/docs/upgrading/',
    '/docs/troubleshooting/',
    '/docs/glossary/',
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
      expect(await readFile(join(dir, page.file), 'utf8')).toBe(renderDocsPage(page, DOCS_PAGES))
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
  const html = renderDocsPage(
    { ...DOCS_PAGES[0]!, title: '<unsafe>"&', description: '"<text>&' },
    DOCS_PAGES,
  )
  expect(html).toContain('<title>&lt;unsafe&gt;&quot;&amp; · Autobuild docs</title>')
  expect(html).toContain('content="&quot;&lt;text&gt;&amp;"')
})

test('published pages link only within the site, and feature guides are text-only', () => {
  for (const page of DOCS_PAGES) {
    expect(page.content, page.source).not.toContain(`${REPO_URL}/blob/`)
    expect(page.content, page.source).not.toContain(`${REPO_URL}/tree/`)
  }
  for (const page of DOCS_PAGES.slice(2))
    expect(page.content).not.toMatch(/<figure|<svg|<img|<script/)
})

test('layout preserves article words and headings from independent HTML baselines', () => {
  for (const original of baseline) {
    const page = DOCS_PAGES.find((entry) => entry.path === original.path)
    expect(page, `missing historical page ${original.path}`).toBeDefined()
    if (!page) continue
    const decode = (text: string) =>
      text.replace(/&#(?:x([0-9a-f]+)|(\d+));|&(amp|lt|gt|quot|apos);/gi, (_, hex, dec, named) =>
        hex || dec
          ? String.fromCodePoint(parseInt(hex ?? dec, hex ? 16 : 10))
          : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[
              named
            ]!,
      )
    const text = decode(page.content.replace(/<[^>]+>/g, ''))
      .replace(/\s+/g, ' ')
      .trim()
    expect(new Bun.CryptoHasher('sha256').update(text).digest('hex')).toBe(original.textHash)
    expect(prepareHeadings(page.content).headings.map((h) => h.label)).toEqual(original.headings)
    expect(
      [...page.content.matchAll(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/g)].map((m) =>
        decode(m[1]!).replace(/\n$/, ''),
      ),
    ).toEqual(original.code)
    for (const key of ['path', 'label', 'title', 'group', 'description'] as const)
      expect(page[key]).toBe(original[key])
  }
})

test('every discovered article preserves rendering, headings, and shared navigation', () => {
  for (const page of DOCS_PAGES) {
    const html = renderDocsPage(page, DOCS_PAGES)
    const article = html.split('aria-atomic="true"></span>')[1]!.split('</article>')[0]!
    expect(article).toBe(prepareHeadings(page.content).html)
    expect(html).toContain(`${page.group} · ${page.label.toLowerCase()}`)
    expect(html).toContain(`${REPO_URL}/blob/main/${page.source}`)
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])
    expect(new Set(ids).size).toBe(ids.length)
    for (const [path] of REPO_REFERENCES) expect(html).toContain(`${REPO_URL}/blob/main/${path}`)
    const nav = renderDocsNavigation(page, DOCS_PAGES)
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
  expect(renderPager(DOCS_PAGES[0]!, DOCS_PAGES)).not.toContain('← previous')
  expect(renderPager(DOCS_PAGES.at(-1)!, DOCS_PAGES)).not.toContain('next →')
  const middle = renderPager(DOCS_PAGES[2]!, DOCS_PAGES)
  expect(middle).toContain('Getting started')
  expect(middle).toContain('Dispatcher')
  const extra = { ...DOCS_PAGES.at(-1)!, path: '/docs/new/', label: 'New page' }
  const pages = [...DOCS_PAGES, extra]
  expect(renderDocsNavigation(extra, pages)).toContain('New page')
  expect(renderPager(DOCS_PAGES.at(-1)!, pages)).toContain('New page')
  expect(renderPager(extra, pages)).toContain(DOCS_PAGES.at(-1)!.label)
})

test('seam overview reuses the selector and links every seam guide', async () => {
  const files = await buildFiles()
  expect(files['index.html']).toContain('class="seam-selector"')
  for (const page of DOCS_PAGES) {
    const html = files[page.file]!
    expect(html.includes('class="seam-selector"')).toBe(page.path === '/docs/seams/')
    expect(page.content).not.toContain('class="seam-selector"')
  }
  const overview = DOCS_PAGES.find((p) => p.path === '/docs/seams/')!
  for (const slug of [
    'ticket-sources',
    'agent-runtimes',
    'workspaces',
    'forges',
    'build-store',
    'dispatcher-hosting',
    'operator-surfaces',
  ]) {
    expect(overview.content).toContain(`href="/docs/${slug}/"`)
  }
  for (const slug of ['ticket-sources', 'agent-runtimes', 'workspaces']) {
    expect(DOCS_PAGES.find((p) => p.path === `/docs/${slug}/`)!.content).toContain(
      'href="/docs/plugin-authoring/',
    )
  }
  const seams = files[overview.file]!
  expect(seams.indexOf('</article>')).toBeLessThan(seams.indexOf('class="seam-selector"'))
})

test('retired server documentation has no source, route or link in the site', async () => {
  const files = await buildFiles()
  for (const slug of [
    'hosted-service',
    'hosted-dispatcher',
    'hosted-dispatcher-cutover-validation',
    'mcp',
  ]) {
    expect(await Bun.file(join(import.meta.dir, '../../../docs', `${slug}.md`)).exists()).toBe(
      false,
    )
    expect(DOCS_PAGES.some((page) => page.path === `/docs/${slug}/`)).toBe(false)
    expect(files[`docs/${slug}/index.html`]).toBeUndefined()
    for (const content of Object.values(files)) {
      if (typeof content !== 'string') continue
      expect(content).not.toMatch(
        new RegExp(`(?:href|src)=["'][^"']*(?:/docs/${slug}/|(?:^|/)${slug}\\.md)`),
      )
    }
  }
})
