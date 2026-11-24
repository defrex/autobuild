/**
 * Build the `ab web` client bundle in memory. `bun run ui:web` writes the
 * result to `packages/core/src/web/assets/`, where it is committed so the
 * published package serves it with no runtime dependencies; a freshness test
 * rebuilds it and compares bytes.
 */
import { join, resolve } from 'node:path'
import type { WebAssetManifest } from '../../../core/src/web/protocol'

const app = import.meta.dir
const pkg = resolve(app, '../..')

/** Entry outputs get fixed served names, so a rebuild never renames a file. */
const RENAME: Record<string, string> = {
  'main.js': 'app.js',
  'main.css': 'app.css',
  'theme-boot.js': 'theme.js',
}

const TYPES: Record<string, string> = {
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  woff2: 'font/woff2',
}

/** Licenses travel beside the fonts they cover; they are not served. */
const LICENSES = ['Atkinson-OFL.txt', 'JetBrains-OFL.txt']

/** The faces the stylesheet declares. */
const FONTS = ['AtkinsonHyperlegibleNext.latin.woff2', 'JetBrainsMono.latin.woff2']

/**
 * Bun's CSS bundler inlines `url()` fonts as data URIs, which the page's
 * `default-src 'self'` policy blocks. Serve each face as a same-origin file
 * instead: replace its exact data URI with the file name.
 */
async function externalizeFonts(css: string, files: Map<string, Uint8Array>): Promise<string> {
  let out = css
  for (const font of FONTS) {
    const bytes = new Uint8Array(await Bun.file(join(pkg, 'fonts', font)).arrayBuffer())
    const inline = `data:font/woff2;base64,${Buffer.from(bytes).toString('base64')}`
    if (!out.includes(inline)) throw new Error(`web bundle stylesheet does not inline ${font}`)
    out = out.replaceAll(inline, font)
    files.set(font, bytes)
  }
  if (out.includes('data:font/')) throw new Error('web bundle stylesheet still inlines a font')
  return out
}

export const WEB_ASSET_DIR = resolve(pkg, '../core/src/web/assets')

export async function buildWebBundle(): Promise<Map<string, Uint8Array>> {
  const result = await Bun.build({
    entrypoints: [join(app, 'main.tsx'), join(app, 'theme-boot.ts')],
    target: 'browser',
    format: 'iife',
    minify: true,
    sourcemap: 'none',
    naming: { entry: '[name].[ext]', chunk: '[name].[ext]', asset: '[name].[ext]' },
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  if (!result.success) {
    throw new Error(`web bundle build failed:\n${result.logs.map(String).join('\n')}`)
  }
  const files = new Map<string, Uint8Array>()
  for (const output of result.outputs) {
    const name = output.path.replace(/^\.\//u, '')
    const served = RENAME[name] ?? name
    if (files.has(served)) throw new Error(`web bundle emitted ${served} twice`)
    files.set(served, new Uint8Array(await output.arrayBuffer()))
  }
  const css = files.get('app.css')
  if (css !== undefined)
    files.set(
      'app.css',
      new TextEncoder().encode(await externalizeFonts(new TextDecoder().decode(css), files)),
    )
  const served = [...files.keys()].sort()
  for (const name of served) {
    const ext = name.slice(name.lastIndexOf('.') + 1)
    if (TYPES[ext] === undefined) throw new Error(`web bundle emitted unexpected ${name}`)
  }
  const manifest: WebAssetManifest = {
    files: served.map((path) => ({ path, type: TYPES[path.slice(path.lastIndexOf('.') + 1)]! })),
    script: 'app.js',
    stylesheet: 'app.css',
    themeScript: 'theme.js',
    fonts: served.filter((name) => name.endsWith('.woff2')),
  }
  for (const required of [manifest.script, manifest.stylesheet, manifest.themeScript])
    if (!files.has(required)) throw new Error(`web bundle is missing ${required}`)
  files.set('manifest.json', new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`))
  for (const license of LICENSES)
    files.set(license, new Uint8Array(await Bun.file(join(pkg, 'fonts', license)).arrayBuffer()))
  return new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}
