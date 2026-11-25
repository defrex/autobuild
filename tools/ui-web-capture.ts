/**
 * Visual and layout-shift evidence for the Autobuild ANSI design system and
 * the `ab web` UI, for this repository's `ui-web` verify step.
 *
 *   bun run capture:ui-web
 *
 * Renders the catalog and every `ab web` page over the scripted fixtures in
 * `packages/ui/src/app/fixtures.ts`, the analytics and timeline JSON routes
 * included, at both grounds and at desktop and phone
 * widths, in a fresh headless Chromium per variant. Each variant records its
 * cumulative layout shift before it is screenshot, and the run fails when any
 * exceeds `CLS_THRESHOLD`. Outputs land in `.ab/ui-web-frames/`: PNGs,
 * `frames.json` and `verify-report.md`. Browser profiles live in a
 * per-invocation OS temporary directory, removed when the run ends.
 *
 * Repository configuration, not product: nothing here ships.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { WebModelHub } from '../packages/core/src/web/hub'
import { loopbackHosts } from '../packages/core/src/web/http'
import type { WebAssetManifest } from '../packages/core/src/web/protocol'
import { startWebServer } from '../packages/core/src/web/server'
import { buildWebBundle } from '../packages/ui/src/app/build'
import {
  analyticsFixture,
  attentionArrivedFrame,
  BLOCKED_SLUG,
  movedFrame,
  NOW,
  overviewFrame,
  RUNNING_SLUG,
  stateChangedFrame,
  timelineFixture,
  WAITING_SLUG,
} from '../packages/ui/src/app/fixtures'
import {
  chromiumBinary,
  debuggerRequests,
} from '../packages/web-dashboard-capture/src/full-document'
import { ARTIFACT_MAX_BYTES, tilePng } from './website-capture-png'

/** The catalog's measured start-up baseline (0.0015 desktop, 0 phone). */
export const CLS_THRESHOLD = 0.002

/** Tallest single capture; `captureBeyondViewport` is unreliable past ~16k rows. */
export const PART_MAX_ROWS = 8192

/** Every wait on the page is bounded by this. */
export const WAIT_MS = 20_000

export const GROUNDS = ['light', 'dark'] as const
export type Ground = (typeof GROUNDS)[number]

export const WIDTHS = [1440, 390] as const
export type Width = (typeof WIDTHS)[number]

const HEIGHTS: Record<Width, number> = { 1440: 900, 390: 844 }

export const FINISHED_SLUG = overviewFrame().overview!.finished[0]!.slug

export interface UiWebPage {
  page: string
  /** Server path for app pages; absent for the file:// catalog. */
  path?: string
  /** `reserve`: wait for the loaded page to replace its masked twin, and
   * its timeline to load. `charts`: wait for the analytics charts to load. */
  settle: 'catalog' | 'reserve' | 'charts' | 'load'
  /** Measurement window after settling, in ms. */
  windowMs: number
  /** Publish the live-change frames once settled. */
  live?: boolean
}

export const PAGES: readonly UiWebPage[] = [
  // Two LiveFlow changes, which fire every 3 s.
  { page: 'catalog', settle: 'catalog', windowMs: 7000 },
  { page: 'overview', path: '/', settle: 'reserve', windowMs: 1500 },
  { page: 'overview-live', path: '/', settle: 'reserve', windowMs: 1500, live: true },
  { page: 'build-running', path: `/builds/${RUNNING_SLUG}`, settle: 'reserve', windowMs: 1500 },
  { page: 'build-blocked', path: `/builds/${BLOCKED_SLUG}`, settle: 'reserve', windowMs: 1500 },
  { page: 'build-waiting', path: `/builds/${WAITING_SLUG}`, settle: 'reserve', windowMs: 1500 },
  { page: 'build-finished', path: `/builds/${FINISHED_SLUG}`, settle: 'reserve', windowMs: 1500 },
  {
    page: 'build-missing',
    path: '/builds/not-in-this-repository',
    settle: 'reserve',
    windowMs: 1500,
  },
  { page: 'analytics', path: '/analytics', settle: 'charts', windowMs: 1500 },
  // Running builds too, so open segments grow with the clock.
  { page: 'analytics-all', path: '/analytics?outcome=all', settle: 'charts', windowMs: 1500 },
  { page: 'analytics-empty', path: '/analytics?kind=node', settle: 'charts', windowMs: 1500 },
  { page: 'unknown', path: '/no-such-page', settle: 'load', windowMs: 1500 },
]

