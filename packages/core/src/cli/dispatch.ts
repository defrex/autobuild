/**
 * `ab dispatch` — the operator's entry into the outer loop (SPEC §3.3, §12).
 * Runs OUTSIDE build sessions like init/upgrade/ticket (§16.3): it takes a
 * repo, not a build, loads its autobuild.toml, wires the real ports, and runs
 * the dispatcher's `tick()` — janitor → startup resume → lease sweep →
 * dispatch — either once (`--once`) or on a watch loop until interrupted.
 * Startup resume runs once per invocation and attempts every current build;
 * later watch ticks preserve deliberate policy parks.
 *
 * It is the SAME `ab` binary agents use (§8): install is `ab` + `ab init`, and
 * everyone — agents and operators — attaches to this one surface. The heavy
 * adapters are constructed here behind an injectable `wire` seam, exactly as
 * `ab ticket create` constructs its TicketSource via a factory, so the whole
 * loop is testable over fakes.
 *
 * Concurrency is config, not code (§16.1): top-level `capacity` caps the
 * concurrent builds for this repo. `launchRunner` starts each build-runner
 * IN-PROCESS but does not block the dispatcher on it (fire-and-forget,
 * tracked) — so with capacity N up to N builds run at once, while the
 * dispatcher's own active-count gate (§12) keeps it from over-launching. A
 * runner drives its build to a park point (§11) and returns; the watch loop's
 * next tick advances the post-PR epilogue (§15.7).
 */
import { hostname } from 'node:os'
import { mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import semver from 'semver'
import { parseConfig } from '../config/load'
import { DISPATCHER_CONFIG_ARTIFACT, LiveConfig, type ConfigSnapshot } from '../config/live'
import { effectiveRuntimeReferences, roleKeyWarnings, SLUG_ROLE } from '../config/roles'
import type { Config } from '../config/schema'
import { loadPlugins } from '../plugins/load'
import type { PluginRegistry } from '../plugins/registry'
import { materializePluginRuntimes } from '../plugins/runtimes'
import { DISPATCHER, humanActor } from '../events/envelope'
import type { RepositoryEventWrite } from '../events/repository'
import { randomIds, randomUuids, type IdSource, type UuidSource } from '../ids'
import { reduceDispatchSettings } from '../kernel/dispatch-settings'
import { DEFAULT_MAX_HARVEST_RECOVERY_ATTEMPTS, reduceHarvest } from '../kernel/harvest'
import { reduceBuild } from '../kernel/reducer'
import { dashboardBuildControl } from './dashboard/actions'
import {
  buildDashboardFromProjected,
  projectHarvest,
  type DashboardBuild,
  type DashboardModel,
  type DashboardSelection,
  type DashboardView,
} from './dashboard/model'
import { DashboardBuildPollCache } from './dashboard/poll'
import {
  dashboardContentWidth,
  detailScrollLimit,
  moveDetailScroll,
  moveTranscriptScroll,
  renderDashboard,
  revealDetailFocus,
  type DashboardRendererResolver,
} from './dashboard/render'
import { parseTranscript } from './dashboard/transcript'
import { deleteBefore, insertText, moveCursor, type ComposerMotion } from './dashboard/composer'
import { dashboardSelections, moveSelection, reconcileSelection } from './dashboard/selection'
import { LiveRegion, paintableRows } from './dashboard/live'
import { createKeyboardProtocol, type KeyboardProtocol } from './keyboard'
import { recordInfrastructureFailure as appendInfrastructureFailure } from '../processes/infrastructure-failure-budget'
import { settlePendingPublication as settleWorkspacePublication } from './publication-settlement'
import type { TerminalInput, TerminalInputEvent, TerminalOut } from './terminal'
import { createForge, resolveForgeRegistration } from '../ports/forge/create'
import { GitHubApiError, type GitHubRequest } from '../ports/forge/github-transport'
import { GitHubForge } from '../ports/forge/github'
import { createProductionRuntimes } from '../ports/runner/production'
import type { RuntimeRegistry } from '../ports/runner/runtime'
import { createTicketSource } from '../ports/tickets/create'
import type { Forge, TicketSource, WorkspaceProvider } from '../ports/types'
import { createWorkspaceRuntime, type WorkspaceRuntime } from '../ports/workspace/create'
import { GitWorktreeProvider } from '../ports/workspace/git-worktree'
import { LocalBuildExecution } from '../ports/workspace/local-build-execution'
import {
  BUILD_EXECUTION_LEASE_TTL_MS,
  type BuildExecution,
  type BuildExecutionHandle,
} from '../ports/workspace/build-execution'
import type { Exec } from '../ports/workspace/git-worktree'
import { validateVercelGithubOrigin } from '../ports/workspace/vercel-sandbox'
import {
  BUILD_EFFECTIVE_CONFIG_ARTIFACT,
  BUILD_RUNNER_DIAGNOSTIC_ARTIFACT,
  effectiveBuildConfigContent,
  parseDiagnostic,
} from '../processes/build-execution-state'
import { HarvestRunner, type HarvestRunnerResult } from '../processes/harvest-runner'
import { scanUnclaimedObservations } from '../processes/harvest'
import {
  controlHarvestRun as applyHarvestRunControl,
  toggleHarvestGate as applyHarvestGateToggle,
  toggleRepositorySetting,
} from '../operator/control'
import {
  Dispatcher,
  emptyTickReport,
  type LaunchRunnerResult,
  type TickReport,
} from '../processes/dispatcher'
import {
  BuildControlError,
  buildControlUser,
  controlBuild,
  type BuildControlResult,
} from './build-control'
import { bulkControlReport, bulkControlRepository, type BulkDirection } from './bulk-control'
import {
  normalizeGitRemoteUrl,
  resolveRepoState,
  resolveRepoStatePaths,
  type RepoStatePaths,
} from './repo-state'
import { openStoreForRepoState } from './store-opening'
import { DispatchFrontend } from './dispatch-frontend'
import { systemClock, type BuildStore, type Clock } from '../store/types'
import { availableRelease } from './self-update'
import {
  startUpgradeNotice,
  type AvailableReleaseProbe,
  type UpgradeNoticeScheduler,
} from './upgrade-notice'

/** Watch-loop default cadence between ticks (§3.3 re-run safety makes this a
 * pure knob — a shorter interval only polls the forge more often). */
const DEFAULT_INTERVAL_MS = 10_000
/** Repository supervisor lease (§12 serialization): TTL and heartbeat cadence.
 * The heartbeat renews at a third of the TTL, so one lost beat still leaves a
 * full interval of margin before a peer can take over. */
const REPO_LEASE_TTL_MS = 60_000
const REPO_LEASE_HEARTBEAT_MS = 20_000
/** Repository artifact containing the schema-validated composed Config used by
 * one dispatch run. It is the frontend's only config source. */
export const DISPATCHER_EFFECTIVE_CONFIG_ARTIFACT = 'dispatcher-effective-config'

/** JSON encoding in the config schema's declarative input shape. Parsed Config
 * has normalized `{steps, stepConfigs}` sections; flattening named step tables
 * lets the frontend validate the artifact with the same strict configSchema. */
function effectiveConfigContent(config: Config): string {
  const { verify, finalize, ...root } = config
  return JSON.stringify({
    ...root,
    verify: { steps: verify.steps, ...verify.stepConfigs },
    finalize: { steps: finalize.steps, ...finalize.stepConfigs },
  })
}

/** The pre-build naming prompt. Its output is only a proposal: dispatcher.ts
 * owns strict validation, timeout/failure fallback, and store-wide uniqueness. */
export function slugNamingPrompt(spec: string): string {
  return [
    'Choose a short identifier for this software build.',
    'Return exactly one lowercase ASCII kebab-case identifier containing one to three meaningful words.',
    'Choose distinguishing subject/action words from the substance of the entire spec, not generic title lead-ins such as add, update, or please.',
    'Return no quotes, Markdown, explanation, or numeric collision suffix; collision handling is done separately.',
    '',
    '<build-spec>',
    spec,
    '</build-spec>',
  ].join('\n')
}

function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
  const defined: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) defined[key] = value
  }
  return defined
}

/** Dashboard store-read cadence. `listBuilds` remains the discovery read;
 * the process-local display cache then polls dashboard-visible streams with
 * `getEvents(lastSeq)`, retaining abort cleanup until final completion and reusing unchanged
 * reductions/timing projections. Repository controls and Harvest are still
 * read fresh. The identical-frame check in `live.ts` makes an unchanged paint
 * cost zero terminal writes. */
const DASHBOARD_POLL_MS = 500

/** Dashboard repaint (not re-read) cadence in watch mode. A running step's
 * elapsed must advance ~1×/s even if the store poll is raised for a slow remote
 * store, so paint is decoupled from the store read and driven from this cheaper
 * timer. A knob: the identical-frame check in `live.ts` collapses a repaint to
 * zero writes until a displayed second actually changes, so a sub-second cadence
 * costs nothing. `--once` runs no tick timer — it renders one snapshot per
 * state (AC 8). */
const DASHBOARD_TICK_MS = 250

type DashboardAction =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'enter'
  | 'auto-merge'
  | 'intake'
  | 'pause'
  | 'resume'
  | 'bulk-pause'
  | 'bulk-resume'
  | 'discard'
  | 'abort-confirm'
  | 'harvest-gate'
  | { kind: 'harvest-run'; run: string | undefined }

interface ResumePrompt {
  slug: string
  /** Snapshot at prompt-open time. Submission revalidates each id. */
  escalationIds: string[]
  value: string
  /** Caret as a UTF-16 grapheme-boundary offset into `value`. */
  cursor: number
}

/** The real adapters the loop drives — resolved by `wire` (default: the
 * production ports; tests inject fakes). */
export interface DispatchWiring {
  store: BuildStore
  tickets: TicketSource
  forge: Forge
  workspaces: WorkspaceProvider
  /** Provider and executor pairs for workspaces recorded before a
   * `[workspace].provider` switch. A build is reaped, released, and executed
   * only through the runtime named on its provisioned fact. */
  retiredWorkspaces?: readonly WorkspaceRuntime[]
  /** Workspace-adjacent build executor. Production always supplies the local
   * subprocess implementation; tests may inject an in-process double. */
  buildExecution: BuildExecution
  /** Runtime registry (§9): name → adapter + compatibility data. The resolver
   * applies `[roles]`, whose `default` entry is required. */
  runtimes: RuntimeRegistry
  /** The store reference sessions resolve as `AB_STORE` (D8) — MUST name the
   * same store as `store`, so an agent's `ab` commands write where the
   * dispatcher reads. */
  storeRef: string
  /** Scoped token for a remote store (D8, `AB_TOKEN`); passed to sessions. */
  token?: string
  ids: IdSource
  uuids: UuidSource
  clock: Clock
  /** Validated startup catalog used by selected plugin adapters. Runtime
   * factories are materialized into `runtimes` before role resolution. */
  plugins?: PluginRegistry
  /** Keeps workspace-owned runtime preflights aligned with accepted hot role reloads. */
  updateRuntimeReferences?: (config: Config) => void
}

export type DispatchNonStoreWiring = Omit<DispatchWiring, 'store' | 'storeRef' | 'token'>

export interface DispatchOpts {
  /** Repo the dispatcher serves (§12: one dispatcher per repo) — the cwd, or
   * in origin mode a private scratch root. Filesystem consumers only. */
  targetRepo: string
  /** Checkout-less origin mode (AUT-302): serve the repository at this origin
   * with no local checkout. CLI `--repository <origin>`, env `AB_REPOSITORY`.
   * Requires an HTTPS AB_STORE + AB_TOKEN, GitHub credentials, and the
   * builtin github forge (from the fetched config). */
  repository?: string
  /** Resolved repository identity — the normalized origin, or the checkout
   * path when the checkout has no origin. Derived from repo state by
   * `abDispatch`; an explicitly supplied value WINS, letting an embedding
   * that already resolved the identity (and keyed its store by it) pin the
   * dispatcher to the same key. Every Store-keyed key and record write uses
   * it. */
  repo?: string
  /** Test seam for origin mode: the GitHub transport the startup config
   * fetch (and the default forge) use instead of real fetch. */
  originConfigTransport?: GitHubRequest
  /** Process environment: adapter secrets (LINEAR_API_KEY) and AB_TOKEN. */
  env: Record<string, string | undefined>
  exec: Exec
  stdout: (line: string) => void
  stderr: (line: string) => void
  /** Single pass then drain in-flight runners and exit; default is a loop. */
  once?: boolean
  /** Watch-loop cadence in ms (§3.3); default DEFAULT_INTERVAL_MS. */
  intervalMs?: number
  /** Explicit durable repository intake override. Omission reuses stored state,
   * falling back to true only when the repository has no setting fact. */
  intake?: boolean
  /** Explicit durable repository claim-time auto-merge override. Omission
   * reuses stored state, falling back to false on a fresh repository. */
  defaultAutoMerge?: boolean
  /** Explicit `--store` override; otherwise AB_STORE, then repo-local state. */
  storeRef?: string
  /** Watch-loop stop signal — the binary aborts it on SIGINT (§15.6-C: an
   * interrupted runner's lease expires and a future dispatch re-attaches). */
  signal?: AbortSignal
  /** Injectable for tests — defaults to the production adapters. */
  wire?: (
    config: Config,
    opts: DispatchOpts,
    state: RepoStatePaths,
    plugins: PluginRegistry,
  ) => Promise<DispatchWiring> | DispatchWiring
  /** Integration seam that substitutes only non-store ports. Store identity,
   * reference, and token always come from production environment selection. */
  nonStoreWire?: (
    config: Config,
    opts: DispatchOpts,
    state: RepoStatePaths,
    plugins: PluginRegistry,
  ) => Promise<DispatchNonStoreWiring> | DispatchNonStoreWiring
  /** Injectable sleep (watch loop); default a real timer. Tests use `once`. */
  sleep?: (ms: number) => Promise<void>
  /** Force line-oriented output with no terminal control sequences (`--plain`),
   * whatever the terminal says. */
  plain?: boolean
  /**
   * The interactive output seam. ABSENT ⇒ non-interactive ⇒ plain — which is
   * exactly today's behavior, so the dashboard can never be the reason a
   * scripted or piped `ab dispatch` starts emitting escapes. The shared binary
   * wiring constructs the real one over `process.stdout`.
   */
  terminal?: TerminalOut
  /** Injectable normalized keyboard/text source; the binary wraps stdin. */
  input?: TerminalInput
  /** Optional repo-dev presentation seam. The resolver is called for every
   * paint; production omits it and remains bound to `renderDashboard`. */
  resolveDashboardRenderer?: DashboardRendererResolver
  /** Private child-kernel correlation. Presence suppresses terminal ownership
   * and enables durable dispatcher status publication. */
  kernelRunId?: string
  /** Private child mode: preserve kernel behavior while routing no legacy
   * line output into the terminal-owning parent. */
  silent?: boolean
  /** Interactive-watch-only release courtesy seams. The supervised kernel
   * publishes results durably; direct plain/noninteractive and one-pass
   * dispatch never consult them. */
  availableReleaseProbe?: AvailableReleaseProbe
  upgradeNoticeScheduler?: UpgradeNoticeScheduler
}

