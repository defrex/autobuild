import { verifyStagesCapture } from './verify-stages-capture'
import { reportIntegrationFailures } from '../packages/core/src/kernel/integration-attention'
import { rollbackCapture, ROLLBACK_AT } from './rollback-capture'
import { handoffCapture } from './handoff-capture'
import { harvestSuspensionCapture } from './harvest-suspension-capture'
import { nativeSessionCapture } from './native-session-capture'
import { readBuildFacts } from '../packages/core/src/store/reduced-reads'
import { readinessChecks } from '../packages/core/src/ports/forge/readiness'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { abDispatch } from '../packages/core/src/cli/dispatch'
import { bulkControlRepository } from '../packages/core/src/cli/bulk-control'
import { renderDashboardFrameImage } from '../packages/core/src/cli/dashboard/frame-image'
import { cellWidth } from '../packages/core/src/cli/dashboard/cells'
import type { DashboardModel } from '../packages/core/src/cli/dashboard/model'
import type { StreamPart } from '../packages/core/src/store/streams/types'
import {
  errorPart,
  promptPart,
  reasoningDeltaPart,
  reasoningEndPart,
  reasoningStartPart,
  sessionPart,
  startPart,
  startStepPart,
  textDeltaPart,
  textEndPart,
  textStartPart,
  toolInputPart,
  toolOutputPart,
  truncationPart,
} from '../packages/core/src/ports/runner/stream-parts'
import { renderDashboard, stripAnsi } from '../packages/core/src/cli/dashboard/render'
import type { TerminalInput, TerminalOut } from '../packages/core/src/cli/terminal'
import { createTerminalModeController } from '../packages/core/src/cli/terminal-restore'
import { agentActor, DISPATCHER, humanActor, KERNEL } from '../packages/core/src/events/envelope'
import { spawnExec } from '../packages/core/src/ports/workspace/git-worktree'
import {
  CONFIG_TOML,
  happyHandlers,
  makeHarness,
  readyTicket,
  type E2eHarness,
  type SkillHandlers,
} from '../packages/core/src/scenarios/harness'

export const RENDER_NOW = Date.parse('2026-07-15T12:10:00.000Z')

type CaptureScenario = 'mixed' | 'happy' | 'integration' | 'capacity'