/** Gap between the live frames published on `overview-live`. */
export const LIVE_STEP_MS = 1200

export interface UiWebVariant {
  id: string
  page: string
  ground: Ground
  width: Width
}

/** The page × ground × width matrix, in capture order. */
export function uiWebVariants(): UiWebVariant[] {
  const variants: UiWebVariant[] = []
  for (const { page } of PAGES)
    for (const ground of GROUNDS)
      for (const width of WIDTHS)
        variants.push({ id: `${page}-${ground}-${width}`, page, ground, width })
  return variants
}

/** Within the bound; a missing or non-finite measurement is a failure. */
export function clsPass(cls: unknown): boolean {
  return typeof cls === 'number' && Number.isFinite(cls) && cls >= 0 && cls <= CLS_THRESHOLD
}

/** Contiguous row ranges covering `[0, height)`, each at most `max` rows. */
export function partRanges(height: number, max = PART_MAX_ROWS): { top: number; height: number }[] {
  if (!Number.isInteger(height) || height <= 0) throw new Error(`invalid page height ${height}`)
  const parts: { top: number; height: number }[] = []
  for (let top = 0; top < height; top += max)
    parts.push({ top, height: Math.min(max, height - top) })
  return parts
}

/** A fixed clock that still ticks: `Date.now()` starts at `now`. */
export function clockScript(now: number): string {
  return `(() => {
  const NOW = ${JSON.stringify(now)};
  const t0 = performance.now();
  Date.now = () => Math.round(NOW + (performance.now() - t0));
})();`
}

/**
 * The layout-shift recorder, with `packages/ui/src/cls-probe.ts`'s semantics:
 * shifts no input caused, summed, with up to eight source descriptors.
 * `installed` distinguishes "no shift" from "the recorder never ran".
 */
export function clsRecorderScript(): string {
  return `(() => {
  const state = { installed: false, total: 0, entries: 0, sources: [] };
  window.__uiWebCls = state;
  const r = (n) => Math.round(n ?? 0);
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.hadRecentInput) continue;
        state.total += entry.value;
        state.entries += 1;
        for (const src of entry.sources ?? []) {
          const el = src.node instanceof Element ? src.node : src.node?.parentElement;
          if (!el) continue;
          const name = el.getAttribute('data-ansi') ?? el.getAttribute('data-catalog') ?? el.tagName;
          const p = src.previousRect ?? {};
          const c = src.currentRect ?? {};
          const text = name + '[' + (el.textContent ?? '').slice(0, 18) + ']@' + r(p.y) + '->' + r(c.y) +
            ' h' + r(p.height) + '->' + r(c.height) + ' x' + r(p.x) + '->' + r(c.x) + ' @' + r(entry.startTime);
          if (!state.sources.includes(text) && state.sources.length < 8) state.sources.push(text);
        }
      }
    }).observe({ type: 'layout-shift', buffered: true });
    state.installed = true;
  } catch (error) {
    state.error = String(error);
  }
})();`
}

export interface FramePart {
  id: string
  index: number
  count: number
  top: number
  height: number
  pngPath: string
}

export interface FrameEntry extends UiWebVariant {
  url: string
  cls: number | null
  clsSources: string[]
  clsPass: boolean
  height?: number
  pngPath?: string
  parts?: FramePart[]
}

export interface CaptureError {
  id?: string
  message: string
}

export interface ReportInput {
  command: string
  chromium: string | undefined
  variants: UiWebVariant[]
  frames: FrameEntry[]
  errors: CaptureError[]
}

const fmt = (cls: number | null) => (cls === null ? 'n/a' : cls.toFixed(4))

