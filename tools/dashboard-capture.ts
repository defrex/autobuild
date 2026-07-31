import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { abDispatch } from '../src/cli/dispatch'
import { bulkControlRepository } from '../src/cli/bulk-control'
import { renderDashboardFrameImage } from '../src/cli/dashboard/frame-image'
import { cellWidth } from '../src/cli/dashboard/cells'
import { renderDashboard, stripAnsi } from '../src/cli/dashboard/render'
import type { TerminalInput, TerminalOut } from '../src/cli/terminal'
import { createTerminalModeController } from '../src/cli/terminal-restore'
import { humanActor, KERNEL } from '../src/events/envelope'
import { spawnExec } from '../src/ports/workspace/git-worktree'
import {
  CONFIG_TOML,
  happyHandlers,
  makeHarness,
  readyTicket,
  type E2eHarness,
  type SkillHandlers,
} from '../src/integration/harness'

const RENDER_NOW = Date.parse('2026-07-15T12:10:00.000Z')

interface FrameSpec {
  id: string
  columns: number
  rows: number
  /** Open the blocked-resume composer over the projected model. This is
   * faithful rather than a fake: `resumeInput` is process-local presentation
   * state that a keypress sets and no event ever produces, so there is nothing
   * in the log for the capture to drive it from. */
  resume?: { slug: string; value: string; cursor: number }
  /** Overlay the existing build-detail kind at a scripted scroll offset. */
  detail?: { slug: string; scroll: number }
  /** Overlay a transcript presentation containing fixed Unicode evidence. */
  transcript?: { slug: string; sessionId: string }
  /** Frame-specific evidence this capture exists to show. */
  requires?: readonly string[]
}

const UNICODE_EVIDENCE = 'naïve — “日本語” ☕️ 🇺🇸 👨‍👩‍👧‍👦'
const RESUME_GUIDANCE = `Use the manual merge path.\nRe-run verify:test afterwards — ${UNICODE_EVIDENCE}.`
const SCRIPTED_BLOCKER = [
  `The scripted plan scenario is intentionally blocked for dashboard capture. Unicode: ${UNICODE_EVIDENCE}.`,
  '',
  'THE CONFLICT',
  'The preview must preserve this paragraph structure.',
  'The list row must withhold this explanation.',
  'The detail view must make every line reachable.',
  'EXPANDED FINAL LINE: dashboard message preview complete.',
].join('\n')

const HELD_EVIDENCE = ['repository PAUSED', 'CAP-QUEUED', '(held)', 'QUEUED'] as const

const FRAME_SPECS: readonly FrameSpec[] = [
  {
    id: 'mixed-wide',
    columns: 140,
    rows: 40,
    requires: [...HELD_EVIDENCE, 'more rows - Enter details'],
  },
  {
    id: 'mixed-narrow',
    columns: 64,
    rows: 50,
    requires: [...HELD_EVIDENCE, 'more rows - Enter details'],
  },
  {
    id: 'unicode-transcript',
    columns: 100,
    rows: 20,
    transcript: { slug: 'complete-dashboard-evidence', sessionId: 's_unicode_capture' },
    requires: ['Transcript  complete-dashboard-evidence', `Agent: ${UNICODE_EVIDENCE}`],
  },
  {
    id: 'resume-prompt',
    columns: 100,
    rows: 30,
    detail: { slug: 'plan-blocked-dashboard', scroll: Number.MAX_SAFE_INTEGER },
    resume: {
      slug: 'plan-blocked-dashboard',
      value: RESUME_GUIDANCE,
      // Mid-buffer, on the second line, so the caret is visibly not just an
      // end-of-text marker.
      cursor: RESUME_GUIDANCE.indexOf('afterwards'),
    },
    requires: [
      'Resume plan-blocked-dashboard',
      'Enter submit',
      'The scripted plan scenario is intentionally blocked for dashboard capture.',
      'EXPANDED FINAL LINE: dashboard message preview complete.',
      UNICODE_EVIDENCE,
    ],
  },
]

const CAPTURE_CONFIG_TOML = CONFIG_TOML.replace('capacity = 2', 'capacity = 4')

export interface CapturedDashboardFrame {
  id: string
  terminal: { columns: number; rows: number }
  lines: string[]
  text: string
  png: Uint8Array
  textPath: string
  pngPath: string
}

