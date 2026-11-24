import { expect, test } from 'bun:test'
import {
  assertOutputUnderScratch,
  motionFrames,
  artifactId,
  type WebsiteFrame,
  discoverFrames,
  chromiumBinary,
  injectProbe,
  type Probe,
  parseProbe,
  probeProblems,
  renderReport,
  SEGMENT_HEIGHT,
  segmentId,
  segmentRanges,
  tileId,
  WEBSITE_FRAMES,
  wrapperPage,
} from './website-capture'
const probe = (over: Partial<Probe> = {}): Probe => ({
  reducedMotion: true,
  still: true,
  figures: [],
  scrollWidth: 390,
  innerWidth: 390,
  scrollHeight: 1000,
  stylesheetLoaded: true,
  lean: null,
  status: null,
  knobSettled: true,
  runtime: null,
  chips: [],
  sectionGaps: [192, 192],
  footerGap: 192,
  ctaGap: 48,
  ...over,
})

const DESKTOP_GAPS = { sectionGaps: [288, 288], footerGap: 288 }
const fixture = (extra = '') =>
  `<!doctype html><html><head><link rel="stylesheet" href="/site.css"></head><body><h1>Documentation</h1>${extra}</body></html>`
const fixtureFiles = (extra = '') => ({
  'index.html': fixture(),
  'site.css': 'body{margin:0;background:white}figure{height:80px}',
  'site.js': '',
  'docs/index.html': fixture(extra),
  'docs/nested/page.html': fixture().replace('/site.css', '../../site.css'),
})

const tallImage = (width: number, height: number) => {
  let seed = 12345
  const rows = Array.from({ length: height }, (_, y) => {
    const row = new Uint8Array(width * 3)
    for (let i = 0; i < row.length; i++) {
      if (y % 50 === 0) row[i] = 200
      else if (y % 50 === 1) row[i] = i & 0xff
      else if (y % 50 === 2) row[i] = (y + i) & 0xff
      else {
        seed = (seed * 1103515245 + 12345) >>> 0
        row[i] = seed >>> 24
      }
    }
    return row
  })
  return { width, colorType: 2, ancillary: [], rows }
}

test('frames are 1440, 390, 1440 remote, and 390 remote', () => {
  expect(WEBSITE_FRAMES.map((f) => [f.id, f.width, f.remote])).toEqual([
    ['desktop', 1440, false],
    ['phone', 390, false],
    ['desktop-remote', 1440, true],
    ['phone-remote', 390, true],
  ])
})

test('chromiumBinary prefers configured binaries, then paths, then PATH', () => {
  const exists = (p: string) => p === '/x/chrome' || p === '/usr/bin/chromium'
  expect(chromiumBinary({ CHROMIUM_BIN: '/x/chrome' }, exists, () => null)).toBe('/x/chrome')
  expect(chromiumBinary({ CHROMIUM_BIN: '/missing' }, exists, () => null)).toBe('/usr/bin/chromium')
  expect(
    chromiumBinary(
      {},
      () => false,
      (n) => (n === 'chromium' ? '/p/chromium' : null),
    ),
  ).toBe('/p/chromium')
  expect(
    chromiumBinary(
      {},
      () => false,
      () => null,
    ),
  ).toBeUndefined()
})

test('injectProbe puts the script before </body> and clicks remote only when asked', () => {
  const html = '<html><head></head><body><p>x</p></body></html>'
  const plain = injectProbe(html, { remote: false })
  const remote = injectProbe(html, { remote: true })
  expect(plain.indexOf('<script>')).toBeLessThan(plain.indexOf('</body>'))
  expect(plain).toContain('<base href="/">')
  expect(plain).not.toContain('data-set="remote"')
  expect(remote).toContain('data-set="remote"')
})

