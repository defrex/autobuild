import { expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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
import {
  DOCS_BASELINE_DIR,
  REGENERATE,
  renderDocsBaseline,
  writeDocsBaseline,
} from './docs-baseline'
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

test('published pages keep navigation on-site and link only declared repository references', () => {
  const references = new Map([
    ['docs/builds.md', ['docs/spec-standard.md#fit-one-implement-session']],
    ['docs/configuration.md', ['docs/architecture.md#key-boundaries']],
    [
      'docs/cli.md',
      ['docs/accounts.md#dispatcher-admission', 'docs/operator-api.md#permanent-project-deletion'],
    ],
    [
      'docs/dispatcher-hosting.md',
      [
        'docs/accounts.md#dispatcher-admission',
        'docs/setup.md#running-the-dispatcher-without-a-checkout-origin-mode',
        'packages/hosted-dispatcher/README.md#shipped-git',
      ],
    ],
    ['docs/operating.md', ['docs/operator-api.md']],
    ['docs/workspaces.md', ['docs/architecture.md#key-boundaries']],
    [
      'docs/troubleshooting.md',
      [
        'docs/accounts.md#dispatcher-admission',
        'docs/remote-store-protocol.md#7-authentication-and-project-authority',
      ],
    ],
  ])
  for (const page of DOCS_PAGES) {
    const expected = (references.get(page.source) ?? []).map(
      (path) => `${REPO_URL}/blob/main/${path}`,
    )
    const actual = [...page.content.matchAll(/href="([^"]+)"/g)]
      .map((match) => match[1]!)
      .filter(
        (href) => href.startsWith(`${REPO_URL}/blob/`) || href.startsWith(`${REPO_URL}/tree/`),
      )
    expect(actual, page.source).toEqual(expected)
  }
  for (const page of DOCS_PAGES.slice(2))
    expect(page.content).not.toMatch(/<figure|<svg|<img|<script/)
})

test('docs pages match the committed per-page baseline', async () => {
  const expected = renderDocsBaseline(DOCS_PAGES)
  const names = (await readdir(DOCS_BASELINE_DIR)).filter((name) => name.endsWith('.json')).sort()
  expect(names, `baseline files differ from published pages; run ${REGENERATE}`).toEqual(
    [...expected.keys()].sort(),
  )
  for (const name of names) {
    const text = await readFile(join(DOCS_BASELINE_DIR, name), 'utf8')
    expect(JSON.parse(text), `${name}: regenerate with ${REGENERATE}`).toEqual(
      JSON.parse(expected.get(name)!),
    )
    expect(text, `${name}: regenerate with ${REGENERATE}`).toBe(expected.get(name)!)
  }
})

test('docs baseline regeneration is idempotent, per page, and removes stale files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'website-docs-baseline-'))
  try {
    const docs = join(root, 'docs')
    const out = join(root, 'baseline')
    await Bun.write(
      join(docs, 'alpha.md'),
      '---\ntitle: Alpha\ngroup: start\ndescription: First page.\norder: 1\n---\n# Alpha\n\n## One\n\nAlpha words.\n',
    )
    await Bun.write(
      join(docs, 'beta.md'),
      '---\ntitle: Beta\ngroup: concepts\ndescription: Second page.\norder: 2\n---\n# Beta\n\nBeta words.\n\n```\nbun ab\n```\n',
    )
    await Bun.write(join(out, 'gone.json'), '{}\n')
    await Bun.write(join(out, 'notes.txt'), 'kept')
    const snapshot = async () => {
      const names = (await readdir(out)).sort()
      return Object.fromEntries(
        await Promise.all(
          names.map(async (name) => [name, await readFile(join(out, name), 'utf8')]),
        ),
      ) as Record<string, string>
    }
    await writeDocsBaseline(out, docs)
    const first = await snapshot()
    expect(Object.keys(first)).toEqual(['alpha.json', 'beta.json', 'notes.txt'])
    await writeDocsBaseline(out, docs)
    expect(await snapshot()).toEqual(first)
    await writeFile(
      join(docs, 'beta.md'),
      '---\ntitle: Beta\ngroup: concepts\ndescription: Second page.\norder: 2\n---\n# Beta\n\nChanged words.\n\n```\nbun ab\n```\n',
    )
    await writeDocsBaseline(out, docs)
    const second = await snapshot()
    expect(second['alpha.json']).toBe(first['alpha.json']!)
    expect(second['beta.json']).not.toBe(first['beta.json']!)
  } finally {
    await rm(root, { recursive: true, force: true })
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