/** setTimeout that also resolves the moment ANY stop signal aborts, so OS
 * SIGINT and raw-mode Ctrl-C share the same watch-loop boundary. */
function interruptibleSleep(
  ms: number,
  signals: readonly (AbortSignal | undefined)[],
): Promise<void> {
  return new Promise<void>((resolveSleep) => {
    const live = signals.filter((signal): signal is AbortSignal => signal !== undefined)
    if (live.some((signal) => signal.aborted)) return resolveSleep()
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      for (const signal of live) signal.removeEventListener('abort', finish)
      resolveSleep()
    }
    const timer = setTimeout(finish, ms)
    for (const signal of live) signal.addEventListener('abort', finish, { once: true })
  })
}

/** Production wiring: the local (or remote) store, configured adapters,
 * git worktrees, and shipped runtimes. Forge construction deliberately happens
 * before store opening so a plugin factory failure cannot precede a claim. */
async function defaultWire(
  config: Config,
  opts: DispatchOpts,
  state: RepoStatePaths,
  plugins: PluginRegistry,
): Promise<DispatchWiring> {
  // Origin mode: no checkout exists, so the provider's host git seams are
  // replaced by the injected origin and the forge's remote reads.
  const originMode = opts.repository !== undefined
  if (config.workspace.provider === 'vercel-sandbox') {
    if (config.forge !== 'github') {
      throw new Error('vercel-sandbox requires the builtin github forge')
    }
    if (!originMode) {
      const origin = await opts.exec(['git', 'remote', 'get-url', 'origin'], {
        cwd: opts.targetRepo,
      })
      if (origin.exitCode !== 0) throw new Error('vercel-sandbox requires a readable Git origin')
      validateVercelGithubOrigin(origin.stdout.trim())
    }
    if (!opts.env.GITHUB_TOKEN && !opts.env.GH_TOKEN) {
      throw new Error(
        'vercel-sandbox publication requires GITHUB_TOKEN or GH_TOKEN in the dispatcher environment',
      )
    }
  }
  const forge = await createForge({
    name: config.forge,
    registry: plugins,
    env: opts.env,
    repoRoot: state.checkout,
    ...(opts.repository !== undefined ? { repository: opts.repository } : {}),
  })
  // Checkout-less provider seams: the sandbox provider derives its origin and
  // remote branch heads from these instead of host `git` — every host-exec
  // call site in the provider is bypassed in origin mode.
  const providerSeams = originMode
    ? {
        origin: async (): Promise<string> => opts.repository!,
        remoteBranchHead: async (branch: string): Promise<string | undefined> => {
          const remoteBranchSha = forge.remoteBranchSha
          if (remoteBranchSha === undefined) return undefined
          try {
            return await remoteBranchSha.call(forge, branch)
          } catch (error) {
            if (error instanceof GitHubApiError && error.status === 404) return undefined
            throw error
          }
        },
      }
    : {}
  const opened = openStoreForRepoState(state, { env: opts.env })

  const tickets = await createTicketSource(
    config.tickets,
    opts.env,
    state.repo,
    opened.localStateRoot,
    plugins,
  )
  const { runtimes } = createProductionRuntimes()
  let runtimeReferences = effectiveRuntimeReferences(config)
  // A local override relocates the whole tree. Remote stores still need local
  // scratch beneath the repository default. Plugin factories receive only
  // their explicit config plus repository/environment context.
  const workspaceRuntime = await createWorkspaceRuntime(config.workspace, {
    registry: plugins,
    worktreeRoot: opened.worktreeRoot,
    // Plugin factories always get the filesystem checkout (the physical path
    // or the origin-mode scratch root) — never the store identity.
    repoRoot: state.checkout,
    env: opts.env,
    storeRef: opened.storeRef,
    runtimeReferences: () => runtimeReferences,
    ...providerSeams,
    ...(opened.token !== undefined ? { storeToken: opened.token } : {}),
  })

  // Builds provisioned before this repository switched providers still hold
  // local worktrees; the builtin can release them when they finish.
  const retiredWorkspaces: WorkspaceRuntime[] =
    config.workspace.provider === 'git-worktree'
      ? []
      : [
          {
            provider: new GitWorktreeProvider({ root: resolve(opened.worktreeRoot) }),
            execution: new LocalBuildExecution({ env: opts.env }),
          },
        ]

  return {
    store: opened.store,
    tickets,
    forge,
    workspaces: workspaceRuntime.provider,
    retiredWorkspaces,
    buildExecution: workspaceRuntime.execution,
    // Shipped registrations are shared with other non-phase judgment paths.
    // Model ids stay in config; production.ts owns adapter compatibility data.
    runtimes,
    storeRef: opened.storeRef,
    ...(opened.token !== undefined ? { token: opened.token } : {}),
    ids: randomIds(),
    uuids: randomUuids(),
    clock: systemClock,
    plugins,
    updateRuntimeReferences: (effectiveConfig) => {
      runtimeReferences = effectiveRuntimeReferences(effectiveConfig)
    },
  }
}

interface ActiveBuildExecution {
  reservation: symbol
  instance: string
  handle?: BuildExecutionHandle
  settled?: Promise<void>
  stopping: boolean
  /** Set at teardown of an environment-supervised execution: the guest keeps
   * running, so the completion chain must append no `execution.ended`, release
   * no lease, settle no publication, and record no wait failure. */
  detaching?: boolean
}

/** The dispatch loop owns deterministic decisions and supervises one
 * workspace-adjacent process per build. Build outcomes flow only through the
 * Store; child completion is liveness evidence used for reaping/single-flight. */
class DispatchLoop {
  private readonly dispatcher: Dispatcher
  private readonly host = hostname()
  private readonly maxHarvestRecoveryAttempts = DEFAULT_MAX_HARVEST_RECOVERY_ATTEMPTS
  /** In-flight build and harvest runs (fire-and-forget) — awaited before a
   * `--once` exit so every visible workflow reaches a durable boundary.
   * Environment-supervised executions are tagged and deliberately NOT drained:
   * their guests keep running and the next invocation settles them. */
  private readonly inFlight = new Set<Promise<void>>()
  private readonly inFlightKinds = new Map<Promise<void>, 'local-parent' | 'environment'>()
  /** One active execution per slug in this kernel. Reservations are acquired
   * before awaits; the durable lease remains the cross-kernel exclusion gate. */
  private readonly activeBuildRuns = new Map<string, ActiveBuildExecution>()
  private acceptingBuildLaunches = true
  /** Process-local fast path; the repository lease is the cross-process gate. */
  private harvestInFlight: Promise<void> | undefined
  /** Outcomes settle outside Dispatcher.tick(), then merge into the next
   * report publication (or a settlement-only publication during teardown). */
  private pendingHarvest = {
    harvestStarted: 0,
    harvestResumed: 0,
    harvestCompleted: 0,
    harvestEscalated: 0,
    harvestFailed: 0,
  }
  /** Settlement-only publications carry the latest standing status instead of
   * manufacturing a zero queue measurement or losing diagnostics. */
  private lastTickStatus = {
    queued: 0,
    janitorDiagnostics: [] as string[],
    ticketDiagnostics: [] as string[],
    creationDiagnostics: [] as string[],
    dependencyDiagnostics: [] as string[],
  }
  /**
   * Interactive dashboard on. `opts.terminal?.interactive === true` — an
   * absent terminal yields `undefined === true` ⇒ false ⇒ today's exact
   * behavior, which is what keeps every existing dispatch test passing
   * untouched and makes plain the default rather than a mode.
   */
  private readonly dashboard: boolean
  private readonly keyboard: KeyboardProtocol | undefined
  private readonly region: LiveRegion | undefined
  /** One display-only incremental build cache for this dispatch process. */
  private readonly dashboardBuilds: DashboardBuildPollCache
  /** Guard against overlapping timer polls, exactly as pollingSubscribe does. */
  private rendering = false
  /** The full, warning-handled timer poll. Teardown joins this exact promise
   * before selecting the final frame. */
  private renderInFlight: Promise<void> | undefined
  /** Cleared at the rendering stop boundary so an already-queued timer callback
   * cannot open a new store read after teardown begins. */
  private acceptingRenderPolls = false
  private timer: ReturnType<typeof setInterval> | undefined
  /** Watch-mode paint timer (AC 8): repaints the CACHED model against a fresh
   * clock so running elapsed ticks between store reads. Absent in `--once`. */
  private tickTimer: ReturnType<typeof setInterval> | undefined
  /** The last projected model, repainted by `paint()` against a moving clock.
   * Read from the store by `renderOnce`; timing is now-independent so the same
   * model ticks without a re-read. */
  private model: DashboardModel | undefined
  /** Ephemeral per-process presentation controls. Dispatcher settings are
   * projected from the repository journal and never cached here. */
  private selection: DashboardSelection | undefined = { kind: 'global' }
  /** Read-only nested UI state. Omission is the top-level list. */
  private view: DashboardView | undefined
  private warningLine: string | undefined
  /** Process-local, persistent release notice. It never shares the replaceable
   * warning slot and is re-applied to every store projection. */
  private availableUpgrade: string | undefined
  private stopUpgradeNotice: (() => void) | undefined
  /** Startup, configuration-level notices — constant for the life of the
   * process. Rendered ABOVE the transient warning line and never overwritten by
   * it: `setWarning` replaces the transient slot outright, so sharing it would
   * let the first tick's janitor notice erase a startup diagnostic for good. */
  private configWarnings: readonly string[] = []
  /** Last intake-enabled tick's standing queue depth, for the dashboard header. */
  private queuedCount = 0
  /** Last successfully measured unclaimed observation count. Sampling failures
   * retain this factual value rather than inventing a zero. */
  private observationCount = 0
  /** A slug/id-bound blocked-resume field. The model receives only slug/value;
   * captured escalation ids stay controller-private. */
  private resumePrompt: ResumePrompt | undefined
  private resumeSubmitting = false
  /** First `a` captures identity only; Enter performs the shared control. */
  private abortConfirmation: { slug: string } | undefined
  /** One queue defines order between ticks and mutating keys. */
  private operationTail: Promise<void> = Promise.resolve()
  private acceptingKeys = false
  private cleanupInput: (() => void) | undefined
  /** Raw Ctrl-C does not raise SIGINT; this wakes the same watch loop. */
  private readonly inputStop = new AbortController()
  /** Repository supervisor lease (§12 serialization): this invocation's holder
   * id while it holds the repo lease, else undefined. A losing invocation
   * records `dispatcher.tick-yielded` and performs no claims, launches, or
   * publications. */
  private repoLeaseHolder: string | undefined
  private repoLeaseHeartbeat: ReturnType<typeof setInterval> | undefined
  /** Set when the store reports this supervisor's repo lease was taken over:
   * stop accepting launches, detach/reap, signal continuations, and exit watch
   * mode cleanly. */
  private superseded = false
  /** Public teardown fact for the durable `dispatcher.run-stopped` reason. */
  get supersededByPeer(): boolean {
    return this.superseded
  }
  /** The holder id this invocation already recorded a `tick-yielded` for. */
  private yieldedTo: string | undefined
  /** Repository identity (§12): the normalized origin, or the checkout path
   * when there is no origin. Every Store-keyed key uses this; filesystem
   * consumers keep using `opts.targetRepo` (the checkout or scratch root). */
  private get repoIdentity(): string {
    return this.opts.repo ?? this.opts.targetRepo
  }

  constructor(
    private readonly liveConfig: LiveConfig,
    private readonly wiring: DispatchWiring,
    private readonly opts: DispatchOpts,
  ) {
    const config = liveConfig.current().config
    this.dashboard = opts.terminal?.interactive === true && opts.plain !== true
    this.keyboard =
      this.dashboard && opts.terminal !== undefined && opts.input !== undefined
        ? createKeyboardProtocol((chunk) => opts.terminal!.write(chunk), opts.terminal.modes)
        : undefined
    this.region =
      this.dashboard && opts.terminal !== undefined
        ? new LiveRegion(opts.terminal, this.keyboard)
        : undefined
    this.dashboardBuilds = new DashboardBuildPollCache(wiring.store, this.repoIdentity, config)

    // `slug` is an internal pre-build role on the same runtime/model resolver. A
    // runtime without the optional capability is normal: omit the seam and let
    // the dispatcher take its deterministic title fallback.
    const nameSlug = async (spec: string, signal: AbortSignal): Promise<string | null> => {
      const resolvedSlug = this.liveConfig.current().resolver.resolve(SLUG_ROLE)
      const oneShot = wiring.runtimes[resolvedSlug.runtime]?.oneShot
      if (oneShot === undefined) return null
      const result = await oneShot.complete({
        prompt: slugNamingPrompt(spec),
        cwd: opts.targetRepo,
        env: definedEnv(opts.env),
        signal,
        ...(resolvedSlug.model !== undefined ? { model: resolvedSlug.model } : {}),
        args: resolvedSlug.args,
      })
      return result.text
    }

    this.dispatcher = new Dispatcher({
      store: wiring.store,
      tickets: wiring.tickets,
      workspaces: wiring.workspaces,
      ...(wiring.retiredWorkspaces === undefined
        ? {}
        : { retiredWorkspaces: wiring.retiredWorkspaces.map((runtime) => runtime.provider) }),
      forge: wiring.forge,
      config,
      getConfig: () => this.liveConfig.current().config,
      repo: this.repoIdentity,
      // Origin mode: the forge answers remote base-branch questions; no
      // checkout git is probed for the served repository's origin.
      ...(opts.repository !== undefined
        ? { repoOrigin: normalizeGitRemoteUrl(opts.repository) }
        : {}),
      checkout: opts.targetRepo,
      exec: opts.exec,
      launchRunner: (slug) => this.launchRunner(slug),
      startHarvest: () => this.launchHarvest(),
      nameSlug,
      ids: wiring.ids,
      clock: wiring.clock,
      // Durable supervision: settle publication from the log-backed guard and
      // skip foreign-execution settlement for builds this process supervises.
      settlePublication: (slug) => this.settlePendingPublication(slug),
      activeExecutions: () => new Set(this.activeBuildRuns.keys()),
      opts: {
        maxHarvestRecoveryAttempts: this.maxHarvestRecoveryAttempts,
      },
    })
  }

