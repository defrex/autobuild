import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { buildFiles, type SiteFiles } from '../packages/website/src/build'
import { SEAMS } from '../packages/website/src/seams'

const REPO_ROOT = join(import.meta.dir, '..')
export const DEFAULT_OUTPUT_DIR = join(REPO_ROOT, '.ab', 'website-frames')

/** Tallest page the capture will screenshot. */
export const MAX_PAGE_HEIGHT = 32_768
const ATTEMPTS = 2

export type CaptureFiles = Record<string, string | Uint8Array<ArrayBuffer>> & {
  'index.html': string
  'site.css': string
  'site.js': string
}

export interface WebsiteFrame {
  docsState?: 'menu' | 'toc' | 'scrolled'
  viewportHeight?: number
  page?: string
  kind?: 'landing' | 'docs'
  motion?: 'reduce' | 'normal'
  figure?: string
  sample?: 'start' | 'midpoint' | 'final'
  duration?: number
  id: string
  width: number
  /** Switch the seam selector to fully remote before measuring and shooting. */
  remote: boolean
  /** The approved reference screenshot this frame is judged against. */
  reference?: string
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
  {
    id: 'phone-remote',
    width: 390,
    remote: true,
    reference: 'design/website/reference-phone-remote.png',
  },
]

/** Encode the complete UTF-8 path, preserving slash/dash and Unicode distinctions. */
export function artifactId(path: string): string {
  return Buffer.from(path).toString('hex')
}

export function discoverFrames(files: CaptureFiles): WebsiteFrame[] {
  return [
    ...WEBSITE_FRAMES.map((f) => ({
      ...f,
      page: 'index.html',
      kind: 'landing' as const,
      motion: 'reduce' as const,
    })),
    ...(Object.hasOwn(files, 'docs/builds/index.html')
      ? [
          { id: 'docs-builds-menu', width: 390, docsState: 'menu' as const },
          { id: 'docs-builds-toc', width: 390, docsState: 'toc' as const },
          { id: 'docs-builds-720', width: 720 },
          { id: 'docs-builds-intermediate', width: 1000 },
          {
            id: 'docs-builds-scrolled',
            width: 1440,
            docsState: 'scrolled' as const,
            viewportHeight: 900,
          },
        ].map((frame) => ({
          ...frame,
          page: 'docs/builds/index.html',
          kind: 'docs' as const,
          motion: 'reduce' as const,
          remote: false,
        }))
      : []),
    ...(Object.hasOwn(files, 'docs/seams/index.html')
      ? [1440, 390].map((width) => ({
          id: `docs-seams-remote-${width}`,
          page: 'docs/seams/index.html',
          kind: 'docs' as const,
          motion: 'reduce' as const,
          width,
          remote: true,
        }))
      : []),
    ...Object.keys(files)
      .filter((p) => p.startsWith('docs/') && p.endsWith('.html'))
      .sort()
      .flatMap((page) =>
        [1440, 390].map((width) => ({
          id: `docs-${artifactId(page)}-${width}`,
          page,
          kind: 'docs' as const,
          motion: 'reduce' as const,
          width,
          remote: false,
        })),
      ),
  ]
}

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

export interface FigureProbe {
  id: string
  animated: boolean
  duration?: number
  timeMs?: number
  complete?: boolean
  still?: boolean
}

/** Expand discovered animated figures in stable start/midpoint/final order. */
export function motionFrames(frame: WebsiteFrame, figures: FigureProbe[]): WebsiteFrame[] {
  if (frame.motion !== 'reduce') return []
  return figures
    .filter((figure) => figure.animated)
    .flatMap((figure) =>
      (['start', 'midpoint', 'final'] as const).map((sample) => ({
        ...frame,
        reference: undefined,
        id: `${frame.id}-figure-${artifactId(figure.id)}-${sample}`,
        motion: 'normal' as const,
        figure: figure.id,
        duration: figure.duration,
        sample,
      })),
    )
}

