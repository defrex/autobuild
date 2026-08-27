import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { abDispatch } from '../src/cli/dispatch'
import { bulkControlRepository } from '../src/cli/bulk-control'
import { renderDashboardFrameImage } from '../src/cli/dashboard/frame-image'
import { cellWidth } from '../src/cli/dashboard/cells'
import { renderDashboard, stripAnsi } from '../src/cli/dashboard/render'
import type { TerminalInput, TerminalOut } from '../src/cli/terminal'
import { createTerminalModeController } from '../src/cli/terminal-restore'
import { agentActor, DISPATCHER, humanActor, KERNEL } from '../src/events/envelope'
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

type CaptureScenario = 'mixed' | 'happy'

interface FrameSpec {
  id: string
  scenario: CaptureScenario
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
  /** Evidence that must never appear in this frame. */
  forbids?: readonly string[]
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
    id: 'headline-happy-wide',
    scenario: 'happy',
    columns: 140,
    rows: 40,
    requires: [
      'intake ON',
      'auto merge ON',
      'harvest ON',
      'active 5/6',
      'AUT-131',
      'AUT-129',
      'AUT-133',
      'AUT-134',
      'AUT-136',
      'PR merged',
      'Harvest',
      'RUNNING',
    ],
    forbids: [
      'BLOCKED',
      'PAUSED',
      '(held)',
      'Unicode',
      UNICODE_EVIDENCE,
      'more rows - Enter details',
    ],
  },
  {
    id: 'mixed-wide',
    scenario: 'mixed',
    columns: 140,
    rows: 40,
    requires: [...HELD_EVIDENCE, 'more rows - Enter details'],
  },
  {
    id: 'mixed-narrow',
    scenario: 'mixed',
    columns: 64,
    rows: 50,
    requires: [...HELD_EVIDENCE, 'more rows - Enter details'],
  },
  {
    id: 'unicode-transcript',
    scenario: 'mixed',
    columns: 100,
    rows: 20,
    transcript: { slug: 'complete-dashboard-evidence', sessionId: 's_unicode_capture' },
    requires: ['Transcript  complete-dashboard-evidence', `Agent: ${UNICODE_EVIDENCE}`],
  },
  {
    id: 'resume-prompt',
    scenario: 'mixed',
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
const HAPPY_CAPTURE_CONFIG_TOML = CONFIG_TOML.replace('capacity = 2', 'capacity = 6')
const HAPPY_LEASE_TTL_MS = 24 * 60 * 60 * 1000

const HAPPY_BUILDS = [
  { id: 'AUT-131', title: 'Cache warm on deploy', slug: 'cache-warm-on-deploy', stage: 'merged' },
  {
    id: 'AUT-134',
    title: 'Dashboard key legend',
    slug: 'dashboard-key-legend',
    stage: 'implement',
  },
  { id: 'AUT-136', title: 'Harvest dedup window', slug: 'harvest-dedup-window', stage: 'plan' },
  { id: 'AUT-129', title: 'Parallel verify steps', slug: 'parallel-verify-steps', stage: 'verify' },
  {
    id: 'AUT-133',
    title: 'Ticket source adapters',
    slug: 'ticket-source-adapters',
    stage: 'code-review',
  },
] as const

type HappyBuildSlug = (typeof HAPPY_BUILDS)[number]['slug']

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
    happy: {
      buildEventsBefore: Record<HappyBuildSlug, string[]>
      buildEventsAfter: Record<HappyBuildSlug, string[]>
      repoJournalUnchanged: boolean
      forgePolls: number
      autoMergeCalls: number
      squashMergeCalls: number
    }
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

interface HappyScenario {
  harness: E2eHarness
  buildEventsBefore: Record<HappyBuildSlug, string[]>
  repoJournalBefore: string
}

async function seedHappyBuild(
  harness: E2eHarness,
  build: (typeof HAPPY_BUILDS)[number],
  observation: boolean,
): Promise<{ observationSeq?: number }> {
  const ticket = { source: 'fake', id: build.id, title: build.title }
  const workspacePath = join(harness.tmp, 'happy-workspaces', build.slug)
  await mkdir(workspacePath, { recursive: true })
  await harness.store.createBuild({
    slug: build.slug,
    repo: harness.origin,
    ticket,
    branch: `ab/${build.slug}`,
  })
  await harness.store.append(build.slug, {
    actor: DISPATCHER,
    type: 'build.created',
    payload: { ticket, repo: harness.origin, baseBranch: 'main' },
  })
  await harness.store.append(build.slug, {
    actor: DISPATCHER,
    type: 'workspace.provisioned',
    payload: {
      provider: 'dashboard-capture',
      ref: workspacePath,
      path: workspacePath,
      branch: `ab/${build.slug}`,
      base: { source: 'remote', sha: 'sha-happy-base' },
    },
  })
  await harness.store.appendWithArtifacts(
    build.slug,
    [{ kind: 'spec', content: `# ${build.title}\n\nHappy-path dashboard scenario.\n` }],
    ([spec]) => ({
      actor: DISPATCHER,
      type: 'spec.imported',
      payload: { artifact: { kind: spec!.kind, rev: spec!.revision }, ticket },
    }),
  )
  await harness.store.append(build.slug, {
    actor: KERNEL,
    type: 'runner.attached',
    payload: { instance: `capture-${build.slug}`, host: 'dashboard-capture' },
  })

  let observationSeq: number | undefined
  if (observation) {
    const event = await harness.store.append(build.slug, {
      actor: agentActor('implement', `s_observe_${build.id}`),
      type: 'observation.recorded',
      payload: {
        id: `obs_${build.id.toLowerCase()}`,
        kind: 'followup',
        summary: `Follow up on ${build.title.toLowerCase()}`,
      },
    })
    observationSeq = event.seq
  }

  const planRound = async (round: number, verdict: 'approve' | 'revise') => {
    const plan = await harness.store.putArtifact(build.slug, {
      kind: 'plan',
      content: `# Plan round ${round}\n`,
    })
    await harness.store.append(build.slug, {
      actor: KERNEL,
      type: 'plan.started',
      payload: { round },
    })
    await harness.store.append(build.slug, {
      actor: agentActor('plan', `s_plan_${build.id}_${round}`),
      type: 'plan.completed',
      payload: { round, artifact: { kind: plan.kind, rev: plan.revision } },
    })
    const notes = await harness.store.putArtifact(build.slug, {
      kind: 'plan-review',
      content: verdict === 'approve' ? 'Approved.\n' : 'Tighten rollout details.\n',
    })
    await harness.store.append(build.slug, {
      actor: KERNEL,
      type: 'plan-review.started',
      payload: { round },
    })
    await harness.store.append(build.slug, {
      actor: agentActor('plan-review', `s_plan_review_${build.id}_${round}`),
      type: 'plan-review.verdict',
      payload: {
        round,
        verdict,
        findings:
          verdict === 'revise'
            ? [
                {
                  id: `f_${build.id.toLowerCase()}_${round}`,
                  severity: 'important',
                  summary: 'Clarify the rollout sequence',
                  persists: [],
                },
              ]
            : [],
        artifact: { kind: notes.kind, rev: notes.revision },
      },
    })
  }

  const completeCodeRound = async (verdict: 'approve' | 'revise' | 'current' = 'approve') => {
    await harness.store.append(build.slug, {
      actor: KERNEL,
      type: 'implement.started',
      payload: { round: 1 },
    })
    const notes = await harness.store.putArtifact(build.slug, {
      kind: 'implement-notes',
      content: 'Implementation complete.\n',
    })
    await harness.store.append(build.slug, {
      actor: agentActor('implement', `s_implement_${build.id}`),
      type: 'implement.completed',
      payload: {
        round: 1,
        commits: { base: 'sha-happy-base', head: `sha-${build.slug}` },
        artifact: { kind: notes.kind, rev: notes.revision },
      },
    })
    await harness.store.append(build.slug, {
      actor: KERNEL,
      type: 'code-review.started',
      payload: { round: 1 },
    })
    if (verdict !== 'current') {
      const review = await harness.store.putArtifact(build.slug, {
        kind: 'code-review',
        content: verdict === 'approve' ? 'Approved.\n' : 'Revise the adapter boundary.\n',
      })
      await harness.store.append(build.slug, {
        actor: agentActor('code-review', `s_code_review_${build.id}`),
        type: 'code-review.verdict',
        payload: {
          round: 1,
          verdict,
          findings:
            verdict === 'revise'
              ? [
                  {
                    id: `f_${build.id.toLowerCase()}_code`,
                    severity: 'important',
                    summary: 'Keep the adapter boundary narrow',
                    persists: [],
                  },
                ]
              : [],
          artifact: { kind: review.kind, rev: review.revision },
        },
      })
    }
  }

  if (build.stage === 'plan') {
    await harness.store.append(build.slug, {
      actor: KERNEL,
      type: 'plan.started',
      payload: { round: 1 },
    })
  } else {
    if (build.stage === 'verify') {
      await planRound(1, 'revise')
      await planRound(2, 'approve')
    } else {
      await planRound(1, 'approve')
    }

    if (build.stage === 'implement') {
      await harness.store.append(build.slug, {
        actor: KERNEL,
        type: 'implement.started',
        payload: { round: 1 },
      })
    } else {
      await completeCodeRound(build.stage === 'code-review' ? 'current' : 'approve')
      if (build.stage !== 'code-review') {
        await harness.store.append(build.slug, {
          actor: KERNEL,
          type: 'verify.started',
          payload: { step: 'unit', attempt: 1 },
        })
        if (build.stage === 'merged') {
          await harness.store.append(build.slug, {
            actor: KERNEL,
            type: 'verify.completed',
            payload: { step: 'unit', attempt: 1, outcome: 'pass' },
          })
          await harness.store.append(build.slug, {
            actor: KERNEL,
            type: 'finalize.started',
            payload: {},
          })
          await harness.store.append(build.slug, {
            actor: KERNEL,
            type: 'finalize.completed',
            payload: {
              pr: {
                number: 41,
                url: 'https://github.com/defrex/autobuild/pull/41',
                headSha: `sha-${build.slug}`,
              },
            },
          })
          await harness.store.append(build.slug, {
            actor: DISPATCHER,
            type: 'pr.merged',
            payload: { sha: 'sha-cache-warm-landed' },
          })
        }
      }
    }
  }

  await harness.store.claimLease(build.slug, `sentinel-${build.slug}`, HAPPY_LEASE_TTL_MS)
  return observationSeq === undefined ? {} : { observationSeq }
}

async function prepareHappyScenario(): Promise<HappyScenario> {
  const harness = await makeHarness({
    handlers: {},
    configToml: HAPPY_CAPTURE_CONFIG_TOML,
    tickets: [],
  })

  try {
    const observations: Array<{ build: string; seq: number }> = []
    for (const [index, build] of HAPPY_BUILDS.entries()) {
      const seeded = await seedHappyBuild(harness, build, index < 3)
      if (seeded.observationSeq !== undefined) {
        observations.push({ build: build.slug, seq: seeded.observationSeq })
      }
    }

    harness.forge.setPrState(41, { state: 'open', mergeable: null })
    await harness.store.ensureRepo(harness.origin)
    const operator = humanActor('dashboard-capture')
    await harness.store.appendRepo(harness.origin, {
      actor: operator,
      type: 'dispatcher.intake-set',
      payload: { enabled: true },
    })
    await harness.store.appendRepo(harness.origin, {
      actor: operator,
      type: 'dispatcher.pause-set',
      payload: { enabled: false },
    })
    await harness.store.appendRepo(harness.origin, {
      actor: operator,
      type: 'dispatcher.auto-merge-default-set',
      payload: { enabled: true },
    })
    const started = await harness.store.appendRepoWithArtifacts(
      harness.origin,
      [{ kind: 'harvest-scan', content: '{"scenario":"happy"}\n' }],
      ([scan]) => ({
        actor: KERNEL,
        type: 'harvest.started',
        payload: {
          run: 'harvest_happy_headline',
          observations,
          scan: { kind: scan!.kind, rev: scan!.revision },
        },
      }),
    )
    const scan = started.artifacts[0]!
    await harness.store.appendRepo(harness.origin, {
      actor: KERNEL,
      type: 'harvest.step.started',
      payload: { run: 'harvest_happy_headline', step: 'scan' },
    })
    await harness.store.appendRepo(harness.origin, {
      actor: KERNEL,
      type: 'harvest.step.completed',
      payload: {
        run: 'harvest_happy_headline',
        step: 'scan',
        outcome: 'completed',
        artifact: { kind: scan.kind, rev: scan.revision },
      },
    })
    await harness.store.appendRepo(harness.origin, {
      actor: KERNEL,
      type: 'harvest.step.started',
      payload: { run: 'harvest_happy_headline', step: 'synthesize', round: 1 },
    })
    await harness.store.claimRepoLease(harness.origin, 'sentinel-happy-harvest', HAPPY_LEASE_TTL_MS)

    const buildEventsBefore = Object.fromEntries(
      await Promise.all(
        HAPPY_BUILDS.map(async ({ slug }) => [
          slug,
          (await harness.events(slug)).map((event) => event.type),
        ]),
      ),
    ) as Record<HappyBuildSlug, string[]>
    const repoJournalBefore = JSON.stringify(await harness.store.getRepoEvents(harness.origin))
    return { harness, buildEventsBefore, repoJournalBefore }
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
    spec.scenario === 'happy'
      ? ['Autobuild', 'Harvest', 'plan', 'implement', 'code-review', 'verify:unit', 'merge']
      : spec.transcript !== undefined
        ? ['Transcript', 'complete-dashboard-evidence']
        : spec.detail === undefined
          ? ['CAP-PLAN', 'CAP-IMPLEMENT', 'CAP-COMPLETE', 'BLOCKED', 'Harvest', 'PAUSED']
          : ['Build  plan-blocked-dashboard', 'BLOCKED']
  for (const required of commonEvidence) {
    if (!text.includes(required)) {
      throw new Error(
        `dashboard capture ${id}: final frame omitted required ${spec.scenario}-scenario evidence "${required}"`,
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
  for (const forbidden of spec.forbids ?? []) {
    if (text.includes(forbidden)) {
      throw new Error(
        `dashboard capture ${id}: final frame included forbidden evidence "${forbidden}"`,
      )
    }
  }
  if (spec.scenario === 'happy' && /\b(?:error|failed|failure)\b/i.test(text)) {
    throw new Error(`dashboard capture ${id}: final frame included failure or error text`)
  }
  if (spec.scenario === 'happy' && plain.some((line) => line.endsWith('~'))) {
    throw new Error(`dashboard capture ${id}: final frame exercised dashboard truncation`)
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
  const sentinelLeaseNotices = new Set(
    HAPPY_BUILDS.map(({ slug }) => `build ${slug} already held by another runner — skipped`),
  )

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
      // The happy fixture pins its pre-seeded builds with sentinel leases so
      // this real dispatch pass cannot mutate their journals. Those deliberate
      // claim losses are capture mechanics, not scenario health; remove only
      // their exact notices while preserving any unexpected warning as visual
      // and test evidence.
      const warningLines =
        spec.scenario === 'happy'
          ? (model.warningLines ?? []).filter((line) => !sentinelLeaseNotices.has(line))
          : []
      const presented = {
        ...model,
        ...(spec.scenario === 'happy'
          ? warningLines.length > 0
            ? { warningLines }
            : { warningLines: undefined }
          : spec.detail === undefined && spec.transcript === undefined
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

/** Drive the real scripted pipelines and dispatch composition, then write the
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
  const mixedHarness = await prepareScenario()
  let happy: HappyScenario
  try {
    happy = await prepareHappyScenario()
  } catch (error) {
    await mixedHarness.cleanup()
    throw error
  }

  try {
    const frames: CapturedDashboardFrame[] = []
    for (const spec of FRAME_SPECS) {
      const harness = spec.scenario === 'happy' ? happy.harness : mixedHarness
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
        '## Headline visual verdict',
        '- [ ] `headline-happy-wide.png` shows intake, auto merge, and harvest enabled.',
        '- [ ] Harvest is running with scan complete and synthesize underway.',
        '- [ ] Five plausible builds span plan, implement, code-review, verify, and merged.',
        '- [ ] A review round count above one is visible.',
        '- [ ] No blocked/paused/held state, failure text, fixture evidence, Unicode stress sample,',
        '      row-count preview, or truncation marker is visible.',
        '- Headline verdict: **[record pass or fail after opening the PNG]**',
        '',
        '## Verification-fixture visual checklist',
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

    const happyBuildEventsAfter = Object.fromEntries(
      await Promise.all(
        HAPPY_BUILDS.map(async ({ slug }) => [
          slug,
          (await happy.harness.events(slug)).map((event) => event.type),
        ]),
      ),
    ) as Record<HappyBuildSlug, string[]>
    for (const { slug } of HAPPY_BUILDS) {
      if (
        JSON.stringify(happy.buildEventsBefore[slug]) !==
        JSON.stringify(happyBuildEventsAfter[slug])
      ) {
        throw new Error(`dashboard capture happy scenario mutated build journal for ${slug}`)
      }
    }
    const mergedEvents = happyBuildEventsAfter['cache-warm-on-deploy']
    if (mergedEvents.at(-1) !== 'pr.merged' || mergedEvents.includes('build.completed')) {
      throw new Error(
        'dashboard capture happy merged build escaped the post-merge display interval',
      )
    }
    if (
      happy.harness.forge.autoMergeCalls.length > 0 ||
      happy.harness.forge.squashMergeCalls.length > 0
    ) {
      throw new Error('dashboard capture happy scenario unexpectedly attempted auto-merge')
    }
    const repoJournalUnchanged =
      JSON.stringify(await happy.harness.store.getRepoEvents(happy.harness.origin)) ===
      happy.repoJournalBefore
    if (!repoJournalUnchanged) {
      throw new Error('dashboard capture happy scenario mutated the Harvest journal while painting')
    }

    return {
      outputDir,
      reportPath,
      frames,
      diagnostics: {
        buildSlugs: mixedHarness.launched.map((entry) => entry.slug),
        agentSkills: [...mixedHarness.agents.sessions.values()].map(
          (session) => session.opts.skill,
        ),
        forgeOpened: mixedHarness.forge.opened.length,
        forgeComments: mixedHarness.forge.comments.length,
        cliErrors: [...mixedHarness.cliErrors, ...happy.harness.cliErrors],
        happy: {
          buildEventsBefore: happy.buildEventsBefore,
          buildEventsAfter: happyBuildEventsAfter,
          repoJournalUnchanged,
          forgePolls: happy.harness.forge.getPrStateCalls.length,
          autoMergeCalls: happy.harness.forge.autoMergeCalls.length,
          squashMergeCalls: happy.harness.forge.squashMergeCalls.length,
        },
      },
    }
  } finally {
    await Promise.all([mixedHarness.cleanup(), happy.harness.cleanup()])
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
