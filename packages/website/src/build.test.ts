import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFiles, buildSite } from './build'
import { copyText } from './client'
import { INSTALL_COMMAND, REPO_URL } from './constants'

const REFERENCE = join(import.meta.dir, '..', '..', '..', 'design', 'website', 'reference.html')

/** Visible text, one token per text node, ignoring markup, styles, and attributes. */
function textOf(html: string): string[] {
  const body = html.slice(html.indexOf('<body'))
  return body
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
    expect((await readdir(dir)).sort()).toEqual(['index.html', 'site.css', 'site.js'])
  })

  test('copy matches the design reference word for word', async () => {
    const { 'index.html': html } = await buildFiles()
    const reference = textOf(await readFile(REFERENCE, 'utf8'))
    // Diagram labels are absolutely positioned, so only their DOM order may differ from the reference.
    const words = (tokens: string[]): string[] => tokens.join(' ').split(' ').sort()
    expect(words(textOf(html))).toEqual(words(reference))
  })

  test('structure: one h1, h2 per section, initial seam state, links', async () => {
    const { 'index.html': html } = await buildFiles()
    expect(html.match(/<h1[ >]/g)).toHaveLength(1)
    expect(html.match(/<h2[ >]/g)).toHaveLength(html.match(/<section[ >]/g)!.length - 1)
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(7)
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(10)
    expect(html).toContain(`href="${REPO_URL}"`)
    expect(html.match(/role="img" aria-label="[^"]+"/g)).toHaveLength(7)
    expect(html).toContain('fully local')
  })

  test('sections are separated by space alone and the page closes on GitHub', async () => {
    const { 'index.html': html, 'site.css': css } = await buildFiles()
    expect(html).not.toContain('class="rule"')
    expect(html).not.toContain('inside one build-runner')
    expect(html).not.toContain('setup.md')
    const last = html.slice(html.lastIndexOf('<section'))
    expect(last.match(/<a class="btn"/g)).toHaveLength(1)
    expect(last).toContain(`<a class="btn" href="${REPO_URL}">View on GitHub</a>`)
    expect(css).toContain('gap: 288px')
    const phone = css.slice(css.indexOf('@media (max-width: 719px)'))
    expect(phone).toContain('gap: 192px')
    expect(phone).toContain('padding-block: 48px 192px')
  })

  test('each figure has a desktop and a portrait form with one description', async () => {
    const { 'index.html': html, 'site.css': css } = await buildFiles()
    expect(html.match(/class="scroll desk-only"/g)).toHaveLength(4)
    expect(html.match(/class="phone-only"/g)).toHaveLength(4)
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

  test('no resources beyond its own files and the webfont', async () => {
    const { 'index.html': html, 'site.js': js } = await buildFiles()
    const hosts = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map(
      (m) => new URL((m[1] ?? '').replace(/&amp;/g, '&')).host,
    )
    expect(new Set(hosts)).toEqual(new Set(['fonts.googleapis.com', 'github.com']))
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

describe('copy control', () => {
  test('copies the install command', async () => {
    const written: string[] = []
    const clipboard = {
      writeText: async (t: string) => {
        written.push(t)
      },
    }
    expect(await copyText(clipboard, INSTALL_COMMAND)).toBe(true)
    expect(written).toEqual(['bun add -g @defrex/autobuild'])
  })

  test('a refused or missing clipboard does not throw', async () => {
    expect(await copyText({ writeText: () => Promise.reject(new Error('denied')) }, 'x')).toBe(
      false,
    )
    expect(
      await copyText(
        {
          writeText: () => {
            throw new Error('sync')
          },
        },
        'x',
      ),
    ).toBe(false)
    expect(await copyText(undefined, 'x')).toBe(false)
  })
})
