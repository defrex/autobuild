import { fullDocumentScreenshot } from './full-document'
import { verifyStagesCapture } from '../../../tools/verify-stages-capture'
import { ACCESS_SCENARIOS, accessFixture } from './access-fixtures'
import { rollbackCapture, ROLLBACK_AT } from '../../../tools/rollback-capture'
import { handoffCapture } from '../../../tools/handoff-capture'
import { harvestSuspensionCapture } from '../../../tools/harvest-suspension-capture'
import { ConnectionView } from '../../hosted-store-service/app/connect/Connection'
import ConnectionPage from '../../hosted-store-service/app/connect/page'
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
 * visual half is judged by the `verify-ui-app` skill from the PNGs.
 *
 * The app tree lives in `packages/hosted-store-service/app` (AUT-409). This
 * tooling lives in its own workspace package
 * (`@defrex/autobuild-web-dashboard-capture`) whose manifest declares the react
 * dependencies it imports, so it resolves under Bun's isolated linker without
 * root pins; the terminal capture tool (`tools/dashboard-capture.ts`, which
 * imports no react) remains at the repository root.
 */
import { FONT_FILES } from '../../hosted-store-service/app/fonts'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DashboardModel } from '@defrex/autobuild/operator-presentation'
import { autoMergeConsentReason } from '../../core/src/cli/dashboard/model'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  BuildsView,
  BuildPageView,
  type BuildPageViewProps,
  type BuildsViewProps,
  DispatcherControls,
  type Selection,
} from '../../hosted-store-service/app/dashboard/BuildsView'
import { LoadingControls } from '../../hosted-store-service/app/dashboard/frame'
import { OperatorShell } from '../../hosted-store-service/app/dashboard/Shell'
import {
  type Ticket,
  TicketListView,
  TicketPageView,
  ticketMoves,
  ViewTabs,
} from '../../hosted-store-service/app/dashboard/tickets'
import type { ViewTab } from '../../hosted-store-service/app/dashboard/project-selection'
import { SignIn } from '../../hosted-store-service/app/sign-in/SignIn'
import { Consent } from '../../hosted-store-service/app/oauth/consent/Consent'
import ConsentPage from '../../hosted-store-service/app/oauth/consent/page'
import { captureDashboardFrames, RENDER_NOW } from '../../../tools/dashboard-capture'

const REPO_ROOT = resolve(import.meta.dir, '../../..')
const FIXTURE_REPO = 'example/repository'
const ALTERNATE_FIXTURE_REPO = 'example/alternate'
const LONG_FIXTURE_REPO = 'example/operator-dashboard-capture-fixture-repository'
const FIXTURE_IDENTITY = 'operator@example.com'
/** RENDER_NOW as the header shows it; fixed so the clock never depends on the host zone. */
/** Consent-page fixtures: a registered client and its id, plus the authorization
 * code and scopes the consent flow carries. The capture stubs `lookupClientName`,
 * so no database is needed to render either consent path. */
const FIXTURE_CLIENT_ID = 'mcp-capture-console'
const FIXTURE_CLIENT_NAME = 'Capture MCP Console'
const FIXTURE_CONSENT_CODE = 'capture-consent-code'
const FIXTURE_SCOPE = 'openid profile email'

export interface WebFrameSpec {
  id: string
  ground?: 'light' | 'dark'
  width: number
  height: number
  /** Text the rendered frame must contain; a miss fails the capture. */
  requires: readonly string[]
  /** Text the rendered frame must not contain. */
  forbids?: readonly string[]
  /** Force the fine-hover reveal that headless Chromium CLI cannot emulate. */
  emulateFineHover?: boolean
  /** Force the keyboard focus ring that static markup cannot establish. */
  emulateKeyboardFocus?: boolean
  /** Render all controls in their request-pending state. */
  controlPending?: boolean
  /** Render the answer register in its disabled request-pending state. */
  answerPending?: boolean
}

