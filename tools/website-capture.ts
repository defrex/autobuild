import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { buildFiles, type SiteFiles } from '../packages/website/src/build'
import { SEAMS } from '../packages/website/src/seams'

const REPO_ROOT = join(import.meta.dir, '..')
export const DEFAULT_OUTPUT_DIR = join(REPO_ROOT, '.ab', 'website-frames')

/** Tallest page the capture will screenshot. */
export const MAX_PAGE_HEIGHT = 12_000
const ATTEMPTS = 2

export interface WebsiteFrame {
  id: string
  width: number
  /** Switch the seam selector to fully remote before measuring and shooting. */
  remote: boolean
  /** The approved reference screenshot this frame is judged against. */
  reference: string
}

export const WEBSITE_FRAMES: readonly WebsiteFrame[] = [
  { id: 'desktop', width: 1440, remote: false, reference: 'design/website/reference-desktop.png' },
  { id: 'phone', width: 390, remote: false, reference: 'design/website/reference-phone.png' },
  {
    id: 'desktop-remote',
    width: 1440,
    remote: true,
    reference: 'design/website/reference-desktop-remote.png',
  },
  // The design ships no 390px remote shot: this frame is judged against the local phone
  // reference for layout and spacing only, and its seam states differ by design.
  { id: 'phone-remote', width: 390, remote: true, reference: 'design/website/reference-phone.png' },
]

/** Pixels between consecutive sections, and from the last section to the footer. */
export function expectedSectionGap(frame: WebsiteFrame): number {
  return frame.width >= 720 ? 288 : 192
}

/** The closing section's terminal-to-button gap; in-section spacing is unchanged. */
export const EXPECTED_CTA_GAP = 48

export interface ChipProbe {
  seam: string
  adapter: string
  pressed: string | null
}

export interface Probe {
  scrollWidth: number
  innerWidth: number
  scrollHeight: number
  stylesheetLoaded: boolean
  lean: string | null
  status: string | null
  /** True once the knob has no running animation or transition. */
  knobSettled: boolean
  /** The adapter id pressed in the runtime row. */
  runtime: string | null
  chips: ChipProbe[]
  /** Gap between each pair of consecutive `main .section` elements, in whole pixels. */
  sectionGaps: number[]
  /** Last section's bottom to the footer's top. */
  footerGap: number
  /** Closing section's `.terminal` bottom to its `.actions` top. */
  ctaGap: number
}

export function chromiumBinary(
  env: Record<string, string | undefined> = process.env,
  exists: (path: string) => boolean = existsSync,
  which: (name: string) => string | undefined | null = (name) => Bun.which(name),
): string | undefined {
  for (const value of [env.CHROMIUM_BIN, env.CHROME_BIN]) {
    if (value && exists(value)) return value
  }
  for (const path of [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]) {
    if (exists(path)) return path
  }
  for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
    const found = which(name)
    if (found) return found
  }
  return undefined
}

/** Longer than the knob's 200ms glide, so the remote frame is probed after it should have settled. */
const KNOB_SETTLE_MS = 350