  private currentConfig(): ConfigSnapshot {
    return this.liveConfig.current()
  }

  /** Publish the exact composed snapshot into one build-owned namespace. The
   * child samples only this artifact and never receives config over IPC. */
  private async publishBuildConfig(slug: string, snapshot = this.currentConfig()): Promise<void> {
    await this.wiring.store.putArtifact(slug, {
      kind: BUILD_EFFECTIVE_CONFIG_ARTIFACT,
      content: effectiveBuildConfigContent(snapshot.config),
      metadata: {
        revision: snapshot.revision,
        ...(this.opts.kernelRunId !== undefined ? { run: this.opts.kernelRunId } : {}),
      },
    })
  }

  private async publishActiveBuildConfigs(snapshot: ConfigSnapshot): Promise<void> {
    await Promise.all(
      [...this.activeBuildRuns.keys()].map((slug) => this.publishBuildConfig(slug, snapshot)),
    )
  }

  private async appendStatus(event: RepositoryEventWrite): Promise<void> {
    if (this.opts.kernelRunId === undefined) return
    await this.wiring.store.appendRepo(this.repoIdentity, event)
  }

  private async refreshConfig(): Promise<void> {
    if (this.opts.once === true) return
    // Origin mode reloads from the forge: autobuild.toml at the CURRENT
    // effective base branch (hot — a rename converges within two ticks).
    // Restart-required changes keep startup-built adapters and file the
    // existing restart-required observation (LiveConfig semantics).
    const outcome =
      this.opts.repository !== undefined && typeof this.wiring.forge.readFile === 'function'
        ? await this.liveConfig.refreshFrom(async () => {
            const baseBranch = this.liveConfig.current().config.baseBranch
            return await this.wiring.forge.readFile!(
              'autobuild.toml',
              baseBranch !== undefined && baseBranch !== '' ? baseBranch : undefined,
            )
          })
        : await this.liveConfig.refreshFromDisk()
    if (outcome.kind === 'unchanged') return
    if (outcome.kind === 'rejected') {
      if (outcome.notify) {
        await this.appendStatus({
          actor: DISPATCHER,
          type: 'dispatcher.config-rejected',
          payload: { run: this.opts.kernelRunId!, error: outcome.error },
        })
        this.warn(`config reload rejected: ${outcome.error}`)
      }
      return
    }
    if (outcome.kind === 'publication-failed') {
      await this.appendStatus({
        actor: DISPATCHER,
        type: 'dispatcher.config-publication-failed',
        payload: { run: this.opts.kernelRunId!, error: outcome.error },
      })
      this.warn(`config reload not applied because its durable trace failed: ${outcome.error}`)
      return
    }

    await this.publishActiveBuildConfigs(outcome.snapshot)
    this.announce(`autobuild.toml reloaded (revision ${outcome.snapshot.revision})`)
    if (outcome.restartRequired.length > 0) {
      this.warn(
        `autobuild.toml reload requires dispatch restart for: ${outcome.restartRequired.join(', ')}`,
      )
    }
    this.reportRoleDiagnostics()
  }

  /** Append one operation after every previously observed tick/key action. */
  private serialize<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async readDispatchSettings(): Promise<ReturnType<typeof reduceDispatchSettings>> {
    const events = await this.wiring.store.getRepoEvents(this.repoIdentity)
    return reduceDispatchSettings(events)
  }

  private dispatcherTick(resumeCurrent: boolean): Promise<Awaited<ReturnType<Dispatcher['tick']>>> {
    return this.serialize(async () => {
      // Refresh before every watch decision. The owner publishes atomically;
      // everything below captures the resulting one snapshot for this tick.
      await this.refreshConfig()
      // Every tick first tries the repository supervisor lease. Without it,
      // this invocation records the yield and performs no claims, launches,
      // or publications — including no tick-completed status publication.
      if (
        !(await this.ensureRepoLease(
          this.repoLeaseHolder ??
            this.opts.kernelRunId ??
            `${this.host}-dispatch-${this.wiring.ids('inst')}`,
        ))
      ) {
        await this.recordTickYielded()
        return emptyTickReport()
      }
      await this.appendStatus({
        actor: DISPATCHER,
        type: 'dispatcher.tick-started',
        payload: { run: this.opts.kernelRunId! },
      })

      // Unclaimed observations are display-only and sampled once per interactive
      // dispatcher tick. A failed scan must neither fail dispatch nor replace
      // the last complete measurement with a fabricated zero.
      if (this.dashboard) {
        try {
          const scan = await scanUnclaimedObservations(this.wiring.store, this.repoIdentity)
          this.observationCount = scan.observations.length
        } catch {
          // Display-only sampling failures retain the last factual count and
          // retry on the next tick; they are not dashboard failures.
        }
      }

      // Sample inside the serialized tick, not at process startup. Every
      // dispatcher therefore gates claims from the latest repository facts.
      const settings = await this.readDispatchSettings()
      const readyObservation =
        settings.intake || (!this.dashboard && this.opts.kernelRunId === undefined)
          ? undefined
          : await this.dispatcher.observeReady()
      const report = await this.dispatcher.tick({
        resumeCurrent,
        acceptNewWork: settings.intake,
        defaultAutoMerge: settings.defaultAutoMerge,
        autoMergeUser: buildControlUser(this.opts.env),
      })
      const publishedReport: TickReport = {
        ...report,
        queued: readyObservation?.queued ?? report.queued,
        invalidTickets: readyObservation?.invalidTickets ?? report.invalidTickets,
        ticketDiagnostics: readyObservation?.ticketDiagnostics ?? report.ticketDiagnostics,
      }
      this.queuedCount = publishedReport.queued
      this.lastTickStatus = {
        queued: publishedReport.queued,
        janitorDiagnostics: [...publishedReport.janitorDiagnostics],
        ticketDiagnostics: [...publishedReport.ticketDiagnostics],
        creationDiagnostics: [...publishedReport.creationDiagnostics],
        dependencyDiagnostics: [...publishedReport.dependencyDiagnostics],
      }
      return (await this.publishTickReport(publishedReport))!
    })
  }

  /** Overlay process-local presentation controls and normalize the exact model
   * the renderer will receive. Detail bounds depend on modal control height, so
   * composition must precede clamping rather than measuring the durable base. */
  private syncModelControls(): void {
    if (this.model === undefined) return
    const {
      selection: _oldSelection,
      warningLines: _oldWarningLines,
      availableUpgrade: _oldAvailableUpgrade,
      resumeInput: _oldResumeInput,
      abortConfirmation: _oldAbortConfirmation,
      view: _oldView,
      ...base
    } = this.model
    // Composed at PROJECTION time, on every projection, so the sticky config
    // diagnostic reaches the first painted frame and every frame after it with
    // no dependence on emission order relative to `startRendering()`.
    const warningLines = [
      ...this.configWarnings,
      ...(this.warningLine !== undefined ? [this.warningLine] : []),
    ]
    let effective: DashboardModel = {
      ...base,
      ...(this.availableUpgrade !== undefined ? { availableUpgrade: this.availableUpgrade } : {}),
      ...(warningLines.length > 0 ? { warningLines } : {}),
      ...(this.selection !== undefined ? { selection: this.selection } : {}),
      ...(this.resumePrompt !== undefined
        ? {
            resumeInput: {
              slug: this.resumePrompt.slug,
              value: this.resumePrompt.value,
              cursor: this.resumePrompt.cursor,
            },
          }
        : {}),
      ...(this.abortConfirmation !== undefined
        ? { abortConfirmation: this.abortConfirmation }
        : {}),
      ...(this.view !== undefined ? { view: this.view } : {}),
    }
    if (this.view?.kind === 'detail') {
      const terminal = this.opts.terminal
      const normalized = {
        ...this.view,
        scroll:
          terminal === undefined
            ? 0
            : Math.max(
                0,
                Math.min(
                  this.view.scroll,
                  detailScrollLimit(
                    effective,
                    dashboardContentWidth(terminal.columns),
                    paintableRows(terminal.rows),
                  ),
                ),
              ),
      }
      this.view = normalized
      effective = { ...effective, view: normalized }
    }
    this.model = effective
  }

  private moveSelection(delta: number): void {
    if (this.view?.kind === 'transcript') {
      const terminal = this.opts.terminal
      this.view = {
        ...this.view,
        scroll:
          terminal === undefined
            ? 0
            : moveTranscriptScroll(
                this.view.transcript,
                terminal.columns,
                paintableRows(terminal.rows),
                this.view.scroll,
                delta,
                this.availableUpgrade !== undefined,
              ),
      }
      this.syncModelControls()
      this.paint()
      return
    }
    if (this.view?.kind === 'detail') {
      const terminal = this.opts.terminal
      this.view = {
        ...this.view,
        scroll:
          terminal === undefined || this.model === undefined
            ? 0
            : moveDetailScroll(
                this.model,
                dashboardContentWidth(terminal.columns),
                paintableRows(terminal.rows),
                this.view.scroll,
                delta,
              ),
      }
      this.syncModelControls()
      this.paint()
      return
    }

    // Input starts before the first asynchronous store projection. The global
    // row exists independently of that projection, so startup navigation must
    // clamp on it rather than letting the generic empty-list helper clear it.
    const rows =
      this.model === undefined ? [{ kind: 'global' } as const] : dashboardSelections(this.model)
    this.selection = moveSelection(rows, this.selection, delta)
    this.syncModelControls()
    this.paint()
  }

  private selectedBuildSlug(
    action: 'auto-merge' | 'pause' | 'resume' | 'discard',
  ): string | undefined {
    if (this.view !== undefined) return this.view.slug
    const selection = this.selection
    if (selection === undefined) {
      this.warn('dashboard action ignored: no active row is selected')
      return undefined
    }
    if (selection.kind !== 'build') {
      const subject = selection.kind === 'harvest' ? 'Harvest' : 'Dispatcher'
      this.say(
        action === 'auto-merge'
          ? `${subject} auto-merge unavailable: select a build`
          : action === 'discard'
            ? `${subject} discard unavailable: select a queued build`
            : `${subject} ${action} unavailable: select a build`,
      )
      return undefined
    }
    return selection.slug
  }

  private async ignoreControlError(surface: 'action' | 'resume', error: unknown): Promise<boolean> {
    if (!(error instanceof BuildControlError)) return false
    this.warn(`dashboard ${surface} ignored: ${error.message}`)
    await this.renderOnce()
    return true
  }

  private async toggleIntake(): Promise<void> {
    if (this.selection?.kind !== 'global') return

    const event = await toggleRepositorySetting({
      store: this.wiring.store,
      repo: this.repoIdentity,
      user: buildControlUser(this.opts.env),
      setting: 'intake',
    })
    this.say(`dispatcher intake ${event.enabled ? 'ON' : 'OFF'}`)
    await this.renderOnce()
  }

  /** Repository-wide quiescence from the always-present global row: park every
   * pausable build and stop intake, or reverse both. Unlike the per-build keys
   * this never toggles — it is an absolute request in one direction, so a build
   * already pausing keeps its single pending pause. A store failure propagates
   * to `queueAction`'s catch, which reports it on the same notice row. */
  private async bulkControl(direction: BulkDirection): Promise<void> {
    // The key routing already guards; keeping it with the action means the
    // invariant travels with the write rather than only with the keypress.
    if (this.view !== undefined || this.selection?.kind !== 'global') return

    const summary = await bulkControlRepository({
      store: this.wiring.store,
      repo: this.repoIdentity,
      env: this.opts.env,
      direction,
    })
    this.announce(bulkControlReport(summary))
    await this.renderOnce()
  }

  private selectedDashboardBuild(): DashboardBuild | undefined {
    const slug =
      this.view?.kind === 'detail'
        ? this.view.slug
        : this.view === undefined && this.selection?.kind === 'build'
          ? this.selection.slug
          : undefined
    return this.model?.builds.find((candidate) => candidate.slug === slug)
  }

  private async dashboardPause(): Promise<void> {
    const slug = this.selectedBuildSlug('pause')
    if (slug === undefined) return

    let result: BuildControlResult
    try {
      result = await controlBuild({
        store: this.wiring.store,
        repo: this.repoIdentity,
        slug,
        env: this.opts.env,
        action: { kind: 'dashboard-pause' },
      })
    } catch (error) {
      if (await this.ignoreControlError('action', error)) return
      throw error
    }

    if (result.kind !== 'command' || (result.command !== 'pause' && result.command !== 'resume')) {
      throw new Error('build-control returned an invalid dashboard pause result')
    }
    this.say(
      result.command === 'resume'
        ? `build ${slug}: pending pause cancelled`
        : `build ${slug}: pause requested`,
    )
    await this.renderOnce()
  }