export interface DashboardCaptureResult {
  outputDir: string
  reportPath: string
  frames: CapturedDashboardFrame[]
  diagnostics: {
    buildSlugs: string[]
    agentSkills: string[]
    forgeOpened: number
    forgeComments: number
    cliErrors: string[]
  }
}

export interface DashboardCaptureOptions {
  /** Product workspace. Generated evidence is always confined to its .ab/. */
  workspacePath?: string
}

function captureHandlers(): SkillHandlers {
  const handlers = happyHandlers()
  const happyPlan = handlers.plan!
  const happyImplement = handlers.implement!

  handlers.plan = async (cli) => {
    if (cli.env.build === 'plan-blocked-dashboard') {
      await cli.run(['context'])
      await cli.run(['escalate', SCRIPTED_BLOCKER])
      return
    }
    return happyPlan(cli)
  }
  handlers.implement = async (cli) => {
    if (cli.env.build === 'implement-blocked-dashboard') {
      await cli.run(['context'])
      await cli.run([
        'escalate',
        'The scripted implement scenario is intentionally blocked for dashboard capture.',
      ])
      return
    }
    return happyImplement(cli)
  }
  return handlers
}

async function prepareScenario(): Promise<E2eHarness> {
  const harness = await makeHarness({
    handlers: captureHandlers(),
    configToml: CAPTURE_CONFIG_TOML,
    tickets: [
      readyTicket('CAP-PLAN', { title: 'Plan blocked dashboard' }),
      readyTicket('CAP-IMPLEMENT', { title: 'Implement blocked dashboard' }),
      readyTicket('CAP-COMPLETE', { title: 'Complete dashboard evidence' }),
      readyTicket('CAP-QUEUED', { title: 'Queued dashboard evidence' }),
    ],
  })

  try {
    const provision = harness.workspaces.provision.bind(harness.workspaces)
    harness.workspaces.provision = async (opts) => {
      if (opts.branch === 'ab/queued-dashboard-evidence') {
        throw new Error('dashboard capture intentionally leaves this build queued')
      }
      return provision(opts)
    }
    const report = await (async () => {
      try {
        return await harness.dispatcher.tick()
      } finally {
        harness.workspaces.provision = provision
      }
    })()
    if (report.dispatched !== 3 || harness.launched.length !== 3) {
      throw new Error(
        `dashboard capture expected three dispatched builds, got ${report.dispatched} dispatches and ${harness.launched.length} runners`,
      )
    }
    const expected = [
      'plan-blocked-dashboard',
      'implement-blocked-dashboard',
      'complete-dashboard-evidence',
    ]
    for (const slug of expected) {
      const launched = harness.launched.find((entry) => entry.slug === slug)
      if (launched === undefined) {
        throw new Error(
          `dashboard capture missing scripted build "${slug}" (launched: ${harness.launched
            .map((entry) => entry.slug)
            .join(', ')})`,
        )
      }
      await launched.runner.run()
    }

    // The fourth ticket's first workspace provision failed through the real
    // dispatcher, leaving a durable queued build. Once the three launched
    // builds have reached their scripted states, use the shared bulk control
    // to establish the repository hold and its paired intake state.
    const queued = (await harness.store.listBuilds()).find(
      (record) => record.ticket?.id === 'CAP-QUEUED',
    )
    if (queued === undefined) {
      throw new Error('dashboard capture did not create the CAP-QUEUED build')
    }
    const queuedEvents = await harness.events(queued.slug)
    if (queuedEvents.some((event) => event.type === 'runner.attached')) {
      throw new Error('dashboard capture CAP-QUEUED unexpectedly attached a runner')
    }
    await bulkControlRepository({
      store: harness.store,
      repo: harness.origin,
      env: { USER: 'dashboard-capture' },
      direction: 'pause',
    })

    const completeEvents = await harness.events('complete-dashboard-evidence')
    const observation = completeEvents.find((event) => event.type === 'observation.recorded')
    if (observation === undefined) {
      throw new Error('dashboard capture complete build produced no scripted observation')
    }

    await harness.store.ensureRepo(harness.origin)
    const started = await harness.store.appendRepoWithArtifacts(
      harness.origin,
      [{ kind: 'harvest-scan', content: '{"capture":true}\n' }],
      (deposited) => ({
        actor: KERNEL,
        type: 'harvest.started',
        payload: {
          run: 'harvest_dashboard_capture',
          observations: [{ build: 'complete-dashboard-evidence', seq: observation.seq }],
          scan: {
            kind: deposited[0]!.kind,
            rev: deposited[0]!.revision,
          },
        },
      }),
    )
    const scan = started.artifacts[0]!
    await harness.store.appendRepo(harness.origin, {
      actor: KERNEL,
      type: 'harvest.step.started',
      payload: { run: 'harvest_dashboard_capture', step: 'scan' },
    })
    await harness.store.appendRepo(harness.origin, {
      actor: KERNEL,
      type: 'harvest.step.completed',
      payload: {
        run: 'harvest_dashboard_capture',
        step: 'scan',
        outcome: 'completed',
        artifact: { kind: scan.kind, rev: scan.revision },
      },
    })
    await harness.store.appendRepo(harness.origin, {
      actor: KERNEL,
      type: 'harvest.step.started',
      payload: {
        run: 'harvest_dashboard_capture',
        step: 'synthesize',
        round: 1,
      },
    })
    await harness.store.appendRepo(harness.origin, {
      actor: humanActor('dashboard-capture'),
      type: 'harvest.pause-requested',
      payload: {},
    })
    await harness.store.appendRepo(harness.origin, {
      actor: KERNEL,
      type: 'harvest.paused',
      payload: {},
    })

    return harness
  } catch (error) {
    await harness.cleanup()
    throw error
  }
}