export interface Probe {
  docs?: {
    menuExpanded: boolean
    tocExpanded: boolean
    active: string[]
    expectedActive: string | null
    leftVisible: boolean
    rightVisible: boolean
    leftTop: number
    rightTop: number
    scrollY: number
    codeContained: boolean
    copyPresent: boolean
    copyHeight: number
    copyPlaced: boolean
  }
  error?: string
  reducedMotion: boolean
  still: boolean
  figures: FigureProbe[]
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

function probeScript(frame: WebsiteFrame): string {
  const remote = frame.remote
  return `<script>
addEventListener('DOMContentLoaded', () => setTimeout(async () => {
  ${frame.docsState === 'menu' ? `document.querySelector('[data-site-menu]')?.click()` : ''}
  ${frame.docsState === 'toc' ? `document.querySelector('[data-toc-toggle]')?.click()` : ''}
  ${frame.docsState === 'scrolled' ? `window.scrollTo(0, document.querySelectorAll('article h2')[2]?.offsetTop - 24 || 600)` : ''}
  ${remote ? `document.querySelector('[data-set="remote"]')?.click()` : ''}
  setTimeout(async () => {
    ${frame.docsState === 'scrolled' ? `await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))` : ''}
    const knob = document.querySelector('.knob')
    // Chromium's virtual-time budget freezes the animation clock, so the glide never advances on
    // its own; finish it so the shot shows the settled knob, then check it sits at the rail's end.
    knob?.getAnimations().forEach((a) => a.finish())
    const rail = knob?.parentElement
    const knobSettled =
      knob !== null && knob !== undefined && knob.getAnimations().length === 0 &&
      (${remote ? 'true' : 'false'} ? knob.offsetLeft + knob.offsetWidth === rail.clientWidth : knob.offsetLeft === 0)
    const frame = ${JSON.stringify(frame)}
    const figures = []
    let error
    try {
      const ids = new Set()
      for (const node of document.querySelectorAll('[data-capture-figure], [data-capture-animated]')) {
        const id = node.getAttribute('data-capture-figure')
        if (!id || ids.has(id)) throw Error('missing or duplicate figure id')
        ids.add(id)
        const animated = node.hasAttribute('data-capture-animated')
        const record = { id, animated }
        if (animated) {
          const adapter = window.__websiteCapture?.[id]
          if (!adapter || !Number.isFinite(adapter.duration) || adapter.duration <= 0) throw Error('invalid or missing adapter: ' + id)
          await adapter.ready
          const target = frame.figure === id
          const timeMs = target ? (frame.sample === 'final' ? adapter.duration : frame.sample === 'midpoint' ? adapter.duration / 2 : 0) : 0
          const ack = await adapter.seek(timeMs, { still: !target })
          if (!ack || ack.timeMs !== timeMs || (target && frame.sample === 'final' && ack.complete !== true) || (!target && ack.still !== true)) throw Error('invalid seek/final/still acknowledgement: ' + id)
          Object.assign(record, ack, { duration: adapter.duration })
        }
        figures.push(record)
      }
    } catch (e) { error = String(e) }
    const still = !document.getAnimations().some(a => a.playState === 'running' || a.pending)
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
    const docsRoot = document.querySelector('[data-docs]')
    const left = document.querySelector('.docs-nav')
    const right = document.querySelector('.docs-toc')
    const visible = (node) => Boolean(node && getComputedStyle(node).display !== 'none')
    const headings = [...document.querySelectorAll('article h2')]
    const expectedHeading = scrollY > 0 && scrollY + innerHeight >= root.scrollHeight - 2 ? headings.at(-1) : headings.filter(h => h.getBoundingClientRect().top <= 24).at(-1) || headings[0]
    const copy = document.querySelector('[data-docs-copy]')
    const copyRect = copy?.getBoundingClientRect()
    const titleRect = document.querySelector('article h1')?.getBoundingClientRect()
    const docs = docsRoot ? {
      menuExpanded: document.querySelector('[data-site-menu]')?.getAttribute('aria-expanded') === 'true',
      tocExpanded: document.querySelector('[data-toc-toggle]')?.getAttribute('aria-expanded') === 'true',
      active: [...document.querySelectorAll('[data-section][aria-current="location"]')].map(a => a.dataset.section),
      expectedActive: expectedHeading?.id || null,
      leftVisible: visible(left), rightVisible: visible(right),
      leftTop: left?.getBoundingClientRect().top || 0, rightTop: right?.getBoundingClientRect().top || 0,
      scrollY,
      copyPresent: Boolean(copy && copy.textContent === 'Copy as Markdown'),
      copyHeight: copyRect?.height || 0,
      copyPlaced: Boolean(copyRect && titleRect && (innerWidth < 720 ? copyRect.top >= titleRect.bottom && copyRect.left === titleRect.left : copyRect.left >= titleRect.right && copyRect.top < titleRect.bottom)),
      codeContained: [...document.querySelectorAll('article pre')].every(pre => pre.getBoundingClientRect().right <= innerWidth && pre.getBoundingClientRect().left >= 0 && getComputedStyle(pre).overflowX === 'auto'),
    } : undefined
    const probe = { docs,
      error, figures, still,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
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
export function injectProbe(html: string, options: WebsiteFrame | { remote: boolean }): string {
  const frame: WebsiteFrame = { id: 'injected', width: 1440, ...options }
  const base =
    frame.page && frame.page !== 'index.html'
      ? `/${frame.page.split('/').map(encodeURIComponent).join('/')}`
      : '/'
  const withBase = html.replace(/<head[^>]*>/i, (head) => `${head}<base href="${base}">`)
  const script = probeScript(frame)
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
document.getElementById('page').addEventListener('load', () => {
 const timer = setInterval(() => {
  const probe = document.getElementById('page').contentDocument.querySelector('meta[name="capture-probe"]')
  if (probe) { document.head.append(probe.cloneNode()); clearInterval(timer) }
 }, 50)
 setTimeout(() => clearInterval(timer), 4500)
})
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
  if (probe.error) problems.push(probe.error)
  if (
    frame.figure &&
    !probe.figures.some(
      (f) =>
        f.id === frame.figure &&
        f.animated &&
        f.duration === frame.duration &&
        f.timeMs ===
          (frame.sample === 'final'
            ? f.duration
            : frame.sample === 'midpoint'
              ? (f.duration ?? NaN) / 2
              : 0) &&
        (frame.sample !== 'final' || f.complete),
    )
  )
    problems.push('missing expected motion evidence')
  if (probe.reducedMotion !== (frame.motion !== 'normal'))
    problems.push('incorrect reduced-motion preference')
  if (!probe.still) problems.push('running or pending animation')
  if (!probe.stylesheetLoaded) problems.push('site.css did not load')
  if (frame.remote) {
    if (probe.lean !== 'remote') problems.push(`seam selector data-lean is ${probe.lean}`)
    if (probe.status !== 'fully remote') problems.push(`status reads "${probe.status}"`)
    if (!probe.knobSettled) problems.push('knob still animating')
    if (probe.runtime !== 'codex') problems.push(`runtime is ${probe.runtime}, expected codex`)
    const sides = new Map<string, string | undefined>()
    for (const seam of SEAMS) for (const a of seam.adapters) sides.set(a.id, a.side)
    for (const chip of probe.chips) {
      const seam = SEAMS.find((entry) => entry.id === chip.seam)
      const side = sides.get(chip.adapter)
      if (side === 'local' && !seam?.adapters.some((adapter) => adapter.side === 'remote')) {
        if (chip.pressed !== 'true')
          problems.push(`fixed local chip ${chip.seam}/${chip.adapter} is not pressed`)
        continue
      }
      if (side === 'remote' && chip.pressed !== 'true') {
        problems.push(`remote chip ${chip.seam}/${chip.adapter} is not pressed`)
      }
      if (side === 'local' && chip.pressed !== 'false') {
        problems.push(`local chip ${chip.seam}/${chip.adapter} is still pressed`)
      }
    }
  }
  if (frame.kind !== 'docs') {
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
  }
  if (frame.kind === 'docs' && probe.docs) {
    const docs = probe.docs
    if (!docs.copyPresent) problems.push('missing docs copy action')
    if (docs.copyHeight < (frame.width < 720 ? 44 : 40)) problems.push('docs copy target too short')
    if (!docs.copyPlaced) problems.push('incorrect docs copy placement')
    if (docs.menuExpanded !== (frame.docsState === 'menu'))
      problems.push('incorrect docs menu state')
    if (docs.tocExpanded !== (frame.docsState === 'toc')) problems.push('incorrect docs TOC state')
    if (docs.leftVisible !== frame.width >= 720) problems.push('incorrect left column visibility')
    if (docs.rightVisible !== frame.width >= 1200)
      problems.push('incorrect right column visibility')
    if (!docs.codeContained) problems.push('code overflow escapes its well')
    if (
      docs.expectedActive &&
      (docs.active.length !== 2 || docs.active.some((id) => id !== docs.expectedActive))
    )
      problems.push('section markers are not synchronized with scroll position')
    if (
      frame.docsState === 'scrolled' &&
      (docs.scrollY <= 0 || Math.abs(docs.leftTop - 24) > 1 || Math.abs(docs.rightTop - 24) > 1)
    )
      problems.push('sidebars did not remain sticky while scrolling')
  }
  if ((frame.kind === 'docs' || frame.width <= 390) && probe.scrollWidth > probe.innerWidth) {
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
      `  - URL: /${frame.page ?? 'index.html'}; duration: ${frame.duration ?? 'none'}ms; page: ${frame.page ?? 'index.html'}; kind: ${frame.kind ?? 'landing'}; motion: ${frame.motion ?? 'reduce'}; figure: ${frame.figure ?? 'none'}; sample: ${frame.sample ?? 'still'}`,
      `  - reduced-motion: ${probe.reducedMotion}; still: ${probe.still}; figures (${probe.figures.length}): ${JSON.stringify(probe.figures)}`,
      `  - reference: ${frame.reference ? `\`${frame.reference}\`` : 'none (design-system and spec review)'}`,
      ...(probe.docs ? [`  - docs: ${JSON.stringify(probe.docs)}`] : []),
      `  - measured: scrollWidth ${probe.scrollWidth}, innerWidth ${probe.innerWidth}, scrollHeight ${probe.scrollHeight}`,
      ...(frame.kind === 'docs'
        ? []
        : [
            `  - spacing: section gaps [${probe.sectionGaps.join(', ')}]px, footer gap ${probe.footerGap}px (expected ${expectedSectionGap(frame)}px), terminal-to-button gap ${probe.ctaGap}px`,
          ]),
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
  png: 'image/png',
}

/** Serve the built site on an ephemeral loopback port, plus `/__frame-<id>.html` variants. */
export function serveSite(
  input: CaptureFiles | SiteFiles,
  frames: WebsiteFrame[] = discoverFrames({ ...input }),
): { url: string; stop: () => void } {
  const files: CaptureFiles = { ...input }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const pathname = decodeURI(new URL(request.url).pathname)
      const variant = /^\/__(page|frame)-([a-z0-9-]+)\.html$/.exec(pathname)
      if (variant) {
        const frame = frames.find((f) => f.id === variant[2])
        if (!frame) return new Response('unknown frame', { status: 404 })
        const height = Number(new URL(request.url).searchParams.get('h')) || 900
        const body =
          variant[1] === 'page'
            ? injectProbe(String(files[frame.page ?? 'index.html']), frame)
            : wrapperPage(frame, height)
        return new Response(body, { headers: { 'content-type': CONTENT_TYPES.html as string } })
      }
      const name = pathname.endsWith('/') ? `${pathname.slice(1)}index.html` : pathname.slice(1)
      if (Object.hasOwn(files, name)) {
        const ext = name.split('.').pop() as string
        return new Response(files[name], {
          headers: { 'content-type': CONTENT_TYPES[ext] as string },
        })
      }
      return new Response('not found', { status: 404 })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, stop: () => void server.stop(true) }
}

/** Scroll evidence uses a real compositor clock: CLI virtual time suspends animation frames. */
interface BrowserReply {
  result?: { value?: string }
  data?: string
}

async function withBrowserTemp<T>(run: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  // Chromium's singleton socket has a short Unix-domain path limit. Own a
  // short temp directory independently of the potentially long profile name.
  const root = await mkdtemp(join(tmpdir(), 'ab-chromium-'))
  try {
    return await run({ ...process.env, TMPDIR: root, TMP: root, TEMP: root })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

export async function runRealtimeChromium(
  chromium: string,
  profileDir: string,
  width: number,
  height: number,
  mode: { dumpDom: true; pressEnterWhen?: string; timeoutMs?: number } | { screenshot: string },
  url: string,
): Promise<string> {
  return withBrowserTemp(async (env) => {
    const proc = Bun.spawn(
      [
        chromium,
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-prefers-reduced-motion',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--remote-debugging-port=0',
        `--user-data-dir=${profileDir}`,
        'about:blank',
      ],
      {
        stdout: 'ignore',
        stderr: 'ignore',
        env,
      },
    )
    let socket: WebSocket | undefined
    try {
      let port: string | undefined
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          port = (await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8')).split('\n')[0]
          break
        } catch {
          await Bun.sleep(50)
        }
      }
      if (!port) throw Error('Chromium debugging port did not become ready')
      const target = (await (
        await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
      ).json()) as { webSocketDebuggerUrl: string }
      const ws = new WebSocket(target.webSocketDebuggerUrl)
      socket = ws
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve()
        ws.onerror = () => reject(Error('Chromium debugger failed'))
      })
      let sequence = 0
      const pending = new Map<
        number,
        { resolve: (value: BrowserReply) => void; reject: (error: Error) => void }
      >()
      ws.onmessage = (event) => {
        const reply = JSON.parse(String(event.data))
        const request = pending.get(reply.id)
        if (!request) return
        pending.delete(reply.id)
        if (reply.error) request.reject(Error(JSON.stringify(reply.error)))
        else request.resolve(reply.result)
      }
      const send = (method: string, params: Record<string, unknown> = {}): Promise<BrowserReply> =>
        new Promise((resolve, reject) => {
          const id = ++sequence
          const timeout = setTimeout(() => {
            pending.delete(id)
            reject(Error(`Chromium ${method} timed out`))
          }, 10000)
          pending.set(id, {
            resolve: (value) => {
              clearTimeout(timeout)
              resolve(value)
            },
            reject: (error) => {
              clearTimeout(timeout)
              reject(error)
            },
          })
          ws.send(JSON.stringify({ id, method, params }))
        })
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      })
      await send('Page.navigate', { url })
      let dom = ''
      let keySent = false
      for (
        let attempt = 0;
        attempt < (('dumpDom' in mode ? mode.timeoutMs : undefined) ?? 10000) / 50;
        attempt++
      ) {
        if ('dumpDom' in mode && mode.pressEnterWhen && !keySent) {
          const ready = await send('Runtime.evaluate', {
            expression: `Boolean(document.querySelector(${JSON.stringify(mode.pressEnterWhen)}))`,
            returnByValue: true,
          })
          if (ready.result?.value) {
            await send('Input.dispatchKeyEvent', {
              type: 'keyDown',
              text: '\r',
              unmodifiedText: '\r',
              key: 'Enter',
              code: 'Enter',
              windowsVirtualKeyCode: 13,
            })
            await send('Input.dispatchKeyEvent', {
              type: 'keyUp',
              key: 'Enter',
              code: 'Enter',
              windowsVirtualKeyCode: 13,
            })
            keySent = true
          }
        }
        const result = await send('Runtime.evaluate', {
          expression:
            'document.querySelector(\'meta[name="capture-probe"]\') ? document.documentElement.outerHTML : ""',
          returnByValue: true,
        })
        dom = result.result?.value || ''
        if (dom) break
        await Bun.sleep(50)
      }
      if (!dom) {
        const state = await send('Runtime.evaluate', {
          expression:
            'JSON.stringify({url: location.href, ready: document.readyState, progress: document.body?.dataset.progress})',
          returnByValue: true,
        })
        throw Error(`real-time capture produced no probe: ${state.result?.value}`)
      }
      if ('screenshot' in mode) {
        const shot = await send('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: false,
        })
        await writeFile(mode.screenshot, Buffer.from(shot.data ?? '', 'base64'))
      }
      return dom
    } finally {
      // Let Chromium reap its renderers and remove singleton sockets before
      // the owner removes the profile; killing only the leader can recreate it.
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ id: 0, method: 'Browser.close' }))
      }
      const timeout = setTimeout(() => proc.kill(), 5000)
      try {
        await proc.exited
      } finally {
        clearTimeout(timeout)
        socket?.close()
      }
    }
  })
}

async function runChromium(
  chromium: string,
  profileDir: string,
  width: number,
  height: number,
  mode: { dumpDom: true } | { screenshot: string },
  url: string,
  motion: 'reduce' | 'normal' = 'reduce',
  realTime = false,
): Promise<string> {
  await mkdir(profileDir, { recursive: true })
  if (realTime) return runRealtimeChromium(chromium, profileDir, width, height, mode, url)
  return withBrowserTemp(async (env) => {
    const proc = Bun.spawn(
      [
        chromium,
        '--headless=new',
        ...(motion === 'reduce' ? ['--force-prefers-reduced-motion'] : []),
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
        ...('dumpDom' in mode ? [] : [`--screenshot=${mode.screenshot}`]),
        '--dump-dom',
        url,
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 90_000,
        env,
      },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) {
      throw new Error(`Chromium exited ${code} for ${url}\n${stderr.trim() || '(no stderr)'}`)
    }
    return stdout
  })
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
  /** Bounded real-site smoke or fixture override; CLI discovers the complete build output. */
  frames?: WebsiteFrame[]
  /** Include extra animated-figure samples; defaults to true for full capture. */
  includeMotionSamples?: boolean
  files?: CaptureFiles
}

export async function captureWebsite(options: CaptureOptions = {}): Promise<string> {
  const outputDir = options.outputDir ?? DEFAULT_OUTPUT_DIR
  assertOutputUnderScratch(REPO_ROOT, outputDir)
  await rm(outputDir, { recursive: true, force: true })
  await mkdir(outputDir, { recursive: true })
  await writeFile(
    join(outputDir, 'verify-report.md'),
    '# Website capture report\n\nFAIL: capture incomplete; no complete inventory yet.\n',
  )
  const chromium = options.chromium ?? chromiumBinary()
  if (!chromium) {
    const message =
      'website capture: no Chromium binary found. Install chromium or set CHROMIUM_BIN.'
    await writeFile(
      join(outputDir, 'verify-report.md'),
      `# Website capture report\n\nFAIL: ${message}\n`,
    )
    throw new Error(message)
  }
  const files: CaptureFiles = options.files ?? { ...(await buildFiles()) }
  const frames = [...(options.frames ?? discoverFrames(files))]
  const site = serveSite(files, frames)
  let profileRoot: string | undefined
  const results: Parameters<typeof renderReport>[0][number][] = []
  try {
    profileRoot = await mkdtemp(join(tmpdir(), 'ab-website-capture-'))
    for (const frame of frames) {
      const frameUrl = (height: number) => `${site.url}/__frame-${frame.id}.html?h=${height}`
      const probe = await attempt(`${frame.id} probe`, async (n) =>
        parseProbe(
          await runChromium(
            chromium,
            join(profileRoot!, `${frame.id}-probe-${n}`),
            frame.width,
            900,
            { dumpDom: true },
            frameUrl(900),
            frame.motion,
            frame.docsState === 'scrolled',
          ),
        ),
      )
      if (options.includeMotionSamples ?? true) {
        frames.push(...motionFrames(frame, probe.figures))
      }
      const problems = probeProblems(frame, probe)
      if (problems.length > 0) {
        throw new Error(`website capture ${frame.id}: ${problems.join('; ')}`)
      }
      if (!frame.viewportHeight && probe.scrollHeight > MAX_PAGE_HEIGHT) {
        throw new Error(
          `website capture ${frame.id}: page height ${probe.scrollHeight}px exceeds complete capture limit ${MAX_PAGE_HEIGHT}px`,
        )
      }
      const height = frame.viewportHeight ?? probe.scrollHeight
      const png = join(outputDir, `${frame.id}.png`)
      await attempt(`${frame.id} screenshot`, async (n) => {
        await rm(png, { force: true })
        const shotDom = await runChromium(
          chromium,
          join(profileRoot!, `${frame.id}-shot-${n}`),
          frame.width,
          height,
          { screenshot: png },
          frameUrl(height),
          frame.motion,
          frame.docsState === 'scrolled',
        )
        const shotProbe = parseProbe(shotDom)
        const shotProblems = probeProblems(frame, shotProbe)
        if (JSON.stringify(shotProbe.figures) !== JSON.stringify(probe.figures))
          shotProblems.push('screenshot figure inventory/state differs from measurement')
        if (shotProblems.length) throw Error(shotProblems.join('; '))
        if (!existsSync(png) || (await stat(png)).size === 0) {
          throw new Error(`no screenshot written at ${png}`)
        }
      })
      results.push({ frame, probe, height, capped: probe.scrollHeight > MAX_PAGE_HEIGHT })
    }
    if (results.length !== frames.length) throw Error('incomplete frame inventory')
    await writeFile(join(outputDir, 'inventory.json'), JSON.stringify(results, null, 2))
    await writeFile(join(outputDir, 'verify-report.md'), renderReport(results))
    return outputDir
  } catch (error) {
    await writeFile(
      join(outputDir, 'verify-report.md'),
      `${renderReport(results)}\nFAIL: ${String(error)}\nExpected inventory: ${JSON.stringify(frames)}`,
    )
    throw error
  } finally {
    site.stop()
    if (profileRoot) await rm(profileRoot, { recursive: true, force: true })
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