  private async dashboardResume(): Promise<void> {
    const slug = this.selectedBuildSlug('resume')
    if (slug === undefined) return

    let result: BuildControlResult
    try {
      result = await controlBuild({
        store: this.wiring.store,
        repo: this.repoIdentity,
        slug,
        env: this.opts.env,
        action: { kind: 'dashboard-resume' },
      })
    } catch (error) {
      if (await this.ignoreControlError('action', error)) return
      throw error
    }

    if (result.kind === 'answer-required') {
      this.resumePrompt = {
        slug,
        escalationIds: result.escalationIds,
        value: '',
        cursor: 0,
      }
      this.syncModelControls()
      this.paint()
      return
    }
    if (result.kind !== 'command' || result.command !== 'resume') {
      throw new Error('build-control returned an invalid dashboard resume result')
    }
    this.say(`build ${slug}: resume requested`)
    await this.renderOnce()
  }

  private async abortConfirmed(): Promise<void> {
    const confirmation = this.abortConfirmation
    if (confirmation === undefined) return
    this.abortConfirmation = undefined
    this.syncModelControls()
    try {
      const result = await controlBuild({
        store: this.wiring.store,
        repo: this.repoIdentity,
        slug: confirmation.slug,
        env: this.opts.env,
        action: { kind: 'abort' },
      })
      if (result.kind !== 'command' || result.command !== 'abort') {
        throw new Error('build-control returned an invalid abort result')
      }
      this.say(`build ${confirmation.slug}: abort requested`)
      await this.renderOnce()
    } catch (error) {
      if (await this.ignoreControlError('action', error)) return
      throw error
    }
  }

  private async discardSelected(): Promise<void> {
    const slug = this.selectedBuildSlug('discard')
    if (slug === undefined) return
    try {
      const result = await controlBuild({
        store: this.wiring.store,
        repo: this.repoIdentity,
        slug,
        env: this.opts.env,
        action: { kind: 'discard' },
      })
      if (result.kind !== 'command' || result.command !== 'discard') {
        throw new Error('build-control returned an invalid discard result')
      }
      this.say(`build ${slug}: discard requested`)
      await this.renderOnce()
    } catch (error) {
      if (await this.ignoreControlError('action', error)) return
      throw error
    }
  }

  /** Toggle the durable repository gate from the always-present header. The
   * latest pending command is the effective requested target, while rendering
   * remains acknowledged-only. */
  private async toggleHarvestGate(): Promise<void> {
    if (this.selection?.kind !== 'global') {
      const subject = this.selection?.kind === 'harvest' ? 'Harvest' : 'Build'
      this.say(`${subject} harvest gate unavailable: select Dispatcher`)
      return
    }

    const result = await applyHarvestGateToggle({
      store: this.wiring.store,
      repo: this.repoIdentity,
      user: buildControlUser(this.opts.env),
    })
    this.say(`harvest gate: ${result.command} requested`)
    await this.renderOnce()
  }

  /** `p` on Harvest acts only on the concrete run captured at keypress time.
   * It never toggles the repository gate and never retargets a replacement run
   * that appeared while the action waited in the serialized queue. */
  private async controlHarvestRun(expectedRun: string | undefined): Promise<void> {
    const { store } = this.wiring
    const repo = this.repoIdentity
    await store.ensureRepo(repo)
    const events = await store.getRepoEvents(repo)
    const state = reduceHarvest(events)
    const projected = projectHarvest(events)
    if (expectedRun === undefined || projected === undefined || projected.run !== expectedRun) {
      this.say('harvest run action ignored: selected run is no longer active')
      await this.renderOnce()
      return
    }

    if (state.paused) {
      this.say('harvest run action unavailable while harvest is OFF; select Dispatcher and press h')
      await this.renderOnce()
      return
    }
    if (state.pendingCommands.some((command) => command.command === 'resume')) {
      this.say('harvest run: resume acknowledgement pending')
      await this.renderOnce()
      return
    }
    if (projected.action === undefined) {
      this.say('harvest run has no available action')
      await this.renderOnce()
      return
    }

    await applyHarvestRunControl({
      store,
      repo,
      user: buildControlUser(this.opts.env),
      run: projected.run,
    })
    const selectedRun = state.runs.find((run) => run.run === projected.run)
    this.say(
      projected.action === 'resume'
        ? 'harvest: error resume requested'
        : selectedRun?.recoveryExhaustion !== undefined
          ? 'harvest: exhausted recovery attention acknowledgement requested'
          : 'harvest: escalation acknowledgement requested',
    )
    await this.renderOnce()
  }

  private clearResumePrompt(slug: string): void {
    if (this.resumePrompt?.slug !== slug) return
    this.resumePrompt = undefined
    this.syncModelControls()
    this.paint()
  }

  /** Submit the prompt through the shared build-control service. Empty input
   * is a retry; nonempty input is authoritative guidance. */
  private async submitResume(prompt: ResumePrompt): Promise<void> {
    let result: BuildControlResult
    try {
      result = await controlBuild({
        store: this.wiring.store,
        repo: this.repoIdentity,
        slug: prompt.slug,
        env: this.opts.env,
        action: {
          kind: 'answer',
          text: prompt.value,
          escalationIds: prompt.escalationIds,
        },
      })
    } catch (error) {
      if (error instanceof BuildControlError) {
        this.clearResumePrompt(prompt.slug)
      }
      if (await this.ignoreControlError('resume', error)) return
      throw error
    }
    if (result.kind !== 'answered') {
      throw new Error('build-control returned an invalid answer result')
    }

    this.clearResumePrompt(prompt.slug)
    this.say(
      `build ${prompt.slug}: blocked resume requested${
        result.resolution === 'guidance' ? ' with guidance' : ' without feedback'
      }`,
    )
    await this.renderOnce()
  }

  private async toggleAutoMerge(): Promise<void> {
    if (this.view === undefined && this.selection?.kind === 'global') {
      const event = await toggleRepositorySetting({
        store: this.wiring.store,
        repo: this.repoIdentity,
        user: buildControlUser(this.opts.env),
        setting: 'auto-merge-default',
      })
      this.say(`dispatcher auto-merge default ${event.enabled ? 'ON' : 'OFF'}`)
      await this.renderOnce()
      return
    }
    const slug = this.selectedBuildSlug('auto-merge')
    if (slug === undefined) return

    let result: BuildControlResult
    try {
      result = await controlBuild({
        store: this.wiring.store,
        repo: this.repoIdentity,
        slug,
        env: this.opts.env,
        action: { kind: 'toggle-auto-merge' },
      })
    } catch (error) {
      if (await this.ignoreControlError('action', error)) return
      throw error
    }
    if (
      result.kind !== 'command' ||
      (result.command !== 'auto-merge-on' && result.command !== 'auto-merge-off')
    ) {
      throw new Error('build-control returned an invalid auto-merge toggle result')
    }
    this.say(
      `build ${slug}: auto-merge ${
        result.command === 'auto-merge-off' ? 'cancelled' : 'requested'
      }`,
    )
    await this.renderOnce()
  }

  private moveDetailSession(delta: number): void {
    if (this.view?.kind !== 'detail') return
    const build = this.model?.builds.find((candidate) => candidate.slug === this.view!.slug)
    const sessions = build?.sessions ?? []
    if (sessions.length === 0) return
    const current = sessions.findIndex((session) => session.id === this.view!.sessionId)
    const index = Math.max(0, Math.min(sessions.length - 1, (current < 0 ? 0 : current) + delta))
    const next = { ...this.view, sessionId: sessions[index]!.id }
    const terminal = this.opts.terminal
    const nextModel = this.model === undefined ? undefined : { ...this.model, view: next }
    this.view = {
      ...next,
      scroll:
        terminal === undefined || nextModel === undefined
          ? 0
          : revealDetailFocus(
              nextModel,
              dashboardContentWidth(terminal.columns),
              paintableRows(terminal.rows),
              'session',
              next.scroll,
            ),
    }
    this.syncModelControls()
    this.paint()
  }

  private detailMessage(
    view: Extract<DashboardView, { kind: 'detail' }>,
    message: string,
    messageWhileSessionOpen?: string,
  ): Extract<DashboardView, { kind: 'detail' }> {
    const { message: _priorMessage, messageWhileSessionOpen: _priorFence, ...stable } = view
    const next = {
      ...stable,
      message,
      ...(messageWhileSessionOpen !== undefined ? { messageWhileSessionOpen } : {}),
    }
    const terminal = this.opts.terminal
    const nextModel = this.model === undefined ? undefined : { ...this.model, view: next }
    return {
      ...next,
      scroll:
        terminal === undefined || nextModel === undefined
          ? 0
          : revealDetailFocus(
              nextModel,
              dashboardContentWidth(terminal.columns),
              paintableRows(terminal.rows),
              'message',
              next.scroll,
            ),
    }
  }

