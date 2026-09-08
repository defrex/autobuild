/**
 * Web dashboard capture: the operator web app's pure views rendered over the
 * same scripted dispatch models the terminal capture produces, then
 * screenshotted with a local Chromium.
 *
 * Repository-local verification tooling, like `dashboard-capture.ts`. It needs
 * no server, network, forge, or live agent runner, and deposits nothing itself.
 * The live app sits behind GitHub OAuth against a real database, so the
 * verifiable surface is the presentation layer: real pipeline → real
 * projection → real React views → real stylesheet → pixels. The deterministic
 * half (evidence strings the frames must and must not contain) fails here; the
 * visual half is judged by the `verify-web-dashboard` skill from the PNGs.
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DashboardModel, TranscriptPresentation } from 'autobuild/operator-presentation'
import { buildActionAvailability } from 'autobuild/operator-presentation'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BuildsView, type BuildsViewProps, type Selection } from '../app/dashboard/BuildsView'
import { dashboardImperative } from '../app/dashboard/imperative'
import { OperatorShell } from '../app/dashboard/Shell'
import { SignIn } from '../app/sign-in/SignIn'
import { captureDashboardFrames, RENDER_NOW } from './dashboard-capture'

const REPO_ROOT = resolve(import.meta.dir, '..')
const FIXTURE_REPO = 'example/repository'
const ALTERNATE_FIXTURE_REPO = 'example/alternate'
const LONG_FIXTURE_REPO = 'example/operator-dashboard-capture-fixture-repository'
const FIXTURE_IDENTITY = 'operator@example.com'
/** RENDER_NOW as the header shows it; fixed so the clock never depends on the host zone. */
const FIXTURE_CLOCK = '12:10:00'

export interface WebFrameSpec {
  id: string
  width: number
  height: number
  /** Text the rendered frame must contain; a miss fails the capture. */
  requires: readonly string[]
  /** Text the rendered frame must not contain. */
  forbids?: readonly string[]
}

/** The frames the verifier inspects, at the two viewports the design targets. */
export const WEB_FRAME_SPECS: readonly WebFrameSpec[] = [
  {
    id: 'builds-loading-wide',
    width: 1440,
    height: 1000,
    requires: ['Loading builds'],
    forbids: ['polling', 'RUNNING', 'BLOCKED', 'MERGED', 'PAUSE ALL'],
  },
  {
    id: 'builds-loading-narrow',
    width: 390,
    height: 1700,
    requires: ['Loading builds'],
    forbids: ['polling', 'RUNNING', 'BLOCKED', 'MERGED', 'PAUSE ALL'],
  },
  {
    id: 'builds-happy-wide',
    width: 1440,
    height: 1000,
    requires: [
      'MERGED',
      'AUT-131',
      'PR merged',
      'Harvest',
      'RUNNING',
      '[x]',
      'merge(waiting)',
      'PAUSE ALL',
      'RESUME ALL',
      'AUTO MERGE',
      'INTAKE',
    ],
    forbids: ['BLOCKED', 'PAUSED', '(held)', 'FAILED'],
  },
  {
    id: 'builds-happy-narrow',
    width: 390,
    height: 1700,
    requires: ['MERGED', 'AUT-131', 'Harvest', 'RUNNING', '[x]', 'PAUSE ALL', 'INTAKE'],
    forbids: ['BLOCKED', 'PAUSED', '(held)'],
  },
  {
    id: 'builds-harvest-wide',
    width: 1440,
    height: 1000,
    requires: ['Harvest', 'RUNNING', 'HARVEST', 'DESELECT'],
    forbids: ['PAUSE ALL', 'RESUME ALL'],
  },
  {
    id: 'builds-harvest-narrow',
    width: 390,
    height: 1700,
    requires: ['Harvest', 'RUNNING', 'HARVEST', 'DESELECT'],
    forbids: ['PAUSE ALL', 'RESUME ALL'],
  },
  {
    id: 'builds-multirepo-wide',
    width: 1440,
    height: 1000,
    requires: [
      'MERGED',
      `repo ${FIXTURE_REPO} ${ALTERNATE_FIXTURE_REPO}`,
      FIXTURE_REPO,
      ALTERNATE_FIXTURE_REPO,
    ],
  },
  {
    id: 'builds-mixed-hover-wide',
    width: 1440,
    height: 1200,
    requires: ['BLOCKED ×2', 'PAUSED', '(held)', 'ABORT', 'RESUME', 'DETAILS'],
  },
  {
    id: 'builds-mixed-detail-wide',
    width: 1440,
    height: 2000,
    requires: [
      'BLOCKED ×2',
      'CAP-PLAN',
      'PAUSED',
      '(held)',
      'QUEUED',
      'more rows - Enter details',
      'Pipeline',
      'Unresolved blockers',
      'Answer escalation',
      'Sessions',
      'Transcript',
      'ABORT',
      'RESUME',
      'CLOSE',
    ],
  },
  {
    id: 'builds-mixed-detail-narrow',
    width: 390,
    height: 2600,
    requires: [
      'BLOCKED ×2',
      '(held)',
      'Unresolved blockers',
      'Answer escalation',
      'ABORT',
      'CLOSE',
    ],
  },
  {
    id: 'builds-mixed-abort-wide',
    width: 1440,
    height: 1200,
    requires: ['Enter confirms, Esc cancels', 'CONFIRM ABORT', 'CANCEL'],
  },
  {
    id: 'builds-longrepo-narrow',
    width: 390,
    height: 900,
    requires: ['BLOCKED ×2', LONG_FIXTURE_REPO],
  },
  {
    id: 'signin-wide',
    width: 1440,
    height: 700,
    requires: ['Autobuild operator', 'Sign in', 'Continue with GitHub'],
    forbids: ['REFUSED'],
  },
  {
    id: 'signin-error-narrow',
    width: 390,
    height: 700,
    requires: ['REFUSED', 'Access was refused', 'Continue with GitHub'],
  },
]

