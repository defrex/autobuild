import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { prepareHeadings, type DocsPage } from './docs'
import { DEFAULT_DOCS_ROOT, loadDocsPages } from './docs-content'

/** One file per published page, so concurrent edits to different pages never share a file. */
export const DOCS_BASELINE_DIR = resolve(import.meta.dir, 'docs-baseline')
export const REGENERATE = 'bun run docs:baseline'

export type DocsBaselineEntry = {
  path: string
  label: string
  title: string
  group: string
  description: string
  textHash: string
  headings: string[]
  code: string[]
}

function decode(text: string): string {
  return text.replace(
    /&#(?:x([0-9a-f]+)|(\d+));|&(amp|lt|gt|quot|apos);/gi,
    (_, hex, dec, named) =>
      hex || dec
        ? String.fromCodePoint(parseInt(hex ?? dec, hex ? 16 : 10))
        : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[named]!,
  )
}

export function docsBaselineEntry(page: DocsPage): DocsBaselineEntry {
  const text = decode(page.content.replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
  return {
    path: page.path,
    label: page.label,
    title: page.title,
    group: page.group,
    description: page.description,
    textHash: new Bun.CryptoHasher('sha256').update(text).digest('hex'),
    headings: prepareHeadings(page.content).headings.map((h) => h.label),
    code: [...page.content.matchAll(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/g)].map((m) =>
      decode(m[1]!).replace(/\n$/, ''),
    ),
  }
}

export function docsBaselineFileName(page: DocsPage): string {
  return `${basename(page.source, '.md')}.json`
}

/** File name to exact file bytes; the generator owns the formatting. */
export function renderDocsBaseline(pages: DocsPage[]): Map<string, string> {
  const files = new Map<string, string>()
  for (const page of pages) {
    const name = docsBaselineFileName(page)
    if (files.has(name)) throw new Error(`${page.source}: duplicate docs baseline file ${name}`)
    files.set(name, `${JSON.stringify(docsBaselineEntry(page), null, 2)}\n`)
  }
  return files
}

/** Rewrites changed files and removes files for pages that are no longer published. */
export async function writeDocsBaseline(
  dir = DOCS_BASELINE_DIR,
  docsRoot = DEFAULT_DOCS_ROOT,
): Promise<void> {
  const expected = renderDocsBaseline(await loadDocsPages(docsRoot))
  await mkdir(dir, { recursive: true })
  for (const name of await readdir(dir)) {
    if (name.endsWith('.json') && !expected.has(name)) await rm(join(dir, name), { force: true })
  }
  for (const [name, text] of expected) {
    const path = join(dir, name)
    const current = await readFile(path, 'utf8').catch(() => undefined)
    if (current !== text) await writeFile(path, text)
  }
}

if (import.meta.main) {
  if (process.argv.length !== 2) {
    console.error(`Usage: ${REGENERATE}`)
    process.exitCode = 1
  } else {
    try {
      await writeDocsBaseline()
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  }
}
