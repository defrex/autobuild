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
import { join } from 'node:path'
import semver from 'semver'
import { parseConfig } from '../config/load'
import { DISPATCHER_CONFIG_ARTIFACT, LiveConfig, type ConfigSnapshot } from '../config/live'
import { roleKeyWarnings, SLUG_ROLE } from '../config/roles'
import type { Config } from '../config/schema'
import { loadPlugins } from '../plugins/load'
import type { PluginRegistry } from '../plugins/registry'
import { materializePluginRuntimes } from '../plugins/runtimes'
import type { AbEvent } from '../events/catalog'
import { DISPATCHER, humanActor } from '../events/envelope'
import type { RepositoryEventWrite } from '../events/repository'
import { randomIds, randomUuids, type IdSource, type UuidSource } from '../ids'
import { reduceDispatchSettings } from '../kernel/dispatch-settings'
import { DEFAULT_MAX_HARVEST_RECOVERY_ATTEMPTS, reduceHarvest } from '../kernel/harvest'
import type { BuildState } from '../kernel/reducer'
import {
  buildDashboardFromProjected,
  dashboardBuildControl,
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
import type { TerminalInput, TerminalInputEvent, TerminalOut } from './terminal'
import { createForge, resolveForgeRegistration } from '../ports/forge/create'
import { createProductionRuntimes } from '../ports/runner/production'
import type { RuntimeRegistry } from '../ports/runner/runtime'
import { createTicketSource } from '../ports/tickets/create'
import type { Forge, TicketSource, WorkspaceProvider } from '../ports/types'
import { createWorkspaceProvider } from '../ports/workspace/create'
import type { Exec } from '../ports/workspace/git-worktree'
import { BuildRunner, LeaseHeldError, SetupFailureError } from '../processes/build-runner'
import { HarvestRunner, type HarvestRunnerResult } from '../processes/harvest-runner'
import { scanUnclaimedObservations } from '../processes/harvest'
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
import { resolveRepoState, type RepoStatePaths } from './repo-state'
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
}