function probeScript(remote: boolean): string {
  return `<script>
addEventListener('DOMContentLoaded', () => setTimeout(() => {
  ${remote ? `document.querySelector('[data-set="remote"]')?.click()` : ''}
  setTimeout(() => {
    const knob = document.querySelector('.knob')
    // Chromium's virtual-time budget freezes the animation clock, so the glide never advances on
    // its own; finish it so the shot shows the settled knob, then check it sits at the rail's end.
    knob?.getAnimations().forEach((a) => a.finish())
    const rail = knob?.parentElement
    const knobSettled =
      knob !== null && knob !== undefined && knob.getAnimations().length === 0 &&
      (${remote ? 'true' : 'false'} ? knob.offsetLeft + knob.offsetWidth === rail.clientWidth : knob.offsetLeft === 0)
    const root = document.documentElement
    const sheet = [...document.styleSheets].find((s) => (s.href || '').endsWith('/site.css'))
    const selector = document.querySelector('.seam-selector')
    const sections = [...document.querySelectorAll('main .section')]
    const rects = sections.map((s) => s.getBoundingClientRect())
    const sectionGaps = rects.slice(1).map((r, i) => Math.round(r.top - rects[i].bottom))
    const footer = document.querySelector('footer')
    const footerGap = footer && rects.length ? Math.round(footer.getBoundingClientRect().top - rects[rects.length - 1].bottom) : -1
    const closing = sections[sections.length - 1]
    const terminal = closing?.querySelector('.terminal')
    const actions = closing?.querySelector('.actions')
    const ctaGap = terminal && actions ? Math.round(actions.getBoundingClientRect().top - terminal.getBoundingClientRect().bottom) : -1
    const probe = {
      sectionGaps,
      footerGap,
      ctaGap,
      scrollWidth: root.scrollWidth,
      innerWidth: innerWidth,
      scrollHeight: root.scrollHeight,
      stylesheetLoaded: Boolean(sheet && sheet.cssRules.length > 0),
      lean: selector ? selector.getAttribute('data-lean') : null,
      status: document.querySelector('[data-status]')?.textContent ?? null,
      knobSettled,
      runtime: document.querySelector('.chip[data-seam="runtime"][aria-pressed="true"]')?.dataset.adapter ?? null,
      chips: [...document.querySelectorAll('.chip')].map((c) => ({
        seam: c.dataset.seam,
        adapter: c.dataset.adapter,
        pressed: c.getAttribute('aria-pressed'),
      })),
    }
    const meta = document.createElement('meta')
    meta.name = 'capture-probe'
    meta.content = JSON.stringify(probe)
    document.head.append(meta)
  }, ${remote ? KNOB_SETTLE_MS : 50})
}, 50))
</script>`
}

/** The built page with a base href and a probe script; the built files stay untouched. */
export function injectProbe(html: string, options: { remote: boolean }): string {
  const withBase = html.replace(/<head[^>]*>/i, (head) => `${head}<base href="/">`)
  const script = probeScript(options.remote)
  return /<\/body>/i.test(withBase)
    ? withBase.replace(/<\/body>/i, `${script}</body>`)
    : `${withBase}${script}`
}

/**
 * Headless Chromium will not lay a page out narrower than ~500px whatever
 * `--window-size` says, so every frame is shot through a wrapper that holds
 * the page in an iframe of the exact frame width. The wrapper copies the
 * probe out of the iframe so `--dump-dom` can read it.
 */
