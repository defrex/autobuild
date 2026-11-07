import { afterAll, describe, expect, test } from 'bun:test'
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
      const broken = fixtureFiles(extra)
      await expect(
        capture({
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

describe('frame tiling under the artifact ceiling', () => {
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
      const handmade = Buffer.concat([
        reference.subarray(0, ihdrEnd),
        chunk,
        reference.subarray(-12),
      ])
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
    const { HOSTED_ARTIFACT_MAX_BYTES } = await import(
      '../packages/hosted-store-service/src/config'
    )
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
          capped: false,
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
