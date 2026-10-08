import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFiles, heroFrameText } from '../packages/website/src/build'
import { OG_HEIGHT, OG_WIDTH, renderOgCard } from '../packages/website/src/og'
import { chromiumBinary } from './website-capture'

/**
 * Regenerate the website's link-preview image.
 *
 * The card is an HTML page drawn in the site's own stylesheet and webfont, so
 * it is screenshotted with a local Chromium rather than rasterized at build
 * time; the PNG is tracked at `packages/website/src/og.png` and copied into
 * `dist/` by the site build. Font rasterization differs between machines, so
 * there is no byte-for-byte check: rerun this after changing the headline,
 * the hero frame, or the site's styles, and look at the result.
 */

const REPO_ROOT = join(import.meta.dir, '..')
export const OG_PATH = join(REPO_ROOT, 'packages', 'website', 'src', 'og.png')

export async function captureOgCard(
  options: { chromium?: string; output?: string } = {},
): Promise<string> {
  const chromium = options.chromium ?? chromiumBinary()
  if (!chromium) {
    throw new Error(
      'website og capture: no Chromium binary found. Install chromium or set CHROMIUM_BIN.',
    )
  }
  const output = options.output ?? OG_PATH
  const files = await buildFiles()
  const card = renderOgCard(await heroFrameText())
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url)
      if (pathname === '/og.html') {
        return new Response(card, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      }
      if (pathname === '/site.css') {
        return new Response(files['site.css'], {
          headers: { 'content-type': 'text/css; charset=utf-8' },
        })
      }
      return new Response('not found', { status: 404 })
    },
  })
  const profile = await mkdtemp(join(tmpdir(), 'ab-website-og-'))
  try {
    const proc = Bun.spawn(
      [
        chromium,
        '--headless=new',
        '--hide-scrollbars',
        '--disable-gpu',
        '--no-sandbox',
        '--no-first-run',
        '--disable-extensions',
        '--run-all-compositor-stages-before-draw',
        '--disable-features=PaintHolding',
        `--user-data-dir=${profile}`,
        '--force-device-scale-factor=1',
        `--window-size=${OG_WIDTH},${OG_HEIGHT}`,
        '--virtual-time-budget=5000',
        `--screenshot=${output}`,
        `http://127.0.0.1:${server.port}/og.html`,
      ],
      { stdout: 'ignore', stderr: 'pipe', timeout: 90_000 },
    )
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
    if (code !== 0) {
      throw new Error(
        `website og capture: Chromium exited ${code}\n${stderr.trim() || '(no stderr)'}`,
      )
    }
    if ((await stat(output)).size === 0) {
      throw new Error(`website og capture: no screenshot written at ${output}`)
    }
    return output
  } finally {
    server.stop(true)
    await rm(profile, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  try {
    console.log(`wrote the link-preview card to ${await captureOgCard()}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