export function renderReport({ command, chromium, variants, frames, errors }: ReportInput): string {
  const byId = new Map(frames.map((f) => [f.id, f]))
  const lines = [
    '# ui-web capture',
    '',
    `- Command: \`${command}\``,
    `- Chromium: ${chromium ?? 'none found (set CHROMIUM_BIN)'}`,
    `- Threshold: a variant fails when its cumulative layout shift exceeds ${CLS_THRESHOLD}`,
    `- Variants: ${frames.length} captured of ${variants.length} expected`,
    '',
    '## Cumulative layout shift',
    '',
    '| variant | CLS | result |',
    '|---|---|---|',
  ]
  for (const v of variants) {
    const f = byId.get(v.id)
    lines.push(
      f === undefined
        ? `| ${v.id} | n/a | MISSING |`
        : `| ${v.id} | ${fmt(f.cls)} | ${f.clsPass ? 'PASS' : 'FAIL'} |`,
    )
  }
  const failing = frames.filter((f) => !f.clsPass)
  if (failing.length > 0) {
    lines.push('', '## Failing shift sources', '')
    for (const f of failing) {
      lines.push(`- ${f.id} (${fmt(f.cls)}):`)
      if (f.clsSources.length === 0) lines.push('  - no sources recorded')
      for (const s of f.clsSources) lines.push(`  - \`${s}\``)
    }
  }
  if (errors.length > 0) {
    lines.push('', '## Infrastructure failure', '')
    for (const e of errors) lines.push(`- ${e.id === undefined ? '' : `${e.id}: `}${e.message}`)
    lines.push('', '### Expected inventory', '')
    for (const v of variants)
      lines.push(
        `- ${v.id} (${v.page}, ${v.ground}, ${v.width}px)${byId.has(v.id) ? '' : ' — missing'}`,
      )
  }
  lines.push('', '## Frames', '')
  for (const f of frames) {
    if (f.pngPath !== undefined) lines.push(`- ${f.id}: \`${f.pngPath}\` (${f.height} rows)`)
    else
      for (const p of f.parts ?? [])
        lines.push(
          `- ${f.id} part ${p.index}/${p.count}: \`${p.pngPath}\` (rows ${p.top}–${p.top + p.height})`,
        )
  }
  lines.push('', '## Visual verdict', '', '')
  return `${lines.join('\n')}\n`
}

/** Refuse an output directory that is not inside the repository's `.ab/`. */
export function assertOutputUnderScratch(out: string, repo: string): void {
  const rel = relative(resolve(repo, '.ab'), resolve(out))
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel))
    throw new Error(`ui-web capture output ${out} is not inside ${join(repo, '.ab')}`)
}

/** Refuse a temporary directory inside the repository: profiles stay outside it. */
export function assertTempOutsideRepo(temp: string, repo: string): void {
  const rel = relative(resolve(repo), resolve(temp))
  if (rel === '' || !(rel.startsWith('..') || isAbsolute(rel)))
    throw new Error(
      `TMPDIR ${temp} is inside the repository; browser profiles must stay outside it`,
    )
}

export interface UiWebFixtureServer {
  url: string
  hub: WebModelHub
  manifest: WebAssetManifest
  stop(): Promise<void>
}

/**
 * The real `ab web` server over the branch's freshly built client, a
 * push-mode hub holding the base overview, and the analytics and timeline
 * routes answered from fixtures. No store is read.
 */
export async function startUiWebFixtureServer(): Promise<UiWebFixtureServer> {
  const files = await buildWebBundle()
  const manifest = JSON.parse(
    new TextDecoder().decode(files.get('manifest.json')!),
  ) as WebAssetManifest
  const hub = new WebModelHub({})
  hub.publish(overviewFrame())
  const server = await startWebServer({
    hostname: '127.0.0.1',
    port: 0,
    allowedHosts: loopbackHosts('127.0.0.1'),
    repositoryLabel: 'github.com/acme/app',
    hub,
    analytics: () => ({
      analytics: async (query) => analyticsFixture(query),
      timeline: async (slug) => timelineFixture(slug),
    }),
    manifest,
    readAsset: (path) => {
      const bytes = files.get(path)
      if (bytes === undefined) throw new Error(`no bundled asset ${path}`)
      return new Blob([bytes as Uint8Array<ArrayBuffer>])
    },
    command: 'ui-web capture',
  })
  return {
    url: server.url,
    hub,
    manifest,
    stop: async () => {
      hub.close()
      await server.stop()
    },
  }
}