export interface WebFixtureModels {
  /** The `headline-happy-wide` scenario: five running builds, a merged PR, a running harvest. */
  happy: DashboardModel
  /** The `mixed-wide` scenario: blocked, pausing, queued-and-held builds under a repository pause. */
  mixed: DashboardModel
}

export interface RenderAssets {
  /** The contents of app/globals.css. */
  css: string
  /** `@font-face` rules that bind `--font-mono` for the capture. */
  fontCss: string
}

const noop = () => {}

const FIXTURE_TRANSCRIPT: TranscriptPresentation = {
  kind: 'turns',
  turns: [
    {
      prompt: 'Plan the scripted dashboard scenario.',
      text: 'Agent: naïve — “日本語” ☕️ 🇺🇸 👨‍👩‍👧‍👦\n\nThe plan needs a decision the spec does not make. Escalating.',
      usage: { inputTokens: 1842, outputTokens: 311, turns: 2 },
    },
  ],
}

function shell(
  children: ReactNode,
  opts: {
    model?: DashboardModel
    repo?: string
    repositories?: readonly string[]
    error?: string
  } = {},
) {
  const repo = opts.repo ?? FIXTURE_REPO
  return (
    <OperatorShell
      repo={repo}
      repositories={opts.repositories ?? [repo]}
      identity={FIXTURE_IDENTITY}
      imperative={opts.model ? dashboardImperative(opts.model) : undefined}
      clock={opts.model ? FIXTURE_CLOCK : undefined}
      error={opts.error}
      onRepo={noop}
      onSignOut={noop}
    >
      {children}
    </OperatorShell>
  )
}

function builds(model?: DashboardModel, extra: Partial<BuildsViewProps> = {}) {
  return (
    <BuildsView
      repo={FIXTURE_REPO}
      model={model}
      now={RENDER_NOW}
      detailOpen={false}
      confirmingAbort={false}
      onActivate={noop}
      onHoverPreview={noop}
      onDeselect={noop}
      onToggleDetail={noop}
      onBuildControl={noop}
      onRequestAbort={noop}
      onCancelAbort={noop}
      onAnswer={noop}
      onTranscript={noop}
      onSetting={noop}
      onBulk={noop}
      onHarvest={noop}
      {...extra}
    />
  )
}

/** The first build parked on a human in the mixed scenario, selected for detail. */
function blockedSelection(model: DashboardModel): Selection {
  const blocked = model.builds.find((build) => build.blockers.length > 0)
  if (!blocked) throw new Error('web dashboard capture: the mixed model has no blocked build')
  return { kind: 'build', slug: blocked.slug }
}