test('parseProbe round-trips and rejects a missing meta', () => {
  const value = probe({ status: 'fully "remote"' })
  const content = JSON.stringify(value).replace(/"/g, '&quot;')
  expect(parseProbe(`<head><meta name="capture-probe" content="${content}"></head>`)).toEqual(value)
  expect(() => parseProbe('<html></html>')).toThrow(
    "did not produce its capture probe before the browser's time budget expired (no load diagnostics: the wrapper itself did not run)",
  )
  const failure = JSON.stringify({
    loaded: false,
    readyState: 'loading',
    href: 'about:blank',
    body: false,
  }).replace(/"/g, '&quot;')
  const error = (() => {
    try {
      parseProbe(
        `<head><meta name="capture-load-failure" content="${failure}"></head>`,
        'docs-x-390 screenshot at 390x16000',
      )
    } catch (e) {
      return String(e)
    }
  })()
  expect(error).toContain(
    'website capture docs-x-390 screenshot at 390x16000: the page did not produce its capture probe',
  )
  expect(error).toContain('"loaded":false')
  expect(error).toContain('"readyState":"loading"')
  expect(error).toContain('"href":"about:blank"')
  expect(error).toContain('"body":false')
})

test('probeProblems checks the stylesheet and the remote contract', () => {
  const desktop = WEBSITE_FRAMES[0]!
  const remote = WEBSITE_FRAMES[2]!
  expect(probeProblems(desktop, probe(DESKTOP_GAPS))).toEqual([])
  expect(probeProblems(desktop, probe({ ...DESKTOP_GAPS, stylesheetLoaded: false }))).toEqual([
    'site.css did not load',
  ])
  expect(
    probeProblems(remote, probe({ ...DESKTOP_GAPS, lean: 'local', status: 'fully local' })).length,
  ).toBe(3)
  const ok = probe({
    ...DESKTOP_GAPS,
    runtime: 'codex',
    lean: 'remote',
    status: 'fully remote',
    chips: [
      { seam: 'tickets', adapter: 'linear', pressed: 'true' },
      { seam: 'tickets', adapter: 'local-files', pressed: 'false' },
      { seam: 'dispatcher', adapter: 'cron', pressed: 'true' },
    ],
  })
  expect(probeProblems(remote, ok)).toEqual([])
  expect(
    probeProblems(remote, {
      ...ok,
      chips: [{ seam: 'dispatcher', adapter: 'local-process', pressed: 'true' }],
    }),
  ).toEqual(['local chip dispatcher/local-process is still pressed'])
  ok.chips[0]!.pressed = 'false'
  expect(probeProblems(remote, ok)).toHaveLength(1)
  ok.chips[0]!.pressed = 'true'
  expect(probeProblems(remote, { ...ok, knobSettled: false })).toEqual(['knob still animating'])
  expect(probeProblems(remote, { ...ok, runtime: 'claude-code' })).toEqual([
    'runtime is claude-code, expected codex',
  ])
})

test('probeProblems holds section spacing to 288px desktop and 192px phone', () => {
  const desktop = WEBSITE_FRAMES[0]!
  const phone = WEBSITE_FRAMES[1]!
  expect(probeProblems(phone, probe())).toEqual([])
  expect(probeProblems(desktop, probe({ ...DESKTOP_GAPS, sectionGaps: [288, 96] }))).toEqual([
    'section gap is 96px, expected 288px',
  ])
  expect(probeProblems(desktop, probe({ ...DESKTOP_GAPS, footerGap: 96 }))).toEqual([
    'footer gap is 96px, expected 288px',
  ])
  expect(probeProblems(phone, probe({ footerGap: 288 }))).toEqual([
    'footer gap is 288px, expected 192px',
  ])
  expect(probeProblems(desktop, probe({ ...DESKTOP_GAPS, sectionGaps: [] }))).toEqual([
    'no sections found to measure',
  ])
  expect(probeProblems(desktop, probe({ ...DESKTOP_GAPS, ctaGap: 56 }))).toEqual([
    'terminal-to-button gap is 56px, expected 48px',
  ])
  expect(probeProblems(phone, probe({ scrollWidth: 500 }))).toEqual([
    'page scrolls sideways (500 > 390)',
  ])
})

test('the remote probe waits out the glide and checks the knob has settled', () => {
  const script = injectProbe('<body></body>', { remote: true })
  expect(script).toContain('getAnimations()')
  expect(script).toContain('}, 350)')
})

test('renderReport pairs references and reports phone overflow', () => {
  const results = (scrollWidth: number) =>
    WEBSITE_FRAMES.map((frame) => ({
      frame,
      probe: probe({ scrollWidth, sectionGaps: [frame.width >= 720 ? 288 : 192] }),
      height: 1000,
    }))
  const pass = renderReport(results(390))
  expect(pass).toContain('design/website/reference-phone.png')
  expect(pass).toContain('design/website/reference-phone-remote.png')
  expect(pass).not.toContain('no approved screenshot')
  expect(pass).toContain('PASS: `phone` has no sideways scroll')
  expect(pass).toContain('PASS: `phone-remote` has no sideways scroll')
  expect(pass).toContain('section gaps [288]px')
  expect(renderReport(results(500))).toContain('FAIL: `phone-remote` scrolls sideways')
})

test('output must live under .ab/', () => {
  expect(() => assertOutputUnderScratch('/repo', '/repo/out')).toThrow('must live under')
  expect(() => assertOutputUnderScratch('/repo', '/repo/.ab')).toThrow('must live under')
  expect(() => assertOutputUnderScratch('/repo', '/repo/.ab/website-frames')).not.toThrow()
})

test('discovers sorted docs HTML with distinct complete-path IDs and relative bases', async () => {
  const { discoverFrames, artifactId } = await import('./website-capture')
  const files = {
    ...fixtureFiles(),
    'docs/a-b.html': fixture(),
    'docs/a/b.html': fixture(),
    'docs/x.png': '',
  }
  const frames = discoverFrames(files).filter((f) => f.kind === 'docs')
  expect(frames.map((f) => f.page)).toEqual([
    'docs/a-b.html',
    'docs/a-b.html',
    'docs/a/b.html',
    'docs/a/b.html',
    'docs/index.html',
    'docs/index.html',
    'docs/nested/page.html',
    'docs/nested/page.html',
  ])
  expect(new Set(frames.map((f) => f.id)).size).toBe(8)
  expect(artifactId('a/b')).not.toBe(artifactId('a-b'))
  expect(injectProbe(fixture(), frames[0]!)).toContain('<base href="/docs/a-b.html">')
  expect(probeProblems(frames[1]!, probe({ sectionGaps: [], footerGap: -1, ctaGap: -1 }))).toEqual(
    [],
  )
  expect(probeProblems(frames[1]!, probe({ scrollWidth: 500 }))).toContain(
    'page scrolls sideways (500 > 390)',
  )
})

test('full discovery expands every animated figure at both widths in sample order', () => {
  const baselines = discoverFrames(fixtureFiles())
  expect(baselines.slice(0, 4)).toEqual(
    WEBSITE_FRAMES.map((frame) => ({
      ...frame,
      page: 'index.html',
      kind: 'landing',
      motion: 'reduce',
    })),
  )
  const figures = [
    { id: 'pipeline', animated: true, duration: 1000 },
    { id: 'static', animated: false },
    { id: 'tree', animated: true, duration: 2400 },
  ]
  const expanded = baselines.flatMap((frame) => {
    const samples = motionFrames(frame, figures)
    expect(samples).toEqual(
      figures
        .filter((figure) => figure.animated)
        .flatMap((figure) =>
          (['start', 'midpoint', 'final'] as const).map((sample) => ({
            ...frame,
            reference: undefined,
            id: `${frame.id}-figure-${artifactId(figure.id)}-${sample}`,
            motion: 'normal',
            figure: figure.id,
            duration: figure.duration,
            sample,
          })),
        ),
    )
    expect(motionFrames({ ...frame, motion: 'normal' }, figures)).toEqual([])
    expect(motionFrames(frame, [{ id: 'static', animated: false }])).toEqual([])
    return samples
  })
  expect(new Set([...baselines, ...expanded].map((frame) => frame.id)).size).toBe(
    baselines.length + expanded.length,
  )
})

test('docs discovery adds real disclosure, boundary and bounded scrolling frames', () => {
  const frames = discoverFrames({
    'index.html': '',
    'site.css': '',
    'site.js': '',
    'docs/builds/index.html': '',
  })
  const states = frames.filter((frame) => frame.id.startsWith('docs-builds-'))
  expect(states.map((frame) => [frame.id, frame.width])).toEqual([
    ['docs-builds-menu', 390],
    ['docs-builds-toc', 390],
    ['docs-builds-720', 720],
    ['docs-builds-intermediate', 1000],
    ['docs-builds-scrolled', 1440],
  ])
  expect(states.at(-1)?.viewportHeight).toBe(900)
  expect(injectProbe('<head></head><body></body>', states[0]!)).toContain(
    "querySelector('[data-site-menu]')?.click()",
  )
  expect(injectProbe('<head></head><body></body>', states[1]!)).toContain(
    "querySelector('[data-toc-toggle]')?.click()",
  )
  expect(injectProbe('<head></head><body></body>', states[4]!)).toContain('window.scrollTo(')
})

test('docs probes reject disclosure, section, sticky, code and width regressions', () => {
  const frame: WebsiteFrame = {
    id: 'scroll',
    width: 1440,
    remote: false,
    kind: 'docs',
    docsState: 'scrolled',
  }
  const docs: NonNullable<Probe['docs']> = {
    menuExpanded: false,
    tocExpanded: false,
    active: ['third', 'third'],
    expectedActive: 'third',
    leftVisible: true,
    rightVisible: true,
    leftTop: 24,
    rightTop: 24,
    scrollY: 600,
    codeContained: true,
    copyPresent: true,
    copyHeight: 40,
    copyPlaced: true,
  }
  expect(probeProblems(frame, probe({ docs }))).toEqual([])
  for (const bad of [
    { copyPresent: false },
    { copyHeight: 39 },
    { copyPlaced: false },
    { menuExpanded: true },
    { tocExpanded: true },
    { active: ['first', 'first'] },
    { leftTop: -20 },
    { codeContained: false },
    { rightVisible: false },
  ]) {
    expect(probeProblems(frame, probe({ docs: { ...docs, ...bad } })).length).toBeGreaterThan(0)
  }
  expect(probeProblems(frame, probe({ docs, scrollWidth: 1500, innerWidth: 1440 }))).toContain(
    'page scrolls sideways (1500 > 1440)',
  )
})

test('the PNG codec round-trips every filter path and rejects unsupported input', async () => {
  const { decodePng, encodePng } = await import('./website-capture-png')
  const image = tallImage(300, 400)
  const decoded = decodePng(encodePng(image))
  expect([decoded.width, decoded.height, decoded.channels]).toEqual([300, 400, 3])
  expect(decoded.rows).toEqual(image.rows)
  // Hand-filter rows with every filter type so decoding does not rely on the encoder's choices.
  const { deflateSync } = await import('node:zlib')
  const stride = 300 * 3
  const raw = new Uint8Array((stride + 1) * 5)
  image.rows.slice(0, 5).forEach((row, y) => {
    const prev = y ? image.rows[y - 1]! : new Uint8Array(stride)
    raw[y * (stride + 1)] = y
    for (let i = 0; i < stride; i++) {
      const a = i >= 3 ? row[i - 3]! : 0
      const b = prev[i]!
      const c = i >= 3 ? prev[i - 3]! : 0
      const p = a + b - c
      const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)]
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][y]!
      raw[y * (stride + 1) + 1 + i] = (row[i]! - pred) & 0xff
    }
  })
  const reference = encodePng({ ...image, rows: image.rows.slice(0, 5) })
  const ihdrEnd = 8 + 12 + 13
  const { crc32 } = (await import('node:zlib')) as unknown as {
    crc32?: (d: Uint8Array) => number
  }
  if (crc32) {
    const body = deflateSync(raw)
    const chunk = new Uint8Array(12 + body.byteLength)
    const view = new DataView(chunk.buffer)
    view.setUint32(0, body.byteLength)
    chunk.set([73, 68, 65, 84], 4)
    chunk.set(body, 8)
    view.setUint32(8 + body.byteLength, crc32(chunk.subarray(4, 8 + body.byteLength)))
    const handmade = Buffer.concat([reference.subarray(0, ihdrEnd), chunk, reference.subarray(-12)])
    expect(decodePng(handmade).rows).toEqual(image.rows.slice(0, 5))
  }
  const bad = (byte: number, value: number) => {
    const copy = reference.slice()
    copy[byte] = value
    return copy
  }
  expect(() => decodePng(bad(8 + 8 + 8, 16))).toThrow('unsupported PNG')
  expect(() => decodePng(bad(8 + 8 + 12, 1))).toThrow('unsupported PNG')
  expect(() => decodePng(bad(0, 0))).toThrow('unsupported PNG')
})