const repo = resolve(import.meta.dir, '..')
const uiPkg = join(repo, 'packages/ui')

/** Build the catalog into `dir` as `packages/ui/scripts/catalog.ts` does,
 * without regenerating the committed tokens stylesheet. */
async function buildCatalog(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  const result = await Bun.build({
    entrypoints: [join(uiPkg, 'src/catalog/main.tsx')],
    outdir: dir,
    target: 'browser',
    minify: true,
    naming: { entry: '[name].[ext]', asset: 'assets/[name]-[hash].[ext]' },
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  if (!result.success)
    throw new Error(`catalog build failed:\n${result.logs.map(String).join('\n')}`)
  const preloads = result.outputs
    .map((o) => relative(dir, o.path))
    .filter((n) => /\.(ttf|woff2?)$/.test(n))
    .map((n) => `<link rel="preload" href="./${n}" as="font" crossorigin>\n`)
    .join('')
  const index = join(dir, 'index.html')
  await writeFile(
    index,
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
  return `file://${index}`
}

type Send = ReturnType<typeof debuggerRequests>['send']

interface Page {
  send: Send
  evaluate(expression: string): Promise<unknown>
  assertLive(): void
}

/** Spawn a browser on a fresh profile, attach to a fresh target, run `use`, reap. */
async function withBrowser<T>(
  chromium: string,
  { width, height, profile }: { width: number; height: number; profile: string },
  use: (page: Page) => Promise<T>,
): Promise<T> {
  await mkdir(profile, { recursive: true })
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
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--force-device-scale-factor=1',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      'about:blank',
    ],
    { stdout: 'ignore', stderr: 'ignore', timeout: 120_000 },
  )
  const deadline = Date.now() + 120_000
  const assertLive = () => {
    if (proc.exitCode !== null) throw new Error(`Chromium exited ${proc.exitCode}`)
    if (Date.now() >= deadline) throw new Error('Chromium capture timed out')
  }
  let socket: WebSocket | undefined
  let protocol: ReturnType<typeof debuggerRequests> | undefined
  try {
    let port = ''
    while (!port) {
      assertLive()
      try {
        port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]!
      } catch {
        await Bun.sleep(50)
      }
    }
    const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
      method: 'PUT',
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`Chromium target: ${response.status}`)
    const target = (await response.json()) as { webSocketDebuggerUrl: string }
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    socket = ws
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(
        () => fail(new Error('Chromium debugger connection timed out')),
        10_000,
      )
      ws.onopen = () => {
        clearTimeout(timer)
        done()
      }
      ws.onerror = ws.onclose = () => {
        clearTimeout(timer)
        fail(new Error('Chromium debugger connection failed'))
      }
    })
    protocol = debuggerRequests(ws, () => {
      assertLive()
      return Math.min(WAIT_MS, deadline - Date.now())
    })
    const send = protocol.send
    const evaluate = async (expression: string) => {
      const reply = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })
      if (reply.exceptionDetails)
        throw new Error(`evaluation failed: ${JSON.stringify(reply.exceptionDetails)}`)
      return reply.result?.value
    }
    return await use({ send, evaluate, assertLive })
  } finally {
    protocol?.close()
    socket?.close()
    proc.kill()
    await proc.exited
  }
}

const SETTLE_STATE = `(() => ({
  ready: document.readyState,
  reserve: !!document.querySelector('[data-ansi="reserve"]'),
  loaded: !!document.querySelector('[data-ansi="reserve"][data-ready]'),
  masked: document.querySelectorAll('[data-ansi="masked"]').length,
  skeletons: document.querySelectorAll('[data-skeleton]').length,
  charts: !!document.querySelector('[data-ansi="step-durations"]:not([data-skeleton])'),
}))()`

