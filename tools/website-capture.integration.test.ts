import { afterAll, describe, expect, test } from 'bun:test'
import { buildFiles } from '../packages/website/src/build'
import { SEAMS } from '../packages/website/src/seams'
import {
  captureWebsite,
  type WebsiteFrame,
  type Probe,
  discoverFrames,
  chromiumBinary,
  type CaptureSegment,
  type CaptureTile,
  probeProblems,
  renderReport,
  SEGMENT_HEIGHT,
  segmentId,
  segmentTiles,
  serveSite,
  tileId,
  WEBSITE_FRAMES,
} from './website-capture'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { rm, stat } from 'node:fs/promises'

// Capture output must live under .ab/; remove exactly what this process created.
const ownedOutput = new Set<string>()
const pendingCaptures = new Set<Promise<unknown>>()
let outputClosed = false
const scratchDir = (name: string) => join(import.meta.dir, '..', '.ab', `${name}-${process.pid}`)
async function capture(options: Parameters<typeof captureWebsite>[0] & { outputDir: string }) {
  if (outputClosed) throw new Error(`capture after cleanup: ${options.outputDir}`)
  ownedOutput.add(options.outputDir)
  const pending = captureWebsite(options)
  pendingCaptures.add(pending)
  try {
    return await pending
  } finally {
    pendingCaptures.delete(pending)
  }
}
afterAll(async () => {
  outputClosed = true
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.allSettled([...pendingCaptures]),
    new Promise((resolve) => (timer = setTimeout(resolve, 30_000))),
  ])
  clearTimeout(timer)
  await Promise.all([...ownedOutput].map((dir) => rm(dir, { recursive: true, force: true })))
}, 60_000)

describe('website capture', () => {
  test('the server serves variants and the built assets with relative-asset URLs resolving', async () => {
    const site = serveSite(await buildFiles())
    try {
      const page = await fetch(`${site.url}/__page-desktop-remote.html`)
      expect(page.status).toBe(200)
      expect(await page.text()).toContain('data-set="remote"')
      expect((await fetch(`${site.url}/__frame-phone.html?h=500`)).status).toBe(200)
      const css = await fetch(`${site.url}/site.css`)
      expect(css.headers.get('content-type')).toContain('text/css')
      const js = await fetch(`${site.url}/site.js`)
      expect(js.headers.get('content-type')).toContain('text/javascript')
      expect((await fetch(`${site.url}/__page-nope.html`)).status).toBe(404)
    } finally {
      site.stop()
    }
  })

  const chromium = chromiumBinary()
  test.skipIf(!chromium)(
    'captures four real PNGs with the stylesheet loaded and the remote state applied',
    async () => {
      const dir = scratchDir('website-capture-test')
      const frames = discoverFrames({ ...(await buildFiles()) }).filter((f) => f.kind === 'landing')
      await capture({ chromium, outputDir: dir, frames, includeMotionSamples: false })
      const inventory: { frame: WebsiteFrame; probe: Probe }[] = await Bun.file(
        join(dir, 'inventory.json'),
      ).json()
      expect(inventory.map((entry) => entry.frame)).toEqual(frames)
      expect(frames.map((frame) => frame.id)).toEqual(WEBSITE_FRAMES.map((frame) => frame.id))
      for (const { frame, probe: measured } of inventory) {
        expect(frame.sample).toBeUndefined()
        expect(measured.stylesheetLoaded).toBe(true)
        expect(probeProblems(frame, measured)).toEqual([])
        if (frame.remote) {
          expect(measured.lean).toBe('remote')
          expect(measured.status).toBe('fully remote')
          expect(measured.runtime).toBe('codex')
          expect(measured.knobSettled).toBe(true)
          expect(measured.chips).toEqual(
            SEAMS.flatMap((seam) =>
              seam.adapters.map((adapter) => ({
                seam: seam.id,
                adapter: adapter.id,
                pressed: (
                  seam.id === 'runtime'
                    ? adapter.id === 'codex'
                    : adapter.side === 'remote'
                )
                  ? 'true'
                  : 'false',
              })),
            ),
          )
        }
      }
      for (const frame of WEBSITE_FRAMES) {
        const png = join(dir, `${frame.id}.png`)
        expect(existsSync(png)).toBe(true)
        expect((await stat(png)).size).toBeGreaterThan(8)
        expect(new Uint8Array(await Bun.file(png).arrayBuffer()).slice(0, 8)).toEqual(
          new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        )
      }
      const report = await Bun.file(join(dir, 'verify-report.md')).text()
      expect(report).toContain('PASS: `phone-remote` has no sideways scroll')
    },
    120_000,
  )
})