test('an artificially tall page tiles below the given ceiling with full coverage', async () => {
  const { decodePng, encodePng, tilePng } = await import('./website-capture-png')
  const image = tallImage(300, 4000)
  const bytes = encodePng(image)
  expect(tilePng(bytes, bytes.byteLength)).toBeNull()
  const max = Math.floor(bytes.byteLength / 3)
  const tiles = tilePng(bytes, max)!
  expect(tiles.length).toBeGreaterThanOrEqual(3)
  expect(tiles.map((t) => t.index)).toEqual(tiles.map((_, i) => i + 1))
  expect(tiles[0]!.top).toBe(0)
  for (const [k, tile] of tiles.entries()) {
    expect(tile.bytes.byteLength).toBeLessThanOrEqual(max)
    expect(tile.count).toBe(tiles.length)
    if (k > 0) expect(tile.top).toBe(tiles[k - 1]!.top + tiles[k - 1]!.height)
  }
  expect(tiles.reduce((sum, t) => sum + t.height, 0)).toBe(4000)
  expect(tiles.flatMap((t) => decodePng(t.bytes).rows)).toEqual(image.rows)
})

test('tile ids are safe and ordered, and the ceiling mirrors the store', async () => {
  const { ARTIFACT_MAX_BYTES } = await import('./website-capture-png')
  const { HOSTED_ARTIFACT_MAX_BYTES } = await import('../packages/hosted-store-service/src/config')
  expect(tileId('docs-ab-1440', 2, 12)).toBe('docs-ab-1440-tile-02-of-12')
  expect(tileId('docs-ab-1440', 2, 12)).toMatch(/^[a-z0-9-]+$/)
  expect(ARTIFACT_MAX_BYTES).toBe(HOSTED_ARTIFACT_MAX_BYTES)
  expect(ARTIFACT_MAX_BYTES).toBe(2_621_440)
})