/** A different mixed-model build, previewed while the blocked selection stays committed. */
function hoverSelection(model: DashboardModel, selected: Selection): Selection {
  const candidate = model.builds.find(
    (build) => selected.kind !== 'build' || build.slug !== selected.slug,
  )
  if (!candidate) throw new Error('web dashboard capture: the mixed model has no hover candidate')
  return { kind: 'build', slug: candidate.slug }
}

/** A build whose abort control is available, for the two-step confirmation frame. */
function abortableSelection(model: DashboardModel): Selection {
  const candidate = model.builds.find((build) => buildActionAvailability(build).abort)
  if (!candidate) throw new Error('web dashboard capture: the mixed model has no abortable build')
  return { kind: 'build', slug: candidate.slug }
}

function frameNode(id: string, models: WebFixtureModels): ReactNode {
  switch (id) {
    case 'builds-loading-wide':
    case 'builds-loading-narrow':
      return shell(builds())
    case 'builds-happy-wide':
    case 'builds-happy-narrow':
      return shell(builds(models.happy), { model: models.happy })
    case 'builds-harvest-wide':
    case 'builds-harvest-narrow':
      return shell(builds(models.happy, { selection: { kind: 'harvest' } }), {
        model: models.happy,
      })
    case 'builds-multirepo-wide':
      return shell(builds(models.happy), {
        model: models.happy,
        repositories: [FIXTURE_REPO, ALTERNATE_FIXTURE_REPO],
      })
    case 'builds-mixed-hover-wide': {
      const selection = blockedSelection(models.mixed)
      return shell(
        builds(models.mixed, {
          selection,
          hoverPreview: hoverSelection(models.mixed, selection),
        }),
        { model: models.mixed },
      )
    }
    case 'builds-mixed-detail-wide':
    case 'builds-mixed-detail-narrow':
      return shell(
        builds(models.mixed, {
          selection: blockedSelection(models.mixed),
          detailOpen: true,
          transcript: FIXTURE_TRANSCRIPT,
        }),
        { model: models.mixed },
      )
    case 'builds-mixed-abort-wide':
      return shell(
        builds(models.mixed, {
          selection: abortableSelection(models.mixed),
          confirmingAbort: true,
        }),
        { model: models.mixed },
      )
    case 'builds-longrepo-narrow':
      return shell(builds(models.mixed), { model: models.mixed, repo: LONG_FIXTURE_REPO })
    case 'signin-wide':
      return <SignIn providers={['github']} />
    case 'signin-error-narrow':
      return <SignIn providers={['github']} error="access_denied" />
    default:
      throw new Error(`web dashboard capture: unknown frame "${id}"`)
  }
}