/** The frames the verifier inspects, at the two viewports the design targets. */
const SCENARIOS: readonly WebFrameSpec[] = [
  ...ACCESS_SCENARIOS.flatMap((name) =>
    ['wide', 'narrow'].map((size) => ({
      id: `access-${name}-${size}`,
      width: size === 'wide' ? 1440 : 390,
      height: 1600,
      requires: [
        name.startsWith('members')
          ? 'Members'
          : name.startsWith('orgs')
            ? 'Organizations'
            : name.startsWith('projects')
              ? 'Projects'
              : 'Connect project',
        ...(name.startsWith('connect-')
          ? [
              '123456789A',
              'https://github.com/acme/mobile',
              'Approve project',
              'Deny',
              name === 'connect-zero'
                ? 'No organization is available'
                : name === 'connect-multiple'
                  ? 'Northwind Labs'
                  : 'Acme Product',
            ]
          : []),
      ],
      forbids: [
        'connected by',
        'Oct 22',
        ...(name.startsWith('connect-') ? ['Review project'] : []),
      ],
    })),
  ),
  ...['wide', 'narrow'].map((size) => ({
    id: `integration-consent-pending-${size}`,
    width: size === 'wide' ? 1440 : 390,
    height: 4400,
    requires: ['Merge awaits consent', 'Merge', 'Hold'],
  })),
  ...['wide', 'narrow'].flatMap((size) => [
    {
      id: `builds-menu-${size}`,
      width: size === 'wide' ? 1440 : 390,
      height: 2200,
      requires: ['Theme', 'System', 'Light', 'Dark', 'Sign out'],
    },
    {
      id: `builds-titles-${size}`,
      width: size === 'wide' ? 1440 : 390,
      height: 2200,
      requires: ['Let designers preview the pricing page before it ships'],
    },
  ]),
  ...['wide', 'narrow'].map((size) => ({
    id: `builds-verify-stages-${size}`,
    width: size === 'wide' ? 1440 : 390,
    height: 2400,
    requires: [
      'concurrent-verification',
      'verify:unit',
      'verify:integration',
      'not run: cancelled by verify:unit',
    ],
  })),
  ...['wide', 'narrow'].map((size) => ({
    id: `builds-rollback-${size}`,
    width: size === 'narrow' ? 390 : 1440,
    height: 2200,
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
  ...['wide', 'narrow'].map((size) => ({
    id: `builds-handoff-${size}`,
    width: size === 'narrow' ? 390 : 1440,
    height: 2200,
    requires: ['handoff 1.0.0', '1.1.0', 'mode drain;', 'drain deadline', '(draining)', 'RUNNING'],
  })),
  {
    id: 'capacity-wide',
    width: 1440,
    height: 1600,
    requires: ['active 5/5', '4 configured', 'descendant-held slots', 'queue-conflict'],
  },
  {
    id: 'capacity-narrow',
    width: 390,
    height: 3200,
    requires: ['active 5/5', '4 configured', 'descendant-held slots', 'queue-conflict'],
  },
  {
    id: 'builds-forge-readiness-wide',
    width: 1440,
    height: 1400,
    requires: ['Forge squash', 'Forge rebase', 'Allow squash merging', 'Allow rebase merging'],
  },
  {
    id: 'builds-forge-readiness-narrow',
    width: 390,
    height: 1800,
    requires: ['Forge squash', 'Forge rebase', 'Allow squash merging', 'Allow rebase merging'],
  },
  ...(['wide', 'narrow'] as const).map((size) => ({
    id: `integration-detail-${size}`,
    width: size === 'wide' ? 1440 : 390,
    height: 2600,
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
    ],
  })),
  ...(['conflict', 'failed', 'ready-node'] as const).map((state) => ({
    id: `integration-detail-${state}`,
    width: 1440,
    height: 3000,
    requires: [
      'Verification',
      'Merge',
      ...(state === 'conflict'
        ? ['src/a file.ts']
        : state === 'failed'
          ? ['repair child']
          : ['press l, or ab merge']),
    ],
  })),
  {
    id: 'integration-wide',
    width: 1440,
    height: 2300,
    requires: [
      'integration into',
      'merged',
      'building',
      'queued',
      'children unknown',
      'unit failed',
      'ready to merge into',
      'NODE-3',
    ],
  },
  {
    id: 'integration-narrow',
    width: 390,
    height: 4400,
    requires: ['integration into', 'unit failed', 'ready to merge into', 'merge(consent)'],
  },

  {
    id: 'builds-post-reconcile-policy-wide',
    width: 1440,
    height: 2200,
    requires: ['skipped by post-reconcile policy'],
  },
  {
    id: 'builds-post-reconcile-policy-narrow',
    width: 390,
    height: 2400,
    requires: ['skipped by post-reconcile policy'],
  },
  ...['wide', 'narrow'].flatMap((size) =>
    ['code', 'checking', 'approval', 'error', 'approved', 'denied', 'expired'].map((state) => ({
      id: `connect-${state}-${size}`,
      width: size === 'wide' ? 1440 : 390,
      height: 900,
      requires: [
        'Autobuild operator',
        'Connect project',
        ...(state === 'checking'
          ? ['Checking connection code']
          : state === 'approval'
            ? ['https://github.com/example/project', 'Approve project', 'Deny']
            : state === 'code'
              ? ['Connection code', 'Review project']
              : state === 'error'
                ? ['Unknown connection code']
                : [`Connection ${state}`]),
      ],
      forbids: state === 'checking' || state === 'approval' ? ['Review project'] : [],
    })),
  ),
  {
    id: 'builds-loading-wide',
    width: 1440,
    height: 1000,
    requires: ['Loading builds'],
    forbids: ['polling', 'RUNNING', 'BLOCKED', 'MERGED'],
  },
  {
    id: 'builds-loading-narrow',
    width: 390,
    height: 1700,
    requires: ['Loading builds'],
    forbids: ['polling', 'RUNNING', 'BLOCKED', 'MERGED'],
  },
  {
    id: 'builds-happy-wide',
    width: 1440,
    height: 1000,
    requires: ['AUT-131', 'PR merged', 'Harvest', '[x]', 'merge(waiting)', 'intake'],
    forbids: ['BLOCKED', 'PAUSED', '(held)', 'FAILED'],
  },
  {
    id: 'builds-happy-narrow',
    width: 390,
    height: 1700,
    requires: ['AUT-131', 'Harvest', '[x]', 'intake'],
    forbids: ['BLOCKED', 'PAUSED', '(held)'],
  },
  {
    id: 'builds-empty-wide',
    width: 1440,
    height: 1000,
    requires: ['intake', 'harvest', 'no active builds'],
    forbids: ['repository RUNNING'],
  },
  {
    id: 'builds-empty-narrow',
    width: 390,
    height: 1000,
    requires: ['intake', 'harvest', 'no active builds'],
    forbids: ['repository RUNNING'],
  },
  {
    id: 'builds-harvest-suspended-wide',
    width: 1440,
    height: 1000,
    requires: ['Harvest', 'SUSPENDED'],
    forbids: ['RESUME'],
  },
  {
    id: 'builds-harvest-suspended-narrow',
    width: 390,
    height: 1700,
    requires: ['Harvest', 'SUSPENDED'],
    forbids: ['RESUME'],
  },
  {
    id: 'builds-harvest-wide',
    width: 1440,
    height: 1000,
    requires: ['Harvest', 'RESUME', 'harvest'],
  },
  {
    id: 'builds-harvest-narrow',
    width: 390,
    height: 1700,
    requires: ['Harvest', 'RESUME', 'harvest'],
  },
  {
    id: 'builds-multirepo-wide',
    width: 1440,
    height: 1000,
    requires: [`Projects github.com/${FIXTURE_REPO} ${ALTERNATE_FIXTURE_REPO}`],
    forbids: ['https://'],
  },
  {
    id: 'builds-mixed-rest-wide',
    width: 1440,
    height: 1200,
    requires: ['BLOCKED', 'repository PAUSED', '(held)'],
    forbids: ['AUTO MERGE', 'DETAILS', 'CLOSE'],
  },
  {
    id: 'builds-mixed-hover-wide',
    width: 1440,
    height: 1200,
    emulateFineHover: true,
    requires: ['BLOCKED', 'repository PAUSED', '(held)'],
    forbids: ['ABORT', 'RESUME', 'AUTO MERGE', 'DETAILS', 'CLOSE'],
  },
  {
    id: 'builds-mixed-focus-wide',
    width: 1440,
    height: 1200,
    emulateKeyboardFocus: true,
    requires: ['BLOCKED'],
    forbids: ['ABORT', 'RESUME', 'AUTO MERGE', 'DETAILS', 'CLOSE'],
  },
  {
    id: 'builds-mixed-paused-wide',
    width: 1440,
    height: 1200,
    requires: ['PAUSED', 'ABORT', 'RESUME'],
    forbids: ['AUTO MERGE', 'DETAILS', 'CLOSE'],
  },
  {
    id: 'builds-auto-merge-on-wide',
    width: 1440,
    height: 1200,
    requires: ['ABORT', 'RESUME'],
    forbids: ['AUTO MERGE', 'DETAILS', 'CLOSE'],
  },
  {
    id: 'builds-parked-no-consent-wide',
    width: 1440,
    height: 1300,
    requires: ['merge(waiting)', 'Merge awaits consent', 'ab merge complete-dashboard-evidence'],
    forbids: [
      'BLOCKED',
      'QUEUED',
      '(held)',
      'merge not ready',
      'merge policy pending',
      'use l on the build row',
    ],
  },
  {
    id: 'builds-mixed-selected-narrow',
    width: 390,
    height: 1700,
    requires: ['BLOCKED', 'ABORT', 'RESUME'],
    forbids: ['AUTO MERGE', 'DETAILS', 'CLOSE'],
  },
  {
    id: 'builds-mixed-detail-wide',
    width: 1440,
    height: 2000,
    requires: [
      'BLOCKED',
      'repository PAUSED',
      'The build stopped to ask a person.',
      'Pipeline',
      'Answer escalation',
      'Ticket',
      'Acceptance criteria',
      'ABORT',
      'RESUME',
    ],
    forbids: ['Sessions', '← builds'],
  },
  {
    id: 'builds-mixed-detail-narrow',
    width: 390,
    height: 2600,
    requires: ['BLOCKED', 'The build stopped to ask a person.', 'Answer escalation', 'ABORT'],
  },
  {
    id: 'builds-mixed-answer-wide',
    width: 1440,
    height: 2000,
    requires: [
      'BLOCKED',
      'optional guidance (empty retries)',
      'SUBMIT',
      'CANCEL',
      'The build stopped to ask a person.',
    ],
  },
  {
    id: 'builds-mixed-answer-narrow',
    width: 390,
    height: 1700,
    requires: ['BLOCKED', 'optional guidance (empty retries)', 'SUBMIT', 'CANCEL'],
  },
  {
    id: 'builds-mixed-abort-wide',
    width: 1440,
    height: 1200,
    requires: ['The live session stops', 'Abort build', 'Cancel'],
  },
  ...['wide', 'narrow'].flatMap((size) => [
    {
      id: `tickets-triage-${size}`,
      width: size === 'wide' ? 1440 : 390,
      height: 1400,
      requires: ['Triage', 'Retry budget for verify steps', 'depends on', 'blocked by', 'proposal'],
    },
    {
      id: `tickets-empty-${size}`,
      width: size === 'wide' ? 1440 : 390,
      height: 900,
      requires: ['Nothing ready.'],
    },
    {
      id: `ticket-page-${size}`,
      width: size === 'wide' ? 1440 : 390,
      height: 1600,
      requires: ['ENQUEUE', 'ICE', 'Acceptance criteria', 'TRIAGE'],
      forbids: ['DEQUEUE'],
    },
  ]),
  {
    id: 'builds-longrepo-narrow',
    width: 390,
    height: 900,
    requires: ['BLOCKED', LONG_FIXTURE_REPO],
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
    requires: ['Access was refused', 'Continue with GitHub'],
    forbids: ['REFUSED'],
  },
  {
    id: 'consent-named-wide',
    width: 1440,
    height: 900,
    requires: [
      'Autobuild operator',
      'Authorize client',
      FIXTURE_CLIENT_NAME,
      'registered as',
      FIXTURE_CLIENT_ID,
      FIXTURE_SCOPE,
    ],
    forbids: ['missing its authorization code'],
  },
  {
    id: 'consent-unnamed-narrow',
    width: 390,
    height: 900,
    requires: [
      'Autobuild operator',
      'Authorize client',
      'A client registered as',
      FIXTURE_CLIENT_ID,
    ],
    forbids: [FIXTURE_CLIENT_NAME, 'missing its authorization code'],
  },
  {
    id: 'consent-missing-code-wide',
    width: 1440,
    height: 900,
    requires: [
      'Autobuild operator',
      'Authorize client',
      'This consent request is missing its authorization code',
    ],
    forbids: ['Requested scopes'],
  },
  {
    id: 'consent-route-narrow',
    width: 390,
    height: 900,
    requires: [
      'Autobuild operator',
      'Authorize client',
      'A client requests operator access',
      FIXTURE_SCOPE,
    ],
    forbids: ['missing its authorization code', FIXTURE_CLIENT_NAME, FIXTURE_CLIENT_ID],
  },
]

export interface WebFixtureModels {
  forgeReadiness?: DashboardModel
  /** The `headline-happy-wide` scenario: five running builds, a merged PR, a running harvest. */
  happy: DashboardModel
  /** The `mixed-wide` scenario: blocked, pausing, queued-and-held builds under a repository pause. */
  integrationNarrow?: DashboardModel
  integration: DashboardModel
  capacity?: DashboardModel
  mixed: DashboardModel
}

export const WEB_FRAME_SPECS: readonly WebFrameSpec[] = SCENARIOS.flatMap((spec) =>
  (['light', 'dark'] as const).map((ground) => ({ ...spec, ground })),
)
export const frameName = (spec: WebFrameSpec) => `${spec.id}-${spec.ground ?? 'light'}`

export interface RenderAssets {
  /** The contents of the app's globals.css. */
  css: string
  /** `@font-face` rules that bind `--font-mono` for the capture. */
  fontCss: string
}

const noop = () => {}

function shell(
  children: ReactNode,
  opts: {
    model?: DashboardModel
    repo?: string
    repositories?: readonly string[]
    error?: string
    menuOpen?: boolean
    projectMenuOpen?: boolean
    tab?: ViewTab
  } = {},
) {
  const repo = opts.repo ?? FIXTURE_REPO
  return (
    <OperatorShell
      repo={repo}
      repositories={opts.repositories ?? [repo]}
      identity={FIXTURE_IDENTITY}
      error={opts.error}
      menuOpen={opts.menuOpen}
      projectMenuOpen={opts.projectMenuOpen}
      onRepo={noop}
      onSignOut={noop}
      tabs={
        <ViewTabs
          repo={repo}
          current={opts.tab ?? 'active'}
          page
          counts={{
            triage: opts.model ? FIXTURE_TICKETS.length : undefined,
            queue: opts.model ? 0 : undefined,
            active: opts.model
              ? `${opts.model.active.current}/${opts.model.active.limit}`
              : undefined,
          }}
        />
      }
      controls={
        opts.model ? (
          <DispatcherControls model={opts.model} onSetting={noop} onHarvest={noop} onBulk={noop} />
        ) : repo ? (
          <LoadingControls />
        ) : null
      }
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
      onActivate={noop}
      onHoverPreview={noop}
      onOpenBuild={noop}
      onRowBuildControl={noop}
      onRowHarvest={noop}
      {...extra}
    />
  )
}

const FIXTURE_LIFECYCLE = { triage: 'triage', ready: 'ready', done: 'done' }

function fixtureTicket(
  id: string,
  title: string,
  body: string,
  extra: Partial<Ticket> = {},
): Ticket {
  return {
    ref: { source: 'database', id, title },
    revision: '1',
    kind: 'work',
    title,
    body,
    state: 'triage',
    resolved: false,
    labels: [],
    ...extra,
  }
}

/** A ticket body with the structure real specs carry: prose, headings, lists, code. */
const FIXTURE_TICKET = fixtureTicket(
  'CAP-PLAN',
  'Plan blocked dashboard',
  [
    '# Plan blocked dashboard',
    '',
    'Exercise a build that stops in plan and asks a person for an answer, so the dashboard shows the question where it is answered.',
    '',
    '## Acceptance criteria',
    '',
    '- The row shows the red question under the build title.',
    '- The build page shows the full question and the `answer` form.',
    '',
    '```ts',
    "await ab.escalate('Which behavior should this build use?')",
    '```',
  ].join('\n'),
)
const FIXTURE_TICKETS: Ticket[] = [
  fixtureTicket(
    'CAP-12',
    'Retry budget for verify steps',
    'Verify steps retry forever on infrastructure errors. Give them a budget and escalate when it runs out.',
    { labels: ['autobuild:proposal'], blockedBy: ['CAP-9'] },
  ),
  fixtureTicket(
    'CAP-11',
    'Document webhook retry behaviour',
    'Users ask what happens when a webhook delivery fails. Write it down in the forge docs.',
    { blockedBy: ['CAP-10'], blockersResolved: false },
  ),
  FIXTURE_TICKET,
]

function ticketList(tab: 'triage' | 'queue', tickets: Ticket[]) {
  return (
    <TicketListView
      repo={FIXTURE_REPO}
      tab={tab}
      page={{ tickets, total: tickets.length, requested: 25, loadMore: noop }}
      onOpenTicket={noop}
    />
  )
}

/** A build's own page, as the operator reaches it from its row. */
function buildPage(model: DashboardModel, slug: string, extra: Partial<BuildPageViewProps> = {}) {
  return (
    <BuildPageView
      repo={FIXTURE_REPO}
      slug={slug}
      model={model}
      now={RENDER_NOW}
      confirmingAbort={false}
      answerPending={false}
      onRowBuildControl={noop}
      onRowRequestAbort={noop}
      onCancelAbort={noop}
      onAnswerStepInput={noop}
      onSubmitAnswerStep={noop}
      onCancelAnswerStep={noop}
      onAnswer={noop}
      ticket={{ detail: { ticket: FIXTURE_TICKET, blockers: [], build: null } }}
      {...extra}
    />
  )
}

/** The first build parked on a human in the mixed scenario. */
function blockedSlug(model: DashboardModel): string {
  const blocked = model.builds.find((build) => build.blockers.length > 0)
  if (!blocked) throw new Error('web dashboard capture: the mixed model has no blocked build')
  return blocked.slug
}

/** A mixed-model build other than the blocked one, previewed under the pointer. */
function hoverSelection(model: DashboardModel, blocked: string): Selection {
  const candidate = model.builds.find((build) => build.slug !== blocked)
  if (!candidate) throw new Error('web dashboard capture: the mixed model has no hover candidate')
  return { kind: 'build', slug: candidate.slug }
}

function emptyModel(model: DashboardModel): DashboardModel {
  return {
    ...model,
    queued: 0,
    active: { ...model.active, current: 0 },
    builds: [],
    harvest: undefined,
  }
}

function actionableHarvestModel(model: DashboardModel): DashboardModel {
  if (!model.harvest) throw new Error('web dashboard capture: the happy model has no Harvest run')
  return {
    ...model,
    harvest: {
      ...model.harvest,
      status: model.harvest.action ? model.harvest.status : 'failed',
      action: model.harvest.action ?? 'resume',
      detail: 'Harvest run stopped and is ready to resume.',
    },
  }
}

function changedBuildModel(
  model: DashboardModel,
  slug: string,
  changes: Partial<DashboardModel['builds'][number]>,
): DashboardModel {
  return {
    ...model,
    builds: model.builds.map((build) => (build.slug === slug ? { ...build, ...changes } : build)),
  }
}

/** A ready landing with a recorded consent policy. Row and detail share
 * both policy provenance and the explanation of the required operator action. */
function parkedNoConsentModel(source: DashboardModel): DashboardModel {
  const origin = source.builds[0]
  if (origin === undefined) {
    throw new Error('web dashboard capture: the mixed model has no build to park')
  }
  return {
    ...source,
    repositoryPaused: false,
    harvestPaused: false,
    harvest: undefined,
    defaultAutoMerge: true,
    builds: [
      {
        ...origin,
        status: 'running',
        alsoPaused: false,
        dispatch: undefined,
        sessions: undefined,
        blockers: [],
        autoMerge: 'off',
        landing: {
          decision: {
            seq: 1,
            candidate: { head: 'capture-head', parent: 'capture-base', cycle: '1' },
            from: 'leaf',
            into: { kind: 'root' },
            labels: [],
            mode: 'consent',
            rule: { index: 0, snapshot: { mode: 'consent' } },
          },
        },
        pr: { url: 'https://forge.example/pr/3', state: 'open' },
        steps: [
          { label: 'plan', state: 'done', timing: { accumulatedMs: 61_000 } },
          { label: 'implement', state: 'done', count: 1, timing: { accumulatedMs: 232_000 } },
          { label: 'code-review', state: 'done', timing: { accumulatedMs: 45_000 } },
          { label: 'verify:test', state: 'done', timing: { accumulatedMs: 88_000 } },
          {
            label: 'merge',
            state: 'current',
            qualifier: 'waiting',
            reason: autoMergeConsentReason(origin.slug),
          },
        ],
      },
    ],
  }
}

async function frameNode(spec: WebFrameSpec, models: WebFixtureModels): Promise<ReactNode> {
  const access = accessFixture(spec.id)
  if (access) return access
  if (spec.id.startsWith('integration-consent-pending-'))
    return shell(builds(models.integration, { pending: 'capture:landing' }), {
      model: models.integration,
    })
  if (spec.id.startsWith('integration-detail-')) {
    const state = spec.id.slice('integration-detail-'.length)
    const slug = state === 'wide' || state === 'narrow' ? 'integration-with-pr' : `queue-${state}`
    return shell(buildPage(models.integration, slug), { model: models.integration })
  }
  if (spec.id.startsWith('builds-verify-stages-')) {
    const model = verifyStagesCapture(models.happy)
    return shell(builds(model), { model })
  }
  if (spec.id.startsWith('builds-rollback-')) {
    const model = rollbackCapture(models.happy)
    return shell(builds(model), { model })
  }
  if (spec.id.startsWith('builds-handoff-')) {
    const model = handoffCapture(models.happy)
    return shell(builds(model), { model })
  }
  switch (spec.id) {
    case 'builds-menu-wide':
    case 'builds-menu-narrow':
      return shell(builds(models.happy), { model: models.happy, menuOpen: true })
    case 'builds-titles-wide':
    case 'builds-titles-narrow': {
      const model = {
        ...models.happy,
        builds: models.happy.builds.map((row, index) => ({
          ...row,
          collectionIdentity: {
            repo: FIXTURE_REPO,
            ...row.collectionIdentity,
            status: row.collectionIdentity?.status ?? 'running',
            title:
              index === 0 ? 'Let designers preview the pricing page before it ships' : undefined,
          },
        })),
      }
      return shell(builds(model), { model })
    }
    case 'builds-forge-readiness-wide':
    case 'builds-forge-readiness-narrow': {
      const model = models.forgeReadiness ?? models.mixed
      return shell(builds(model), { model })
    }
    case 'capacity-wide':
    case 'capacity-narrow': {
      const capacity = models.capacity ?? models.integration
      return shell(builds(capacity), { model: capacity })
    }
    case 'integration-narrow': {
      const model = models.integrationNarrow ?? models.integration
      return shell(builds(model), { model })
    }
    case 'integration-wide':
      return shell(builds(models.integration), { model: models.integration })
    case 'builds-loading-wide':
    case 'builds-loading-narrow':
      return shell(builds())
    case 'builds-happy-wide':
    case 'builds-happy-narrow':
      return shell(builds(models.happy), { model: models.happy })
    case 'builds-empty-wide':
    case 'builds-empty-narrow': {
      const model = emptyModel(models.happy)
      return shell(builds(model), { model })
    }
    case 'builds-harvest-suspended-wide':
    case 'builds-harvest-suspended-narrow': {
      const model = { ...models.happy, harvest: harvestSuspensionCapture() }
      return shell(builds(model), { model })
    }
    case 'builds-harvest-wide':
    case 'builds-harvest-narrow': {
      const model = actionableHarvestModel(models.happy)
      return shell(builds(model, { selection: { kind: 'harvest' } }), { model })
    }
    case 'builds-multirepo-wide':
      return shell(builds(models.happy), {
        model: models.happy,
        repo: `https://github.com/${FIXTURE_REPO}`,
        repositories: [`https://github.com/${FIXTURE_REPO}`, ALTERNATE_FIXTURE_REPO],
        projectMenuOpen: true,
      })
    case 'builds-mixed-rest-wide':
      return shell(builds(models.mixed), { model: models.mixed })
    case 'builds-mixed-focus-wide':
      return shell(
        builds(models.mixed, { pending: spec.controlPending ? 'capture:pending' : undefined }),
        { model: models.mixed },
      )
    case 'builds-mixed-selected-narrow':
      return shell(
        buildPage(models.mixed, blockedSlug(models.mixed), {
          pending: spec.controlPending ? 'capture:pending' : undefined,
        }),
        { model: models.mixed },
      )
    case 'builds-mixed-hover-wide':
      return shell(
        builds(models.mixed, {
          hoverPreview: hoverSelection(models.mixed, blockedSlug(models.mixed)),
        }),
        { model: models.mixed },
      )
    case 'builds-mixed-paused-wide': {
      const slug = blockedSlug(models.mixed)
      const model = changedBuildModel(models.mixed, slug, { status: 'paused' })
      return shell(buildPage(model, slug), { model })
    }
    case 'builds-auto-merge-on-wide': {
      const slug = blockedSlug(models.mixed)
      const model = changedBuildModel(models.mixed, slug, { autoMerge: 'enabled' })
      return shell(buildPage(model, slug), { model })
    }
    case 'builds-parked-no-consent-wide': {
      const model = parkedNoConsentModel(models.mixed)
      const parked = model.builds[0]
      if (parked === undefined) throw new Error('parked model has no build')
      return shell(buildPage(model, parked.slug), { model })
    }
    case 'builds-post-reconcile-policy-wide':
    case 'builds-post-reconcile-policy-narrow':
      return shell(buildPage(models.mixed, 'complete-dashboard-evidence'), {
        model: models.mixed,
      })
    case 'builds-mixed-detail-wide':
    case 'builds-mixed-detail-narrow':
      return shell(buildPage(models.mixed, blockedSlug(models.mixed)), { model: models.mixed })
    case 'tickets-triage-wide':
    case 'tickets-triage-narrow':
      return shell(ticketList('triage', FIXTURE_TICKETS), { model: models.mixed, tab: 'triage' })
    case 'tickets-empty-wide':
    case 'tickets-empty-narrow':
      return shell(ticketList('queue', []), { model: models.mixed, tab: 'queue' })
    case 'ticket-page-wide':
    case 'ticket-page-narrow':
      return shell(
        <TicketPageView
          repo={FIXTURE_REPO}
          id={FIXTURE_TICKET.ref.id}
          detail={{ ticket: FIXTURE_TICKET, blockers: [], build: null }}
          moves={ticketMoves('triage', FIXTURE_LIFECYCLE, { triage: 2, ready: 0, icebox: 0 })}
        />,
        { model: models.mixed, tab: 'triage' },
      )
    case 'builds-mixed-answer-wide':
    case 'builds-mixed-answer-narrow': {
      const slug = blockedSlug(models.mixed)
      return shell(
        buildPage(models.mixed, slug, {
          pending: spec.answerPending ? `${slug}:answer` : undefined,
          answerPending: spec.answerPending ?? false,
          answerStep: { slug, escalationIds: ['esc-capture'], input: '' },
        }),
        { model: models.mixed },
      )
    }
    case 'builds-mixed-abort-wide': {
      // The confirmation frame is the blocked build's page after leaving its answer step.
      const slug = blockedSlug(models.mixed)
      return shell(buildPage(models.mixed, slug, { confirmingAbort: true }), {
        model: models.mixed,
      })
    }
    case 'builds-longrepo-narrow':
      return shell(builds(models.mixed), { model: models.mixed, repo: LONG_FIXTURE_REPO })
    case 'connect-checking-wide':
    case 'connect-checking-narrow':
      return await ConnectionPage({ searchParams: Promise.resolve({ code: '123456789a' }) })
    case 'connect-code-wide':
    case 'connect-code-narrow':
      return await ConnectionPage({ searchParams: Promise.resolve({}) })
    case 'connect-approval-wide':
    case 'connect-approval-narrow':
    case 'connect-error-wide':
    case 'connect-error-narrow':
    case 'connect-approved-wide':
    case 'connect-approved-narrow':
    case 'connect-denied-wide':
    case 'connect-denied-narrow':
    case 'connect-expired-wide':
    case 'connect-expired-narrow': {
      const state = spec.id.split('-')[1]!
      return (
        <ConnectionView
          code="123456789A"
          context={{
            assignment: 'fixed',
            organizations: [],
            assignedOrganization: { id: 'example', name: 'Example organization' },
          }}
          error={
            state === 'error' ? 'Unknown connection code. Check the code in your CLI.' : undefined
          }
          connection={
            state === 'error'
              ? undefined
              : {
                  repo: 'https://github.com/example/project',
                  credentialId: 'a'.repeat(32),
                  code: '123456789A',
                  status:
                    state === 'approval' ? 'pending' : (state as 'approved' | 'denied' | 'expired'),
                }
          }
        />
      )
    }
    case 'signin-wide':
      return <SignIn providers={['github']} />
    case 'signin-error-narrow':
      return <SignIn providers={['github']} error="access_denied" />
    case 'consent-named-wide':
    case 'consent-unnamed-narrow':
      // The view is an async component: the awaited element must be produced
      // here, mirroring Consent.test.tsx. The stubbed lookup selects the
      // named-client path (wide) and the client_id fallback path (narrow).
      // These frames render the Consent component rather than the route
      // module's page because only the component carries the lookupClientName
      // seam the stub needs (AUT-402).
      return await Consent({
        query:
          spec.id === 'consent-named-wide'
            ? {
                consent_code: FIXTURE_CONSENT_CODE,
                client_id: FIXTURE_CLIENT_ID,
                scope: FIXTURE_SCOPE,
              }
            : { consent_code: FIXTURE_CONSENT_CODE, client_id: FIXTURE_CLIENT_ID },
        lookupClientName: () =>
          Promise.resolve(spec.id === 'consent-named-wide' ? FIXTURE_CLIENT_NAME : null),
      })
    case 'consent-missing-code-wide':
    case 'consent-route-narrow': {
      const query =
        spec.id === 'consent-missing-code-wide'
          ? {}
          : { consent_code: FIXTURE_CONSENT_CODE, scope: FIXTURE_SCOPE }
      // Both frames go through the real route page wrapper. Neither query
      // carries client_id, so the registered-name lookup never fires and no
      // database is needed (the seam lives on Consent, not the page — AUT-402).
      const element = await ConsentPage({ searchParams: Promise.resolve(query) })
      // Awaiting the wrapper yields the Consent element; renderToStaticMarkup
      // cannot take it (React 19 throws on suspended sync renders — the reason
      // Consent.test.tsx streams), so resolve the component to its static tree.
      return await Consent({ query: element.props.query })
    }
    default:
      throw new Error(`web dashboard capture: unknown frame "${spec.id}"`)
  }
}

/** Capture-only state emulation for capabilities unavailable through Chromium's CLI. */
export function captureStateCss(spec: WebFrameSpec): string {
  return [
    spec.emulateFineHover ? '.row[data-hovered] .rowhead { color: var(--live); }' : '',
    spec.emulateKeyboardFocus
      ? '.rows > .row:nth-child(1 of :not(.harvest)) .rowhead { outline: 2px solid var(--live); outline-offset: 1px; }'
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** One complete fixture page: the rendered view inside the real stylesheet. */
export async function renderWebFrame(
  spec: WebFrameSpec,
  models: WebFixtureModels,
  assets: RenderAssets,
): Promise<string> {
  const markup = renderToStaticMarkup(await frameNode(spec, models))
  return [
    '<!doctype html>',
    `<html lang="en" data-theme="${spec.ground ?? 'light'}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${spec.id}</title>`,
    `<style>${assets.fontCss}</style>`,
    `<style>${assets.css}</style>`,
    `<style data-capture-state>${captureStateCss(spec)}</style>`,
    '</head>',
    `<body>${markup}<script>document.fonts.ready.then(() => document.documentElement.dataset.fontsReady = "true")</script></body>`,
    '</html>',
  ].join('\n')
}

/** The visible text of a rendered frame, entities decoded, whitespace collapsed. */
export function evidenceText(html: string): string {
  return html
    .replace(/<span class="note">([^<]*)<\/span>/g, '$1')
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
  if (spec.id.startsWith('builds-') && text.includes('repository RUNNING')) {
    throw new Error(`web dashboard capture ${spec.id}: frame contains repository RUNNING`)
  }
  if (spec.id.startsWith('builds-') && html.includes('class="fastext"')) {
    throw new Error(`web dashboard capture ${spec.id}: signed-in frame contains a footer toolbar`)
  }
  if (spec.id.startsWith('builds-')) {
    for (const retired of ['PAUSE ALL', 'RESUME ALL', 'DESELECT']) {
      if (text.includes(retired)) {
        throw new Error(
          `web dashboard capture ${spec.id}: frame contains retired label "${retired}"`,
        )
      }
    }
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

/** Bind the packaged Atkinson Hyperlegible Next and JetBrains Mono files offline. */
export function fontFaceCss(repoRoot = REPO_ROOT): string {
  return `${Object.entries(FONT_FILES)
    .map(
      ([role, file]) =>
        `@font-face { font-family: 'ANSI ${role}'; font-weight: ${role === 'sans' ? '100 900' : '100 800'}; src: url('${pathToFileURL(join(repoRoot, 'packages/hosted-store-service/app/fonts', file)).href}'); }`,
    )
    .join('\n')}\n:root { --font-mono: 'ANSI mono'; --font-sans: 'ANSI sans'; }`
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

/** Retry transient browser failures once, with a fresh isolated profile. */
const SCREENSHOT_ATTEMPTS = 2

async function screenshot(
  chromium: string,
  htmlPath: string,
  pngPath: string,
  spec: WebFrameSpec,
  profileDir: string,
): Promise<{ width: number; height: number }> {
  let failure: Error | undefined
  for (let attempt = 1; attempt <= SCREENSHOT_ATTEMPTS; attempt += 1) {
    try {
      return await fullDocumentScreenshot(
        chromium,
        pathToFileURL(htmlPath).href,
        pngPath,
        spec.width,
        spec.height,
        `${profileDir}-${attempt}`,
      )
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error))
      await rm(pngPath, { force: true })
    }
  }
  throw new Error(
    `web dashboard capture ${spec.id}: ${failure?.message ?? 'no screenshot attempt ran'}`,
  )
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
  ground?: 'light' | 'dark'
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
    const capture = await captureDashboardFrames({
      workspacePath: workspace,
      consentQueueFixtures: true,
    })
    return {
      forgeReadiness: frameModel(capture, 'forge-readiness-wide'),
      happy: frameModel(capture, 'headline-happy-wide'),
      mixed: frameModel(capture, 'mixed-wide'),
      integration: frameModel(capture, 'integration-wide'),
      integrationNarrow: frameModel(capture, 'integration-narrow'),
      capacity: frameModel(capture, 'capacity-wide'),
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

export function report(frames: WebDashboardFrame[], chromium: string, outputDir: string): string {
  const lines = [
    '# Web dashboard visual verification',
    '',
    `Generated by \`bun run capture:web-dashboard\` with Chromium at \`${chromium}\`.`,
    "Frames render the operator web app's pure views (OperatorShell, BuildsView, SignIn, the OAuth consent page)",
    'over the scripted dispatch models from',
    '`tools/dashboard-capture.ts` (`headline-happy-wide` and `mixed-wide`), the real',
    '`packages/hosted-store-service/app/globals.css`, and the packaged Atkinson Hyperlegible Next and JetBrains Mono files bound through FONT_FILES.',
    'Captures include the full document, which may exceed the initial viewport. Nothing here is a golden image:',
    'judge whether each frame is coherent and obeys the rules recorded in DESIGN.md.',
    '',
    'The wide rest/hover pair uses one model so row coordinates can be compared.',
    'Fine-pointer hover and keyboard focus are modeled explicitly in dedicated wide frames; capture-only CSS emulates capabilities that static Chromium markup cannot establish.',
    'The state-change flash and keyboard shortcuts are code-reviewed; narrow frames carry no hover preview.',
    '',
    '## Frames',
    '',
    ...frames.map(
      (frame) =>
        `- \`${relative(outputDir, frame.pngPath)}\` (${frame.ground}, ${frame.width}×${frame.height}), source \`${relative(outputDir, frame.htmlPath)}\``,
    ),
    '',
    '## Visual criteria',
    '',
    '- [ ] Every PNG opens, is non-empty, and shows its named ANSI ground. On short states, empty ground below the last row is the natural end of the document.',
    '- [ ] Compare every light/dark variant to ANSI and the applicable pinned reference. Both grounds use the packaged Atkinson Hyperlegible Next and JetBrains Mono fonts.',
    '- [ ] Title-first rows retain ticket, slug, status, all facts and steps. Current teal, done green, provisional amber, pending slack; timing is quiet.',
    '- [ ] Escalations show the complete red question, explanation, one answer composer, and full-bleed phone treatment with full-width primary answer.',
    '- [ ] Merge consent is amber on ground with Merge/Hold. No optimistic success or unconfirmed abort.',
    '- [ ] The tab line leads with Triage, Queue, Active and Done and marks the current tab; abort confirms in the square confirmation dialog with a red primary and ghost Cancel.',
    '- [ ] Masthead, outlined account menu and Theme choices, ruled rows, centered reading pages match ANSI. No shadow, gradient, pills or interface emoji.',
    '- [ ] Browser-owned flow, wrapping identifiers, pending/disabled states, keyboard focus and loading without invented values remain clear at both widths.',
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
    css: await readFile(
      join(REPO_ROOT, 'packages', 'hosted-store-service', 'app', 'globals.css'),
      'utf8',
    ),
    fontCss: fontFaceCss(),
  }
  await rm(outputDir, { recursive: true, force: true })
  await mkdir(outputDir, { recursive: true })
  const userDataDir = await mkdtemp(join(tmpdir(), 'ab-web-capture-chromium-'))
  try {
    const frames: WebDashboardFrame[] = []
    for (const spec of WEB_FRAME_SPECS) {
      const html = await renderWebFrame(spec, models, assets)
      checkEvidence(spec, html)
      const htmlPath = join(outputDir, `${frameName(spec)}.html`)
      const pngPath = join(outputDir, `${frameName(spec)}.png`)
      await writeFile(htmlPath, html)
      // Isolate each frame and retry from stale browser state.
      const dimensions = await screenshot(
        chromium,
        htmlPath,
        pngPath,
        spec,
        join(userDataDir, frameName(spec)),
      )
      frames.push({
        id: frameName(spec),
        ground: spec.ground,
        ...dimensions,
        htmlPath,
        pngPath,
      })
    }
    await writeFile(join(outputDir, 'frames.json'), JSON.stringify(frames, null, 2))
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
