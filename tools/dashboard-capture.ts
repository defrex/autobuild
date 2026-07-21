import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { abDispatch } from '../src/cli/dispatch'
import { renderDashboardFrameImage } from '../src/cli/dashboard/frame-image'
import { renderDashboard, stripAnsi } from '../src/cli/dashboard/render'
import type { TerminalInput, TerminalOut } from '../src/cli/terminal'
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
const FRAME_SPECS = [
  { id: 'mixed-wide', columns: 140, rows: 40 },
  { id: 'mixed-narrow', columns: 64, rows: 50 },
] as const

const CAPTURE_CONFIG_TOML = CONFIG_TOML.replace(
  'capacity = 2',
  'capacity = 3',
)

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
  const happyPlan = handlers['plan']!
  const happyImplement = handlers['implement']!

  handlers['plan'] = async (cli) => {
    if (cli.env.build === 'plan-blocked-dashboard') {
      await cli.run(['context'])
      await cli.run([
        'escalate',
        'The scripted plan scenario is intentionally blocked for dashboard capture.',
      ])
      return
    }
    return happyPlan(cli)
  }
  handlers['implement'] = async (cli) => {
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
    ],
  })

  try {
    const report = await harness.dispatcher.tick()
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

    const completeEvents = await harness.events('complete-dashboard-evidence')
    const observation = completeEvents.find(
      (event) => event.type === 'observation.recorded',
    )
    if (observation === undefined) {
      throw new Error(
        'dashboard capture complete build produced no scripted observation',
      )
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
          observations: [
            { build: 'complete-dashboard-evidence', seq: observation.seq },
          ],
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

function validateCapturedFrame(
  id: string,
  lines: string[] | undefined,
  columns: number,
): string[] {
  if (lines === undefined || lines.length === 0) {
    throw new Error(`dashboard capture ${id}: dispatch painted no frame`)
  }
  const plain = lines.map(stripAnsi)
  for (const [index, line] of plain.entries()) {
    if (line.length > columns) {
      throw new Error(
        `dashboard capture ${id}: line ${index + 1} is ${line.length} cells, wider than ${columns}`,
      )
    }
  }
  const text = plain.join('\n')
  for (const required of [
    'CAP-PLAN',
    'CAP-IMPLEMENT',
    'CAP-COMPLETE',
    'BLOCKED',
    'RUNNING',
    'Harvest',
    'PAUSED',
  ]) {
    if (!text.includes(required)) {
      throw new Error(
        `dashboard capture ${id}: final frame omitted required mixed-state evidence "${required}"`,
      )
    }
  }
  if (id === 'mixed-narrow' && !text.includes('~')) {
    throw new Error(
      'dashboard capture mixed-narrow: width did not exercise dashboard truncation',
    )
  }
  return [...lines]
}

async function capturePaint(
  harness: E2eHarness,
  spec: (typeof FRAME_SPECS)[number],
): Promise<string[]> {
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
      const lines = renderDashboard(model, {
        ...options,
        now: RENDER_NOW,
      })
      captured = [...lines]
      return lines
    },
  })

  if (stderr.length > 0) {
    throw new Error(
      `dashboard capture ${spec.id}: nested dispatch reported ${stderr.join('; ')}`,
    )
  }
  return validateCapturedFrame(spec.id, captured, spec.columns)
}

function assertOutputUnderScratch(workspacePath: string, outputDir: string): void {
  const scratch = resolve(workspacePath, '.ab')
  const output = resolve(outputDir)
  const rel = relative(scratch, output)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(
      `dashboard frame output must be below ${scratch}, got ${output}`,
    )
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
        '- [ ] The Harvest row remains legible.',
        '- [ ] The narrow frame truncates deliberately without clipping.',
        '- [ ] Colour emphasis is present and literal statuses remain readable.',
        '',
      ].join('\n'),
    )

    return {
      outputDir,
      reportPath,
      frames,
      diagnostics: {
        buildSlugs: harness.launched.map((entry) => entry.slug),
        agentSkills: [...harness.agents.sessions.values()].map(
          (session) => session.opts.skill,
        ),
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