test('renderReport lists the tiles of a tiled frame', () => {
  const frame = WEBSITE_FRAMES[0]!
  const tiles = [1, 2].map((index) => ({
    id: `desktop-tile-${index}-of-2`,
    frame: 'desktop',
    index,
    count: 2,
    top: (index - 1) * 500,
    height: 500,
    png: `.ab/website-frames/desktop-tile-${index}-of-2.png`,
  }))
  const report = renderReport(
    [
      {
        frame,
        probe: probe({ sectionGaps: [288] }),
        height: 1000,
        tiles,
      },
    ],
    100,
  )
  expect(report).toContain('`desktop` — tiled into 2 PNGs (each ≤ 100 bytes), 1440x1000')
  expect(report).toContain(
    '  - tile 2/2 `desktop-tile-2-of-2` — `.ab/website-frames/desktop-tile-2-of-2.png`, rows 500–999',
  )
  expect(report).not.toContain('`.ab/website-frames/desktop.png`')
})

test('segmentRanges splits pages taller than one window into balanced contiguous ranges', () => {
  expect(SEGMENT_HEIGHT).toBe(16_384)
  expect(segmentRanges(900)).toEqual([{ top: 0, height: 900 }])
  expect(segmentRanges(SEGMENT_HEIGHT)).toEqual([{ top: 0, height: SEGMENT_HEIGHT }])
  for (const [height, count] of [
    [SEGMENT_HEIGHT + 1, 2],
    [34_110, 3],
    [40_000, 3],
    [262_144, 16],
  ] as const) {
    const ranges = segmentRanges(height)
    expect(ranges).toHaveLength(count)
    let top = 0
    for (const range of ranges) {
      expect(range.top).toBe(top)
      expect(range.height).toBeLessThanOrEqual(SEGMENT_HEIGHT)
      top += range.height
    }
    expect(top).toBe(height)
    const heights = ranges.map((r) => r.height)
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1)
  }
  expect(segmentRanges(40_000).map((r) => r.height)).toEqual([13_334, 13_333, 13_333])
  for (const bad of [0, -1, 1.5, Number.NaN])
    expect(() => segmentRanges(bad)).toThrow('positive integer')
})

