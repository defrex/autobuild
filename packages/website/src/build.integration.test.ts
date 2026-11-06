import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFiles, buildSite } from './build'
import { HEADLINE, INSTALL_COMMAND, LEAD, REPO_URL, SITE_URL } from './constants'

const REFERENCE = join(import.meta.dir, '..', '..', '..', 'design', 'website', 'reference.html')

/** Visible text, one token per text node, ignoring markup, styles, and attributes. */
function textOf(html: string): string[] {
  const body = html.slice(html.indexOf('<body'))
  return body
    .replace(/<header[\s\S]*?<\/header>/g, '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, '')
    .replace(/<br\s*\/?>/g, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .split('\n')
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter((t) => t.length > 0)
}

const tmp: string[] = []
afterAll(async () => {
  for (const dir of tmp) await rm(dir, { recursive: true, force: true })
})

describe('static site', () => {
  test('buildSite writes plain files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'website-'))
    tmp.push(dir)
    await buildSite(dir)
    expect((await readdir(dir)).sort()).toEqual([
      'docs',
      'index.html',
      'og.png',
      'site.css',
      'site.js',
    ])
  })

  test('copy matches the design reference word for word', async () => {
    const { 'index.html': html } = await buildFiles()
    const updatedReference = (await readFile(REFERENCE, 'utf8'))
      .replaceAll('bun add -g @defrex/autobuild', INSTALL_COMMAND)
      .replaceAll('>ab init<', '>bun ab init<')
      .replaceAll('>ab dispatch<', '>bun ab dispatch<')
      // hosted-protocol-docs authorizes these factual selector refinements.
      .replace(/<button[^>]*>cron<\/button>/, '')
      .replace('>Postgres<', '>remote store<')
      .replace('>web UI<', '>Operator API<')
      .replace('>MCP<', '>stdio MCP<')
    const reference = textOf(updatedReference)
    const landing = html
      .replace(
        /<section class="section">(?:(?!<section)[\s\S])*?autobuild · integration[\s\S]*?<\/section>/,
        '',
      )
      .replace('<a class="btn" href="/docs/getting-started/">Getting started</a>', '')
    // Diagram labels are absolutely positioned, so only their DOM order may differ from the reference.
    const words = (tokens: string[]): string[] => tokens.join(' ').split(' ').sort()
    expect(words(textOf(landing))).toEqual(words(reference))
  })

  test('four figures are static drawings with capture IDs and no motion', async () => {
    const { 'index.html': html, 'site.js': js } = await buildFiles()
    for (const id of ['pipeline', 'dispatcher', 'intake', 'integration-tree']) {
      expect(html.match(new RegExp(`data-capture-figure="${id}"`, 'g'))).toHaveLength(1)
    }
    expect(html).not.toContain('data-capture-animated')
    expect(html).not.toContain('data-motion')
    expect(js).not.toContain('__websiteCapture')
    // Docs copy uses the canonical origin as a URL base, without a network service.
    expect(js.replaceAll(SITE_URL, '')).not.toMatch(/https?:\/\//)
  })

  test('the hero leads into the getting-started commands, then Documentation and a ghost GitHub', async () => {
    const { 'index.html': html } = await buildFiles()
    const first = html.slice(html.indexOf('<section'), html.indexOf('</section>'))
    expect(first).toMatch(
      /<\/div><\/div><div class="actions links"><a class="btn" href="\/docs\/">Documentation<\/a><a class="btn ghost" href="[^"]+">GitHub<\/a><\/div>$/,
    )
    expect(first).not.toContain('class="frame"')
    expect(first).not.toContain('data-copy')
    const terminal = (section: string): string =>
      section.match(
        /<div class="terminal">(?:<div class="cmd">[\s\S]*?<\/span><\/div>){4}<\/div>/,
      )![0]
    const last = html.slice(html.lastIndexOf('<section'))
    expect(terminal(first)).toBe(terminal(last))
    expect(terminal(first)).toContain(`<b>${INSTALL_COMMAND}</b>`)
  })

  test('sections carry no inline docs links', async () => {
    const { 'index.html': html } = await buildFiles()
    expect(html.slice(html.indexOf('<main'))).not.toMatch(/<p><a href="\/docs\//)
    for (const path of ['builds', 'dispatcher', 'integration', 'seams', 'tickets']) {
      expect(html).not.toContain(`href="/docs/${path}/"`)
    }
  })

  test('structure: one h1, h2 per section, initial seam state, links', async () => {
    const { 'index.html': html } = await buildFiles()
    expect(html.match(/<h1[ >]/g)).toHaveLength(1)
    expect(html.match(/<h2[ >]/g)).toHaveLength(html.match(/<section[ >]/g)!.length - 1)
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(7)
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(9)
    expect(html).toContain(`href="${REPO_URL}"`)
    expect(html.match(/role="img" aria-label="[^"]+"/g)).toHaveLength(6)
    expect(html).toContain('fully local')
    expect(html).toContain('bun add -D @defrex/autobuild')
    expect(html).toContain('bun ab init')
    expect(html).toContain('bun ab dispatch')
  })

  test('sections are separated by space alone and the page closes on GitHub', async () => {
    const { 'index.html': html, 'site.css': css } = await buildFiles()
    expect(html.slice(html.indexOf('<main'))).not.toContain('site-rule')
    expect(html).not.toContain('inside one build-runner')
    expect(html).not.toContain('setup.md')
    const last = html.slice(html.lastIndexOf('<section'))
    expect(last.match(/<a class="btn"/g)).toHaveLength(2)
    expect(last).toContain(`<a class="btn" href="${REPO_URL}">View on GitHub</a>`)
    expect(css).toContain('gap: 288px')
    const phone = css.slice(css.indexOf('@media (max-width: 719px)'))
    expect(phone).toContain('gap: 192px')
    expect(phone).toContain('padding-block: 48px 192px')
  })

  test('each drawn figure has a desktop and a portrait form with one description', async () => {
    // The integration figure is preformatted terminal text that scrolls instead.
    const { 'index.html': html, 'site.css': css } = await buildFiles()
    expect(html.match(/class="scroll desk-only"/g)).toHaveLength(3)
    expect(html.match(/class="phone-only"/g)).toHaveLength(3)
    const desk = [...html.matchAll(/class="scroll desk-only"[^>]*aria-label="([^"]+)"/g)].map(
      (m) => m[1],
    )
    const phone = [...html.matchAll(/class="phone-only" role="img" aria-label="([^"]+)"/g)].map(
      (m) => m[1],
    )
    expect(phone).toEqual(desk)
    // Every portrait drawing is capped to the page width, never a fixed desktop size.
    expect(html.match(/width: 358px; max-width: 100%/g)).toHaveLength(3)
    const small = css.slice(css.indexOf('@media (max-width: 719px)'))
    expect(small).toMatch(/\.desk-only\s*{\s*display: none/)
    expect(small).toMatch(/\.phone-only\s*{\s*display: block/)
    expect(css).toMatch(/\.phone-only\s*{\s*display: none/)
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('a shared link previews with the headline, the lead, and the card image', async () => {
    const { 'index.html': html, 'og.png': png } = await buildFiles()
    const head = html.slice(0, html.indexOf('<body'))
    const meta = (selector: string): string | undefined =>
      new RegExp(`<meta (?:property|name)="${selector}" content="([^"]*)">`).exec(head)?.[1]
    expect(meta('description')).toBe(LEAD)
    expect(meta('og:title')).toBe(HEADLINE)
    expect(meta('og:description')).toBe(LEAD)
    expect(meta('og:url')).toBe(`${SITE_URL}/`)
    expect(meta('og:image')).toBe(`${SITE_URL}/og.png`)
    expect(meta('og:image:width')).toBe('1200')
    expect(meta('og:image:height')).toBe('630')
    expect(meta('og:image:alt')).toBeTruthy()
    expect(meta('twitter:card')).toBe('summary_large_image')
    expect(meta('twitter:image')).toBe(`${SITE_URL}/og.png`)
    expect(head).toContain(`<link rel="canonical" href="${SITE_URL}/">`)
    // The tracked card is a 1200x630 PNG: the signature, then IHDR width and height.
    expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([1200, 630])
  })

  test('no resources beyond its own files and the webfont', async () => {
    const { 'index.html': html, 'site.js': js } = await buildFiles()
    const hosts = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map(
      (m) => new URL((m[1] ?? '').replace(/&amp;/g, '&')).host,
    )
    expect(new Set(hosts)).toEqual(
      new Set(['fonts.googleapis.com', 'github.com', 'www.autobuild.run']),
    )
    expect(js).not.toContain('fetch(')
  })

  test('styles keep to the flat grid', async () => {
    const { 'site.css': css } = await buildFiles()
    expect(css).not.toMatch(/box-shadow|gradient|text-shadow|italic/)
    expect(css).not.toMatch(/border-radius\s*:\s*[^0;\s]/)
    for (const m of css.matchAll(/font-weight\s*:\s*(\d+)/g))
      expect(['400', '700']).toContain(m[1] as string)
  })
})

describe('knob motion', () => {
  test('the knob glides in 250ms or less and is still under reduced motion', async () => {
    const { 'site.css': css, 'index.html': html } = await buildFiles()
    const rule = css.match(/\.knob\s*{([^}]*)}/)?.[1] ?? ''
    const ms = Number(rule.match(/transition:\s*left\s+(\d+)ms/)?.[1])
    expect(ms).toBeGreaterThan(0)
    expect(ms).toBeLessThanOrEqual(250)
    const reduced =
      css.match(/@media \(prefers-reduced-motion: reduce\)\s*{([\s\S]*?})\s*}/)?.[1] ?? ''
    expect(reduced).toMatch(/\.knob\s*{[^}]*transition:\s*none/)
    expect(html).toMatch(/class="knob" style="left: [^"]*"/)
    expect(html).not.toMatch(/class="knob"[^>]*(animation|transition)/)
  })
})
