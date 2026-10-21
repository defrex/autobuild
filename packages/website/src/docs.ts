import { renderSiteHeader } from './site-header'
import { REPO_URL, SITE_URL } from './constants'
import { OG_HEIGHT, OG_IMAGE_ALT, OG_WIDTH } from './og'

export interface DocsPage {
  group: 'start' | 'concepts' | 'guides' | 'reference'
  path: string
  file: `${string}.html`
  label: string
  title: string
  description: string
  source: string
  order: number
  content: string
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function renderDocsPage(page: DocsPage, pages: readonly DocsPage[]): string {
  const title = `${page.title} · Autobuild docs`
  const url = `${SITE_URL}${page.path}`
  const nav = renderDocsNavigation(page, pages)
  const prepared = prepareHeadings(page.content)
  const toc = renderToc(prepared.headings)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(page.description)}">
<link rel="canonical" href="${escapeHtml(url)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Autobuild">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(page.description)}">
<meta property="og:url" content="${escapeHtml(url)}">
<meta property="og:image" content="${SITE_URL}/og.png">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="${OG_WIDTH}">
<meta property="og:image:height" content="${OG_HEIGHT}">
<meta property="og:image:alt" content="${escapeHtml(OG_IMAGE_ALT)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(page.description)}">
<meta name="twitter:image" content="${SITE_URL}/og.png">
<meta name="twitter:image:alt" content="${escapeHtml(OG_IMAGE_ALT)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&amp;display=swap">
<link rel="stylesheet" href="/site.css">
</head>
<body class="docs" id="top">
<a class="skip-link" href="#content">Skip to content</a>
${renderSiteHeader('docs', nav)}
<div data-docs>
<div class="docs-inline-toc"><button type="button" data-toc-toggle aria-expanded="true" aria-controls="docs-sections">On this page <span aria-hidden="true">▾</span></button><div id="docs-sections">${toc}</div>${docsRule()}</div>
<div class="docs-shell">
<nav class="docs-nav docs-sidebar" aria-label="Documentation">${nav}</nav>
<main id="content" tabindex="-1"><article><div class="docs-eyebrow">${page.group} · ${escapeHtml(page.label.toLowerCase())}</div><div class="docs-title-row"><h1 class="headline">${escapeHtml(page.title)}</h1><button type="button" class="docs-copy" data-docs-copy data-markdown-exclude>Copy as Markdown</button></div><span class="docs-copy-status" data-copy-status data-markdown-exclude role="status" aria-live="polite" aria-atomic="true"></span>${prepared.html}</article>${docsRule()}${renderPager(page, pages)}</main>
<aside class="docs-toc docs-sidebar" aria-label="Page sections"><b>On this page</b>${toc}${docsRule()}<a href="${REPO_URL}/blob/main/${page.source}">Edit this page ↗</a><a href="#top">Back to top ↑</a></aside>
</div>
<footer class="docs-footer">${docsRule()}<div><span>Autobuild · Apache-2.0</span><span><a href="/">Home</a> <a href="${REPO_URL}">GitHub ↗</a></span></div></footer>
</div>
<script type="module" src="/site.js"></script>
</body>
</html>
`
}

export const REPO_REFERENCES = [
  ['SPEC.md', 'Design spec'],
  ['docs/architecture.md', 'Architecture map'],
  ['docs/configuration.md', 'Configuration reference'],
  ['skills/guide/references/spec-standard.md', 'Spec standard'],
] as const

export function docsRule(): string {
  return `<div class="docs-rule" aria-hidden="true">${'─'.repeat(200)}</div>`
}

export function renderDocsNavigation(page: DocsPage, pages: readonly DocsPage[]): string {
  const groups = [...new Set(pages.map((entry) => entry.group))]
  return (
    groups
      .map(
        (group) =>
          `<div class="docs-group"><div class="docs-group-label">${group}/</div>${pages
            .filter((entry) => entry.group === group)
            .map(
              (entry) =>
                `<a href="${escapeHtml(entry.path)}"${entry.path === page.path ? ' aria-current="page"' : ''}><span class="docs-marker" aria-hidden="true">${entry.path === page.path ? '&gt;' : ' '}</span><span>${escapeHtml(entry.label)}</span></a>`,
            )
            .join('')}</div>`,
      )
      .join('') +
    `<div class="docs-group"><div class="docs-group-label">repo/</div>${REPO_REFERENCES.map(([path, label]) => `<a href="${REPO_URL}/blob/main/${path}"><span class="docs-marker" aria-hidden="true"> </span><span>${label} ↗</span></a>`).join('')}</div>`
  )
}

export function renderPager(page: DocsPage, pages: readonly DocsPage[]): string {
  const index = pages.findIndex((entry) => entry.path === page.path)
  return `<nav class="docs-pager" aria-label="Adjacent pages">${([-1, 1] as const)
    .map((offset) => {
      const entry = index < 0 ? undefined : pages[index + offset]
      return entry
        ? `<a class="${offset === 1 ? 'docs-next' : ''}" href="${escapeHtml(entry.path)}"><span>${offset === -1 ? '← previous' : 'next →'}</span><b>${escapeHtml(entry.label)}</b></a>`
        : '<span></span>'
    })
    .join('')}</nav>`
}

export interface DocsHeading {
  id: string
  label: string
}
function headingText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity: string) => {
      if (entity.startsWith('#'))
        return String.fromCodePoint(
          entity[1]?.toLowerCase() === 'x'
            ? parseInt(entity.slice(2), 16)
            : Number(entity.slice(1)),
        )
      return (
        ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[
          entity.toLowerCase()
        ] ?? _
      )
    })
}
export function prepareHeadings(content: string): { html: string; headings: DocsHeading[] } {
  const used = new Set([...content.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]!))
  const headings: DocsHeading[] = []
  const html = content.replace(
    /<h2([^>]*)>([\s\S]*?)<\/h2>/g,
    (_, attrs: string, inner: string) => {
      const label = headingText(inner)
      let id = /\bid="([^"]+)"/.exec(attrs)?.[1]
      if (!id) {
        const base =
          label
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, '-')
            .replace(/^-|-$/g, '') || 'section'
        id = base
        let suffix = 2
        while (used.has(id)) id = `${base}-${suffix++}`
        used.add(id)
        attrs += ` id="${escapeHtml(id)}"`
      }
      headings.push({ id, label })
      return `<h2${attrs}>${inner}</h2>`
    },
  )
  return { html, headings }
}
function renderToc(headings: DocsHeading[]): string {
  return `<ul class="docs-section-list">${headings.map(({ id, label }, index) => `<li><a data-section="${escapeHtml(id)}" href="#${escapeHtml(id)}"${index === 0 ? ' aria-current="location"' : ''}><span class="docs-marker" aria-hidden="true">${index === 0 ? '&gt;' : ' '}</span><span>${escapeHtml(label)}</span></a></li>`).join('')}</ul>`
}