class CaptureTerminal implements TerminalOut {
  readonly interactive = true
  readonly writes: string[] = []
  readonly modes = createTerminalModeController((chunk) => this.write(chunk))

  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {}

  write(chunk: string): void {
    this.writes.push(chunk)
  }
}

const NO_INPUT: TerminalInput = {
  start: () => () => {},
}

function validateCapturedFrame(spec: FrameSpec, lines: string[] | undefined): string[] {
  const { id, columns } = spec
  if (lines === undefined || lines.length === 0) {
    throw new Error(`dashboard capture ${id}: dispatch painted no frame`)
  }
  const plain = lines.map(stripAnsi)
  for (const [index, line] of plain.entries()) {
    const cells = cellWidth(line)
    if (cells > columns) {
      throw new Error(
        `dashboard capture ${id}: line ${index + 1} is ${cells} cells, wider than ${columns}`,
      )
    }
  }
  const text = plain.join('\n')
  const commonEvidence =
    spec.transcript !== undefined
      ? ['Transcript', 'complete-dashboard-evidence']
      : spec.detail === undefined
        ? ['CAP-PLAN', 'CAP-IMPLEMENT', 'CAP-COMPLETE', 'BLOCKED', 'Harvest', 'PAUSED']
        : ['Build  plan-blocked-dashboard', 'BLOCKED']
  for (const required of commonEvidence) {
    if (!text.includes(required)) {
      throw new Error(
        `dashboard capture ${id}: final frame omitted required mixed-state evidence "${required}"`,
      )
    }
  }
  for (const required of spec.requires ?? []) {
    if (!text.includes(required)) {
      throw new Error(
        `dashboard capture ${id}: final frame omitted required evidence "${required}"`,
      )
    }
  }
  if (id === 'mixed-narrow' && !text.includes('~')) {
    throw new Error('dashboard capture mixed-narrow: width did not exercise dashboard truncation')
  }
  return [...lines]
}

async function capturePaint(harness: E2eHarness, spec: FrameSpec): Promise<string[]> {
  const terminal = new CaptureTerminal(spec.columns, spec.rows)
  const stderr: string[] = []
  let captured: string[] | undefined

  await abDispatch({
    targetRepo: harness.origin,
    env: { USER: 'dashboard-capture' },
    exec: spawnExec,
    stdout: () => {},
    stderr: (line) => stderr.push(line),
    once: true,
    terminal,
    input: NO_INPUT,
    wire: () => harness.wiring,
    resolveDashboardRenderer: () => (model, options) => {
      const presented = {
        ...model,
        ...(spec.detail === undefined && spec.transcript === undefined
          ? { warningLines: [`Unicode warning: ${UNICODE_EVIDENCE}`] }
          : {}),
        ...(spec.detail !== undefined
          ? {
              view: {
                kind: 'detail' as const,
                slug: spec.detail.slug,
                scroll: spec.detail.scroll,
              },
            }
          : {}),
        ...(spec.transcript !== undefined
          ? {
              view: {
                kind: 'transcript' as const,
                slug: spec.transcript.slug,
                sessionId: spec.transcript.sessionId,
                scroll: 0,
                transcript: {
                  kind: 'turns' as const,
                  turns: [{ prompt: `Review ${UNICODE_EVIDENCE}`, text: UNICODE_EVIDENCE }],
                },
              },
            }
          : {}),
        ...(spec.resume !== undefined ? { resumeInput: spec.resume } : {}),
      }
      const lines = renderDashboard(presented, {
        ...options,
        now: RENDER_NOW,
      })
      captured = [...lines]
      return lines
    },
  })

  if (stderr.length > 0) {
    throw new Error(`dashboard capture ${spec.id}: nested dispatch reported ${stderr.join('; ')}`)
  }
  return validateCapturedFrame(spec, captured)
}