/** One complete fixture page: the rendered view inside the real stylesheet. */
export function renderWebFrame(
  spec: WebFrameSpec,
  models: WebFixtureModels,
  assets: RenderAssets,
): string {
  const markup = renderToStaticMarkup(frameNode(spec.id, models))
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${spec.id}</title>`,
    `<style>${assets.fontCss}</style>`,
    `<style>${assets.css}</style>`,
    '</head>',
    `<body>${markup}</body>`,
    '</html>',
  ].join('\n')
}

/** The visible text of a rendered frame, entities decoded, whitespace collapsed. */
export function evidenceText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
}

/** Throws naming the first missing or forbidden evidence string. */
export function checkEvidence(spec: WebFrameSpec, html: string): void {
  const text = evidenceText(html)
  if (spec.id.startsWith('builds-') && (text.includes('BUILDS') || text.includes('TICKETS'))) {
    throw new Error(`web dashboard capture ${spec.id}: signed-in frame contains a surface tab word`)
  }
  const fastextSlots = [...html.matchAll(/class="ft" data-slot="(red|green|yellow|cyan)"/g)].map(
    (match) => match[1],
  )
  if (html.includes('class="fastext"') && fastextSlots.join(',') !== 'red,green,yellow,cyan') {
    throw new Error(
      `web dashboard capture ${spec.id}: expected red, green, yellow, cyan Fastext slots; got ${fastextSlots.join(',') || 'none'}`,
    )
  }
  for (const required of spec.requires) {
    if (!text.includes(required)) {
      throw new Error(
        `web dashboard capture ${spec.id}: frame omitted required evidence "${required}"`,
      )
    }
  }
  for (const forbidden of spec.forbids ?? []) {
    if (text.includes(forbidden)) {
      throw new Error(
        `web dashboard capture ${spec.id}: frame contains forbidden evidence "${forbidden}"`,
      )
    }
  }
}

/**
 * Bind `--font-mono` for the capture without the network: the installed
 * JetBrains Mono when the host has it, otherwise the DejaVu Sans Mono the
 * terminal renderer already depends on. Frames are judged for coherence, not
 * compared to golden pixels, so the face may differ between hosts.
 */
export function fontFaceCss(repoRoot = REPO_ROOT): string {
  const ttf = (file: string) =>
    pathToFileURL(join(repoRoot, 'node_modules', 'dejavu-fonts-ttf', 'ttf', file)).href
  return [
    '@font-face {',
    "  font-family: 'Capture Mono';",
    '  font-weight: 400;',
    `  src: local('JetBrains Mono'), local('JetBrainsMono-Regular'), local('JetBrainsMono Nerd Font'), local('JetBrainsMonoNF-Regular'), url('${ttf('DejaVuSansMono.ttf')}');`,
    '}',
    '@font-face {',
    "  font-family: 'Capture Mono';",
    '  font-weight: 700;',
    `  src: local('JetBrains Mono Bold'), local('JetBrainsMono-Bold'), local('JetBrainsMono Nerd Font Bold'), local('JetBrainsMonoNF-Bold'), url('${ttf('DejaVuSansMono-Bold.ttf')}');`,
    '}',
    ":root { --font-mono: 'Capture Mono'; }",
  ].join('\n')
}

/**
 * Locate a Chromium-family binary: `CHROMIUM_BIN` or `CHROME_BIN` first, then
 * common install paths, then PATH. Undefined when none exists.
 */
export function chromiumBinary(
  env: Record<string, string | undefined> = process.env,
  exists: (path: string) => boolean = existsSync,
  which: (name: string) => string | undefined | null = (name) => Bun.which(name),
): string | undefined {
  const configured = [env.CHROMIUM_BIN, env.CHROME_BIN].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  )
  for (const candidate of configured) if (exists(candidate)) return candidate
  const installed = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]
  for (const candidate of installed) if (exists(candidate)) return candidate
  for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
    const found = which(name)
    if (found) return found
  }
  return undefined
}

async function screenshot(
  chromium: string,
  htmlPath: string,
  pngPath: string,
  spec: WebFrameSpec,
  userDataDir: string,
): Promise<void> {
  const proc = Bun.spawn(
    [
      chromium,
      '--headless=new',
      '--hide-scrollbars',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--disable-extensions',
      `--user-data-dir=${userDataDir}`,
      '--force-device-scale-factor=1',
      `--window-size=${spec.width},${spec.height}`,
      '--virtual-time-budget=5000',
      `--screenshot=${pngPath}`,
      pathToFileURL(htmlPath).href,
    ],
    { stdout: 'ignore', stderr: 'pipe', timeout: 90_000 },
  )
  const stderr = await new Response(proc.stderr).text()
  const code = await proc.exited
  if (code !== 0 || !existsSync(pngPath)) {
    throw new Error(
      `web dashboard capture ${spec.id}: Chromium exited ${code} without a screenshot\n${stderr.trim()}`,
    )
  }
}

function assertOutputUnderScratch(repoRoot: string, outputDir: string): void {
  const scratch = resolve(repoRoot, '.ab')
  const output = resolve(outputDir)
  const rel = relative(scratch, output)
  if (rel === '' || rel.startsWith('..') || rel.startsWith(sep)) {
    throw new Error(`web dashboard capture output must live under ${scratch}, got ${output}`)
  }
}

export interface WebDashboardFrame {
  id: string
  width: number
  height: number
  htmlPath: string
  pngPath: string
}

export interface WebDashboardCaptureResult {
  outputDir: string
  reportPath: string
  chromium: string
  frames: WebDashboardFrame[]
}

export interface WebDashboardCaptureOptions {
  /** Chromium binary; defaults to `chromiumBinary()`. */
  chromium?: string
  /** Defaults to `<repo>/.ab/web-dashboard-frames`; must stay under `.ab/`. */
  outputDir?: string
  /** Defaults to the real scripted dispatch harness in a temporary workspace. */
  models?: WebFixtureModels
}

function frameModel(
  capture: Awaited<ReturnType<typeof captureDashboardFrames>>,
  id: string,
): DashboardModel {
  const frame = capture.frames.find((entry) => entry.id === id)
  if (!frame) throw new Error(`web dashboard capture: terminal capture produced no "${id}" frame`)
  return frame.model
}

/** Run the scripted dispatch harness once and keep only the projected models. */
export async function harnessModels(): Promise<WebFixtureModels> {
  const workspace = await mkdtemp(join(tmpdir(), 'ab-web-capture-'))
  try {
    const capture = await captureDashboardFrames({ workspacePath: workspace })
    return {
      happy: frameModel(capture, 'headline-happy-wide'),
      mixed: frameModel(capture, 'mixed-wide'),
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

function report(frames: WebDashboardFrame[], chromium: string, outputDir: string): string {
  const lines = [
    '# Web dashboard visual verification',
    '',
    `Generated by \`bun run capture:web-dashboard\` with Chromium at \`${chromium}\`.`,
    "Frames render the operator web app's pure views (OperatorShell, BuildsView, SignIn)",
    'over the scripted dispatch models from',
    '`tools/dashboard-capture.ts` (`headline-happy-wide` and `mixed-wide`), the real',
    '`app/globals.css`, and a locally installed monospace face (JetBrains Mono when',
    'the host has it, otherwise DejaVu Sans Mono). Nothing here is a golden image:',
    'judge whether each frame is coherent and obeys the rules recorded in DESIGN.md.',
    '',
    'The fine-pointer hover preview is modeled explicitly in the wide hover frame.',
    'Focus rings, the state-change flash, and keyboard shortcuts are code-reviewed',
    'rather than screenshotted; narrow frames carry no hover preview.',
    '',
    '## Frames',
    '',
    ...frames.map(
      (frame) =>
        `- \`${relative(outputDir, frame.pngPath)}\` (${frame.width}×${frame.height}), source \`${relative(outputDir, frame.htmlPath)}\``,
    ),
    '',
    '## Visual criteria',
    '',
    '- [ ] Every PNG opens, is non-empty, and shows a black ground. Empty black below the content is the fixed viewport height, not a defect.',
    '- [ ] Compare loading and loaded Builds at both widths, then sign-in: the masthead is exactly one cell row high with identical coordinates in every state. The control line and the top and bottom edges of the Fastext footer are also stable where present.',
    '- [ ] Control line: no signed-in frame shows a BUILDS or TICKETS tab word. `builds-multirepo-wide.png` shows the `repo` label and selector with both repository options; every other Builds frame is configured with one repository and omits the complete selector and label.',
    '- [ ] Loading frames show five static, neutral placeholder rows at the normal three-row build rhythm, with no digits, status words, imperative, synthetic values, or animation. The old polling sentence is absent.',
    '- [ ] The document itself does not scroll. Builds and open build detail are clipped only by and scroll within the centre between the control line and Fastext; the shell anchors do not move.',
    '- [ ] Masthead: every glyph keeps the monospace face’s natural width-to-height proportions with no axis-specific scaling; the repository name is yellow at left, one imperative word is bold in its tone (MERGED green on the happy frames, BLOCKED ×2 red on the mixed frames, REFUSED red on the sign-in error), and the poll clock is at the right edge on wide frames and absent on narrow ones. On `builds-longrepo-narrow.png` the long repository name visibly ellipsizes while `BLOCKED ×2` renders whole and remains the most prominent word.',
    '- [ ] Dispatcher line: queue, active, observations, repository state, and the intake, auto merge, and harvest toggle words with bold ON in green or OFF in yellow. The happy frames show everything ON and RUNNING; the mixed frames show PAUSED and OFF.',
    '- [ ] Rows: ticket id, bold slug, and a right-pinned bold STATUS word in its status color; beneath it the bracket step line `[x] [>] [~] [ ]` in green, bold cyan, yellow, and dim, wrapping by whole steps with nothing clipped or overlapping. The Harvest row uses the same grammar.',
    '- [ ] Palette: hues are visibly muted rather than pure-primary. Across the happy and mixed frames, BLOCKED/red, RUNNING/green, PAUSED/yellow, and QUEUED/cyan remain distinguishable at a glance before reading the words.',
    '- [ ] Mixed frames: the queued build shows `(held)` in yellow beside a literal cyan `QUEUED`; blocked rows carry red `!` message lines; the multi-paragraph blocker shows a three-row preview ending in a `... N more rows - Enter details` line.',
    '- [ ] Hover frame: exactly two cyan `>` lane markers appear at once without shifting row text: the selected blocked row is bold, while a different dimmed row carries the regular-weight preview. Detail stays closed and the Fastext footer remains in the selected blocked build context (ABORT, RESUME, DETAILS). No 390px frame carries a preview marker.',
    '- [ ] Detail frames: the selected row carries the cyan `>` lane marker; every other row dims to gray except its STATUS word, yellow `(held)` annotation, and red lines, which remain full-color state information; detail unfolds beneath the row between two dim rules with Pipeline, Unresolved blockers (red text in a well), the answer composer, Sessions, and a Transcript whose Unicode sample (accents, curly quotes, em dash, CJK, emoji with variation selector, flag, ZWJ family) is legible and unsplit.',
    '- [ ] Abort frame: a red `! abort <slug>? Enter confirms, Esc cancels` line under the selected row, and a footer of `CONFIRM ABORT` in red, `CANCEL` in cyan, and two empty cells that keep their green and yellow outlines.',
    '- [ ] Fastext footer: four transparent outline cells left to right red, green, yellow, cyan on wide frames, two per line on narrow frames; each border and label use its slot hue, labels never truncate, and no resting fill appears. A disabled cell keeps its hue at 0.9 opacity on only its foreground and outline, while its resting surface remains transparent on the black ground; an empty cell keeps its outline with no label. Slot colors never change with state. The Harvest frames select the Harvest row and show empty red, the run action in green when available, yellow `HARVEST`, and cyan `DESELECT`. The capture has deterministically verified all four slot elements in this order.',
    '- [ ] Buttons: primary actions are transparent ink outlines at rest and secondary actions are borderless transparent words. Hover, active, disabled, and keyboard focus treatments are distinct; focus and active are code-reviewed where a static capture cannot show them.',
    '- [ ] Sign-in frames: the masthead title, a bold `Sign in`, one line of copy, and an ink-outline `Continue with GitHub` primary button; the error variant adds REFUSED in the masthead and a red `!` notice.',
    '- [ ] Across every frame: state is never color-only (each colored state has its word or glyph), no text overlaps or clips, no borders except the shared-width button outlines and keyboard focus rings, no shadows, gradients, or icon glyphs appear, corners are square, and no emoji comes from the interface itself (emoji inside fixture message text is content).',
    '',
    '## Web dashboard visual verdict',
    '',
    'Record pass or fail here with the criterion that decided it.',
    '',
  ]
  return lines.join('\n')
}