const fixture = (extra = '') =>
  `<!doctype html><html><head><link rel="stylesheet" href="/site.css"></head><body><h1>Documentation</h1>${extra}</body></html>`
const fixtureFiles = (extra = '') => ({
  'index.html': fixture(),
  'site.css': 'body{margin:0;background:white}figure{height:80px}',
  'site.js': '',
  'docs/index.html': fixture(extra),
  'docs/nested/page.html': fixture().replace('/site.css', '../../site.css'),
})

// Use docs-only descriptors for fixtures; the unchanged real landing is covered above.
test.skipIf(!chromiumBinary())(
  'captures docs and awaitable motion samples; rejects broken evidence',
  async () => {
    const { discoverFrames } = await import('./website-capture')
    const animation = `<figure data-capture-figure="sequence" data-capture-animated>still</figure><script>
window.__websiteCapture = { sequence: { duration: 100, async seek(timeMs, {still}) {
 const node = document.querySelector('figure');
 node.textContent = still ? 'reduced still' : String(timeMs);
 node.style.background = still ? 'gray' : timeMs === 0 ? 'red' : timeMs === 50 ? 'green' : 'blue';
 return {timeMs, still: still && matchMedia('(prefers-reduced-motion: reduce)').matches, complete: timeMs === 100};
}}};</script>`
    const files = fixtureFiles(animation)
    const frames = discoverFrames(files).filter((f) => f.kind === 'docs')
    const dir = scratchDir('website-fixtures')
    await capture({ files, frames, outputDir: dir })
    const inventory = await Bun.file(join(dir, 'inventory.json')).json()
    expect(inventory).toHaveLength(10)
    for (const r of inventory)
      expect((await stat(join(dir, `${r.frame.id}.png`))).size).toBeGreaterThan(0)
    const samples = inventory.filter((r: { frame: { sample?: string } }) => r.frame.sample)
    expect(samples.map((r: { probe: Probe }) => r.probe.figures[0]?.timeMs)).toEqual([
      0, 50, 100, 0, 50, 100,
    ])
    expect(samples[2].probe.figures[0].complete).toBe(true)
    for (const [name, extra, error] of [
      ['missing', '<figure data-capture-figure="x" data-capture-animated></figure>', 'adapter'],
      [
        'duplicate',
        '<figure data-capture-figure="same"></figure><figure data-capture-figure="same"></figure>',
        'duplicate',
      ],
      [
        'rejected',
        animation.replace('const node =', 'throw Error("seek rejected"); const node ='),
        'seek rejected',
      ],
      ['duration', animation.replace('duration: 100', 'duration: 0'), 'adapter'],
      [
        'final',
        animation.replace('complete: timeMs === 100', 'complete: false'),
        'acknowledgement',
      ],
      [
        'running',
        '<style>@keyframes spin{to{opacity:0}}h1{animation:spin 10s infinite}</style>',
        'animation',
      ],
      ['overflow', '<div style="width:2000px">wide</div>', 'sideways'],
    ]) {
      // The broken markup sits on docs/index.html; one width of it suffices.
      const broken = fixtureFiles(extra)
      await expect(
        capture({
          files: broken,
          frames: discoverFrames(broken).filter(
            (f) => f.kind === 'docs' && f.page === 'docs/index.html' && f.width === 390,
          ),
          outputDir: `${dir}-${name}`,
        }),
      ).rejects.toThrow(error)
      expect(await Bun.file(`${dir}-${name}/verify-report.md`).text()).toContain('FAIL:')
    }
  },
  240_000,
)

test('real built docs are discovered at desktop and phone widths', async () => {
  const files = await buildFiles()
  const frames = discoverFrames({ ...files }).filter(
    (frame) => frame.kind === 'docs' && !frame.id.startsWith('docs-builds-') && !frame.remote,
  )
  const pages = Object.keys(files)
    .filter((name) => name.startsWith('docs/') && name.endsWith('.html'))
    .sort()
  expect(frames.map((frame) => [frame.page, frame.width])).toEqual(
    pages.flatMap((page) => [1440, 390].map((width) => [page, width])),
  )
})