const TWO_FRAMES =
  'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))'

async function waitFor(
  page: Page,
  what: string,
  done: (state: Record<string, unknown>) => boolean,
): Promise<void> {
  const until = Date.now() + WAIT_MS
  let state: Record<string, unknown> = {}
  for (;;) {
    page.assertLive()
    state = ((await page.evaluate(SETTLE_STATE)) ?? {}) as Record<string, unknown>
    if (done(state)) return
    if (Date.now() >= until)
      throw new Error(
        `timed out after ${WAIT_MS} ms waiting for ${what}; last state ${JSON.stringify(state)}`,
      )
    await Bun.sleep(50)
  }
}

async function settle(page: Page, kind: UiWebPage['settle']): Promise<void> {
  await waitFor(page, 'document load', (s) => s.ready === 'complete')
  await page.evaluate('document.fonts.ready.then(() => true)')
  if (kind === 'reserve')
    await waitFor(
      page,
      'the loaded page',
      (s) => s.loaded === true && s.masked === 0 && s.skeletons === 0,
    )
  if (kind === 'charts')
    await waitFor(page, 'the loaded charts', (s) => s.charts === true && s.skeletons === 0)
  await page.evaluate(TWO_FRAMES)
}

/** Shoot the full page in parts of at most PART_MAX_ROWS rows, each under the store ceiling. */
async function shoot(
  page: Page,
  variant: UiWebVariant,
  out: string,
): Promise<Pick<FrameEntry, 'height' | 'pngPath' | 'parts'>> {
  const metrics = await page.send('Page.getLayoutMetrics')
  const content = metrics.cssContentSize?.height
  if (typeof content !== 'number' || !Number.isFinite(content) || content <= 0)
    throw new Error('invalid document height')
  const height = Math.max(HEIGHTS[variant.width], Math.ceil(content))
  const strips: { top: number; height: number; bytes: Uint8Array }[] = []
  for (const range of partRanges(height)) {
    const shot = await page.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { x: 0, y: range.top, width: variant.width, height: range.height, scale: 1 },
    })
    if (typeof shot.data !== 'string' || shot.data.length === 0) throw new Error('empty screenshot')
    const bytes = new Uint8Array(Buffer.from(shot.data, 'base64'))
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (
      bytes.byteLength < 24 ||
      view.getUint32(16) !== variant.width ||
      view.getUint32(20) !== range.height
    )
      throw new Error(
        `screenshot of rows ${range.top}–${range.top + range.height} has the wrong size`,
      )
    const tiles = tilePng(bytes, ARTIFACT_MAX_BYTES)
    if (tiles === null) strips.push({ ...range, bytes })
    else
      for (const t of tiles)
        strips.push({ top: range.top + t.top, height: t.height, bytes: t.bytes })
  }
  const rel = relative(repo, out)
  if (strips.length === 1) {
    const pngPath = join(rel, `${variant.id}.png`)
    await writeFile(join(repo, pngPath), strips[0]!.bytes)
    return { height, pngPath }
  }
  const parts: FramePart[] = []
  for (const [i, strip] of strips.entries()) {
    const id = `${variant.id}-part-${i + 1}-of-${strips.length}`
    const pngPath = join(rel, `${id}.png`)
    await writeFile(join(repo, pngPath), strip.bytes)
    parts.push({
      id,
      index: i + 1,
      count: strips.length,
      top: strip.top,
      height: strip.height,
      pngPath,
    })
  }
  return { height, parts }
}

