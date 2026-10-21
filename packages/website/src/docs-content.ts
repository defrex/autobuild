import { readdir, readFile, access } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import type { DocsPage } from './docs'
import { REPO_URL } from './constants'

export const DEFAULT_DOCS_ROOT = resolve(import.meta.dir, '../../../docs')
const GROUPS = ['start', 'concepts', 'guides', 'reference'] as const

function metadata(text: string, source: string): Record<string, unknown> | undefined {
  if (!text.startsWith('---\n')) return undefined
  const end = text.indexOf('\n---\n', 4)
  if (end < 0) throw new Error(`${source}: unclosed frontmatter`)
  const value = Bun.YAML.parse(text.slice(4, end))
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${source}: frontmatter must be a mapping`)
  return value as Record<string, unknown>
}

/** Publication is opt-in, and discovery happens on every build, including dev requests. */
export async function loadDocsPages(docsRoot = DEFAULT_DOCS_ROOT): Promise<DocsPage[]> {
  docsRoot = resolve(docsRoot)
  const names = (await readdir(docsRoot)).filter((name) => name.endsWith('.md')).sort()
  const entries: { page: DocsPage; body: string; absolute: string }[] = []
  for (const name of names) {
    const absolute = join(docsRoot, name)
    const text = await readFile(absolute, 'utf8')
    const meta = metadata(text, name)
    if (!meta) continue
    for (const key of ['title', 'group', 'description']) {
      if (typeof meta[key] !== 'string' || !(meta[key] as string).trim())
        throw new Error(`${name}: ${key} must be a nonempty string`)
    }
    if (!GROUPS.includes(meta.group as DocsPage['group'])) throw new Error(`${name}: invalid group`)
    if (typeof meta.order !== 'number' || !Number.isFinite(meta.order))
      throw new Error(`${name}: order must be a finite number`)
    if (meta.label !== undefined && (typeof meta.label !== 'string' || !meta.label.trim()))
      throw new Error(`${name}: label must be a nonempty string`)
    const slug = meta.slug === undefined ? basename(name, '.md') : meta.slug
    if (typeof slug !== 'string' || (slug !== '' && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)))
      throw new Error(`${name}: unsafe slug`)
    const path = slug ? `/docs/${slug}/` : '/docs/'
    if (entries.some(({ page }) => page.path === path))
      throw new Error(`${name}: duplicate route ${path}`)
    const body = text.slice(text.indexOf('\n---\n', 4) + 5).trimStart()
    const titleLine = `# ${meta.title}`
    if (body.split('\n', 1)[0] !== titleLine)
      throw new Error(`${name}: expected one opening h1 matching title`)
    entries.push({
      absolute,
      body: body.slice(titleLine.length).trimStart(),
      page: {
        title: meta.title as string,
        description: meta.description as string,
        group: meta.group as DocsPage['group'],
        order: meta.order,
        label: (meta.label ?? meta.title) as string,
        source: `docs/${name}`,
        path,
        file: `${path.slice(1)}index.html`,
        content: '',
      },
    })
  }
  const routes = new Map(entries.map(({ absolute, page }) => [absolute, page.path]))
  for (const entry of entries) {
    let html = Bun.markdown.html(entry.body, { headings: false })
    if (/<h1[ >]/.test(html))
      throw new Error(`${entry.page.source}: expected one opening h1 matching title`)
    const replacements = new Map<string, string>()
    for (const match of html.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)) {
      const href = match[1]!
      if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(href)) continue
      const [, target, suffix = ''] = /^([^?#]*)(.*)$/.exec(href)!
      if (!target?.endsWith('.md')) continue
      const absolute = resolve(dirname(entry.absolute), decodeURIComponent(target))
      try {
        await access(absolute)
      } catch {
        throw new Error(`${entry.page.source}: missing Markdown target ${target}`)
      }
      const route = routes.get(absolute)
      const repoPath = relative(dirname(docsRoot), absolute).split('\\').join('/')
      replacements.set(href, `${route ?? `${REPO_URL}/blob/main/${repoPath}`}${suffix}`)
    }
    html = html.replace(
      /(<a\b[^>]*\bhref=")([^"]*)(")/g,
      (_, before: string, href: string, after: string) =>
        `${before}${replacements.get(href) ?? href}${after}`,
    )
    entry.page.content = html.replaceAll('<pre><code', '<pre class="terminal"><code')
  }
  return entries
    .sort(
      (a, b) =>
        GROUPS.indexOf(a.page.group) - GROUPS.indexOf(b.page.group) ||
        a.page.order - b.page.order ||
        a.page.source.localeCompare(b.page.source),
    )
    .map(({ page }) => page)
}