/**
 * Capture every frame: render, check evidence, screenshot, and write the
 * verification report under `.ab/web-dashboard-frames/`.
 */
export async function captureWebDashboardFrames(
  options: WebDashboardCaptureOptions = {},
): Promise<WebDashboardCaptureResult> {
  const chromium = options.chromium ?? chromiumBinary()
  if (!chromium) {
    throw new Error(
      'web dashboard capture: no Chromium binary found. Install chromium or set CHROMIUM_BIN.',
    )
  }
  const outputDir = options.outputDir ?? join(REPO_ROOT, '.ab', 'web-dashboard-frames')
  assertOutputUnderScratch(REPO_ROOT, outputDir)
  const models = options.models ?? (await harnessModels())
  const assets: RenderAssets = {
    css: await readFile(join(REPO_ROOT, 'app', 'globals.css'), 'utf8'),
    fontCss: fontFaceCss(),
  }
  await rm(outputDir, { recursive: true, force: true })
  await mkdir(outputDir, { recursive: true })
  const userDataDir = await mkdtemp(join(tmpdir(), 'ab-web-capture-chromium-'))
  try {
    const frames: WebDashboardFrame[] = []
    for (const spec of WEB_FRAME_SPECS) {
      const html = renderWebFrame(spec, models, assets)
      checkEvidence(spec, html)
      const htmlPath = join(outputDir, `${spec.id}.html`)
      const pngPath = join(outputDir, `${spec.id}.png`)
      await writeFile(htmlPath, html)
      await screenshot(chromium, htmlPath, pngPath, spec, userDataDir)
      frames.push({ id: spec.id, width: spec.width, height: spec.height, htmlPath, pngPath })
    }
    const reportPath = join(outputDir, 'verify-report.md')
    await writeFile(reportPath, report(frames, chromium, outputDir))
    return { outputDir, reportPath, chromium, frames }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  try {
    const result = await captureWebDashboardFrames()
    console.log(
      `captured ${result.frames.length} web dashboard frames; verify report: ${result.reportPath}`,
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