export function wrapperPage(frame: WebsiteFrame, height: number): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#fff}iframe{display:block;border:0;width:${frame.width}px;height:${height}px}</style></head><body><iframe id="page" src="/__page-${frame.id}.html"></iframe><script>
document.getElementById('page').addEventListener('load', () => setTimeout(() => {
  const probe = document.getElementById('page').contentDocument.querySelector('meta[name="capture-probe"]')
  if (probe) document.head.append(probe.cloneNode())
}, 900))
</script></body></html>`
}

/** Read the probe `injectProbe` writes into a `--dump-dom` document. */
export function parseProbe(dom: string): Probe {
  const match = /<meta[^>]*name="capture-probe"[^>]*content="([^"]*)"/i.exec(dom)
  if (!match) throw new Error('website capture: the page produced no capture-probe meta')
  const json = (match[1] as string)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
  return JSON.parse(json) as Probe
}

/** Why a probe does not show the page as it should look, if it does not. */
export function probeProblems(frame: WebsiteFrame, probe: Probe): string[] {
  const problems: string[] = []
  if (!probe.stylesheetLoaded) problems.push('site.css did not load')
  if (frame.remote) {
    if (probe.lean !== 'remote') problems.push(`seam selector data-lean is ${probe.lean}`)
    if (probe.status !== 'fully remote') problems.push(`status reads "${probe.status}"`)
    if (!probe.knobSettled) problems.push('knob still animating')
    if (probe.runtime !== 'codex') problems.push(`runtime is ${probe.runtime}, expected codex`)
    const sides = new Map<string, string | undefined>()
    for (const seam of SEAMS) for (const a of seam.adapters) sides.set(a.id, a.side)
    for (const chip of probe.chips) {
      const side = sides.get(chip.adapter)
      if (side === 'remote' && chip.pressed !== 'true') {
        problems.push(`remote chip ${chip.seam}/${chip.adapter} is not pressed`)
      }
      if (side === 'local' && chip.pressed !== 'false') {
        problems.push(`local chip ${chip.seam}/${chip.adapter} is still pressed`)
      }
    }
  }
  const expected = expectedSectionGap(frame)
  if (probe.sectionGaps.length === 0) problems.push('no sections found to measure')
  for (const gap of probe.sectionGaps) {
    if (gap !== expected) problems.push(`section gap is ${gap}px, expected ${expected}px`)
  }
  if (probe.footerGap !== expected) {
    problems.push(`footer gap is ${probe.footerGap}px, expected ${expected}px`)
  }
  if (probe.ctaGap !== EXPECTED_CTA_GAP) {
    problems.push(`terminal-to-button gap is ${probe.ctaGap}px, expected ${EXPECTED_CTA_GAP}px`)
  }
  if (frame.width <= 390 && probe.scrollWidth > probe.innerWidth) {
    problems.push(`page scrolls sideways (${probe.scrollWidth} > ${probe.innerWidth})`)
  }
  return problems
}

export function renderReport(
  results: readonly { frame: WebsiteFrame; probe: Probe; height: number; capped: boolean }[],
): string {
  const lines = ['# Website capture report', '', '## Frames', '']
  for (const { frame, probe, height, capped } of results) {
    lines.push(
      `- \`${frame.id}\` — \`.ab/website-frames/${frame.id}.png\`, ${frame.width}x${height}${
        capped ? ` (page height capped at ${MAX_PAGE_HEIGHT}px)` : ''
      }`,
      `  - reference: \`${frame.reference}\``,
      `  - measured: scrollWidth ${probe.scrollWidth}, innerWidth ${probe.innerWidth}, scrollHeight ${probe.scrollHeight}`,
      `  - spacing: section gaps [${probe.sectionGaps.join(', ')}]px, footer gap ${probe.footerGap}px (expected ${expectedSectionGap(frame)}px), terminal-to-button gap ${probe.ctaGap}px`,
    )
  }
  lines.push('', '## Horizontal overflow at 390px', '')
  for (const { frame, probe } of results.filter((r) => r.frame.width <= 390)) {
    const over = probe.scrollWidth > probe.innerWidth
    lines.push(
      over
        ? `FAIL: \`${frame.id}\` scrolls sideways (scrollWidth ${probe.scrollWidth} > innerWidth ${probe.innerWidth}).`
        : `PASS: \`${frame.id}\` has no sideways scroll (scrollWidth ${probe.scrollWidth} <= innerWidth ${probe.innerWidth}).`,
    )
  }
  lines.push(
    '',
    '## Notes',
    '',
    '`phone-remote` has no approved screenshot of its own: judge it against `reference-phone.png` for layout and spacing only; the seam states differ by design.',
    '',
    'The page links web fonts; offline, a fallback face renders. Typeface-only differences from the reference are not findings.',
    '',
    '## Website visual verdict',
    '',
    '(the verifier records pass or fail here)',
    '',
  )
  return lines.join('\n')
}

export function assertOutputUnderScratch(repoRoot: string, outputDir: string): void {
  const scratch = resolve(repoRoot, '.ab')
  const rel = relative(scratch, resolve(outputDir))
  if (rel === '' || rel.startsWith('..') || rel.startsWith(sep)) {
    throw new Error(`website capture output must live under ${scratch}, got ${resolve(outputDir)}`)
  }
}

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
}

/** Serve the built site on an ephemeral loopback port, plus `/__frame-<id>.html` variants. */
export function serveSite(files: SiteFiles): { url: string; stop: () => void } {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url)
      const variant = /^\/__(page|frame)-([a-z-]+)\.html$/.exec(pathname)
      if (variant) {
        const frame = WEBSITE_FRAMES.find((f) => f.id === variant[2])
        if (!frame) return new Response('unknown frame', { status: 404 })
        const height = Number(new URL(request.url).searchParams.get('h')) || 900
        const body =
          variant[1] === 'page'
            ? injectProbe(files['index.html'], { remote: frame.remote })
            : wrapperPage(frame, height)
        return new Response(body, { headers: { 'content-type': CONTENT_TYPES.html as string } })
      }
      const name = pathname === '/' ? 'index.html' : pathname.slice(1)
      if (Object.hasOwn(files, name)) {
        const ext = name.split('.').pop() as string
        return new Response(files[name as keyof SiteFiles], {
          headers: { 'content-type': CONTENT_TYPES[ext] as string },
        })
      }
      return new Response('not found', { status: 404 })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, stop: () => void server.stop(true) }
}