test('segment ids are safe and ordered', () => {
  expect(segmentId('docs-ab-390', 2, 3)).toBe('docs-ab-390-segment-2-of-3')
  expect(segmentId('docs-ab-390', 2, 12)).toBe('docs-ab-390-segment-02-of-12')
  expect(segmentId('docs-ab-390', 2, 12)).toMatch(/^[a-z0-9-]+$/)
})

test('a segment wrapper keeps the page full height and clips to the segment rows', () => {
  const frame = WEBSITE_FRAMES[1]!
  const whole = wrapperPage(frame, 40_000)
  expect(whole).toContain('html,body{margin:0;background:#fff}iframe{')
  expect(whole).toContain('height:40000px}')
  expect(whole).not.toContain('margin-top')
  expect(whole).not.toContain('overflow:hidden')
  expect(whole).toContain('capture-load-failure')
  const segment = wrapperPage(frame, 40_000, { top: 13_334, height: 13_333 })
  expect(segment).toContain('html,body{margin:0;background:#fff;height:13333px;overflow:hidden}')
  expect(segment).toContain('height:40000px;margin-top:-13334px')
})

test('renderReport lists the segments and segment tiles of a segmented frame', () => {
  const frame = WEBSITE_FRAMES[0]!
  const segments = [1, 2].map((index) => ({
    id: segmentId('desktop', index, 2),
    frame: 'desktop',
    index,
    count: 2,
    top: (index - 1) * 20_000,
    height: 20_000,
  }))
  const tiles = [
    [0, 20_000, 1],
    [20_000, 10_000, 2],
    [30_000, 10_000, 2],
  ].map(([top, height, segment], i) => ({
    id: tileId('desktop', i + 1, 3),
    frame: 'desktop',
    index: i + 1,
    count: 3,
    top: top!,
    height: height!,
    png: `.ab/website-frames/${tileId('desktop', i + 1, 3)}.png`,
    segment: segment!,
  }))
  const report = renderReport(
    [{ frame, probe: probe({ sectionGaps: [288] }), height: 40_000, tiles, segments }],
    100,
  )
  expect(report).toContain(
    '`desktop` — 2 segments, tiled into 3 PNGs (each ≤ 100 bytes), 1440x40000',
  )
  expect(report).toContain('  - segment 2/2 `desktop-segment-2-of-2` — rows 20000–39999')
  expect(report).toContain(
    '  - tile 3/3 `desktop-tile-3-of-3` — `.ab/website-frames/desktop-tile-3-of-3.png`, rows 30000–39999, segment 2/2',
  )
  const order = ['segment 1/2', 'segment 2/2 `', 'tile 1/3', 'tile 2/3', 'tile 3/3'].map((needle) =>
    report.indexOf(needle),
  )
  expect(order.every((at) => at >= 0)).toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
})
