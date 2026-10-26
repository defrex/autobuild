import { describe, expect, test } from 'bun:test'
import { buildFiles } from '../packages/website/src/build'
import { SEAMS } from '../packages/website/src/seams'
import {
  assertOutputUnderScratch,
  captureWebsite,
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
        { seam: 'dispatcher', adapter: 'local-process', pressed: 'true' },
      ],
    })
    expect(probeProblems(remote, ok)).toEqual([])
    expect(
      probeProblems(remote, {
        ...ok,
        chips: [{ seam: 'dispatcher', adapter: 'local-process', pressed: 'false' }],
      }),
    ).toEqual(['fixed local chip dispatcher/local-process is not pressed'])
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
      const frames = discoverFrames({ ...(await buildFiles()) }).filter((f) => f.kind === 'landing')
      await captureWebsite({ chromium, outputDir: dir, frames, includeMotionSamples: false })
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
                    : seam.id === 'dispatcher'
                      ? adapter.id === 'local-process'
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
  const paths = (Bun.TOML.parse(config) as { verify: { 'ui-website': { paths: string[] } } })
    .verify['ui-website'].paths
  for (const path of [
    'packages/website/**',
    'docs/**',
    'design/website/**',
    'tools/website-capture*',
    '.agents/skills/verify-ui-website/SKILL.md',
  ])
    expect(paths).toContain(path)
})

test('real built docs are discovered at desktop and phone widths', async () => {
  const frames = discoverFrames({ ...(await buildFiles()) }).filter(
    (frame) => frame.kind === 'docs' && !frame.id.startsWith('docs-builds-') && !frame.remote,
  )
  expect(frames.map((frame) => [frame.page, frame.width])).toEqual([
    ['docs/agent-runtimes/index.html', 1440],
    ['docs/agent-runtimes/index.html', 390],
    ['docs/build-store/index.html', 1440],
    ['docs/build-store/index.html', 390],
    ['docs/builds/index.html', 1440],
    ['docs/builds/index.html', 390],
    ['docs/cli/index.html', 1440],
    ['docs/cli/index.html', 390],
    ['docs/configuration/index.html', 1440],
    ['docs/configuration/index.html', 390],
    ['docs/dispatcher-hosting/index.html', 1440],
    ['docs/dispatcher-hosting/index.html', 390],
    ['docs/dispatcher/index.html', 1440],
    ['docs/dispatcher/index.html', 390],
    ['docs/forges/index.html', 1440],
    ['docs/forges/index.html', 390],
    ['docs/getting-started/index.html', 1440],
    ['docs/getting-started/index.html', 390],
    ['docs/glossary/index.html', 1440],
    ['docs/glossary/index.html', 390],
    ['docs/index.html', 1440],
    ['docs/index.html', 390],
    ['docs/intake/index.html', 1440],
    ['docs/intake/index.html', 390],
    ['docs/integration/index.html', 1440],
    ['docs/integration/index.html', 390],
    ['docs/operating/index.html', 1440],
    ['docs/operating/index.html', 390],
    ['docs/operator-surfaces/index.html', 1440],
    ['docs/operator-surfaces/index.html', 390],
    ['docs/plugin-authoring/index.html', 1440],
    ['docs/plugin-authoring/index.html', 390],
    ['docs/seams/index.html', 1440],
    ['docs/seams/index.html', 390],
    ['docs/skills/index.html', 1440],
    ['docs/skills/index.html', 390],
    ['docs/ticket-sources/index.html', 1440],
    ['docs/ticket-sources/index.html', 390],
    ['docs/tickets/index.html', 1440],
    ['docs/tickets/index.html', 390],
    ['docs/troubleshooting/index.html', 1440],
    ['docs/troubleshooting/index.html', 390],
    ['docs/upgrading/index.html', 1440],
    ['docs/upgrading/index.html', 390],
    ['docs/verification/index.html', 1440],
    ['docs/verification/index.html', 390],
    ['docs/workspaces/index.html', 1440],
    ['docs/workspaces/index.html', 390],
  ])
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

test('new Markdown page flows through output, navigation, pager and both real capture widths', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const root = await mkdtemp(join(tmpdir(), 'capture-markdown-'))
  const outputDir = join(import.meta.dir, '../.ab', `markdown-capture-${process.pid}`)
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
      await captureWebsite({
        chromium,
        outputDir,
        files: { ...files },
        frames: added,
        includeMotionSamples: false,
      })
      const inventory: { frame: WebsiteFrame; probe: Probe; height: number; capped: boolean }[] =
        await Bun.file(join(outputDir, 'inventory.json')).json()
      expect(inventory).toHaveLength(2)
      for (const entry of inventory) {
        expect(entry.probe.scrollHeight).toBeGreaterThan(12_000)
        expect(entry.height).toBe(entry.probe.scrollHeight)
        expect(entry.capped).toBe(false)
        expect(probeProblems(entry.frame, entry.probe)).toEqual([])
        expect(existsSync(join(outputDir, `${entry.frame.id}.png`))).toBe(true)
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
