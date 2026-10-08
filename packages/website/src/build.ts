import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { renderPage } from './page'

const SRC = import.meta.dir
export const DEFAULT_OUT = join(SRC, '..', 'dist')

export interface SiteFiles {
  'index.html': string
  'site.css': string
  'site.js': string
}

/** Everything the site is made of, as text. */
export async function buildFiles(): Promise<SiteFiles> {
  const bundle = await Bun.build({
    entrypoints: [join(SRC, 'client.ts')],
    minify: true,
    target: 'browser',
  })
  if (!bundle.success) throw new Error(bundle.logs.map(String).join('\n'))
  const [output] = bundle.outputs
  return {
    'index.html': renderPage({ heroFrame: await Bun.file(join(SRC, 'hero-frame.txt')).text() }),
    'site.css': await Bun.file(join(SRC, 'styles.css')).text(),
    'site.js': await (output as Bun.BuildArtifact).text(),
  }
}

export async function buildSite(outDir: string = DEFAULT_OUT): Promise<string> {
  const files = await buildFiles()
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
  for (const [name, content] of Object.entries(files)) await Bun.write(join(outDir, name), content)
  return outDir
}

if (import.meta.main) {
  const out = await buildSite()
  console.log(`built the site into ${out}`)
}
