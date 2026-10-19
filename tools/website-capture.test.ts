import { describe, expect, test } from 'bun:test'
import { buildFiles } from '../packages/website/src/build'
import {
  assertOutputUnderScratch,
  captureWebsite,
  discoverFrames,
  chromiumBinary,
  injectProbe,
  type Probe,
  parseProbe,
  probeProblems,
  renderReport,
  serveSite,
  WEBSITE_FRAMES,
} from './website-capture'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { stat } from 'node:fs/promises'

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

describe('website capture', () => {
  const DESKTOP_GAPS = { sectionGaps: [288, 288], footerGap: 288 }

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
    expect(chromiumBinary({ CHROMIUM_BIN: '/missing' }, exists, () => null)).toBe(
      '/usr/bin/chromium',
    )
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
    expect(parseProbe(`<head><meta name="capture-probe" content="${content}"></head>`)).toEqual(
      value,
    )
    expect(() => parseProbe('<html></html>')).toThrow('no capture-probe')
  })

  test('probeProblems checks the stylesheet and the remote contract', () => {
    const desktop = WEBSITE_FRAMES[0]!
    const remote = WEBSITE_FRAMES[2]!
    expect(probeProblems(desktop, probe(DESKTOP_GAPS))).toEqual([])
    expect(probeProblems(desktop, probe({ ...DESKTOP_GAPS, stylesheetLoaded: false }))).toEqual([
      'site.css did not load',
    ])
    expect(
      probeProblems(remote, probe({ ...DESKTOP_GAPS, lean: 'local', status: 'fully local' }))
        .length,
    ).toBe(3)
    const ok = probe({
      ...DESKTOP_GAPS,
      runtime: 'codex',
      lean: 'remote',
      status: 'fully remote',
      chips: [
        { seam: 'tickets', adapter: 'linear', pressed: 'true' },
        { seam: 'tickets', adapter: 'local-files', pressed: 'false' },
      ],
    })
    expect(probeProblems(remote, ok)).toEqual([])
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
        capped: false,
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
      const dir = join(import.meta.dir, '..', '.ab', `website-capture-test-${process.pid}`)
      await captureWebsite({ chromium, outputDir: dir })
      for (const frame of WEBSITE_FRAMES) {
        const png = join(dir, `${frame.id}.png`)
        expect(existsSync(png)).toBe(true)
        expect((await stat(png)).size).toBeGreaterThan(0)
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
    const dir = join(import.meta.dir, '..', '.ab', `website-fixtures-${process.pid}`)
    await captureWebsite({ files, frames, outputDir: dir })
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
      const broken = fixtureFiles(extra)
      await expect(
        captureWebsite({
          files: broken,
          frames: discoverFrames(broken).filter((f) => f.kind === 'docs'),
          outputDir: `${dir}-${name}`,
        }),
      ).rejects.toThrow(error)
      expect(await Bun.file(`${dir}-${name}/verify-report.md`).text()).toContain('FAIL:')
    }
  },
  240_000,
)

test('website applicability includes all website inputs and capture tooling', async () => {
  const config = await Bun.file(join(import.meta.dir, '..', 'autobuild.toml')).text()
  const paths = (Bun.TOML.parse(config) as { verify: { website: { paths: string[] } } }).verify
    .website.paths
  for (const path of [
    'packages/website/**',
    'design/website/**',
    'tools/website-capture*',
    '.agents/skills/verify-website/SKILL.md',
  ])
    expect(paths).toContain(path)
})

test('real built docs are discovered at desktop and phone widths', async () => {
  const frames = discoverFrames({ ...(await buildFiles()) }).filter(
    (frame) => frame.kind === 'docs',
  )
  expect(frames.map((frame) => [frame.page, frame.width])).toEqual([
    ['docs/builds/index.html', 1440],
    ['docs/builds/index.html', 390],
    ['docs/configuration/index.html', 1440],
    ['docs/configuration/index.html', 390],
    ['docs/dispatcher/index.html', 1440],
    ['docs/dispatcher/index.html', 390],
    ['docs/getting-started/index.html', 1440],
    ['docs/getting-started/index.html', 390],
    ['docs/index.html', 1440],
    ['docs/index.html', 390],
    ['docs/integration/index.html', 1440],
    ['docs/integration/index.html', 390],
    ['docs/operating/index.html', 1440],
    ['docs/operating/index.html', 390],
    ['docs/seams/index.html', 1440],
    ['docs/seams/index.html', 390],
    ['docs/tickets/index.html', 1440],
    ['docs/tickets/index.html', 390],
  ])
})