export interface DispatchOpts {
  /** Repo the dispatcher serves (§12: one dispatcher per repo) — the cwd. */
  targetRepo: string
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

/** Latest open workspace's locally reachable path. Historical events predate
 * path evidence, so their provider ref remains the compatibility fallback. */
function openWorkspacePath(events: AbEvent[]): string | null {
  let open: string | null = null
  for (const event of events) {
    if (event.type === 'workspace.provisioned') {
      open = event.payload.path ?? event.payload.ref
    } else if (event.type === 'workspace.released') open = null
  }
  return open
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
  const forge = await createForge({
    name: config.forge,
    registry: plugins,
    env: opts.env,
    repoRoot: opts.targetRepo,
  })
  const opened = openStoreForRepoState(state, { env: opts.env })

  const tickets = await createTicketSource(
    config.tickets,
    opts.env,
    opened.repo,
    opened.localStateRoot,
    plugins,
  )
  const { runtimes } = createProductionRuntimes()
  // A local override relocates the whole tree. Remote stores still need local
  // scratch beneath the repository default. Plugin factories receive only
  // their explicit config plus repository/environment context.
  const workspaces = await createWorkspaceProvider(config.workspace, {
    registry: plugins,
    worktreeRoot: opened.worktreeRoot,
    repoRoot: opened.repo,
    env: opts.env,
  })

  return {
    store: opened.store,
    tickets,
    forge,
    workspaces,
    // Shipped registrations are shared with other non-phase judgment paths.
    // Model ids stay in config; production.ts owns adapter compatibility data.
    runtimes,
    storeRef: opened.storeRef,
    ...(opened.token !== undefined ? { token: opened.token } : {}),
    ids: randomIds(),
    uuids: randomUuids(),
    clock: systemClock,
    plugins,
  }
}

/** The dispatch loop: owns the Dispatcher, the in-process runner fleet, and
 * the tick cadence. One instance per `ab dispatch` invocation. */
class DispatchLoop {
  private readonly dispatcher: Dispatcher
  private readonly host = hostname()
  private readonly maxHarvestRecoveryAttempts = DEFAULT_MAX_HARVEST_RECOVERY_ATTEMPTS
  /** In-flight build and harvest runs (fire-and-forget) — awaited before a
   * `--once` exit so every visible workflow reaches a durable boundary. */
  private readonly inFlight = new Set<Promise<void>>()
  /** One active BuildRunner per slug in this dispatch process. The token is
   * reserved before async setup and makes cleanup identity-safe; the durable
   * build lease remains the cross-process recovery/exclusion gate. */
  private readonly activeBuildRuns = new Map<string, symbol>()
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
    this.dashboardBuilds = new DashboardBuildPollCache(wiring.store, opts.targetRepo, config)

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
      })
      return result.text
    }

    this.dispatcher = new Dispatcher({
      store: wiring.store,
      tickets: wiring.tickets,
      workspaces: wiring.workspaces,
      forge: wiring.forge,
      config,
      getConfig: () => this.liveConfig.current().config,
      repo: opts.targetRepo,
      exec: opts.exec,
      launchRunner: (slug) => this.launchRunner(slug),
      startHarvest: () => this.launchHarvest(),
      nameSlug,
      ids: wiring.ids,
      clock: wiring.clock,
      opts: {
        maxHarvestRecoveryAttempts: this.maxHarvestRecoveryAttempts,
      },
    })
  }

  private currentConfig(): ConfigSnapshot {
    return this.liveConfig.current()
  }

  private async appendStatus(event: RepositoryEventWrite): Promise<void> {
    if (this.opts.kernelRunId === undefined) return
    await this.wiring.store.appendRepo(this.opts.targetRepo, event)
  }

  private async refreshConfig(): Promise<void> {
    if (this.opts.once === true) return
    const outcome = await this.liveConfig.refreshFromDisk()
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
    const events = await this.wiring.store.getRepoEvents(this.opts.targetRepo)
    return reduceDispatchSettings(events)
  }

  private dispatcherTick(resumeCurrent: boolean): Promise<Awaited<ReturnType<Dispatcher['tick']>>> {
    return this.serialize(async () => {
      // Refresh before every watch decision. The owner publishes atomically;
      // everything below captures the resulting one snapshot for this tick.
      await this.refreshConfig()
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
          const scan = await scanUnclaimedObservations(this.wiring.store, this.opts.targetRepo)
          this.observationCount = scan.observations.length
        } catch (error) {
          this.warn(
            `dashboard observation scan failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
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

    const { store } = this.wiring
    const repo = this.opts.targetRepo
    const current = await this.readDispatchSettings()
    const enabled = !current.intake
    await store.appendRepo(repo, {
      actor: humanActor(buildControlUser(this.opts.env)),
      type: 'dispatcher.intake-set',
      payload: { enabled },
    })
    this.say(`dispatcher intake ${enabled ? 'ON' : 'OFF'}`)
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
      repo: this.opts.targetRepo,
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
        repo: this.opts.targetRepo,
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
        repo: this.opts.targetRepo,
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
        repo: this.opts.targetRepo,
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
        repo: this.opts.targetRepo,
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

    const { store } = this.wiring
    const repo = this.opts.targetRepo
    await store.ensureRepo(repo)
    const state = reduceHarvest(await store.getRepoEvents(repo))
    const pending = state.pendingCommands.at(-1)
    const requestedPaused = pending === undefined ? state.paused : pending.command === 'pause'
    const command = requestedPaused ? 'resume' : 'pause'
    await store.appendRepo(repo, {
      actor: humanActor(buildControlUser(this.opts.env)),
      type: command === 'resume' ? 'harvest.resume-requested' : 'harvest.pause-requested',
      payload: {},
    })
    this.say(`harvest gate: ${command} requested`)
    await this.renderOnce()
  }

  /** `p` on Harvest acts only on the concrete run captured at keypress time.
   * It never toggles the repository gate and never retargets a replacement run
   * that appeared while the action waited in the serialized queue. */
  private async controlHarvestRun(expectedRun: string | undefined): Promise<void> {
    const { store } = this.wiring
    const repo = this.opts.targetRepo
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

    await store.appendRepo(repo, {
      actor: humanActor(buildControlUser(this.opts.env)),
      type: 'harvest.resume-requested',
      payload: {},
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
        repo: this.opts.targetRepo,
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
      const { store } = this.wiring
      const repo = this.opts.targetRepo
      const current = await this.readDispatchSettings()
      const enabled = !current.defaultAutoMerge
      await store.appendRepo(repo, {
        actor: humanActor(buildControlUser(this.opts.env)),
        type: 'dispatcher.auto-merge-default-set',
        payload: { enabled },
      })
      this.say(`dispatcher auto-merge default ${enabled ? 'ON' : 'OFF'}`)
      await this.renderOnce()
      return
    }
    const slug = this.selectedBuildSlug('auto-merge')
    if (slug === undefined) return

    let result: BuildControlResult
    try {
      result = await controlBuild({
        store: this.wiring.store,
        repo: this.opts.targetRepo,
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
      repo: this.opts.targetRepo,
      workspacePath: this.opts.targetRepo,
      ids,
      uuids,
      clock,
      instance: `${this.host}-harvest-${ids('inst')}`,
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
          this.say(`harvest ${result.run} ${result.outcome}`)
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

  /** Construct a BuildRunner over the shared store/workspace and start it
   * without blocking the dispatcher. Capacity is enforced by the dispatcher's
   * active-count gate; the tracked promise lets `--once` drain it. A known
   * local run wins over a transiently stale lease, so polling cannot create a
   * second agent session for the same build while that run is still live. */
  private async launchRunner(slug: string): Promise<LaunchRunnerResult> {
    if (this.activeBuildRuns.has(slug)) return 'already-active'

    // Reserve before the first await: startup resume and later lease sweeps
    // share this seam, and neither may pass async setup for the same slug.
    const reservation = Symbol(slug)
    this.activeBuildRuns.set(slug, reservation)

    try {
      const { store, runtimes, ids, clock, storeRef, token } = this.wiring
      const record = await store.getBuild(slug)
      const workspacePath = openWorkspacePath(await store.getEvents(slug))
      if (record === null || workspacePath === null) {
        throw new Error(
          `launchRunner("${slug}"): no build record or open workspace — the ` +
            'dispatcher provisions both before launching (§12)',
        )
      }

      const runner = new BuildRunner({
        store,
        config: this.currentConfig().config,
        getConfig: () => this.currentConfig().config,
        runtimes,
        workspacePath,
        branch: record.branch ?? `ab/${slug}`,
        slug,
        exec: this.opts.exec,
        forge: this.wiring.forge,
        ids,
        clock,
        instance: `${this.host}-${slug}-${ids('inst')}`,
        host: this.host,
        // D8: sessions resolve THIS store; identity keys (AB_BUILD/PHASE/SESSION)
        // are stamped per session by the runner and never overridden here.
        sessionEnv: {
          AB_STORE: storeRef,
          ...(token !== undefined ? { AB_TOKEN: token } : {}),
        },
      })

      let tracked: Promise<void>
      tracked = runner
        .run()
        .then(
          async (state: BuildState) => {
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
            this.say(`build ${slug} parked (${state.status})`)
          },
          async (error: unknown) => {
            if (error instanceof LeaseHeldError) {
              await this.appendStatus({
                actor: DISPATCHER,
                type: 'dispatcher.runner-settled',
                payload: { run: this.opts.kernelRunId!, slug, outcome: 'lease-held' },
              })
              this.say(`build ${slug} already held by another runner — skipped`)
              return
            }
            await this.appendStatus({
              actor: DISPATCHER,
              type: 'dispatcher.runner-settled',
              payload: {
                run: this.opts.kernelRunId!,
                slug,
                outcome: 'failed',
                error: error instanceof Error ? error.message : String(error),
              },
            })
            const line = `build ${slug} runner failed: ${error instanceof Error ? error.message : String(error)}`
            // SetupFailureError has already deposited an attributed durable
            // fact. Plain mode still needs a line; the TTY gets the persistent
            // build-row projection on its next store poll, not a global notice.
            if (error instanceof SetupFailureError && this.dashboard) return
            this.warn(line)
          },
        )
        .finally(() => {
          this.inFlight.delete(tracked)
          // An old run must never clear a newer reservation for this slug.
          if (this.activeBuildRuns.get(slug) === reservation) {
            this.activeBuildRuns.delete(slug)
          }
        })
      this.inFlight.add(tracked)
      return 'scheduled'
    } catch (error) {
      // Preflight/setup failures never strand the slug. Identity-checking keeps
      // this safe if launch coordination grows more concurrent in the future.
      if (this.activeBuildRuns.get(slug) === reservation) {
        this.activeBuildRuns.delete(slug)
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

  private async drainInFlight(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight])
    }
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

  /** Report a completed operator action where the operator can see it. The
   * header's conditional row is one shared notice slot — a warning and an
   * action report compete for the same line, and the latest wins. `say` is
   * deliberately silent on a TTY, so a report routed through it would never
   * appear; `warn` would reach the row but write stderr in plain mode, which
   * this is not. Hence the third seam. */
  private announce(line: string): void {
    if (this.dashboard) this.setWarning(line)
    else this.opts.stdout(line)
  }

  private warn(line: string): void {
    if (this.dashboard) this.setWarning(line)
    else if (this.opts.silent !== true) this.opts.stderr(line)
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
      ticketDiagnostics,
      creationDiagnostics,
      dependencyDiagnostics,
      queued: _queued,
      ...counts
    } = report
    for (const line of janitorDiagnostics) this.warn(line)
    for (const line of ticketDiagnostics) this.warn(line)
    for (const line of creationDiagnostics) this.say(line)
    for (const line of dependencyDiagnostics) this.say(line)
    const parts = Object.entries(counts)
      .filter(([, count]) => typeof count === 'number' && count > 0)
      .map(([name, count]) => `${name}=${count}`)
    if (parts.length > 0) {
      this.say(`tick: ${parts.join(' ')}`)
      return true
    }
    // A tick that did something is worth a plain line. Interactive mode
    // suppresses both action counts and the every-10s idle noise.
    if (!this.dashboard && printIdle) {
      this.opts.stdout('tick: idle')
      return true
    }
    return (
      janitorDiagnostics.length > 0 ||
      ticketDiagnostics.length > 0 ||
      creationDiagnostics.length > 0 ||
      dependencyDiagnostics.length > 0
    )
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
    const repoRecord = await this.wiring.store.getRepo(this.opts.targetRepo)
    const repositoryEvents =
      repoRecord === null ? [] : await this.wiring.store.getRepoEvents(this.opts.targetRepo)

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
        repo: this.opts.targetRepo,
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

  async run(): Promise<void> {
    // Before the `--once` branch, so both modes report it exactly once.
    this.reportRoleDiagnostics()
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
        await this.finishRendering()
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
      while (!this.stopped) {
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
        if (this.stopped) break
        await sleep(intervalMs)
      }
    } finally {
      // Stop input and join teardown work first so every result that becomes
      // reportable at that boundary is included. Active Harvest work is still
      // deliberately not awaited in watch mode.
      await this.finishRendering()
      for (const report of await this.publishSettlementReports()) {
        this.printReport(report, false)
      }
    }
    // The finished interactive frame stays on screen; never append a late line
    // beneath it. Plain mode retains its historical shutdown line.
    if (!this.dashboard) this.say('ab dispatch stopped')
  }
}

/**
 * Entry point (§8.2). Loads the repo's config — whose required [tickets]
 * table selects the TicketSource and names its ready state. A file source with
 * no `dir` still defaults to `.autobuild/tickets` (§13). Then wires the ports
 * and runs until one pass finishes (`--once`) or `opts.signal` aborts (SIGINT).
 */
export async function abDispatch(opts: DispatchOpts): Promise<void> {
  const state = await resolveRepoState({
    targetRepo: opts.targetRepo,
    exec: opts.exec,
    ...(opts.storeRef !== undefined ? { storeRef: opts.storeRef } : {}),
    ...(opts.env.AB_STORE !== undefined ? { envStore: opts.env.AB_STORE } : {}),
  })
  // Normalize once, then use these exact values for config/tickets/repository
  // identity, store wiring, worktrees, and every session's AB_STORE.
  const resolvedOpts: DispatchOpts = {
    ...opts,
    targetRepo: state.repo,
    storeRef: state.storeRef,
  }

  // Interactive production dispatch is two programs. Resolve/open only the
  // Store in the terminal owner; config, plugins, adapters, runners, and ticket
  // I/O are constructed exclusively by the supervised private child. Injected
  // wiring remains the direct test/embedding seam, and every plain/non-TTY
  // invocation stays on the byte-compatible in-process kernel path below.
  if (
    resolvedOpts.kernelRunId === undefined &&
    resolvedOpts.wire === undefined &&
    resolvedOpts.plain !== true &&
    resolvedOpts.terminal?.interactive === true &&
    resolvedOpts.input !== undefined
  ) {
    const opened = openStoreForRepoState(state, { env: resolvedOpts.env })
    try {
      const frontend = new DispatchFrontend({
        repo: state.repo,
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
  // Configured plugin code is trusted like configured shell commands, but it
  // must resolve, evaluate, validate, and register before production wiring
  // opens a store, claims a ticket, or launches a runner.
  const plugins = await loadPlugins(config.plugins, resolvedOpts.targetRepo)
  // Validate the selector against the complete catalog before either custom
  // wiring or production wiring can open state or perform side effects.
  resolveForgeRegistration(config.forge, plugins)
  const wire = resolvedOpts.wire ?? defaultWire
  const wired = await wire(config, resolvedOpts, state, plugins)
  const runtimes = await materializePluginRuntimes(wired.runtimes, plugins, {
    repoRoot: resolvedOpts.targetRepo,
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
        resolvedOpts.targetRepo,
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
    },
  )

  // Launch flags are durable repository setters. Omission writes nothing, so
  // another dispatcher cannot clobber the latest operator choice with a value
  // it inferred at startup. Fresh-repository fallbacks live in the reducer.
  await wiring.store.ensureRepo(resolvedOpts.targetRepo)
  const actor = humanActor(buildControlUser(resolvedOpts.env))
  if (resolvedOpts.intake !== undefined) {
    await wiring.store.appendRepo(resolvedOpts.targetRepo, {
      actor,
      type: 'dispatcher.intake-set',
      payload: { enabled: resolvedOpts.intake },
    })
  }
  if (resolvedOpts.defaultAutoMerge !== undefined) {
    await wiring.store.appendRepo(resolvedOpts.targetRepo, {
      actor,
      type: 'dispatcher.auto-merge-default-set',
      payload: { enabled: resolvedOpts.defaultAutoMerge },
    })
  }

  if (resolvedOpts.kernelRunId !== undefined) {
    await wiring.store.appendRepoWithArtifacts(
      resolvedOpts.targetRepo,
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
      await wiring.store.appendRepo(resolvedOpts.targetRepo, {
        actor: DISPATCHER,
        type: 'dispatcher.run-stopped',
        payload: { run: resolvedOpts.kernelRunId, outcome: 'normal', exitCode: 0 },
      })
    }
  } catch (error) {
    if (resolvedOpts.kernelRunId !== undefined) {
      try {
        await wiring.store.appendRepo(resolvedOpts.targetRepo, {
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