function assertOutputUnderScratch(workspacePath: string, outputDir: string): void {
  const scratch = resolve(workspacePath, '.ab')
  const output = resolve(outputDir)
  const rel = relative(scratch, output)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`dashboard frame output must be below ${scratch}, got ${output}`)
  }
}

/** Drive the real scripted pipeline and dispatch composition, then write the
 * two evidence forms to scratch. Applicability and later PR designation are
 * intentionally absent: the kernel and repo-local verifier own those choices. */
export async function captureDashboardFrames(
  options: DashboardCaptureOptions = {},
): Promise<DashboardCaptureResult> {
  const workspacePath = resolve(options.workspacePath ?? process.cwd())
  const outputDir = join(workspacePath, '.ab', 'dashboard-frames')
  assertOutputUnderScratch(workspacePath, outputDir)
  await rm(outputDir, { recursive: true, force: true })
  await mkdir(outputDir, { recursive: true })
  const harness = await prepareScenario()

  try {
    const frames: CapturedDashboardFrame[] = []
    for (const spec of FRAME_SPECS) {
      const lines = await capturePaint(harness, spec)
      const rendered = renderDashboardFrameImage(lines, {
        columns: spec.columns,
      })
      const textPath = join(outputDir, `${spec.id}.txt`)
      const pngPath = join(outputDir, `${spec.id}.png`)
      await writeFile(textPath, rendered.text)
      await writeFile(pngPath, rendered.png)

      frames.push({
        id: spec.id,
        terminal: { columns: spec.columns, rows: spec.rows },
        lines,
        text: rendered.text,
        png: rendered.png,
        textPath,
        pngPath,
      })
    }

    const reportPath = join(outputDir, 'verify-report.md')
    await writeFile(
      reportPath,
      [
        '# Dashboard visual verification',
        '',
        '## Generated evidence',
        ...frames.flatMap((frame) => [
          `- ${frame.id} (${frame.terminal.columns}x${frame.terminal.rows})`,
          `  - text: ${frame.id}.txt`,
          `  - image: ${frame.id}.png`,
        ]),
        '',
        '## Visual checklist',
        '- [ ] Every PNG opens and is non-empty.',
        '- [ ] Rows, statuses, progress, and separators do not overlap.',
        '- [ ] The Harvest row remains legible and long list messages show a three-row preview/count.',
        '- [ ] Both mixed frames show repository PAUSED and CAP-QUEUED as (held) while retaining QUEUED.',
        '- [ ] The narrow frame truncates deliberately without clipping.',
        '- [ ] Colour emphasis is present and literal statuses remain readable.',
        '- [ ] Unicode samples in the warning, blocker, composer, and transcript are readable, unsplit,',
        '      non-overlapping, and are not code-point escapes.',
        '- [ ] The resume-prompt frame shows the composer panel in place of the',
        '      key legend over the existing scrolled detail view: build name,',
        '      complete blocker through its unique final line, optional-guidance',
        '      note, a two-line field with a visible caret, and its key bindings.',
        '',
      ].join('\n'),
    )

    return {
      outputDir,
      reportPath,
      frames,
      diagnostics: {
        buildSlugs: harness.launched.map((entry) => entry.slug),
        agentSkills: [...harness.agents.sessions.values()].map((session) => session.opts.skill),
        forgeOpened: harness.forge.opened.length,
        forgeComments: harness.forge.comments.length,
        cliErrors: [...harness.cliErrors],
      },
    }
  } finally {
    await harness.cleanup()
  }
}

if (import.meta.main) {
  try {
    const result = await captureDashboardFrames()
    console.log(
      `captured ${result.frames.length} dashboard frames; verify report: ${result.reportPath}`,
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
