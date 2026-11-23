/**
 * Build the Autobuild ANSI catalog as a static page in `.ab/ui-catalog/`.
 *
 *   bun packages/ui/scripts/catalog.ts            build
 *   bun packages/ui/scripts/catalog.ts --shot     build, then screenshot both themes
 */
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { tokensCss } from '../src/tokens-css'

const pkg = resolve(import.meta.dir, '..')
const repo = resolve(pkg, '../..')
const out = join(repo, '.ab/ui-catalog')

await writeFile(join(pkg, 'src/generated/tokens.css'), tokensCss())
await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })

const result = await Bun.build({
  entrypoints: [join(pkg, 'src/catalog/main.tsx')],
  outdir: out,
  target: 'browser',
  minify: true,
  naming: { entry: '[name].[ext]', asset: 'assets/[name]-[hash].[ext]' },
  define: { 'process.env.NODE_ENV': '"production"' },
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

// Fonts load before first layout: a late face reflows text and shifts the page.
const preloads = (await readdir(join(out, 'assets')).catch(() => []))
  .filter((n) => /\.(ttf|woff2?)$/.test(n))
  .map((n) => `<link rel="preload" href="./assets/${n}" as="font" crossorigin>\n`)
  .join('')

await writeFile(
  join(out, 'index.html'),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Autobuild ANSI catalog</title>
${preloads}<link rel="stylesheet" href="./main.css">
</head>
<body><div id="root"></div><script src="./main.js"></script></body>
</html>
`,
)

let js = 0
let css = 0
for (const name of (await readdir(out)).filter((n) => /\.(js|css)$/.test(n))) {
  const bytes = await Bun.file(join(out, name)).arrayBuffer()
  if (name.endsWith('.js')) js += gzipSync(new Uint8Array(bytes)).length
  if (name.endsWith('.css')) css += gzipSync(new Uint8Array(bytes)).length
}
const fonts = (await readdir(join(out, 'assets')).catch(() => [])).length
console.log(`catalog: ${join(out, 'index.html')}`)
console.log(
  `gzipped: js ${(js / 1024).toFixed(1)} KB, css ${(css / 1024).toFixed(1)} KB, ${fonts} font assets`,
)

if (process.argv.includes('--shot')) {
  const chromium = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].find((p) => Bun.file(p).size > 0)
  if (chromium === undefined) throw new Error('no local Chromium found')
  const profile = join(out, '.profile')
  for (const [theme, width] of [
    ['light', 1440],
    ['dark', 1440],
    ['light', 390],
  ] as const) {
    const file = join(out, `catalog-${theme}-${width}.png`)
    const proc = Bun.spawn(
      [
        chromium,
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        `--user-data-dir=${profile}`,
        `--window-size=${width},9000`,
        '--virtual-time-budget=4000',
        `--screenshot=${file}`,
        `file://${join(out, 'index.html')}?theme=${theme}`,
      ],
      { stdout: 'ignore', stderr: 'ignore' },
    )
    await proc.exited
    console.log(`shot: ${file} (${((await stat(file)).size / 1024).toFixed(0)} KB)`)
  }
  await rm(profile, { recursive: true, force: true })
}