async function captureVariant(
  chromium: string,
  profile: string,
  variant: UiWebVariant,
  url: string,
  spec: UiWebPage,
  hub: WebModelHub,
  out: string,
): Promise<FrameEntry> {
  hub.publish(overviewFrame())
  return withBrowser(
    chromium,
    { width: variant.width, height: HEIGHTS[variant.width], profile },
    async (page) => {
      await page.send('Page.enable')
      await page.send('Emulation.setDeviceMetricsOverride', {
        width: variant.width,
        height: HEIGHTS[variant.width],
        deviceScaleFactor: 1,
        mobile: false,
      })
      await page.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: variant.ground }],
      })
      await page.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' })
      await page.send('Page.addScriptToEvaluateOnNewDocument', { source: clockScript(NOW) })
      await page.send('Page.addScriptToEvaluateOnNewDocument', { source: clsRecorderScript() })
      const nav = await page.send('Page.navigate', { url })
      if (nav.errorText) throw new Error(`navigation failed: ${nav.errorText}`)
      await settle(page, spec.settle)
      if (spec.live) {
        for (const frame of [stateChangedFrame, attentionArrivedFrame, movedFrame]) {
          hub.publish(frame())
          await Bun.sleep(LIVE_STEP_MS)
        }
      }
      await Bun.sleep(spec.windowMs)
      const measured = (await page.evaluate('window.__uiWebCls ?? null')) as {
        installed?: boolean
        total?: number
        sources?: string[]
        error?: string
      } | null
      if (measured === null || measured.installed !== true)
        throw new Error(
          `layout-shift recorder did not run${measured?.error ? `: ${measured.error}` : ''}`,
        )
      const cls = typeof measured.total === 'number' ? measured.total : null
      const shot = await shoot(page, variant, out)
      return {
        ...variant,
        url,
        cls,
        clsSources: measured.sources ?? [],
        clsPass: clsPass(cls),
        ...shot,
      }
    },
  )
}

async function main(): Promise<number> {
  const command = 'bun run capture:ui-web'
  const out = join(repo, '.ab/ui-web-frames')
  assertOutputUnderScratch(out, repo)
  await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true })
  const variants = uiWebVariants()
  const frames: FrameEntry[] = []
  const errors: CaptureError[] = []
  const chromium = chromiumBinary()
  const write = async () => {
    await writeFile(join(out, 'frames.json'), `${JSON.stringify(frames, null, 2)}\n`)
    await writeFile(
      join(out, 'verify-report.md'),
      renderReport({ command, chromium, variants, frames, errors }),
    )
  }
  if (chromium === undefined) {
    errors.push({
      message: 'no Chromium binary found; set CHROMIUM_BIN to a Chromium-family browser',
    })
    await write()
    console.error(`ui-web: ${errors[0]!.message}`)
    return 1
  }
  const temp = tmpdir()
  let root: string | undefined
  let server: UiWebFixtureServer | undefined
  try {
    assertTempOutsideRepo(temp, repo)
    root = await mkdtemp(join(temp, 'ab-uiweb-'))
    const catalogUrl = await buildCatalog(join(out, 'site/catalog'))
    server = await startUiWebFixtureServer()
    const base = server.url.replace(/\/$/u, '')
    for (const variant of variants) {
      const spec = PAGES.find((p) => p.page === variant.page)!
      const url = spec.path === undefined ? catalogUrl : `${base}${spec.path}`
      const started = Date.now()
      try {
        const frame = await captureVariant(
          chromium,
          join(root, variant.id),
          variant,
          url,
          spec,
          server.hub,
          out,
        )
        frames.push(frame)
        console.log(
          `ui-web: ${variant.id} CLS ${fmt(frame.cls)} ${frame.clsPass ? 'PASS' : 'FAIL'} (${Date.now() - started} ms)`,
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        errors.push({
          id: variant.id,
          message: `${variant.page} at ${variant.ground} ${variant.width}px: ${message}`,
        })
        console.error(`ui-web: ${variant.id} failed: ${message}`)
      }
    }
  } catch (error) {
    errors.push({ message: error instanceof Error ? error.message : String(error) })
  } finally {
    await server?.stop()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
    await write()
  }
  const failing = frames.filter((f) => !f.clsPass).length
  console.log(
    `ui-web: ${frames.length}/${variants.length} variants, ${failing} over CLS ${CLS_THRESHOLD}, ${errors.length} errors; report ${relative(repo, join(out, 'verify-report.md'))}`,
  )
  return errors.length > 0 || failing > 0 || frames.length !== variants.length ? 1 : 0
}

if (import.meta.main) process.exit(await main())