test('new Markdown page flows through output, navigation, pager and both real capture widths', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const root = await mkdtemp(join(tmpdir(), 'capture-markdown-'))
  const outputDir = scratchDir('markdown-capture')
  try {
    const page = (title: string, order: number) =>
      `---\ntitle: ${title}\ngroup: guides\norder: ${order}\ndescription: A generated page\n---\n# ${title}\n\nFirst paragraph.\n\n## Section\n\nMore words.\n`
    await Bun.write(join(root, 'before.md'), page('Before', 1))
    await Bun.write(
      join(root, 'added.md'),
      page('Added', 2) + '\nLong article paragraph.\n'.repeat(350),
    )
    await Bun.write(join(root, 'after.md'), page('After', 3))
    const files = await buildFiles(root)
    const html = files['docs/added/index.html']!
    expect(html).toContain('href="/docs/added/" aria-current="page"')
    expect(html).toContain('guides/')
    expect(html).toContain('<b>Before</b>')
    expect(html).toContain('<b>After</b>')
    // Discovery uses the emitted file as the route, with one frame per device class.
    const added = discoverFrames({ ...files }).filter((frame) => frame.page?.includes('added'))
    expect(added.map((frame) => frame.width)).toEqual([1440, 390])
    const chromium = chromiumBinary()
    if (chromium) {
      await capture({
        chromium,
        outputDir,
        files: { ...files },
        frames: added,
        includeMotionSamples: false,
      })
      const inventory: {
        frame: WebsiteFrame
        probe: Probe
        height: number
        tiles?: { id: string }[]
        segments?: unknown[]
      }[] = await Bun.file(join(outputDir, 'inventory.json')).json()
      expect(inventory).toHaveLength(2)
      for (const entry of inventory) {
        expect(entry.probe.scrollHeight).toBeGreaterThan(12_000)
        expect(entry.height).toBe(entry.probe.scrollHeight)
        expect(probeProblems(entry.frame, entry.probe)).toEqual([])
        // A page over one window's height is shot in segments and stored as page-ordered tiles.
        const segmented = entry.height > SEGMENT_HEIGHT
        expect(Boolean(entry.segments)).toBe(segmented)
        for (const id of segmented ? entry.tiles!.map((t) => t.id) : [entry.frame.id])
          expect(existsSync(join(outputDir, `${id}.png`))).toBe(true)
      }
    }
    await rm(join(root, 'added.md'))
    expect('docs/added/index.html' in (await buildFiles(root))).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)

test('seams overview captures the remote interaction at both widths', async () => {
  const frames = discoverFrames({ ...(await buildFiles()) })
  expect(
    frames
      .filter((frame) => frame.kind === 'docs' && frame.remote)
      .map((frame) => [frame.page, frame.width]),
  ).toEqual([
    ['docs/seams/index.html', 1440],
    ['docs/seams/index.html', 390],
  ])
})

describe('frame tiling under the artifact ceiling', () => {
  // 400 solid 100px blocks with unique colours: block k fills page rows 100k..100k+99.
  const blockColour = (k: number) => [k % 256, Math.floor(k / 256) * 80 + 40, 255 - (k % 256)]
  const tallFiles = () =>
    fixtureFiles(
      Array.from(
        { length: 400 },
        (_, k) => `<div style="height:100px;background:rgb(${blockColour(k).join(',')})"></div>`,
      ).join(''),
    )
  const tallFixture = (files: ReturnType<typeof tallFiles>) => ({
    ...files,
    // The fixture body is exactly 40,000px: no heading, no margins.
    'docs/index.html': String(files['docs/index.html']).replace('<h1>Documentation</h1>', ''),
  })

  test.skipIf(!chromiumBinary())(
    'a 40,000px page captures in ordered segments with no gaps or overlaps at both widths',
    async () => {
      const { decodePng } = await import('./website-capture-png')
      const { readdir } = await import('node:fs/promises')
      const files = tallFixture(tallFiles())
      const frames = discoverFrames(files).filter(
        (f) => f.kind === 'docs' && f.page === 'docs/index.html',
      )
      expect(frames.map((f) => f.width)).toEqual([1440, 390])
      const dir = scratchDir('website-segments')
      await capture({ files, frames, outputDir: dir, includeMotionSamples: false })
      const inventory = await Bun.file(join(dir, 'inventory.json')).json()
      const report = await Bun.file(join(dir, 'verify-report.md')).text()
      expect(inventory).toHaveLength(2)
      /** Every tile is contiguous, inside its own segment, and every page row
       * shows its own block: nothing is missing, repeated or shifted. */
      const expectTiles = async (
        entry: { frame: { id: string; width: number }; segments: CaptureSegment[] },
        tiles: readonly (CaptureTile & { bytes?: Uint8Array })[],
        tileReport: string,
        maxFrameBytes: number,
      ) => {
        let rows = 0
        for (const [i, tile] of tiles.entries()) {
          expect(tile.index).toBe(i + 1)
          expect(tile.count).toBe(tiles.length)
          expect(tile.id).toBe(tileId(entry.frame.id, i + 1, tiles.length))
          expect(tile.top).toBe(rows)
          const owner = entry.segments[tile.segment! - 1]!
          expect(tile.top).toBeGreaterThanOrEqual(owner.top)
          expect(tile.top + tile.height).toBeLessThanOrEqual(owner.top + owner.height)
          expect(tileReport).toContain(`\`${tile.id}\``)
          const bytes = tile.bytes ?? (await Bun.file(join(dir, `${tile.id}.png`)).bytes())
          expect(bytes.byteLength).toBeLessThanOrEqual(maxFrameBytes)
          const image = decodePng(bytes)
          expect(image.width).toBe(entry.frame.width)
          expect(image.height).toBe(tile.height)
          for (let y = 0; y < tile.height; y++) {
            const page = tile.top + y
            if (page % 100 !== 0 && page % 100 !== 99 && y !== 0 && y !== tile.height - 1) continue
            const pixel = [...image.rows[y]!.subarray(0, 3)]
            expect([page, ...pixel]).toEqual([page, ...blockColour(Math.floor(page / 100))])
          }
          rows += tile.height
        }
        expect(rows).toBe(40_000)
      }
      for (const entry of inventory) {
        expect(entry.height).toBe(40_000)
        expect(entry.segments).toHaveLength(3)
        let top = 0
        for (const [i, segment] of entry.segments.entries()) {
          expect(segment.id).toBe(segmentId(entry.frame.id, i + 1, 3))
          expect(segment.top).toBe(top)
          top += segment.height
          expect(report).toContain(`\`${segment.id}\``)
        }
        expect(top).toBe(40_000)
        // Under the default limit each segment is one tile, as shot.
        expect(entry.tiles).toHaveLength(3)
        await expectTiles(entry, entry.tiles, report, 2_621_440)
        // A small limit cuts those same segment shots into more, still
        // contiguous tiles, and the report lists every one.
        const shots = await Promise.all(
          entry.segments.map(async (segment: CaptureSegment, i: number) => ({
            ...segment,
            bytes: await Bun.file(join(dir, `${entry.tiles[i].id}.png`)).bytes(),
          })),
        )
        const tiled = segmentTiles(entry.frame.id, shots, 40_000)
        expect(tiled.length).toBeGreaterThan(3)
        const tiledReport = renderReport(
          [{ ...entry, tiles: tiled.map(({ bytes: _bytes, ...tile }) => tile) }],
          40_000,
        )
        await expectTiles(entry, tiled, tiledReport, 40_000)
      }
      const pngs = (await readdir(dir)).filter((n) => n.endsWith('.png'))
      expect(pngs.some((n) => n.includes('-segment-'))).toBe(false)
      for (const entry of inventory) expect(pngs).not.toContain(`${entry.frame.id}.png`)
      for (const name of pngs)
        expect((await stat(join(dir, name))).size).toBeLessThanOrEqual(2_621_440)
    },
    360_000,
  )

  test.skipIf(!chromiumBinary())(
    'a page whose probe never runs fails with load diagnostics, not a bare missing meta',
    async () => {
      const files = fixtureFiles('<script>window.addEventListener = () => {}</script>')
      // The override must precede the injected probe; fixture content sits before </body>.
      const frames = discoverFrames(files).filter(
        (f) => f.kind === 'docs' && f.page === 'docs/index.html' && f.width === 390,
      )
      const dir = scratchDir('website-load-failure')
      const error = await capture({
        files,
        frames,
        outputDir: dir,
        includeMotionSamples: false,
      }).catch((e) => String(e))
      expect(error).toContain('did not produce its capture probe')
      expect(error).toContain('390x900')
      expect(error).toContain('"loaded":true')
      expect(await Bun.file(join(dir, 'verify-report.md')).text()).toContain('FAIL:')
    },
    120_000,
  )

  test.skipIf(!chromiumBinary())(
    'a tall docs page captures as ceiling-bounded tiles; a fitting frame stays whole',
    async () => {
      const { decodePng } = await import('./website-capture-png')
      const { readdir } = await import('node:fs/promises')
      const blocks = Array.from(
        { length: 120 },
        (_, i) =>
          `<div style="height:50px;background:hsl(${(i * 37) % 360},70%,60%)">block ${i} ${'lorem ipsum '.repeat(i % 7)}</div>`,
      ).join('')
      const files = fixtureFiles(blocks)
      const docs = discoverFrames(files).filter((f) => f.kind === 'docs' && f.width === 1440)
      const frames = [docs.find((f) => f.page === 'docs/index.html')!]
      const dir = scratchDir('website-tiles')
      const max = 40_000
      await capture({
        files,
        frames,
        outputDir: dir,
        includeMotionSamples: false,
        maxFrameBytes: max,
      })
      const [entry] = await Bun.file(join(dir, 'inventory.json')).json()
      expect(existsSync(join(dir, `${entry.frame.id}.png`))).toBe(false)
      expect(entry.tiles.length).toBeGreaterThanOrEqual(2)
      expect(new Set(entry.tiles.map((t: { id: string }) => t.id)).size).toBe(entry.tiles.length)
      const report = await Bun.file(join(dir, 'verify-report.md')).text()
      let rows = 0
      for (const tile of entry.tiles) {
        expect(tile.id).toBe(tileId(entry.frame.id, tile.index, tile.count))
        expect(tile.frame).toBe(entry.frame.id)
        expect(tile.top).toBe(rows)
        rows += tile.height
        expect(decodePng(await Bun.file(join(dir, `${tile.id}.png`)).bytes()).height).toBe(
          tile.height,
        )
        expect(report).toContain(`\`${tile.id}\``)
      }
      expect(rows).toBe(entry.height)
      for (const name of (await readdir(dir)).filter((n) => n.endsWith('.png')))
        expect((await stat(join(dir, name))).size).toBeLessThanOrEqual(max)

      await capture({
        files,
        frames,
        outputDir: `${dir}-whole`,
        includeMotionSamples: false,
      })
      const [whole] = await Bun.file(join(`${dir}-whole`, 'inventory.json')).json()
      expect('tiles' in whole).toBe(false)
      expect(existsSync(join(`${dir}-whole`, `${whole.frame.id}.png`))).toBe(true)
      const full = decodePng(await Bun.file(join(`${dir}-whole`, `${whole.frame.id}.png`)).bytes())
      expect(full.height).toBe(rows)
    },
    120_000,
  )
})

test.skipIf(!chromiumBinary())(
  'landing paint rejection retries fresh shots and never publishes incomplete evidence',
  async () => {
    const { decodePng, encodePng } = await import('./website-capture-png')
    const files = { ...(await buildFiles()) }
    const frame = { ...WEBSITE_FRAMES[0]!, motion: 'reduce' as const }
    for (const exhaust of [false, true]) {
      const outputDir = scratchDir(`paint-${exhaust}`)
      let shots = 0
      const promise = capture({
        files,
        frames: [frame],
        includeMotionSamples: false,
        outputDir,
        screenshotBytes(bytes, attempt) {
          shots++
          if (attempt && !exhaust) return bytes
          const image = decodePng(bytes)
          // Simulate an unpainted header while leaving the DOM and other pixels intact.
          for (const row of image.rows.slice(0, 100)) row.fill(0)
          return encodePng(image)
        },
      })
      if (exhaust) {
        await expect(promise).rejects.toThrow('incomplete paint')
        expect(existsSync(join(outputDir, 'inventory.json'))).toBe(false)
        expect(existsSync(join(outputDir, 'desktop.png'))).toBe(false)
        expect(await Bun.file(join(outputDir, 'verify-report.md')).text()).toContain(
          'classification: capture-error',
        )
      } else {
        await promise
        expect(existsSync(join(outputDir, 'inventory.json'))).toBe(true)
        expect(existsSync(join(outputDir, 'desktop.png'))).toBe(true)
      }
      expect(shots).toBe(2)
      const history = await Bun.file(join(outputDir, 'desktop-segment-1-of-1-attempts.json')).json()
      expect(history.map((entry: { status: string }) => entry.status)).toEqual([
        'rejected',
        exhaust ? 'rejected' : 'complete',
      ])
    }
  },
  30_000,
)

test('website verifier retries unavailable captures and escalates without passing incomplete evidence', async () => {
  const skill = await Bun.file(
    join(import.meta.dir, '../.agents/skills/verify-ui-website/SKILL.md'),
  ).text()
  for (const phrase of [
    'Never pass incomplete evidence',
    'ab escalate',
    'record both attempts',
    'never fail the build for missing or blank pixels on that page',
    'no Chromium binary',
  ])
    expect(skill).toContain(phrase)
})

test.skipIf(!chromiumBinary())(
  'real-time landing readiness awaits fonts and image decode, with bounded unavailable-evidence diagnostics',
  async () => {
    const { runRealtimeChromium } = await import('./website-capture')
    const { mkdir } = await import('node:fs/promises')
    const frame = {
      ...WEBSITE_FRAMES[0]!,
      motion: 'normal' as const,
      figure: 'readiness-figure',
      duration: 100,
      sample: 'final' as const,
    }
    const built = { ...(await buildFiles()) }
    const readiness = `<script>
Object.defineProperty(document.fonts, 'ready', {value: new Promise(resolve=>setTimeout(() => {document.querySelector('h1').textContent='Ready fonts'; resolve()},900))});
HTMLImageElement.prototype.decode = () => new Promise(resolve=>setTimeout(() => {document.querySelector('footer span').textContent='Decoded image'; resolve()},300));
window.__websiteCapture = {'readiness-figure': {duration:100, ready:Promise.resolve(), seek: async (timeMs) => ({timeMs,complete:timeMs===100})}};
</script><div data-capture-figure="readiness-figure" data-capture-animated>Readiness figure</div><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'%3E%3C/svg%3E" style="position:absolute" />`
    const files = {
      ...built,
      'index.html': built['index.html'].replace('</body>', `${readiness}</body>`),
    }
    const outputDir = scratchDir('readiness')
    await capture({ files, frames: [frame], outputDir, includeMotionSamples: false })
    const inventory = await Bun.file(join(outputDir, 'inventory.json')).json()
    expect(inventory[0].probe.readiness.elapsedMs).toBeGreaterThanOrEqual(300)
    expect(inventory[0].probe.readiness.fonts).toBe('loaded')
    expect(
      inventory[0].probe.paintRegions.some(
        (region: { label: string }) => region.label === 'h1: Ready fonts',
      ),
    ).toBe(true)
    expect(
      inventory[0].probe.paintRegions.some(
        (region: { label: string }) => region.label === 'footer: Decoded image',
      ),
    ).toBe(true)
    expect(inventory[0].probe.reducedMotion).toBe(false)
    expect(inventory[0].probe.figures).toContainEqual({
      id: 'readiness-figure',
      animated: true,
      duration: 100,
      timeMs: 100,
      complete: true,
    })
    const stalled = {
      ...built,
      'index.html': built['index.html'].replace(
        '</body>',
        `<script>Object.defineProperty(document.fonts,'ready',{value:new Promise(()=>{})})</script></body>`,
      ),
    }
    const site = serveSite(stalled, [frame])
    const profile = scratchDir('readiness-profile')
    ownedOutput.add(profile)
    await mkdir(profile, { recursive: true })
    try {
      await expect(
        runRealtimeChromium(
          chromiumBinary()!,
          profile,
          1440,
          900,
          { dumpDom: true, timeoutMs: 500 },
          `${site.url}/__frame-desktop.html?h=900`,
        ),
      ).rejects.toThrow('real-time capture produced no probe')
    } finally {
      site.stop()
    }
  },
  15_000,
)