export interface FrameSpec {
  selection?: DashboardModel['selection']
  harvestSuspended?: boolean
  rollback?: boolean
  handoff?: boolean
  nativeSessions?: boolean
  verifyStages?: boolean
  forgeReadiness?: boolean
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
  /** Overlay the read-only session view over scripted stream parts. The
   * harness injects a wire and never reaches DispatchFrontend, so this is
   * necessarily a renderer-level overlay (like `transcript`) — the production
   * controller path is covered by dispatch-frontend.test.ts. */
  session?: {
    slug: string
    sessionId: string
    stream: string
    status: 'open' | 'closed'
    outcome?: 'completed' | 'aborted'
    parts: readonly StreamPart[]
    follow?: boolean
  }
  standby?: string
  availableUpgrade?: string
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

/** Scripted live mid-turn: session header, labelled prompt, a step, reasoning
 * and answer deltas, and a tool call whose output has not landed yet. */
const SESSION_LIVE_PARTS: readonly StreamPart[] = [
  sessionPart({
    session: 's_live_capture',
    role: 'implement',
    runner: 'pi',
    model: 'zai/glm',
    phase: 'implement',
    round: 2,
  }),
  promptPart('wire the live session view into the dashboard'),
  startPart('m1'),
  startStepPart(),
  reasoningStartPart('r1'),
  reasoningDeltaPart('r1', 'the projection owns the vocabulary; the feed owns the reads'),
  reasoningEndPart('r1'),
  textStartPart('t1'),
  textDeltaPart('t1', 'wiring the shared feed into both controllers now'),
  toolInputPart('c1', 'bash', { command: 'bun test packages/core' }),
]

/** Scripted closed session: a full part sequence including tool output
 * exceeding the documented row cap, an error part, and a truncation marker. */
const SESSION_CLOSED_PARTS: readonly StreamPart[] = [
  sessionPart({
    session: 's_closed_capture',
    role: 'code-review',
    runner: 'scripted',
    phase: 'code-review',
    round: 1,
  }),
  promptPart('review the session view diff'),
  startPart('m1'),
  textStartPart('t1'),
  textDeltaPart('t1', 'the review found one boundary worth tightening'),
  textEndPart('t1'),
  toolInputPart('c1', 'bash', { command: 'bun test' }),
  toolOutputPart('c1', Array.from({ length: 12 }, (_, i) => `row-${i}`).join('\n')),
  truncationPart(4096),
  errorPart('the provider rate limit was exhausted'),
]

const HAPPY_EVIDENCE = [
  'intake ON',
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
] as const
const HAPPY_FORBIDDEN = [
  'BLOCKED',
  'PAUSED',
  '(held)',
  'Unicode',
  UNICODE_EVIDENCE,
  'more rows - Enter details',
] as const

/** Terminal width of the website hero frame; `packages/website` lays the
 * frame out at exactly this many cells. */
export const WEBSITE_HERO_COLUMNS = 133

export const FRAME_SPECS: readonly FrameSpec[] = [
  ...[180, 100].map((columns) => ({
    id: `rollback-${columns === 180 ? 'wide' : 'narrow'}`,
    scenario: 'happy' as const,
    columns,
    rows: 50,
    rollback: true,
    requires: [
      'rollback: failed 1.1.0',
      'bbbbbbbbbbbb',
      'restored 1.0.0',
      'aaaaaaaaaaaa',
      'held',
      ROLLBACK_AT,
      'RUNNING',
    ],
  })),
  ...[180, 100].map((columns) => ({
    id: `handoff-${columns === 180 ? 'wide' : 'narrow'}`,
    scenario: 'happy' as const,
    columns,
    rows: 50,
    handoff: true,
    requires: [
      'handoff 1.0.0',
      '1.1.0',
      'mode',
      'drain;',
      'drain deadline',
      '(draining)',
      'RUNNING',
    ],
  })),
  {
    id: 'harvest-suspended-wide',
    scenario: 'happy',
    columns: 180,
    rows: 42,
    harvestSuspended: true,
    requires: ['Harvest', 'SUSPENDED'],
  },
  {
    id: 'harvest-suspended-narrow',
    scenario: 'happy',
    columns: 100,
    rows: 50,
    harvestSuspended: true,
    requires: ['Harvest', 'SUSPENDED'],
  },
  {
    id: 'capacity-wide',
    scenario: 'capacity',
    columns: 180,
    rows: 44,
    requires: ['active 5/5', '4 configured', 'descendant-held slots', 'queue-conflict'],
  },
  ...(['wide', 'narrow'] as const).map((size) => ({
    id: `integration-detail-${size}`,
    scenario: 'integration' as const,
    columns: size === 'wide' ? 140 : 70,
    rows: 80,
    detail: { slug: 'integration-with-pr', scroll: 0 },
    requires: [
      'Integration',
      'Progress',
      'Branch',
      'Steps',
      'Children',
      'implement',
      'code-review',
      'Verification',
      'Merge',
      'Queued documentation work',
    ],
  })),
  ...(['conflict', 'failed', 'ready-node'] as const).map((state) => ({
    id: `integration-detail-${state}`,
    scenario: 'integration' as const,
    columns: 110,
    rows: 60,
    detail: { slug: `queue-${state}`, scroll: 0 },
    requires:
      state === 'conflict'
        ? ['Conflict', 'src/a file.ts']
        : state === 'failed'
          ? ['repair child', 'unit']
          : ['press l, or ab merge queue-ready-node'],
  })),
  {
    id: 'integration-wide',
    selection: { kind: 'build', slug: 'queue-held' },
    scenario: 'integration',
    columns: 140,
    rows: 80,
    requires: [
      'consent queue',
      'held',
      'conflicted',
      'collect',
      'integration →',
      'merged',
      'children unknown',
      'unit failed',
      'ready to merge into',
      'NODE-3',
      'Janitor failing: forge publication unavailable',
    ],
  },

  {
    id: 'integration-narrow',
    forbids: ['Janitor failing:'],
    scenario: 'integration',
    columns: 70,
    rows: 110,
    requires: [
      'merged',
      'building',
      'queued',
      'unit failed',
      'repair child',
      'ready to merge into',
    ],
  },

  {
    id: 'post-reconcile-policy',
    scenario: 'mixed',
    columns: 140,
    rows: 60,
    detail: { slug: 'complete-dashboard-evidence', scroll: 0 },
    requires: ['skipped by post-reconcile policy'],
  },
  {
    id: 'verify-stages-wide',
    scenario: 'mixed',
    columns: 140,
    rows: 100,
    verifyStages: true,
    requires: [
      'concurrent-verification',
      'verify:unit',
      'verify:integration',
      'not run: cancelled by verify:unit',
    ],
  },
  {
    id: 'headline-happy-wide',
    scenario: 'happy',
    columns: 140,
    rows: 40,
    requires: HAPPY_EVIDENCE,
    forbids: HAPPY_FORBIDDEN,
  },
  {
    // The website hero: the same happy scenario at the narrowest width that
    // keeps every pipeline row on one line, so the frame fits the page at
    // the 14px cell with a 2ch well on either side. `packages/website/src/hero-frame.txt` tracks its exact
    // ANSI lines; `bun run capture:website-hero` keeps the two in step.
    id: 'website-hero',
    scenario: 'happy',
    columns: WEBSITE_HERO_COLUMNS,
    rows: 40,
    requires: HAPPY_EVIDENCE,
    forbids: HAPPY_FORBIDDEN,
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
    id: 'native-sessions',
    scenario: 'mixed',
    columns: 120,
    rows: 35,
    nativeSessions: true,
    detail: { slug: 'plan-blocked-dashboard', scroll: Number.MAX_SAFE_INTEGER },
    requires: ['suspended', 'resumed'],
  },
  {
    id: 'session-live',
    scenario: 'mixed',
    columns: 100,
    rows: 24,
    session: {
      slug: 'complete-dashboard-evidence',
      sessionId: 's_live_capture',
      stream: 'st_live_capture',
      status: 'open',
      parts: SESSION_LIVE_PARTS,
      follow: true,
    },
    requires: [
      'Session  complete-dashboard-evidence',
      'Prompt: wire the live session view into the dashboard',
      '~ the projection owns the vocabulary; the feed owns the reads',
      'bash({"command":"bun test packages/core"})',
      'waiting for output',
      'following tail',
    ],
    forbids: ['ERROR', 'ABORTED', 'Stream closed'],
  },
  {
    id: 'session-closed',
    scenario: 'mixed',
    columns: 100,
    rows: 24,
    session: {
      slug: 'complete-dashboard-evidence',
      sessionId: 's_closed_capture',
      stream: 'st_closed_capture',
      status: 'closed',
      outcome: 'completed',
      parts: SESSION_CLOSED_PARTS,
      follow: true,
    },
    requires: [
      'Stream closed: completed',
      'ERROR: the provider rate limit was exhausted',
      '… 4 more rows withheld',
      '… 4096 bytes truncated',
    ],
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
  {
    id: 'standby-list',
    scenario: 'mixed',
    columns: 140,
    rows: 40,
    standby: 'peer-run; pid 1234; host build-host; heartbeat 500ms ago',
    availableUpgrade: '9.1.0',
    requires: [
      'Dispatcher on standby: repository held by peer-run',
      'run ab upgrade',
      'Unicode warning',
    ],
  },
  {
    id: 'standby-detail',
    scenario: 'mixed',
    columns: 140,
    rows: 24,
    standby: 'peer-run; pid 1234; host build-host; heartbeat 500ms ago',
    detail: { slug: 'plan-blocked-dashboard', scroll: 0 },
    requires: [
      'Dispatcher on standby: repository held by peer-run',
      'Build  plan-blocked-dashboard',
    ],
  },
  {
    id: 'forge-readiness-wide',
    scenario: 'mixed',
    columns: 140,
    rows: 60,
    forgeReadiness: true,
    requires: ['Forge squash', 'Forge rebase', 'Allow squash merging', 'Allow rebase merging'],
  },
  {
    id: 'forge-readiness-narrow',
    scenario: 'mixed',
    columns: 80,
    rows: 70,
    forgeReadiness: true,
    requires: ['Forge squash', 'Forge rebase', 'Allow squash merging', 'Allow rebase merging'],
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
  /** Store-only projection used as the terminal/web parity oracle. */
  model: DashboardModel
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
  /** Keep the existing web integration fixture independent of terminal queue evidence. */
  consentQueueFixtures?: boolean
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

async function prepareIntegrationScenario(
  consentQueueFixtures: boolean,
  capacityIdentities = false,
): Promise<E2eHarness> {
  const harness = await makeHarness({
    handlers: happyHandlers(),
    configToml: `${CAPTURE_CONFIG_TOML}
[[merge]]
from = "node"
into = "node"
mode = "auto"
`,
    tickets: [],
  })
  await harness.store.ensureRepo(harness.origin)
  harness.forge.remoteBranches.set('main', 'opening-sha')
  harness.forge.setPrState(91, { state: 'open', mergeable: null })
  for (const [index, label] of ['empty', 'with-pr', 'nested', 'aborted', 'unknown'].entries()) {
    const slug = `integration-${label}`
    harness.forge.remoteBranches.set(
      `ab-node/${slug}`,
      label === 'with-pr' ? 'child-sha' : 'opening-sha',
    )
    if (label === 'nested')
      harness.forge.nodeComparisons.set(
        'ab-node/integration-with-pr...ab-node/integration-nested',
        0,
      )
    await harness.store.createBuild({
      slug,
      repo: harness.origin,
      branch: `ab-node/${slug}`,
      ticket: { source: 'fake', id: `NODE-${index + 1}` },
      created: {
        actor: DISPATCHER,
        type: 'build.created',
        payload: {
          ticket: { source: 'fake', id: `NODE-${index + 1}` },
          repo: harness.origin,
          kind: 'node',
          baseBranch: label === 'nested' ? 'ab-node/integration-with-pr' : 'main',
          ...(label === 'nested'
            ? { target: { ticket: { source: 'fake', id: 'NODE-2' }, build: 'integration-with-pr' } }
            : {}),
        },
      },
    })
    await harness.store.append(slug, {
      actor: DISPATCHER,
      type: 'node.opening',
      payload: {
        branch: `ab-node/${slug}`,
        parent: 'main',
        sha: 'opening-sha',
      },
    })
    await harness.store.append(slug, {
      actor: DISPATCHER,
      type: 'node.opened',
      payload: { sha: 'opening-sha' },
    })
    if (label === 'with-pr') {
      const original = 'b'.repeat(40)
      const rewritten = 'a'.repeat(40)
      await harness.store.append(slug, {
        actor: KERNEL,
        type: 'node.writer-reserved',
        payload: {
          id: 'intent-replay',
          operation: 'restack',
          expected: original,
          parent: 'opening-sha',
          oldBase: 'opening-sha',
          archive: 'refs/archive/intent',
          changes: [{ sha: original }],
          upstreamBuilds: [],
          merges: [],
        },
      })
      await harness.store.append(slug, {
        actor: KERNEL,
        type: 'node.item-prepared',
        payload: { id: 'intent-replay', index: 0, base: 'opening-sha' },
      })
      await harness.store.append(slug, {
        actor: KERNEL,
        type: 'node.item-replayed',
        payload: {
          id: 'intent-replay',
          index: 0,
          base: 'opening-sha',
          head: rewritten,
          dropped: false,
        },
      })
      await harness.store.append(slug, {
        actor: KERNEL,
        type: 'node.publish-intended',
        payload: { id: 'intent-replay', head: rewritten },
      })
      await harness.store.append(slug, {
        actor: KERNEL,
        type: 'node.rewritten',
        payload: { id: 'intent-replay', previous: original, head: rewritten },
      })
      await harness.store.append(slug, {
        actor: KERNEL,
        type: 'node.writer-settled',
        payload: { id: 'intent-replay', outcome: 'completed' },
      })
      // These provenance facts must not shift the established leaf timeline.
      harness.clock.advance(-6000)
    }
    await harness.store.append(slug, {
      actor: DISPATCHER,
      type: 'node.inventory',
      payload: {
        head: 'child-sha',
        builds: [],
        foreign: label === 'with-pr' ? ['a'.repeat(40)] : [],
      },
    })
    harness.clock.advance(-1000)
    await harness.store.append(slug, {
      actor: DISPATCHER,
      type: 'node.compared',
      payload: {
        parentSha: 'opening-sha',
        headSha: label === 'with-pr' ? 'child-sha' : 'opening-sha',
        ahead: label === 'with-pr' ? 1 : 0,
      },
    })
    await harness.store.append(slug, {
      actor: DISPATCHER,
      type: 'integration.observed',
      payload: {
        openChildren:
          label === 'with-pr'
            ? capacityIdentities
              ? ['NODE-3', ...(consentQueueFixtures ? ['queue-active'] : []), 'QUEUED-CHILD']
              : ['WORK-1', 'WORK-2', 'QUEUED-CHILD']
            : [],
        contributions:
          label === 'with-pr'
            ? Array.from({ length: 8 }, (_, i) => `landed-${i}`)
            : label === 'nested'
              ? ['nested-landed']
              : [],
        diagnostics: label === 'unknown' ? ['ticket enumeration unavailable'] : [],
        ...(label === 'with-pr'
          ? {
              children: [
                { source: 'fake', id: 'WORK-1', title: 'Implement the documentation pages' },
                { source: 'fake', id: 'WORK-2', title: 'Review the new integration dashboard' },
                { source: 'fake', id: 'QUEUED-CHILD', title: 'Queued documentation work' },
                ...Array.from({ length: 8 }, (_, i) => ({
                  source: 'fake',
                  id: `DONE-${i}`,
                  title: `Completed integration work ${i + 1}`,
                  builds: [`landed-${i}`],
                })),
              ],
            }
          : {}),
      },
    })
    if (label !== 'unknown') {
      const parent = label === 'with-pr' ? 'b'.repeat(40) : 'opening-sha'
      if (label === 'with-pr')
        await harness.store.append(slug, {
          actor: DISPATCHER,
          type: 'target.moved',
          payload: { branch: 'main', sha: parent },
        })
      await harness.store.append(slug, {
        actor: DISPATCHER,
        type: 'node.parent-distance',
        payload: {
          base: 'opening-sha',
          parent,
          branch: label === 'nested' ? 'ab-node/integration-with-pr' : 'main',
          count: label === 'with-pr' ? 3 : 0,
        },
      })
    }
    if (label === 'with-pr')
      await harness.store.append(slug, {
        actor: DISPATCHER,
        type: 'pr.opened',
        payload: { pr: { number: 91, url: 'https://example.test/pr/91', headSha: 'child-sha' } },
      })
    if (label === 'aborted')
      await harness.store.append(slug, { actor: DISPATCHER, type: 'build.aborted', payload: {} })
  }
  for (const [index, phase] of (capacityIdentities ? [] : ['implement', 'code-review']).entries()) {
    const slug = `detail-work-${index + 1}`
    const ticket = {
      source: 'fake',
      id: `WORK-${index + 1}`,
      title: index ? 'Review the new integration dashboard' : 'Implement the documentation pages',
    }
    await harness.store.createBuild({
      slug,
      repo: harness.origin,
      ticket,
      created: {
        actor: DISPATCHER,
        type: 'build.created',
        payload: {
          repo: harness.origin,
          ticket,
          baseBranch: 'ab-node/integration-with-pr',
          target: { ticket: { source: 'fake', id: 'NODE-2' }, build: 'integration-with-pr' },
        },
      },
    })
    await harness.store.append(slug, {
      actor: KERNEL,
      type: 'runner.attached',
      payload: { instance: slug, host: 'capture' },
    })
    await harness.store.claimLease(slug, `sentinel-${slug}`, HAPPY_LEASE_TTL_MS)
    await harness.store.append(slug, {
      actor: KERNEL,
      type: phase === 'implement' ? 'implement.started' : 'code-review.started',
      payload: { round: 1 },
    })
  }
  if (!consentQueueFixtures) return harness
  for (const [index, label] of [
    'ready-leaf',
    'ready-node',
    'held',
    'incomplete',
    'active',
    'conflict',
    'stale',
    'failed',
  ].entries()) {
    const slug = `queue-${label}`
    const node = label !== 'ready-leaf'
    const parent = 'a'.repeat(40)
    const head = label === 'failed' ? 'f'.repeat(40) : `head-${label}`
    await harness.store.createBuild({
      slug,
      repo: harness.origin,
      branch: `preview/${label}`,
      // Only borrowed-slot evidence needs source-qualified record identities.
      ...(capacityIdentities ? { ticket: { source: 'fake', id: `QUEUE-${index}` } } : {}),
      created: {
        actor: DISPATCHER,
        type: 'build.created',
        payload: {
          ticket: { source: 'fake', id: `QUEUE-${index}` },
          repo: harness.origin,
          kind: node ? 'node' : 'work',
          baseBranch: 'ab-node/integration-with-pr',
          target: { ticket: { source: 'fake', id: 'NODE-2' }, build: 'integration-with-pr' },
        },
      },
    })
    if (!node)
      await harness.store.append(slug, {
        actor: KERNEL,
        type: 'workspace.provisioned',
        payload: {
          provider: 'local',
          ref: 'capture',
          branch: `preview/${label}`,
          base: { source: 'local', sha: parent, remoteError: 'capture' },
        },
      })
    await harness.store.append(slug, {
      actor: DISPATCHER,
      type: 'node.opening',
      payload: { branch: `preview/${label}`, parent: 'ab-node/integration-with-pr', sha: parent },
    })
    await harness.store.append(slug, {
      actor: DISPATCHER,
      type: 'node.opened',
      payload: { sha: parent },
    })
    await harness.store.append(slug, {
      actor: DISPATCHER,
      type: 'node.compared',
      payload: { headSha: head, parentSha: parent, ahead: 1 },
    })
    await harness.store.append(slug, {
      actor: DISPATCHER,
      type: 'integration.observed',
      payload: {
        openChildren: label === 'incomplete' ? ['OPEN-CHILD'] : [],
        diagnostics: [],
        contributions: ['child-contribution'],
      },
    })
    await harness.store.append(slug, {
      actor: DISPATCHER,
      type: 'integration.prepared',
      payload: {
        id: `cycle-${label}`,
        head,
        parent,
        config: JSON.stringify({ verify: { steps: label === 'failed' ? ['unit'] : [] } }),
      },
    })
    await harness.store.append(slug, {
      actor: DISPATCHER,
      type: 'node.parent-distance',
      payload: {
        base: parent,
        parent,
        branch: 'ab-node/integration-with-pr',
        count: 0,
      },
    })
    if (label === 'failed') {
      await harness.store.append(slug, {
        actor: KERNEL,
        type: 'verify.started',
        payload: {
          step: 'unit',
          attempt: 1,
          restackId: `cycle-${label}`,
          headSha: head,
          baseSha: parent,
        },
      })
      await harness.store.append(slug, {
        actor: KERNEL,
        type: 'verify.completed',
        payload: {
          step: 'unit',
          attempt: 1,
          restackId: `cycle-${label}`,
          headSha: head,
          baseSha: parent,
          outcome: 'fail',
        },
      })
    }
    if (label === 'failed') await reportIntegrationFailures(harness.store, slug)
    if (!node)
      await harness.store.append(slug, {
        actor: KERNEL,
        type: 'runner.attached',
        payload: { instance: 'capture', host: 'capture' },
      })
    const finalized = await harness.store.append(slug, {
      actor: KERNEL,
      type: 'finalize.completed',
      payload: {
        pr: { number: 100 + index, url: `https://example.test/pr/${100 + index}`, headSha: head },
      },
    })
    await harness.store.append(slug, {
      actor: DISPATCHER,
      type: 'landing.decided',
      payload: {
        candidate: {
          head,
          parent,
          cycle: node ? `cycle-${label}` : String(finalized.seq),
        },
        from: node ? 'node' : 'leaf',
        into: { kind: 'node', ticket: 'NODE-2' },
        labels: [],
        mode: 'consent',
        rule: { default: true },
      },
    })
    if (label === 'held')
      await harness.store.append(slug, {
        actor: { kind: 'human', user: 'capture' },
        type: 'build.hold-requested',
        payload: {},
      })
    if (label === 'stale')
      await harness.store.append(slug, {
        actor: DISPATCHER,
        type: 'node.compared',
        payload: { headSha: head, parentSha: 'new-parent', ahead: 1 },
      })
    if (label === 'active' || label === 'conflict') {
      await harness.store.append(slug, {
        actor: DISPATCHER,
        type: 'node.writer-reserved',
        payload: {
          id: label,
          operation: 'restack',
          expected: head,
          parent,
          oldBase: parent,
          archive: 'archive',
          changes: [{ sha: 'change' }],
          upstreamBuilds: [],
          merges: [],
        },
      })
      if (label === 'conflict')
        await harness.store.append(slug, {
          actor: DISPATCHER,
          type: 'node.item-prepared',
          payload: { id: label, index: 0, base: parent },
        })
      if (label === 'conflict')
        await harness.store.append(slug, {
          actor: DISPATCHER,
          type: 'node.item-conflicted',
          payload: { id: label, index: 0, base: parent, files: ['src/a file.ts', 'src/日本語.ts'] },
        })
    }
    await harness.store.claimLease(slug, `sentinel-${slug}`, HAPPY_LEASE_TTL_MS)
  }
  harness.forge.remoteBranches.set('ab-node/integration-with-pr', 'a'.repeat(40))
  return harness
}

async function prepareBorrowedCapacity(harness: E2eHarness): Promise<void> {
  await harness.store.append('queue-conflict', {
    actor: KERNEL,
    type: 'workspace.provisioned',
    payload: {
      provider: 'local',
      ref: 'capture-conflict',
      branch: 'preview/conflict',
      base: { source: 'local', sha: 'a'.repeat(40), remoteError: 'capture' },
    },
  })
  for (let index = 0; index < 3; index++) {
    const slug = `waiting-child-${index}`
    await harness.store.createBuild({
      slug,
      repo: harness.origin,
      ticket: { source: 'fake', id: slug },
      created: {
        actor: DISPATCHER,
        type: 'build.created',
        payload: {
          repo: harness.origin,
          ticket: { source: 'fake', id: slug },
          baseBranch: 'preview/conflict',
          target: { build: 'queue-conflict', ticket: { source: 'fake', id: 'QUEUE-5' } },
        },
      },
    })
    await harness.store.append(slug, { actor: DISPATCHER, type: 'build.paused', payload: {} })
    await harness.store.claimLease(slug, `sentinel-${slug}`, HAPPY_LEASE_TTL_MS)
  }
}

export async function prepareScenario(): Promise<E2eHarness> {
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

    // Capacity admission samples the stepping clock twice during the initial
    // tick. Preserve the established reconcile/landing evidence timestamps;
    // these frames exercise policy and layout rather than admission timing.
    harness.clock.advance(-2000)

    // Seed a completed reconcile cycle with explicit policy evidence on the open PR.
    const slug = 'complete-dashboard-evidence'
    await harness.store.append(slug, {
      actor: KERNEL,
      type: 'reconcile.started',
      payload: { attempt: 1, baseSha: 'capture-base' },
    })
    const completion = await harness.store.append(slug, {
      actor: agentActor('reconcile', 'capture-reconcile'),
      type: 'reconcile.completed',
      payload: { mergeCommit: 'capture-merge', artifact: { kind: 'reconcile-notes', rev: 0 } },
    })
    await harness.store.append(slug, {
      actor: KERNEL,
      type: 'verify.reconcile-policy-captured',
      payload: {
        reconcileSeq: completion.seq,
        steps: [{ step: 'unit', enabled: false, source: 'verify.afterReconcile' }],
      },
    })
    await harness.store.append(slug, {
      actor: KERNEL,
      type: 'verify.started',
      payload: { step: 'unit', attempt: 2 },
    })
    await harness.store.append(slug, {
      actor: KERNEL,
      type: 'verify.completed',
      payload: {
        step: 'unit',
        attempt: 2,
        outcome: 'skipped',
        skipCause: 'post-reconcile-policy',
        reason: 'skipped by post-reconcile policy: verify.afterReconcile = false',
      },
    })

    const readyState = (await readBuildFacts(harness.store, slug)).value.state
    if (!readyState.pr || !readyState.finalizeCompletedSeq)
      throw new Error('post-reconcile capture requires a finalized PR')
    await harness.store.append(slug, {
      actor: DISPATCHER,
      type: 'landing.decided',
      payload: {
        candidate: {
          head: readyState.pr.headSha,
          parent: 'capture-base',
          cycle: String(readyState.finalizeCompletedSeq),
        },
        from: 'leaf',
        into: { kind: 'root' },
        labels: [],
        mode: 'consent',
        rule: { index: 0, snapshot: { mode: 'consent' } },
      },
    })

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

export interface HappyScenario {
  harness: E2eHarness
  buildEventsBefore: Record<HappyBuildSlug, string[]>
  repoJournalBefore: string
}

async function seedHappyBuild(
  harness: E2eHarness,
  build: (typeof HAPPY_BUILDS)[number],
  observation: boolean,
  /** seq of the journal's `dispatcher.auto-merge-default-set {enabled: true}`
   * fact, written before the builds were seeded. Each happy build is seeded
   * with the consent the fan-out would otherwise have to settle on its first
   * dispatch pass (which would mutate the journal the capture pins). */
  autoMergeDefaultSeq: number | undefined,
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
  const target = await spawnExec(['git', 'rev-parse', 'refs/heads/main'], { cwd: harness.origin })
  if (target.exitCode !== 0) throw new Error(target.stderr)
  await harness.store.append(build.slug, {
    actor: DISPATCHER,
    type: 'target.moved',
    payload: { branch: 'main', sha: target.stdout.trim() },
  })
  // Keep the established visual timeline when adding this observation fact.
  harness.clock.advance(-1000)
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

  // Settled auto-merge consent under the ON default, exactly as the fan-out
  // would have written it (human-attributed, answering the journal fact by
  // seq). Seeding — rather than letting the capture's real dispatch pass
  // reconcile — is what keeps the pinned build journals byte-stable.
  if (autoMergeDefaultSeq !== undefined) {
    const request = await harness.store.append(build.slug, {
      actor: humanActor('dashboard-capture'),
      type: 'build.auto-merge-requested',
      payload: { defaultSeq: autoMergeDefaultSeq },
    })
    if (build.stage === 'merged') {
      await harness.store.append(build.slug, {
        actor: DISPATCHER,
        type: 'pr.auto-merge-enabled',
        payload: { commandSeq: request.seq },
      })
    }
  }

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
        // Exactly one start: the seeded journal is the pinned fixture, and a
        // duplicate append would shift every subsequent event's seq.
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

export async function prepareHappyScenario(): Promise<HappyScenario> {
  const harness = await makeHarness({
    handlers: {},
    configToml: HAPPY_CAPTURE_CONFIG_TOML,
    tickets: [],
  })

  try {
    const observations: Array<{ build: string; seq: number }> = []
    // Repository settings are written BEFORE the builds: the ON default's seq
    // is what each build's seeded consent answers, so the capture's real
    // dispatch pass finds every build already settled and mutates nothing.
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
    const autoMergeDefault = await harness.store.appendRepo(harness.origin, {
      actor: operator,
      type: 'dispatcher.auto-merge-default-set',
      payload: { enabled: true },
    })
    for (const [index, build] of HAPPY_BUILDS.entries()) {
      const seeded = await seedHappyBuild(harness, build, index < 3, autoMergeDefault.seq)
      if (seeded.observationSeq !== undefined) {
        observations.push({ build: build.slug, seq: seeded.observationSeq })
      }
    }
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
    const repoJournalBefore = JSON.stringify(
      (await harness.store.getRepoEvents(harness.origin)).filter((event) =>
        event.type.startsWith('harvest.'),
      ),
    )
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
    (spec.scenario === 'integration' || spec.scenario === 'capacity') && !spec.detail
      ? ['integration', 'collect', 'children unknown']
      : spec.scenario === 'happy'
        ? ['Autobuild', 'Harvest', 'plan', 'implement', 'code-review', 'verify:unit', 'merge']
        : spec.transcript !== undefined
          ? ['Transcript', 'complete-dashboard-evidence']
          : spec.session !== undefined
            ? ['Session', spec.session.slug]
            : spec.detail === undefined
              ? ['CAP-PLAN', 'CAP-IMPLEMENT', 'CAP-COMPLETE', 'BLOCKED', 'Harvest', 'PAUSED']
              : [
                  `Build  ${spec.detail.slug}`,
                  ...(spec.detail.slug === 'plan-blocked-dashboard' ? ['BLOCKED'] : []),
                ]
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
  if (
    spec.scenario === 'happy' &&
    /\b(?:error|failed|failure)\b/i.test(
      spec.rollback ? text.replace('rollback: failed', 'rollback:') : text,
    )
  ) {
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

async function capturePaint(
  harness: E2eHarness,
  spec: FrameSpec,
): Promise<{ lines: string[]; model: DashboardModel }> {
  const terminal = new CaptureTerminal(spec.columns, spec.rows)
  const stderr: string[] = []
  let captured: string[] | undefined
  let capturedModel: DashboardModel | undefined
  const sentinelLeaseNotices = new Set(
    HAPPY_BUILDS.map(({ slug }) => `build ${slug} already held by another runner — skipped`),
  )
  // The supervised kernel claims the repository lease itself, so the sentinel
  // holder must stand down for the capture. The adopting HarvestRunner is
  // then held off the seeded open run by failing its adopted-holder liveness
  // heartbeat (and every later lease claim): the loop's own 20 s heartbeat
  // timer never fires inside one --once capture.
  const happyHarness = spec.scenario === 'happy'
  const originalHeartbeatRepo = harness.store.heartbeatRepo.bind(harness.store)
  const originalClaimRepoLease = harness.store.claimRepoLease.bind(harness.store)
  // Synthetic rows intentionally provoke many independent failures. Their
  // durable receipts advance the stepping clock; retain ownership throughout
  // this synchronous capture pass without changing production lease timing.
  harness.store.claimRepoLease = (repo, holder, ttl) =>
    originalClaimRepoLease(repo, holder, ttl * 10)
  let repoLeaseClaims = 0
  if (happyHarness) {
    await harness.store.ensureRepo(harness.origin)
    await harness.store.releaseRepoLease(harness.origin, 'sentinel-happy-harvest')
    harness.store.heartbeatRepo = async () => false
    harness.store.claimRepoLease = async (repo, holder, ttl) => {
      repoLeaseClaims += 1
      // Only the loop's initial claim succeeds; current-lease ticks no longer
      // re-claim. A later claim is the adopting HarvestRunner re-acquiring
      // after its deliberately lost heartbeat.
      return repoLeaseClaims === 1 ? originalClaimRepoLease(repo, holder, ttl * 10) : false
    }
  }

  const priorReadiness = harness.forge.readiness
  if (spec.forgeReadiness) {
    harness.forge.readiness = readinessChecks('pass', 'Permitted')
    for (const check of harness.forge.readiness.slice(0, 2)) {
      check.status = 'fail'
      check.detail = `${check.check} merging is disabled.`
    }
  }
  await abDispatch({
    targetRepo: harness.origin,
    // The capture harness keys its store by the checkout path; pin the same
    // identity so the dispatch loop serves the seeded journals.
    repo: harness.origin,
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
      const sourceModel = spec.verifyStages
        ? verifyStagesCapture(model)
        : spec.rollback
          ? rollbackCapture(model)
          : spec.handoff
            ? handoffCapture(model)
            : model
      const presented = {
        ...sourceModel,
        ...(spec.harvestSuspended ? { harvest: harvestSuspensionCapture() } : {}),
        ...(spec.selection ? { selection: spec.selection } : {}),
        // Runtime commits include generated fixture bytes; keep their visible
        // provenance stable just like the scripted clock and repository name.
        builds: sourceModel.builds.map((build) => ({
          ...build,
          ...(spec.nativeSessions && build.slug === spec.detail?.slug
            ? { sessions: nativeSessionCapture() }
            : {}),
          ...(build.pipelineSource
            ? { pipelineSource: { ...build.pipelineSource, commit: 'capture-source' } }
            : {}),
        })),
        ...(spec.standby !== undefined ? { standby: spec.standby } : {}),
        ...(spec.availableUpgrade !== undefined ? { availableUpgrade: spec.availableUpgrade } : {}),
        ...(spec.forgeReadiness
          ? {}
          : spec.scenario === 'happy'
            ? warningLines.length > 0
              ? { warningLines }
              : { warningLines: undefined }
            : spec.detail === undefined &&
                spec.transcript === undefined &&
                spec.session === undefined
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
        ...(spec.session !== undefined
          ? {
              view: {
                kind: 'session' as const,
                slug: spec.session.slug,
                sessionId: spec.session.sessionId,
                stream: spec.session.stream,
                status: spec.session.status,
                ...(spec.session.outcome !== undefined ? { outcome: spec.session.outcome } : {}),
                source: { kind: 'parts' as const, parts: [...spec.session.parts], lastSeq: 1 },
                follow: spec.session.follow ?? true,
                scroll: 0,
              },
            }
          : {}),
        ...(spec.resume !== undefined ? { resumeInput: spec.resume } : {}),
      }
      const lines = renderDashboard(presented, {
        ...options,
        now: RENDER_NOW,
      })
      capturedModel = presented
      captured = [...lines]
      return lines
    },
  })

  harness.forge.readiness = priorReadiness
  harness.store.claimRepoLease = originalClaimRepoLease
  if (happyHarness) {
    harness.store.heartbeatRepo = originalHeartbeatRepo
    harness.store.claimRepoLease = originalClaimRepoLease
    await harness.store.claimRepoLease(harness.origin, 'sentinel-happy-harvest', HAPPY_LEASE_TTL_MS)
  }

  if (stderr.length > 0) {
    throw new Error(`dashboard capture ${spec.id}: nested dispatch reported ${stderr.join('; ')}`)
  }
  if (capturedModel === undefined)
    throw new Error(
      `dashboard capture ${spec.id}: model was not projected: ${terminal.writes.join(' ')}`,
    )
  return { lines: validateCapturedFrame(spec, captured), model: capturedModel }
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
  const capacityHarness = await prepareIntegrationScenario(true, true)
  await prepareBorrowedCapacity(capacityHarness)
  const integrationHarness = await prepareIntegrationScenario(
    options.consentQueueFixtures !== false,
  )
  let happy: HappyScenario
  try {
    happy = await prepareHappyScenario()
  } catch (error) {
    await capacityHarness.cleanup()
    await integrationHarness.cleanup()
    await mixedHarness.cleanup()
    throw error
  }

  try {
    const frames: CapturedDashboardFrame[] = []
    for (const frameSpec of FRAME_SPECS) {
      const spec =
        frameSpec.scenario === 'integration' && options.consentQueueFixtures === false
          ? {
              ...frameSpec,
              selection: undefined,
              rows: 44,
              requires: ['integration', 'collect', 'children unknown', 'NODE-3'],
            }
          : frameSpec
      const harness =
        spec.scenario === 'happy'
          ? happy.harness
          : spec.scenario === 'capacity'
            ? capacityHarness
            : spec.scenario === 'integration'
              ? integrationHarness
              : mixedHarness
      if (spec.id === 'integration-wide') {
        await harness.store.append('integration-unknown', {
          actor: DISPATCHER,
          type: 'build.janitor-attempt-failed',
          payload: {
            firstFailureAt: '2026-07-15T11:45:00.000Z',
            attempt: 8,
            message: 'forge publication unavailable',
            nextAttemptAt: '2027-01-01T00:00:00.000Z',
          },
        })
        await harness.store.append('integration-unknown', {
          actor: DISPATCHER,
          type: 'build.janitor-failing',
          payload: { message: 'forge publication unavailable' },
        })
      }
      if (spec.id === 'integration-narrow')
        await harness.store.append('integration-unknown', {
          actor: DISPATCHER,
          type: 'build.janitor-recovered',
          payload: {},
        })
      const { lines, model } = await capturePaint(harness, spec)
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
        model,
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
        '- [ ] `headline-happy-wide.png` shows intake and harvest enabled, with selected landing controls.',
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
        '      bounded blocker preview with an explicit omitted-line count,',
        '      optional-guidance note, a two-line field with a visible caret,',
        '      and its key bindings. The underlying scrolled detail shows the',
        '      complete blocker through its unique final line.',
        '- [ ] The session-live frame shows the read-only live view mid-turn:',
        '      session header, labelled prompt, ~-marked reasoning, the tool call',
        '      still waiting for output, and the following-tail legend.',
        '- [ ] The session-closed frame shows the closed view: the withheld-row',
        '      count, the truncation marker, the error line, and the',
        '      Stream closed: completed outcome line.',
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
    const harvestJournal = async (): Promise<string> =>
      JSON.stringify(
        (await happy.harness.store.getRepoEvents(happy.harness.origin)).filter((event) =>
          event.type.startsWith('harvest.'),
        ),
      )
    // The dispatcher's own run boundaries and tick facts now journal
    // unconditionally (even without a kernelRunId), so purity is asserted over
    // the Harvest journal — the facts painting must never mutate.
    const repoJournalUnchanged = (await harvestJournal()) === happy.repoJournalBefore
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
    await Promise.all([
      capacityHarness.cleanup(),
      integrationHarness.cleanup(),
      mixedHarness.cleanup(),
      happy.harness.cleanup(),
    ])
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