async function runChromium(
  chromium: string,
  profileDir: string,
  width: number,
  height: number,
  mode: { dumpDom: true } | { screenshot: string },
  url: string,
): Promise<string> {
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
      `--user-data-dir=${profileDir}`,
      '--force-device-scale-factor=1',
      `--window-size=${width},${height}`,
      '--virtual-time-budget=5000',
      'dumpDom' in mode ? '--dump-dom' : `--screenshot=${mode.screenshot}`,
      url,
    ],
    { stdout: 'dumpDom' in mode ? 'pipe' : 'ignore', stderr: 'pipe', timeout: 90_000 },
  )
  const [stdout, stderr, code] = await Promise.all([
    'dumpDom' in mode ? new Response(proc.stdout).text() : Promise.resolve(''),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) {
    throw new Error(`Chromium exited ${code} for ${url}\n${stderr.trim() || '(no stderr)'}`)
  }
  return stdout
}

async function attempt<T>(label: string, run: (n: number) => Promise<T>): Promise<T> {
  let failure: Error | undefined
  for (let n = 0; n < ATTEMPTS; n++) {
    try {
      return await run(n)
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error))
    }
  }
  throw new Error(`website capture ${label}: ${failure?.message ?? 'no attempt ran'}`)
}

export interface CaptureOptions {
  chromium?: string
  /** Defaults to `<repo>/.ab/website-frames`; must stay under `.ab/`. */
  outputDir?: string
  files?: SiteFiles
}

export async function captureWebsite(options: CaptureOptions = {}): Promise<string> {
  const chromium = options.chromium ?? chromiumBinary()
  if (!chromium) {
    throw new Error(
      'website capture: no Chromium binary found. Install chromium or set CHROMIUM_BIN.',
    )
  }
  const outputDir = options.outputDir ?? DEFAULT_OUTPUT_DIR
  assertOutputUnderScratch(REPO_ROOT, outputDir)
  const files = options.files ?? (await buildFiles())
  await rm(outputDir, { recursive: true, force: true })
  await mkdir(outputDir, { recursive: true })
  const profileRoot = await mkdtemp(join(tmpdir(), 'ab-website-capture-'))
  const site = serveSite(files)
  try {
    const results: Parameters<typeof renderReport>[0][number][] = []
    for (const frame of WEBSITE_FRAMES) {
      const frameUrl = (height: number) => `${site.url}/__frame-${frame.id}.html?h=${height}`
      const probe = await attempt(`${frame.id} probe`, async (n) =>
        parseProbe(
          await runChromium(
            chromium,
            join(profileRoot, `${frame.id}-probe-${n}`),
            frame.width,
            900,
            { dumpDom: true },
            frameUrl(900),
          ),
        ),
      )
      const problems = probeProblems(frame, probe)
      if (problems.length > 0) {
        throw new Error(`website capture ${frame.id}: ${problems.join('; ')}`)
      }
      const height = Math.min(probe.scrollHeight, MAX_PAGE_HEIGHT)
      const png = join(outputDir, `${frame.id}.png`)
      await attempt(`${frame.id} screenshot`, async (n) => {
        await rm(png, { force: true })
        await runChromium(
          chromium,
          join(profileRoot, `${frame.id}-shot-${n}`),
          frame.width,
          height,
          { screenshot: png },
          frameUrl(height),
        )
        if (!existsSync(png) || (await stat(png)).size === 0) {
          throw new Error(`no screenshot written at ${png}`)
        }
      })
      results.push({ frame, probe, height, capped: probe.scrollHeight > MAX_PAGE_HEIGHT })
    }
    await writeFile(join(outputDir, 'verify-report.md'), renderReport(results))
    return outputDir
  } finally {
    site.stop()
    await rm(profileRoot, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  try {
    console.log(`website frames written to ${await captureWebsite()}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