  private async openSelected(): Promise<void> {
    if (this.view === undefined) {
      if (this.selection?.kind !== 'build') return
      const selectedSlug = this.selection.slug
      const build = this.model?.builds.find((candidate) => candidate.slug === selectedSlug)
      if (build === undefined) return
      this.view = {
        kind: 'detail',
        slug: build.slug,
        scroll: 0,
        ...(build.sessions?.[0] !== undefined ? { sessionId: build.sessions[0].id } : {}),
      }
      this.syncModelControls()
      this.paint()
      return
    }
    if (this.view.kind === 'transcript') return

    const captured = this.view
    const build = this.model?.builds.find((candidate) => candidate.slug === captured.slug)
    const session = build?.sessions?.find((candidate) => candidate.id === captured.sessionId)
    if (session === undefined) {
      this.view = this.detailMessage(captured, 'No session is selected.')
      this.syncModelControls()
      this.paint()
      return
    }
    if (session.status === 'open') {
      this.view = this.detailMessage(
        captured,
        'Transcript unavailable while this session is still open.',
        session.id,
      )
      this.syncModelControls()
      this.paint()
      return
    }
    if (session.status === 'reclaimed') {
      this.view = this.detailMessage(
        captured,
        'This session was reclaimed by a recovering runner; transcript unavailable.',
      )
      this.syncModelControls()
      this.paint()
      return
    }
    if (session.transcript === undefined) {
      this.view = this.detailMessage(captured, 'This session ended without a transcript deposit.')
      this.syncModelControls()
      this.paint()
      return
    }

    const ref = session.transcript
    try {
      const artifact = await this.wiring.store.getArtifact(captured.slug, ref.kind, ref.rev)
      // Reads race polling, terminalization, and Escape. Apply only to the exact
      // detail/session that initiated the pinned read.
      if (
        this.view?.kind !== 'detail' ||
        this.view.slug !== captured.slug ||
        this.view.sessionId !== session.id
      ) {
        return
      }
      if (artifact === null) {
        this.view = this.detailMessage(
          captured,
          `Transcript ${ref.kind}@${ref.rev} is not retrievable.`,
        )
      } else {
        this.view = {
          kind: 'transcript',
          slug: captured.slug,
          sessionId: session.id,
          transcript: parseTranscript(new TextDecoder().decode(artifact.content)),
          scroll: 0,
        }
      }
    } catch (error) {
      if (
        this.view?.kind === 'detail' &&
        this.view.slug === captured.slug &&
        this.view.sessionId === session.id
      ) {
        this.view = this.detailMessage(
          captured,
          `Transcript read failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    this.syncModelControls()
    this.paint()
  }

  private leaveView(): void {
    if (this.view?.kind === 'transcript') {
      this.view = {
        kind: 'detail',
        slug: this.view.slug,
        sessionId: this.view.sessionId,
        scroll: 0,
      }
    } else if (this.view?.kind === 'detail') {
      this.view = undefined
    } else {
      return
    }
    this.syncModelControls()
    this.paint()
  }

  private async handleAction(action: DashboardAction): Promise<void> {
    if (typeof action !== 'string') {
      await this.controlHarvestRun(action.run)
      return
    }
    switch (action) {
      case 'up':
        this.moveSelection(-1)
        return
      case 'down':
        this.moveSelection(1)
        return
      case 'left':
        this.moveDetailSession(-1)
        return
      case 'right':
        this.moveDetailSession(1)
        return
      case 'enter':
        await this.openSelected()
        return
      case 'intake':
        await this.toggleIntake()
        return
      case 'pause':
        await this.dashboardPause()
        return
      case 'resume':
        await this.dashboardResume()
        return
      case 'bulk-pause':
        await this.bulkControl('pause')
        return
      case 'bulk-resume':
        await this.bulkControl('resume')
        return
      case 'auto-merge':
        await this.toggleAutoMerge()
        return
      case 'discard':
        await this.discardSelected()
        return
      case 'abort-confirm':
        await this.abortConfirmed()
        return
      case 'harvest-gate':
        await this.toggleHarvestGate()
        return
    }
  }

  private queueAction(action: DashboardAction): void {
    void this.serialize(() => this.handleAction(action)).catch((error: unknown) => {
      const name = typeof action === 'string' ? action : action.kind
      this.warn(
        `dashboard ${name} action failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
  }

  /** Modal edits are synchronous and never enter the dispatcher operation
   * queue. Only Enter serializes a store write, so polling/ticks continue while
   * an operator thinks and types. */
  private handleResumeInput(input: TerminalInputEvent): void {
    const prompt = this.resumePrompt
    if (prompt === undefined || this.resumeSubmitting) return
    const edit = (next: { value: string; cursor: number }): void => {
      this.resumePrompt = { ...prompt, ...next }
      this.syncModelControls()
      this.paint()
    }
    const move = (motion: ComposerMotion): void => {
      this.resumePrompt = { ...prompt, cursor: moveCursor(prompt.value, prompt.cursor, motion) }
      this.syncModelControls()
      this.paint()
    }
    switch (input.type) {
      // A paste is one insertion, not a burst of keystrokes: no part of it can
      // be interpreted as submit, and none of it is dropped.
      case 'text':
      case 'paste':
        edit(insertText(prompt.value, prompt.cursor, input.text))
        return
      case 'newline':
        edit(insertText(prompt.value, prompt.cursor, '\n'))
        return
      case 'backspace':
        edit(deleteBefore(prompt.value, prompt.cursor))
        return
      case 'left':
      case 'right':
      case 'up':
      case 'down':
      case 'home':
      case 'end':
        // Up/Down move the CARET while the prompt is open; the dashboard's row
        // selection deliberately does not follow.
        move(input.type)
        return
      case 'escape':
        this.clearResumePrompt(prompt.slug)
        return
      case 'enter':
        this.resumeSubmitting = true
        void this.serialize(() => this.submitResume(prompt))
          .catch((error: unknown) => {
            this.warn(
              `dashboard resume action failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            )
          })
          .finally(() => {
            this.resumeSubmitting = false
            this.syncModelControls()
            this.paint()
          })
        return
      case 'interrupt':
        return
    }
  }

  private onInput(input: TerminalInputEvent): void {
    if (!this.acceptingKeys) return
    if (input.type === 'interrupt') {
      this.acceptingKeys = false
      this.inputStop.abort()
      return
    }
    if (this.resumePrompt !== undefined) {
      this.handleResumeInput(input)
      return
    }
    // Outside the resume prompt `newline` is handled identically to `enter`.
    // That is the structural mitigation for splitting CR from LF: only the
    // composer can tell the two apart, so a terminal that reports Return as LF
    // cannot make Enter stop working anywhere else.
    const enterLike = input.type === 'enter' || input.type === 'newline'
    if (this.abortConfirmation !== undefined) {
      if (enterLike) this.queueAction('abort-confirm')
      else if (input.type === 'escape') {
        this.abortConfirmation = undefined
        this.syncModelControls()
        this.paint()
      }
      return
    }

    if (
      input.type === 'up' ||
      input.type === 'down' ||
      input.type === 'left' ||
      input.type === 'right'
    ) {
      this.queueAction(input.type)
      return
    }
    if (enterLike) {
      this.queueAction('enter')
      return
    }
    if (input.type === 'escape') {
      this.leaveView()
      return
    }
    // A stray paste outside the prompt is a no-op, not a burst of command keys;
    // directional motions were routed above.
    if (input.type !== 'text') return
    switch (input.text.toLowerCase()) {
      case 'm':
        if (this.view?.kind !== 'transcript') this.queueAction('auto-merge')
        return
      case 'i':
        if (this.view === undefined && this.selection?.kind === 'global') this.queueAction('intake')
        return
      case 'p':
        if (this.view === undefined && this.selection?.kind === 'global') {
          this.queueAction('bulk-pause')
          return
        }
        if (this.view === undefined && this.selection?.kind === 'harvest') {
          this.queueAction({ kind: 'harvest-run', run: this.model?.harvest?.run })
          return
        }
        if (dashboardBuildControl(this.selectedDashboardBuild()?.status ?? 'queued')?.key === 'p') {
          this.queueAction('pause')
        }
        return
      case 'r':
        if (this.view === undefined && this.selection?.kind === 'global') {
          this.queueAction('bulk-resume')
          return
        }
        if (dashboardBuildControl(this.selectedDashboardBuild()?.status ?? 'queued')?.key === 'r') {
          this.queueAction('resume')
        }
        return
      case 'd': {
        const slug =
          this.view?.slug ?? (this.selection?.kind === 'build' ? this.selection.slug : undefined)
        const build = this.model?.builds.find((candidate) => candidate.slug === slug)
        if (build?.status === 'queued') this.queueAction('discard')
        return
      }
      case 'a': {
        if (this.view?.kind === 'transcript') return
        const slug =
          this.view?.slug ?? (this.selection?.kind === 'build' ? this.selection.slug : undefined)
        const build = this.model?.builds.find((candidate) => candidate.slug === slug)
        if (build === undefined || build.status === 'aborting' || build.status === 'cleaning') {
          return
        }
        this.abortConfirmation = { slug: build.slug }
        this.syncModelControls()
        this.paint()
        return
      }
      case 'h':
        if (this.view === undefined && this.selection?.kind === 'global')
          this.queueAction('harvest-gate')
        return
      default:
        return
    }
  }

  private startInput(): void {
    if (!this.dashboard || this.opts.input === undefined) return
    this.acceptingKeys = true
    this.cleanupInput = this.opts.input.start((input) => this.onInput(input), {
      onListening: () => this.keyboard?.query(),
      onKeyboardFlags: (flags) => this.keyboard?.reported(flags),
      onDeviceAttributes: () => this.keyboard?.deviceAttributes(),
    })
  }

  private stopInput(): void {
    this.acceptingKeys = false
    const cleanup = this.cleanupInput
    this.cleanupInput = undefined
    cleanup?.()
  }

  /** Start one repository workflow without blocking the dispatcher tick.
   * Process-local tracking prevents redundant contenders and lets `--once`
   * drain it; the repository lease excludes other dispatch processes. */
  private launchHarvest(): void {
    // Do not even start a second local contender while one is active. A second
    // dispatch process is independently excluded by the repository lease.
    if (this.harvestInFlight !== undefined) return

    const { store, tickets, runtimes, ids, uuids, clock, storeRef, token } = this.wiring
    const runner = new HarvestRunner({
      store,
      tickets,
      config: this.currentConfig().config,
      getConfig: () => this.currentConfig().config,
      runtimes,
      repo: this.repoIdentity,
      workspacePath: this.opts.targetRepo,
      ids,
      uuids,
      clock,
      instance: `${this.host}-harvest-${ids('inst')}`,
      ...(this.repoLeaseHolder !== undefined ? { leaseHolder: this.repoLeaseHolder } : {}),
      sessionEnv: {
        AB_STORE: storeRef,
        ...(token !== undefined ? { AB_TOKEN: token } : {}),
      },
      opts: {
        maxRecoveryAttempts: this.maxHarvestRecoveryAttempts,
      },
    })

    let tracked: Promise<void>
    tracked = runner
      .run()
      .then((result) => {
        this.recordHarvestResult(result)
        if (
          !this.stopped &&
          (result.outcome === 'completed' ||
            result.outcome === 'escalated' ||
            result.outcome === 'failed')
        ) {
          const line = `harvest ${result.run} ${result.outcome}`
          if (result.outcome === 'failed') this.failureNotice(line)
          else this.say(line)
        }
      })
      .catch(async (error: unknown) => {
        this.pendingHarvest.harvestFailed += 1
        if (this.opts.kernelRunId !== undefined) {
          await this.appendStatus({
            actor: DISPATCHER,
            type: 'dispatcher.harvest-runner-failed',
            payload: {
              run: this.opts.kernelRunId,
              error: error instanceof Error ? error.message : String(error),
            },
          })
        }
        if (!this.stopped) {
          this.warn(
            `harvest runner failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      })
      .finally(() => {
        this.inFlight.delete(tracked)
        if (this.harvestInFlight === tracked) this.harvestInFlight = undefined
      })
    this.harvestInFlight = tracked
    this.inFlight.add(tracked)
  }

  private recordHarvestResult(result: HarvestRunnerResult): void {
    if ('launch' in result) {
      if (result.launch === 'started') this.pendingHarvest.harvestStarted += 1
      else this.pendingHarvest.harvestResumed += 1
    }
    if (result.outcome === 'completed') this.pendingHarvest.harvestCompleted += 1
    else if (result.outcome === 'escalated') {
      this.pendingHarvest.harvestEscalated += 1
    } else if (result.outcome === 'failed') {
      this.pendingHarvest.harvestFailed += 1
    }
  }

  private hasPendingHarvestResults(): boolean {
    return (
      this.pendingHarvest.harvestStarted > 0 ||
      this.pendingHarvest.harvestResumed > 0 ||
      this.pendingHarvest.harvestCompleted > 0 ||
      this.pendingHarvest.harvestEscalated > 0 ||
      this.pendingHarvest.harvestFailed > 0
    )
  }

  /** Publish one report from one Harvest snapshot. Acknowledgement subtracts
   * only that snapshot after the durable append, preserving outcomes that
   * settle while the Store write is in flight and retaining all counters when
   * publication fails. */
  private async publishTickReport(
    report: TickReport,
    settlementOnly = false,
  ): Promise<TickReport | undefined> {
    const snapshot = { ...this.pendingHarvest }
    if (
      settlementOnly &&
      snapshot.harvestStarted === 0 &&
      snapshot.harvestResumed === 0 &&
      snapshot.harvestCompleted === 0 &&
      snapshot.harvestEscalated === 0 &&
      snapshot.harvestFailed === 0
    ) {
      return undefined
    }

    const merged: TickReport = {
      ...report,
      harvestStarted: report.harvestStarted + snapshot.harvestStarted,
      harvestResumed: report.harvestResumed + snapshot.harvestResumed,
      harvestCompleted: report.harvestCompleted + snapshot.harvestCompleted,
      harvestEscalated: report.harvestEscalated + snapshot.harvestEscalated,
      harvestFailed: report.harvestFailed + snapshot.harvestFailed,
    }
    const {
      queued: _queued,
      janitorDiagnostics: _janitorDiagnostics,
      blockedDiagnostics: _blockedDiagnostics,
      ticketDiagnostics: _ticketDiagnostics,
      creationDiagnostics: _creationDiagnostics,
      dependencyDiagnostics: _dependencyDiagnostics,
      ...counters
    } = merged
    await this.appendStatus({
      actor: DISPATCHER,
      type: 'dispatcher.tick-completed',
      payload: {
        run: this.opts.kernelRunId!,
        ...this.lastTickStatus,
        counters,
      },
    })

    this.pendingHarvest.harvestStarted -= snapshot.harvestStarted
    this.pendingHarvest.harvestResumed -= snapshot.harvestResumed
    this.pendingHarvest.harvestCompleted -= snapshot.harvestCompleted
    this.pendingHarvest.harvestEscalated -= snapshot.harvestEscalated
    this.pendingHarvest.harvestFailed -= snapshot.harvestFailed
    return merged
  }

  /** Settlement-only completions are serialized after operational ticks. Loop
   * so a result arriving during an awaited status append gets its own report. */
  private publishSettlementReports(): Promise<TickReport[]> {
    return this.serialize(async () => {
      const reports: TickReport[] = []
      while (this.hasPendingHarvestResults()) {
        const report = await this.publishTickReport(emptyTickReport(), true)
        if (report !== undefined) reports.push(report)
      }
      return reports
    })
  }

  private async matchingRunnerDiagnostic(slug: string, instance: string) {
    const metas = await this.wiring.store.listArtifacts(slug, BUILD_RUNNER_DIAGNOSTIC_ARTIFACT)
    for (const meta of metas.toReversed()) {
      if (meta.metadata.instance !== instance) continue
      const artifact = await this.wiring.store.getArtifact(slug, meta.kind, meta.revision)
      if (artifact === null) continue
      const diagnostic = parseDiagnostic(artifact)
      if (diagnostic?.instance === instance) return diagnostic
    }
    return null
  }

  private async settlePendingPublication(slug: string): Promise<void> {
    await settleWorkspacePublication(
      {
        store: this.wiring.store,
        storeRef: this.wiring.storeRef,
        publication: this.wiring.workspaces.publication,
        forge: this.wiring.forge,
        workspacePath: this.opts.targetRepo,
        exec: this.opts.exec,
        ids: this.wiring.ids,
        runId: this.opts.kernelRunId!,
      },
      slug,
    )
  }

  private async recordInfrastructureFailure(input: {
    slug: string
    instance: string
    workspaceRef: string
    operation: 'provision' | 'start' | 'wait' | 'stop' | 'delete' | 'reconcile'
    error: unknown
    cleanupPending: boolean
    identity?: BuildExecutionHandle['identity']
  }): Promise<void> {
    await appendInfrastructureFailure(
      { store: this.wiring.store, ids: this.wiring.ids },
      {
        slug: input.slug,
        events: await this.wiring.store.getEvents(input.slug),
        maxAttempts: this.currentConfig().config.policy.maxInfrastructureAttempts,
        provider: input.identity?.provider ?? this.wiring.workspaces.name,
        workspaceRef: input.workspaceRef,
        instance: input.instance,
        ...(input.identity?.environmentId !== undefined
          ? { environmentId: input.identity.environmentId }
          : {}),
        ...(input.identity?.sessionId !== undefined ? { sessionId: input.identity.sessionId } : {}),
        operation: input.operation,
        error: input.error,
        cleanupPending: input.cleanupPending,
      },
    )
  }

  /** Start one workspace-adjacent executor without handing it workspace,
   * config, or outcome channels. Capacity and local single-flight remain
   * kernel decisions; the kernel reserves the durable execution lease before
   * launch and retains it until the executor has reaped its complete tree. */
  private async launchRunner(slug: string): Promise<LaunchRunnerResult> {
    if (!this.acceptingBuildLaunches || this.activeBuildRuns.has(slug)) return 'already-active'

    const reservation = Symbol(slug)
    const instance = `${this.host}-${slug}-${this.wiring.ids('inst')}`
    const active: ActiveBuildExecution = { reservation, instance, stopping: false }
    this.activeBuildRuns.set(slug, active)
    let leaseClaimed = false

    try {
      await this.publishBuildConfig(slug)
      leaseClaimed = await this.wiring.store.claimLease(
        slug,
        instance,
        BUILD_EXECUTION_LEASE_TTL_MS,
      )
      if (!leaseClaimed) {
        this.activeBuildRuns.delete(slug)
        await this.appendStatus({
          actor: DISPATCHER,
          type: 'dispatcher.runner-settled',
          payload: { run: this.opts.kernelRunId!, slug, outcome: 'lease-held' },
        })
        this.failureNotice(`build ${slug} already held by another runner — skipped`)
        return 'already-active'
      }
      const launchEvents = await this.wiring.store.getEvents(slug)
      let workspaceRef: string | undefined
      let workspaceProvider: string | undefined
      for (const event of launchEvents) {
        if (event.type === 'workspace.provisioned') {
          workspaceRef = event.payload.ref
          workspaceProvider = event.payload.provider
        } else if (event.type === 'workspace.released') {
          workspaceRef = undefined
          workspaceProvider = undefined
        }
      }
      if (workspaceRef === undefined) throw new Error(`build ${slug} has no open workspace`)
      // Execute through the runtime that owns the workspace: a build
      // provisioned before a provider switch still runs where it lives.
      const owning =
        workspaceProvider === undefined || workspaceProvider === this.wiring.workspaces.name
          ? { name: this.wiring.workspaces.name, execution: this.wiring.buildExecution }
          : (() => {
              const retired = this.wiring.retiredWorkspaces?.find(
                (runtime) => runtime.provider.name === workspaceProvider,
              )
              if (retired === undefined) {
                throw new Error(
                  `build ${slug} workspace ${workspaceRef} belongs to provider "${workspaceProvider}", which is no longer configured`,
                )
              }
              return { name: retired.provider.name, execution: retired.execution }
            })()
      // A prior publication acknowledgement may have been lost after its push
      // reached the durable branch. Reconcile that fact before a replacement
      // runner can rerun the phase and create a non-fast-forward successor.
      await this.settlePendingPublication(slug)
      const handle = await owning.execution.start({
        slug,
        storeRef: this.wiring.storeRef,
        instance,
        workspaceRef,
      })
      active.handle = handle
      const identity = handle.identity ?? {
        provider: owning.name,
        workspaceRef,
      }
      await this.wiring.store.append(slug, {
        actor: DISPATCHER,
        type: 'execution.started',
        payload: { ...identity, instance },
      })

      let tracked: Promise<void>
      tracked = handle.completion
        .then(
          async (exit) => {
            // A detached execution's guest keeps running: no `execution.ended`,
            // no lease release, no publication settlement — the next
            // supervisor settles the execution from the Store.
            if (active.detaching) return
            try {
              await this.wiring.store.append(slug, {
                actor: DISPATCHER,
                type: 'execution.ended',
                payload: {
                  instance,
                  workspaceRef,
                  outcome: active.stopping ? 'stopped' : 'completed',
                  exitCode: exit.exitCode,
                },
              })
              if (active.stopping) return
              const diagnostic = await this.matchingRunnerDiagnostic(slug, instance)
              if (diagnostic?.outcome === 'lease-held') {
                await this.appendStatus({
                  actor: DISPATCHER,
                  type: 'dispatcher.runner-settled',
                  payload: { run: this.opts.kernelRunId!, slug, outcome: 'lease-held' },
                })
                this.failureNotice(`build ${slug} already held by another runner — skipped`)
                return
              }

              const state = reduceBuild(await this.wiring.store.getEvents(slug))
              if (diagnostic === null && exit.exitCode === 0) {
                await this.appendStatus({
                  actor: DISPATCHER,
                  type: 'dispatcher.runner-settled',
                  payload: {
                    run: this.opts.kernelRunId!,
                    slug,
                    outcome: 'parked',
                    status: state.status,
                  },
                })
                this.failureNotice(`build ${slug} parked (${state.status})`)
                return
              }

              const detail =
                diagnostic?.error ??
                `child exited ${exit.exitCode ?? 'without status'}${exit.signal ? ` (${exit.signal})` : ''}`
              await this.appendStatus({
                actor: DISPATCHER,
                type: 'dispatcher.runner-settled',
                payload: { run: this.opts.kernelRunId!, slug, outcome: 'failed', error: detail },
              })
              this.warn(`build ${slug} runner failed: ${detail}`)
            } finally {
              await this.wiring.store.releaseLease(slug, instance)
              await this.settlePendingPublication(slug)
            }
          },
          async (error) => {
            // A detached wait is teardown of local supervision, not a guest
            // failure; the next supervisor re-observes the execution.
            if (active.detaching) return
            // A rejected executor completion cannot prove the remote VM was
            // stopped. Keep the lease until expiry: recovery fences and reaps
            // the exact recorded identity before authorizing a replacement.
            await this.recordInfrastructureFailure({
              slug,
              instance,
              workspaceRef,
              operation: 'wait',
              error,
              cleanupPending: true,
              identity,
            })
          },
        )
        .finally(() => {
          this.inFlightKinds.delete(tracked)
          this.inFlight.delete(tracked)
          if (this.activeBuildRuns.get(slug)?.reservation === reservation) {
            this.activeBuildRuns.delete(slug)
          }
        })
      active.settled = tracked
      this.inFlight.add(tracked)
      this.inFlightKinds.set(tracked, handle.supervision)
      return 'scheduled'
    } catch (error) {
      if (this.activeBuildRuns.get(slug)?.reservation === reservation) {
        this.activeBuildRuns.delete(slug)
      }
      if (leaseClaimed) {
        const events = await this.wiring.store.getEvents(slug)
        let workspaceRef = ''
        for (const event of events) {
          if (event.type === 'workspace.provisioned') workspaceRef = event.payload.ref
          else if (event.type === 'workspace.released') workspaceRef = ''
        }
        if (workspaceRef !== '') {
          await this.recordInfrastructureFailure({
            slug,
            instance,
            workspaceRef,
            operation: 'start',
            error,
            cleanupPending: this.wiring.workspaces.recovery !== undefined,
          })
        }
        // Local start failures have no possible remote holder. Remote failures
        // retain the lease until its TTL fences an ambiguous start.
        if (this.wiring.workspaces.recovery === undefined) {
          await this.wiring.store.releaseLease(slug, instance)
        }
      }
      await this.appendStatus({
        actor: DISPATCHER,
        type: 'dispatcher.runner-settled',
        payload: {
          run: this.opts.kernelRunId!,
          slug,
          outcome: 'launch-failed',
          error: error instanceof Error ? error.message : String(error),
        },
      })
      throw error
    }
  }

  private get stopped(): boolean {
    return this.opts.signal?.aborted === true || this.inputStop.signal.aborted
  }

  /** `--once` awaits only local-parent executions and harvest: an
   * environment-supervised execution keeps running in its guest, and a later
   * invocation settles its completion from the Store alone. */
  private async drainInFlight(): Promise<void> {
    for (;;) {
      const pending = [...this.inFlight].filter(
        (promise) => this.inFlightKinds.get(promise) !== 'environment',
      )
      if (pending.length === 0) return
      await Promise.all(pending)
    }
  }

  /** Teardown distinguishes supervision kinds. A local-parent execution is
   * stopped and reaped exactly as before. An environment-supervised execution
   * is DETACHED: the guest keeps running and heartbeating its lease; the next
   * invocation settles the execution from the Store plus provider liveness
   * (AC: a restarted dispatcher never replaces a healthy environment). */
  private async stopBuildExecutions(): Promise<void> {
    this.acceptingBuildLaunches = false
    const active = [...this.activeBuildRuns.entries()]
    for (const [, entry] of active) {
      if (entry.handle?.supervision === 'environment') entry.detaching = true
      else entry.stopping = true
    }
    await Promise.all(
      active.map(async ([slug, entry]) => {
        if (entry.handle?.supervision === 'environment') {
          // Abort the local wait only — no command kill, no environment stop,
          // no lease release, no durable end. Drop the tracking so the
          // process can exit while the guest outlives it.
          try {
            await entry.handle.detach()
          } catch {
            // Detach is best-effort: an unresolvable wait still exits.
          }
          this.activeBuildRuns.delete(slug)
          if (entry.settled !== undefined) {
            this.inFlight.delete(entry.settled)
            this.inFlightKinds.delete(entry.settled)
          }
          return
        }
        const result = await entry.handle?.stop()
        if (result?.outcome === 'unknown') {
          await this.recordInfrastructureFailure({
            slug,
            instance: entry.instance,
            workspaceRef: entry.handle?.identity?.workspaceRef ?? slug,
            operation: 'stop',
            error: result.error,
            cleanupPending: true,
            identity: entry.handle?.identity,
          })
          // Do not wait forever for command.wait after an ambiguous stop. The
          // durable lease intentionally remains until TTL expiry and fencing.
          return
        }
        await entry.settled
      }),
    )
  }

  // ── Message routing ───────────────────────────────────────────────────────
  //
  // The interactive frame is the dashboard's ONLY output surface. Routine
  // notices are intentionally silent there; only warnings/errors become a
  // process-local warning row. A concurrent store poll overlays the latest
  // warning again before painting, so an older projection cannot erase it.
  // Plain/non-interactive mode keeps the existing line sinks exactly.

  private setWarning(line: string): void {
    this.warningLine = line
    this.syncModelControls()
    this.paint()
  }

  private say(line: string): void {
    if (!this.dashboard && this.opts.silent !== true) this.opts.stdout(line)
  }

  /** Routine acknowledgement: line-oriented stdout, dashboard-silent. */
  private announce(line: string): void {
    if (!this.dashboard) this.opts.stdout(line)
  }

  private warn(line: string): void {
    if (this.dashboard) this.setWarning(line)
    else if (this.opts.silent !== true) this.opts.stderr(line)
  }

  /** Failure-severity dashboard notice whose historical plain sink is stdout. */
  private failureNotice(line: string): void {
    if (this.dashboard) this.setWarning(line)
    else if (this.opts.silent !== true) this.opts.stdout(line)
  }

  /** Routine diagnostic whose historical line-oriented sink is stderr. */
  private routineDiagnostic(line: string): void {
    if (!this.dashboard && this.opts.silent !== true) this.opts.stderr(line)
  }

  /**
   * Janitor, ticket, and dependency diagnostics are independent notices
   * (line-oriented in plain mode; on a TTY only warning-severity diagnostics
   * are rendered). Contained janitor failures and invalid ticket records use
   * the warning seam so scripted JSON/stdout consumers stay clean; dependency
   * holds retain their ordinary notice seam. In line-oriented mode this is the
   * operator's attributed view of why a build or ready ticket is sitting still,
   * with no provider, filesystem, or database inspection. The counts map
   * guards on `typeof count === 'number'`
   * because a non-numeric TickReport field would otherwise be dropped here
   * silently (`count > 0` is false for an array, with no type error).
   *
   * `say()` is the plain stdout identity and intentionally silent on the
   * dashboard, so line-oriented behavior is unchanged while routine
   * interactive chatter disappears.
   */
  /**
   * A startup, configuration-level notice (§9 role-key consumability) — never a
   * tick outcome, never blocking. Both surfaces get the SAME strings in full:
   * stderr writes each one, the dashboard wraps them into its warning region.
   * No surface gets a digest, a cap, or a truncated tail.
   */
  private reportRoleDiagnostics(): void {
    const lines = roleKeyWarnings(this.currentConfig().config)
    if (this.dashboard) {
      this.configWarnings = lines
      this.syncModelControls()
      this.paint()
    } else {
      for (const line of lines) this.opts.stderr(line)
    }
  }

  private printReport(report: Awaited<ReturnType<Dispatcher['tick']>>, printIdle = true): boolean {
    // `queued` is a standing depth, not a tick action — the header owns it;
    // repeating it in the notice would make every saturated tick look busy.
    const {
      janitorDiagnostics,
      blockedDiagnostics,
      ticketDiagnostics,
      creationDiagnostics,
      dependencyDiagnostics,
      queued: _queued,
      ...counts
    } = report
    for (const line of janitorDiagnostics) this.routineDiagnostic(line)
    for (const line of blockedDiagnostics) this.say(line)
    for (const line of ticketDiagnostics) this.routineDiagnostic(line)
    for (const line of creationDiagnostics) this.say(line)
    for (const line of dependencyDiagnostics) this.say(line)
    const parts = Object.entries(counts)
      .filter(([, count]) => typeof count === 'number' && count > 0)
      .map(([name, count]) => `${name}=${count}`)
    if (parts.length > 0) {
      this.say(`tick: ${parts.join(' ')}`)
      return true
    }
    const reportedDiagnostic =
      janitorDiagnostics.length > 0 ||
      blockedDiagnostics.length > 0 ||
      ticketDiagnostics.length > 0 ||
      creationDiagnostics.length > 0 ||
      dependencyDiagnostics.length > 0
    if (reportedDiagnostic) return true
    // A tick that did something is worth a plain line. Interactive mode
    // suppresses both action counts and the every-10s idle noise.
    if (!this.dashboard && printIdle) {
      this.opts.stdout('tick: idle')
      return true
    }
    return false
  }

  // ── The live region ───────────────────────────────────────────────────────

  /**
   * The store READ half of a frame: discover builds, incrementally refresh
   * dashboard-visible streams, combine their cached projections with a fresh
   * repository-journal projection, then paint. Read-only — it appends nothing
   * and decides nothing. Paint is split out so the watch-mode tick timer can
   * repaint cached timing against a moving clock without re-reading.
   */
  private async renderOnce(): Promise<void> {
    const { terminal } = this.opts
    if (this.region === undefined || terminal === undefined) return
    const configSnapshot = this.currentConfig()
    const buildSnapshot = await this.dashboardBuilds.refresh(
      configSnapshot.config,
      configSnapshot.revision,
    )
    const repoRecord = await this.wiring.store.getRepo(this.repoIdentity)
    const repositoryEvents =
      repoRecord === null ? [] : await this.wiring.store.getRepoEvents(this.repoIdentity)

    // Action-triggered and timer refreshes share the cache but may finish their
    // repository reads out of order. Never let an older build snapshot replace
    // one that committed later.
    if (!this.dashboardBuilds.isCurrent(buildSnapshot)) return

    // Polling continues while the operator types. Keep the prompt bound to the
    // captured build/escalations, shrink it around externally answered ids, and
    // clear it rather than ever retargeting feedback to a newly selected row.
    if (this.resumePrompt !== undefined) {
      const prompt = this.resumePrompt
      const state = buildSnapshot.states.get(prompt.slug)
      const active = state !== undefined && ['running', 'paused', 'blocked'].includes(state.status)
      const openIds = new Set(state?.openEscalations.map((item) => item.id) ?? [])
      const remaining = prompt.escalationIds.filter((id) => openIds.has(id))
      if (!active || remaining.length === 0) {
        this.resumePrompt = undefined
      } else if (remaining.length !== prompt.escalationIds.length) {
        this.resumePrompt = { ...prompt, escalationIds: remaining }
      }
    }
    if (this.abortConfirmation !== undefined) {
      const state = buildSnapshot.states.get(this.abortConfirmation.slug)
      if (
        state === undefined ||
        !['queued', 'running', 'paused', 'blocked'].includes(state.status) ||
        state.pendingCommands.some((command) => command.command === 'abort')
      ) {
        // Another process may have durably requested the abort while this
        // process-local prompt was open. Never leave a stale confirmation up.
        this.abortConfirmation = undefined
      }
    }

    const previousRows = this.model === undefined ? [] : dashboardSelections(this.model)
    const projected = buildDashboardFromProjected(
      buildSnapshot.builds,
      {
        repo: this.repoIdentity,
        queued: this.queuedCount,
        activeCount: [...buildSnapshot.states.values()].filter(
          (state) => state.status !== 'done' && state.status !== 'aborted',
        ).length,
        capacity: configSnapshot.config.capacity,
        observationCount: this.observationCount,
        observationLimit: configSnapshot.config.policy.harvestThreshold,
      },
      repositoryEvents,
    )
    const nextRows = dashboardSelections(projected)
    this.selection = reconcileSelection(previousRows, nextRows, this.selection)

    if (this.view !== undefined) {
      const build = projected.builds.find((candidate) => candidate.slug === this.view!.slug)
      if (build === undefined) {
        // Detail follows dashboard visibility: acknowledged abort cleanup stays
        // open, and final completion returns the operator to the list.
        this.view = undefined
      } else if (this.view.kind === 'detail') {
        const detail = this.view
        const sessions = build.sessions ?? []
        const selected = sessions.some((session) => session.id === detail.sessionId)
          ? detail.sessionId
          : sessions[0]?.id
        const messageStillValid =
          detail.messageWhileSessionOpen === undefined ||
          sessions.some(
            (session) => session.id === detail.messageWhileSessionOpen && session.status === 'open',
          )
        const {
          message: priorMessage,
          messageWhileSessionOpen: priorMessageFence,
          sessionId: _priorSession,
          ...stableDetail
        } = detail
        this.view = {
          ...stableDetail,
          ...(selected !== undefined ? { sessionId: selected } : {}),
          ...(messageStillValid && priorMessage !== undefined
            ? {
                message: priorMessage,
                ...(priorMessageFence !== undefined
                  ? { messageWhileSessionOpen: priorMessageFence }
                  : {}),
              }
            : {}),
        }
      }
    }

    this.model = projected
    this.syncModelControls()
    this.paint()
  }

  /**
   * The PAINT half: render the cached model against the CURRENT clock and
   * repaint. `now` is what makes a running step's elapsed advance (AC 8); the
   * identical-frame check in `LiveRegion.update` collapses a repaint whose
   * displayed second is unchanged to zero writes. No store I/O.
   */
  private paint(): void {
    const { terminal } = this.opts
    if (this.region === undefined || terminal === undefined || this.model === undefined) return
    const renderer = this.opts.resolveDashboardRenderer?.() ?? renderDashboard
    this.region.update(
      renderer(this.model, {
        color: true,
        width: terminal.columns,
        // NOT `terminal.rows` — the region's trailing newline needs a row of
        // its own, so a frame of exactly `rows` scrolls its own header off.
        // See `paintableRows`.
        height: paintableRows(terminal.rows),
        now: this.wiring.clock().getTime(),
      }),
    )
  }

  private startUpgradeChecks(): void {
    if (
      (!this.dashboard && this.opts.kernelRunId === undefined) ||
      this.opts.once === true ||
      this.stopUpgradeNotice !== undefined
    ) {
      return
    }
    const probe =
      this.opts.availableReleaseProbe ?? ((signal: AbortSignal) => availableRelease({ signal }))
    try {
      this.stopUpgradeNotice = startUpgradeNotice({
        probe,
        ...(this.opts.upgradeNoticeScheduler !== undefined
          ? { scheduler: this.opts.upgradeNoticeScheduler }
          : {}),
        onAvailable: (version) => {
          if (this.availableUpgrade !== undefined && !semver.gt(version, this.availableUpgrade)) {
            return
          }
          this.availableUpgrade = version
          if (this.opts.kernelRunId !== undefined) {
            void this.appendStatus({
              actor: DISPATCHER,
              type: 'dispatcher.upgrade-available',
              payload: { run: this.opts.kernelRunId, version },
            }).catch(() => {
              // Release discovery and publication are a silent courtesy.
            })
          }
          this.syncModelControls()
          this.paint()
        },
      })
    } catch {
      // Timer/probe setup is the same silent courtesy as the check itself.
    }
  }

  private startRendering(): void {
    if (!this.dashboard || this.timer !== undefined) return
    this.acceptingRenderPolls = true
    const tick = (): void => {
      if (!this.acceptingRenderPolls || this.rendering) return // fenced, no overlap
      this.rendering = true
      let handled!: Promise<void>
      handled = this.renderOnce()
        .catch((error: unknown) => {
          // A transient store error must never kill dispatch — the dashboard
          // is a view, and a view that throws is a bug in the view.
          this.warn(
            `dashboard render failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        })
        .finally(() => {
          // Identity matters if lifecycle code ever stops and restarts polling:
          // an older completion must not clear a replacement poll's guard.
          if (this.renderInFlight !== handled) return
          this.renderInFlight = undefined
          this.rendering = false
        })
      this.renderInFlight = handled
    }
    this.timer = setInterval(tick, DASHBOARD_POLL_MS)
    // Never hold the process open for a redraw.
    this.timer.unref?.()
    // Watch mode only: a second, cheap timer repaints the cached model so a
    // running step's elapsed advances ~1×/s decoupled from the store poll
    // (AC 8). `--once` renders a single snapshot per state, so it gets no ticker.
    if (this.opts.once !== true) {
      this.tickTimer = setInterval(() => this.paint(), DASHBOARD_TICK_MS)
      this.tickTimer.unref?.()
    }
    tick()
  }

  private async stopRendering(): Promise<void> {
    // Clear both timer sources before yielding. The boolean also fences a timer
    // callback that was already queued when clearInterval ran.
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    if (this.tickTimer !== undefined) clearInterval(this.tickTimer)
    this.tickTimer = undefined
    this.acceptingRenderPolls = false

    // The poll owns model/controller mutation as well as terminal painting, so
    // join it rather than merely suppressing a late LiveRegion.update(). Its
    // normal rejection is warning-handled above; the catch keeps teardown safe
    // even if reporting that warning itself throws.
    const inFlight = this.renderInFlight
    if (inFlight !== undefined) {
      try {
        await inFlight
      } catch {
        // Dashboard rendering remains best-effort during teardown.
      }
    }
  }

  /** Stop polling, paint the truth one last time, release the region. Every
   * exit path runs this — including SIGINT — or the operator's shell is left
   * without a cursor. */
  private async finishRendering(): Promise<void> {
    // Stop network/process discovery synchronously before any final dashboard
    // read. A probe that ignores cancellation is never joined. The private
    // kernel owns this courtesy even though it owns no terminal rendering.
    this.stopUpgradeNotice?.()
    this.stopUpgradeNotice = undefined
    if (!this.dashboard) return
    // No new keys or polls may begin once teardown starts. Already queued
    // actions finish before the final truth is painted and raw mode/cursor are
    // considered released.
    try {
      try {
        this.stopInput()
      } catch (error) {
        // Cursor restoration must not be skipped just because stdin restoration
        // itself failed. Keep the failure visible in the final warning row when
        // the presentation seam is still usable.
        try {
          this.warn(
            `dashboard input cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        } catch {
          // Rendering that warning is best-effort too.
        }
      }
      await this.stopRendering()
      await this.operationTail
      try {
        await this.renderOnce()
      } catch {
        // Best-effort: a failed final frame must not mask the run's outcome.
      }
    } finally {
      // Cursor/normal-screen restoration is unconditional once dashboard
      // teardown begins, including poll and final-read failures.
      this.region?.finish()
    }
  }

  // ── Repository supervisor lease (§12 serialization) ────────────────────────

  /** Claim (or renew) the repository lease for this invocation and start the
   * heartbeat timer. False means another supervisor holds it: the caller
   * yields — no claims, launches, or publications. */
  private async ensureRepoLease(holder: string): Promise<boolean> {
    if (this.superseded) return false
    const claimed = await this.wiring.store
      .claimRepoLease(this.repoIdentity, holder, REPO_LEASE_TTL_MS)
      .catch(() => false)
    if (!claimed) {
      if (this.repoLeaseHolder !== undefined) {
        // We held the lease and the store says it is gone: a peer took over.
        this.superseded = true
      }
      return false
    }
    if (this.repoLeaseHolder === undefined) {
      this.repoLeaseHolder = holder
      this.startRepoLeaseHeartbeat(holder)
    }
    return true
  }

  private startRepoLeaseHeartbeat(holder: string): void {
    if (this.repoLeaseHeartbeat !== undefined) return
    this.repoLeaseHeartbeat = setInterval(() => {
      this.wiring.store.heartbeatRepo(this.repoIdentity, holder).then(
        (alive) => {
          if (alive) return
          // A peer holds the repository now. Exit watch mode cleanly after
          // the same teardown every stop takes (detach remote / reap local,
          // signal continuations, release the lease).
          this.superseded = true
          this.inputStop.abort()
        },
        () => {
          // Store unreachable: retry on the next beat; a later false result
          // proves takeover.
        },
      )
    }, REPO_LEASE_HEARTBEAT_MS)
    this.repoLeaseHeartbeat.unref?.()
  }

  private stopRepoLeaseHeartbeat(): void {
    if (this.repoLeaseHeartbeat !== undefined) clearInterval(this.repoLeaseHeartbeat)
    this.repoLeaseHeartbeat = undefined
  }

  /** Durable record that this invocation found the repository held and
   * performed no claims, launches, or publications. The holder is resolved
   * from the repository record. Recorded once per yield period, not once per
   * retrying tick. */
  private async recordTickYielded(): Promise<void> {
    try {
      const record = await this.wiring.store.getRepo(this.repoIdentity).catch(() => null)
      const holder = record?.lease?.holder
      if (holder === undefined || this.yieldedTo === holder) return
      this.yieldedTo = holder
      await this.wiring.store.appendRepo(this.repoIdentity, {
        actor: DISPATCHER,
        type: 'dispatcher.tick-yielded',
        payload: {
          ...(this.opts.kernelRunId !== undefined ? { run: this.opts.kernelRunId } : {}),
          holder,
        },
      })
    } catch {
      // Presentation-only durable evidence; the yield behavior is unchanged.
    }
  }

  private async releaseRepoLease(): Promise<void> {
    this.stopRepoLeaseHeartbeat()
    const holder = this.repoLeaseHolder
    this.repoLeaseHolder = undefined
    if (holder === undefined) return
    try {
      await this.wiring.store.releaseRepoLease(this.repoIdentity, holder)
    } catch {
      // Expiry fences an ambiguous release.
    }
  }

  async run(): Promise<void> {
    // Before the `--once` branch, so both modes report it exactly once.
    this.reportRoleDiagnostics()
    // Repository supervisor lease (§12): two invocations for one repository
    // never both act. A losing invocation records the yield and performs no
    // claims, launches, or publications.
    const holder = this.opts.kernelRunId ?? `${this.host}-dispatch-${this.wiring.ids('inst')}`
    if (!(await this.ensureRepoLease(holder))) {
      await this.recordTickYielded()
      const peer = (await this.wiring.store.getRepo(this.repoIdentity).catch(() => null))?.lease
        ?.holder
      const message = `tick yielded: repository held by ${peer ?? 'another invocation'}`
      this.warn(message)
      if (this.opts.once === true) return
      // Watch mode stays alive and retries the claim at every tick.
    }
    const capacity = this.currentConfig().config.capacity
    if (this.opts.once) {
      if (!this.dashboard) {
        this.say(`ab dispatch — one pass over ${this.opts.targetRepo} (capacity ${capacity})`)
      }
      // Render BEFORE the tick and until the drain finishes, so the operator
      // watches the initial pass's builds change state while they run. The
      // render loop only reads: `--once` still calls tick() exactly ONCE, so
      // it never claims a ticket that becomes Ready mid-drain.
      try {
        this.startInput()
        this.startRendering()
        const initial = await this.dispatcherTick(true)
        const initialPrinted = this.printReport(initial, false)
        await this.drainInFlight()
        const settledReports = await this.publishSettlementReports()
        let settledPrinted = false
        for (const report of settledReports) {
          settledPrinted = this.printReport(report, false) || settledPrinted
        }
        if (!initialPrinted && !settledPrinted) {
          this.printReport(emptyTickReport())
        }
      } finally {
        await this.stopBuildExecutions()
        // Signal provisioning continuations and release their leases before
        // the repository lease, so the next supervisor adopts immediately.
        await this.dispatcher.stopProvisioning()
        await this.finishRendering()
        await this.releaseRepoLease()
      }
      return
    }

    const intervalMs = this.opts.intervalMs ?? DEFAULT_INTERVAL_MS
    const sleep =
      this.opts.sleep ??
      ((ms: number) => interruptibleSleep(ms, [this.opts.signal, this.inputStop.signal]))
    if (!this.dashboard) {
      this.say(
        `ab dispatch — watching ${this.opts.targetRepo} (capacity ${capacity}, ` +
          `every ${Math.round(intervalMs / 1000)}s) — Ctrl-C to stop`,
      )
    }
    try {
      this.startInput()
      this.startRendering()
      this.startUpgradeChecks()
      let startup = true
      while (!this.stopped && !this.superseded) {
        try {
          const report = await this.dispatcherTick(startup)
          this.printReport(report, this.harvestInFlight === undefined)
          startup = false
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await this.appendStatus({
            actor: DISPATCHER,
            type: 'dispatcher.tick-failed',
            payload: { run: this.opts.kernelRunId!, error: message },
          })
          this.warn(`tick failed: ${message}`)
        }
        if (this.stopped || this.superseded) break
        await sleep(intervalMs)
      }
      if (this.superseded) {
        this.warn('dispatcher superseded by another invocation — detaching')
      }
    } finally {
      await this.stopBuildExecutions()
      // Signal provisioning continuations and release their leases before
      // the repository lease, so the next supervisor adopts immediately.
      await this.dispatcher.stopProvisioning()
      // Stop input and join teardown work first so every result that becomes
      // reportable at that boundary is included. Active Harvest work is still
      // deliberately not awaited in watch mode.
      await this.finishRendering()
      for (const report of await this.publishSettlementReports()) {
        this.printReport(report, false)
      }
      await this.releaseRepoLease()
    }
    // The finished interactive frame stays on screen; never append a late line
    // beneath it. Plain mode retains its historical shutdown line.
    if (!this.dashboard) this.say('ab dispatch stopped')
  }
}

/** Origin-mode startup: fetch autobuild.toml from the repository through the
 * forge — the default branch first (baseBranch is itself config), then the
 * configured base branch when one is set. The final parse is the startup
 * Config; both reads share one memoized GitHubForge. */
async function fetchOriginModeConfig(
  opts: DispatchOpts,
  transport?: GitHubRequest,
): Promise<{
  content: string
  config: Config
}> {
  const repository = normalizeGitRemoteUrl(opts.repository!)
  const label = `${repository}/autobuild.toml`
  const forge = new GitHubForge({
    env: opts.env,
    repository,
    ...(transport !== undefined ? { transport } : {}),
  })
  const readFile = forge.readFile
  if (readFile === undefined) {
    throw new Error('the github forge does not implement readFile — this is a wiring bug')
  }
  const content = await readFile.call(forge, 'autobuild.toml').catch((error: unknown) => {
    if (error instanceof GitHubApiError && error.status === 404) {
      throw new Error(
        `${label}: not found on the repository's default branch — origin-mode dispatch ` +
          'reads autobuild.toml from the forge (SPEC §8.2, §16.1)',
      )
    }
    throw error
  })
  const parsed = parseConfig(content, label)
  if (parsed.baseBranch === undefined || parsed.baseBranch === '') {
    return { content, config: parsed }
  }
  const branchContent = await readFile
    .call(forge, 'autobuild.toml', parsed.baseBranch)
    .catch((error: unknown) => {
      if (error instanceof GitHubApiError && error.status === 404) {
        throw new Error(
          `${label}: not found at configured baseBranch ${JSON.stringify(parsed.baseBranch)} — ` +
            'commit autobuild.toml to the base branch before dispatching in origin mode',
        )
      }
      throw error
    })
  const branchLabel = `${label}@${parsed.baseBranch}`
  return { content: branchContent, config: parseConfig(branchContent, branchLabel) }
}

/** Origin-mode repo state: the identity is the normalized origin; local
 * scratch (state root, worktree root) lives under a per-origin temp directory
 * and the store MUST be remote HTTPS. Requirements are validated here so a
 * misconfigured origin-mode launch fails before any side effect. */
async function resolveOriginModeState(opts: DispatchOpts): Promise<RepoStatePaths> {
  const identity = normalizeGitRemoteUrl(opts.repository!)
  const selectedStore = opts.storeRef ?? opts.env.AB_STORE
  if (selectedStore === undefined || !/^https:\/\//i.test(selectedStore)) {
    throw new Error(
      'origin-mode dispatch requires an HTTPS BuildStore — set AB_STORE (or --store) to the hosted Store URL',
    )
  }
  if (opts.env.AB_TOKEN === undefined || opts.env.AB_TOKEN === '') {
    throw new Error('origin-mode dispatch requires AB_TOKEN for the remote Store')
  }
  if (opts.env.GITHUB_TOKEN === undefined && opts.env.GH_TOKEN === undefined) {
    throw new Error('origin-mode dispatch requires GITHUB_TOKEN or GH_TOKEN for the GitHub API')
  }
  const scratch = join(
    tmpdir(),
    'autobuild',
    createHash('sha256').update(identity).digest('hex').slice(0, 16),
  )
  await mkdir(scratch, { recursive: true })
  return resolveRepoStatePaths({
    repo: identity,
    checkout: scratch,
    ...(opts.storeRef !== undefined ? { storeRef: opts.storeRef } : {}),
    ...(opts.env.AB_STORE !== undefined ? { envStore: opts.env.AB_STORE } : {}),
  })
}

/**
 * Entry point (§8.2). Loads the repo's config — whose required [tickets]
 * table selects the TicketSource and names its ready state. A file source with
 * no `dir` still defaults to `.autobuild/tickets` (§13). Then wires the ports
 * and runs until one pass finishes (`--once`) or `opts.signal` aborts (SIGINT).
 *
 * Origin mode (AUT-302): `opts.repository` (CLI `--repository`, env
 * `AB_REPOSITORY`) serves a repository with NO local checkout. The startup
 * config is fetched from the forge (default branch, then the configured
 * `baseBranch`), the store must be remote HTTPS, and the identity — not a
 * path — is the served repository.
 */
export async function abDispatch(opts: DispatchOpts): Promise<void> {
  if (opts.wire !== undefined && opts.nonStoreWire !== undefined) {
    throw new Error('dispatch wire and nonStoreWire are mutually exclusive')
  }
  const state =
    opts.repository !== undefined
      ? await resolveOriginModeState(opts)
      : await resolveRepoState({
          targetRepo: opts.targetRepo,
          exec: opts.exec,
          ...(opts.storeRef !== undefined ? { storeRef: opts.storeRef } : {}),
          ...(opts.env.AB_STORE !== undefined ? { envStore: opts.env.AB_STORE } : {}),
        })
  // Normalize once, then use these exact values for config/tickets/repository
  // identity, store wiring, worktrees, and every session's AB_STORE.
  // `targetRepo` stays the FILESYSTEM checkout (or origin-mode scratch root);
  // `repo` is the store-keyed identity.
  const resolvedOpts: DispatchOpts = {
    ...opts,
    targetRepo: state.checkout,
    storeRef: state.storeRef,
    repo: opts.repo ?? state.repo,
  }

  // Interactive production dispatch is two programs. Resolve/open only the
  // Store in the terminal owner; config, plugins, adapters, runners, and ticket
  // I/O are constructed exclusively by the supervised private child. Injected
  // wiring remains the direct test/embedding seam, and every plain/non-TTY
  // invocation stays on the byte-compatible in-process kernel path below.
  if (
    resolvedOpts.kernelRunId === undefined &&
    resolvedOpts.wire === undefined &&
    resolvedOpts.nonStoreWire === undefined &&
    resolvedOpts.plain !== true &&
    resolvedOpts.terminal?.interactive === true &&
    resolvedOpts.input !== undefined
  ) {
    if (opts.repository !== undefined) {
      throw new Error(
        'origin-mode dispatch (--repository) is a serverless workhorse and cannot run the ' +
          'interactive dashboard: pass --plain or run it without a TTY',
      )
    }
    const opened = openStoreForRepoState(state, { env: resolvedOpts.env })
    try {
      const frontend = new DispatchFrontend({
        repo: state.repo,
        checkout: state.checkout,
        storeRef: opened.storeRef,
        store: opened.store,
        env: resolvedOpts.env,
        terminal: resolvedOpts.terminal,
        input: resolvedOpts.input,
        once: resolvedOpts.once === true,
        ...(resolvedOpts.intervalMs !== undefined ? { intervalMs: resolvedOpts.intervalMs } : {}),
        ...(resolvedOpts.intake !== undefined ? { intake: resolvedOpts.intake } : {}),
        ...(resolvedOpts.defaultAutoMerge !== undefined
          ? { defaultAutoMerge: resolvedOpts.defaultAutoMerge }
          : {}),
        ...(resolvedOpts.signal !== undefined ? { signal: resolvedOpts.signal } : {}),
        ...(resolvedOpts.resolveDashboardRenderer !== undefined
          ? { resolveDashboardRenderer: resolvedOpts.resolveDashboardRenderer }
          : {}),
      })
      await frontend.run()
    } finally {
      await opened.store.close()
    }
    return
  }

  const configPath = join(resolvedOpts.targetRepo, 'autobuild.toml')
  let configContent: string
  let config: Config
  if (opts.repository !== undefined) {
    // Origin mode startup config: the base branch's autobuild.toml, fetched
    // through the forge (default branch first — baseBranch itself is config).
    const fetched = await fetchOriginModeConfig(opts, opts.originConfigTransport)
    configContent = fetched.content
    config = fetched.config
    if (config.forge !== 'github') {
      throw new Error(
        `origin-mode dispatch requires the builtin github forge, but the fetched autobuild.toml selects ${JSON.stringify(config.forge)}`,
      )
    }
    if (config.plugins !== undefined && config.plugins.length > 0) {
      throw new Error(
        'origin-mode dispatch cannot load configured plugins: plugin code is checkout-relative ' +
          'and there is no checkout. Remove [plugins] from the base branch autobuild.toml or run from a checkout',
      )
    }
  } else {
    try {
      configContent = await Bun.file(configPath).text()
      config = parseConfig(configContent, configPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(
          `${configPath}: not found — 'ab dispatch' reads autobuild.toml from ` +
            'the resolved Git main checkout (SPEC §8.2, §16.1)',
        )
      }
      throw error
    }
  }
  // Configured plugin code is trusted like configured shell commands, but it
  // must resolve, evaluate, validate, and register before production wiring
  // opens a store, claims a ticket, or launches a runner.
  const plugins = await loadPlugins(config.plugins, resolvedOpts.targetRepo)
  // Validate the selector against the complete catalog before either custom
  // wiring or production wiring can open state or perform side effects.
  resolveForgeRegistration(config.forge, plugins)
  let wired: DispatchWiring
  if (resolvedOpts.nonStoreWire !== undefined) {
    const opened = openStoreForRepoState(state, { env: resolvedOpts.env })
    const ports = await resolvedOpts.nonStoreWire(config, resolvedOpts, state, plugins)
    wired = {
      ...ports,
      store: opened.store,
      storeRef: opened.storeRef,
      ...(opened.token !== undefined ? { token: opened.token } : {}),
    }
  } else {
    const wire = resolvedOpts.wire ?? defaultWire
    wired = await wire(config, resolvedOpts, state, plugins)
  }
  const runtimes = await materializePluginRuntimes(wired.runtimes, plugins, {
    // Filesystem root for plugin runtime code — never the store identity.
    repoRoot: state.checkout,
    env: resolvedOpts.env,
  })
  const wiring: DispatchWiring = {
    ...wired,
    runtimes,
    plugins: wired.plugins ?? plugins,
  }
  // Construction eagerly validates every startup role before repository
  // settings or runner work can mutate durable state. The publisher is used
  // only by later watch refreshes.
  const liveConfig = new LiveConfig(
    configPath,
    config,
    configContent,
    wiring.runtimes,
    async ({ content, effectiveConfig, restartRequired, effectiveChanged }) => {
      await wiring.store.appendRepoWithArtifacts(
        state.repo,
        [
          {
            kind: DISPATCHER_CONFIG_ARTIFACT,
            content,
            metadata: { restartRequired: [...restartRequired], effectiveChanged },
          },
          {
            kind: DISPATCHER_EFFECTIVE_CONFIG_ARTIFACT,
            content: effectiveConfigContent(effectiveConfig),
            metadata: {
              ...(resolvedOpts.kernelRunId !== undefined ? { run: resolvedOpts.kernelRunId } : {}),
              effectiveChanged,
            },
          },
        ],
        (deposited) => {
          const artifact = deposited[0]
          const effectiveArtifact = deposited[1]
          if (artifact === undefined || effectiveArtifact === undefined) {
            throw new Error('config reload deposit returned incomplete artifacts')
          }
          return {
            actor: DISPATCHER,
            type: 'dispatcher.config-reloaded',
            payload: {
              artifact: { kind: artifact.kind, rev: artifact.revision },
              restartRequired: [...restartRequired],
              effectiveChanged,
              ...(resolvedOpts.kernelRunId !== undefined
                ? {
                    run: resolvedOpts.kernelRunId,
                    effectiveConfig: {
                      kind: effectiveArtifact.kind,
                      rev: effectiveArtifact.revision,
                    },
                    roleWarnings: roleKeyWarnings(effectiveConfig),
                  }
                : {}),
            },
          }
        },
      )
      wiring.updateRuntimeReferences?.(effectiveConfig)
    },
  )

  // Launch flags are durable repository setters. Omission writes nothing, so
  // another dispatcher cannot clobber the latest operator choice with a value
  // it inferred at startup. Fresh-repository fallbacks live in the reducer.
  await wiring.store.ensureRepo(state.repo)
  const actor = humanActor(buildControlUser(resolvedOpts.env))
  if (resolvedOpts.intake !== undefined) {
    await wiring.store.appendRepo(state.repo, {
      actor,
      type: 'dispatcher.intake-set',
      payload: { enabled: resolvedOpts.intake },
    })
  }
  if (resolvedOpts.defaultAutoMerge !== undefined) {
    await wiring.store.appendRepo(state.repo, {
      actor,
      type: 'dispatcher.auto-merge-default-set',
      payload: { enabled: resolvedOpts.defaultAutoMerge },
    })
  }

  if (resolvedOpts.kernelRunId !== undefined) {
    await wiring.store.appendRepoWithArtifacts(
      state.repo,
      [
        {
          kind: DISPATCHER_EFFECTIVE_CONFIG_ARTIFACT,
          content: effectiveConfigContent(config),
          metadata: { run: resolvedOpts.kernelRunId, revision: 0 },
        },
      ],
      (deposited) => {
        const artifact = deposited[0]
        if (artifact === undefined) throw new Error('startup config deposit returned no artifact')
        return {
          actor: DISPATCHER,
          type: 'dispatcher.run-started',
          payload: {
            run: resolvedOpts.kernelRunId!,
            pid: process.pid,
            effectiveConfig: { kind: artifact.kind, rev: artifact.revision },
            roleWarnings: roleKeyWarnings(config),
          },
        }
      },
    )
  }

  const loop = new DispatchLoop(liveConfig, wiring, resolvedOpts)
  try {
    await loop.run()
    if (resolvedOpts.kernelRunId !== undefined) {
      await wiring.store.appendRepo(state.repo, {
        actor: DISPATCHER,
        type: 'dispatcher.run-stopped',
        payload: {
          run: resolvedOpts.kernelRunId,
          outcome: 'normal',
          exitCode: 0,
          ...(loop.supersededByPeer ? { reason: 'superseded' as const } : {}),
        },
      })
    }
  } catch (error) {
    if (resolvedOpts.kernelRunId !== undefined) {
      try {
        await wiring.store.appendRepo(state.repo, {
          actor: DISPATCHER,
          type: 'dispatcher.run-stopped',
          payload: {
            run: resolvedOpts.kernelRunId,
            outcome: 'abnormal',
            exitCode: 1,
            error: error instanceof Error ? error.message : String(error),
          },
        })
      } catch {
        // Preserve the kernel failure; the supervising frontend records exit.
      }
    }
    throw error
  } finally {
    if (resolvedOpts.wire === undefined) await wiring.store.close()
  }
}
