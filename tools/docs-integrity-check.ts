import { access, readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { loadDocsPages } from '../packages/website/src/docs-content'
import { type DocsPage, renderDocsPage } from '../packages/website/src/docs'

function attributes(html: string, tag: string, attribute: string): string[] {
  // Code examples are not live elements, including authored raw HTML examples.
  html = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(pre|code)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
  return [
    ...html.matchAll(
      new RegExp(
        `<${tag}\\b[^>]*?\\b${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
        'gi',
      ),
    ),
  ].map((match) =>
    (match[1] ?? match[2] ?? match[3] ?? '')
      .replaceAll('&amp;', '&')
      .replaceAll('&quot;', '"')
      .replaceAll('&#39;', "'"),
  )
}
const links = (html: string) => attributes(html, 'a', 'href')
const ids = (html: string) => new Set(attributes(html, '[a-z][a-z0-9-]*', 'id'))

export async function checkDocsIntegrity(
  options: {
    root?: string
    docsRoot?: string
    render?: (page: DocsPage, pages: DocsPage[]) => string
  } = {},
): Promise<string[]> {
  const root = resolve(options.root ?? join(import.meta.dir, '..'))
  const docsRoot = resolve(options.docsRoot ?? join(root, 'docs'))
  const findings: string[] = []
  try {
    let pages: DocsPage[] = []
    try {
      pages = await loadDocsPages(docsRoot)
    } catch (error) {
      findings.push(`Cannot discover public docs: ${String(error)}`)
    }
    const rendered = new Map(
      pages.map((page) => [
        resolve(docsRoot, page.source.slice(5)),
        (options.render ?? renderDocsPage)(page, pages),
      ]),
    )
    const routes = new Map(
      pages.map((page) => [page.path, resolve(docsRoot, page.source.slice(5))]),
    )
    const htmlCache = new Map(rendered)
    async function targetHtml(path: string): Promise<string> {
      const cached = htmlCache.get(path)
      if (cached !== undefined) return cached
      const text = await readFile(path, 'utf8')
      const html = Bun.markdown.html(text, { headings: true })
      htmlCache.set(path, html)
      return html
    }
    async function validate(source: string, href: string) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return
      try {
        const [beforeFragment = '', fragment] = href.split('#')
        const path = decodeURIComponent(beforeFragment.split('?')[0] ?? '')
        const anchor = fragment === undefined ? undefined : decodeURIComponent(fragment)
        let target: string
        if (path.startsWith('/')) {
          if (path === '/') return
          const route = routes.get(path.endsWith('/') ? path : `${path}/`)
          if (!route) throw new Error(`missing website route ${path}`)
          target = route
        } else target = path ? resolve(dirname(source), path) : source
        await access(target)
        if (anchor && (target.endsWith('.md') || rendered.has(target))) {
          if (!ids(await targetHtml(target)).has(anchor))
            throw new Error(`missing fragment #${anchor} in ${target}`)
        }
      } catch (error) {
        findings.push(`${source}: ${href}: ${String(error)}`)
      }
    }
    for (const [source, html] of rendered) {
      const navs = [
        ...html.matchAll(/<(?:nav|div)\b[^>]*aria-label="Documentation"[^>]*>([\s\S]*?)<\/nav>/g),
      ]
      // The mobile header embeds the same navigation in its documentation region.
      const mobile =
        /<div class="docs-menu-navigation"[^>]*>([\s\S]*?)<div class="docs-site-links">/.exec(html)
      if (mobile) navs.push(mobile)
      else findings.push(`${source}: missing Documentation menu navigation`)
      if (!navs.length) findings.push(`${source}: missing Documentation navigation`)
      for (const nav of navs) {
        const targets = links(nav[1]!)
        for (const route of routes.keys())
          if (!targets.includes(route)) findings.push(`${source}: navigation missing ${route}`)
        for (const href of targets) await validate(source, href)
      }
      for (const href of links(html)) await validate(source, href)
    }
    for (const name of (await readdir(docsRoot)).filter((name) => name.endsWith('.md'))) {
      const source = join(docsRoot, name)
      const text = await readFile(source, 'utf8')
      const body = text.replace(/^---\n[\s\S]*?\n---\n/, '')
      for (const href of links(Bun.markdown.html(body, { headings: false })))
        await validate(source, href)
    }
  } catch (error) {
    findings.push(`Cannot check docs integrity: ${String(error)}`)
  }
  return [...new Set(findings)]
}

if (import.meta.main) {
  const findings = await checkDocsIntegrity()
  if (findings.length) {
    console.error(findings.join('\n'))
    process.exitCode = 1
  }
}
