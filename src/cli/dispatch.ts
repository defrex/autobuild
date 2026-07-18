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
 * Concurrency is config, not code (§16.1): `[dispatcher].capacity` caps the
 * concurrent builds for this repo. `launchRunner` starts each build-runner
 * IN-PROCESS but does not block the dispatcher on it (fire-and-forget,
 * tracked) — so with capacity N up to N builds run at once, while the
 * dispatcher's own active-count gate (§12) keeps it from over-launching. A
 * runner drives its build to a park point (§11) and returns; the watch loop's
 * next tick advances the post-PR epilogue (§15.7).
 */
import { hostname } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../config/load'
import type { Config } from '../config/schema'
import type { AbEvent } from '../events/catalog'
import { humanActor } from '../events/envelope'
import { randomIds, type IdSource } from '../ids'
import { reduceBuild, type BuildState } from '../kernel/reducer'
import { buildDashboard, type DashboardModel } from './dashboard/model'
import { renderDashboard } from './dashboard/render'
import {
  moveSelection,
  reconcileSelection,
} from './dashboard/selection'
import { LiveRegion, paintableRows } from './dashboard/live'
import type { DashboardKey, TerminalInput, TerminalOut } from './terminal'
import { GitHubForge } from '../ports/forge/github'
import { ClaudeAgentRunner } from '../ports/runner/claude'
import { PiAgentRunner } from '../ports/runner/pi'
import { createRuntimeResolver, type RuntimeResolver } from '../ports/runner/routing'
import type { RuntimeRegistry } from '../ports/runner/runtime'
import { createTicketSource } from '../ports/tickets/create'
import type { Forge, TicketSource, WorkspaceProvider } from '../ports/types'
import { GitWorktreeProvider, type Exec } from '../ports/workspace/git-worktree'
import { BuildRunner, LeaseHeldError } from '../processes/build-runner'
import {
  HarvestRunner,
  type HarvestRunnerResult,
} from '../processes/harvest-runner'
import {
  Dispatcher,
  emptyTickReport,
  type TickReport,
} from '../processes/dispatcher'
import { RemoteBuildStore } from '../store/remote/client'
import { DEFAULT_LOCAL_ROOT } from '../store/local/store'
import { resolveStore } from './store-ref'
import { systemClock, type BuildStore, type Clock } from '../store/types'

/** Watch-loop default cadence between ticks (§3.3 re-run safety makes this a
 * pure knob — a shorter interval only polls the forge more often). */
const DEFAULT_INTERVAL_MS = 10_000

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

/** Dashboard redraw cadence. `listBuilds` is not subscribable, so polling the
 * list is the honest mechanism; the identical-frame check in `live.ts` makes a
 * poll that finds nothing new cost zero writes. Near subscribe's
 * DEFAULT_POLL_MS (store/subscribe.ts:10) — a pure knob: raise it if a
 * RemoteBuildStore makes each frame's HTTP calls bite. */
const DASHBOARD_POLL_MS = 500

/** Dashboard repaint (not re-read) cadence in watch mode. A running step's
 * elapsed must advance ~1×/s even if the store poll is raised for a slow remote
 * store, so paint is decoupled from the store read and driven from this cheaper
 * timer. A knob: the identical-frame check in `live.ts` collapses a repaint to
 * zero writes until a displayed second actually changes, so a sub-second cadence
 * costs nothing. `--once` runs no tick timer — it renders one snapshot per
 * state (AC 8). */
const DASHBOARD_TICK_MS = 250

/** The real adapters the loop drives — resolved by `wire` (default: the
 * production ports; tests inject fakes). */
export interface DispatchWiring {
  store: BuildStore
  tickets: TicketSource
  forge: Forge
  workspaces: WorkspaceProvider
  /** Runtime registry (§9): name → adapter + compatibility data. The resolver
   * applies `[roles]`; `defaultRuntime` is the wiring fallback. */
  runtimes: RuntimeRegistry
  defaultRuntime: string
  /** The store reference sessions resolve as `AB_STORE` (D8) — MUST name the
   * same store as `store`, so an agent's `ab` commands write where the
   * dispatcher reads. */
  storeRef: string
  /** Scoped token for a remote store (D8, `AB_TOKEN`); passed to sessions. */
  token?: string
  ids: IdSource
  clock: Clock
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
  /** `AB_STORE` override; default the local store at ~/.autobuild. */
  storeRef?: string
  /** Watch-loop stop signal — the binary aborts it on SIGINT (§15.6-C: an
   * interrupted runner's lease expires and a future dispatch re-attaches). */
  signal?: AbortSignal
  /** Injectable for tests — defaults to the production adapters. */
  wire?: (config: Config, opts: DispatchOpts) => Promise<DispatchWiring> | DispatchWiring
  /** Injectable sleep (watch loop); default a real timer. Tests use `once`. */
  sleep?: (ms: number) => Promise<void>
  /** Force line-oriented output with no terminal control sequences (`--plain`),
   * whatever the terminal says. */
  plain?: boolean
  /**
   * The interactive output seam. ABSENT ⇒ non-interactive ⇒ plain — which is
   * exactly today's behavior, so the dashboard can never be the reason a
   * scripted or piped `ab dispatch` starts emitting escapes. `bin/ab.ts`
   * constructs the real one over `process.stdout`.
   */
  terminal?: TerminalOut
  /** Injectable normalized key source; the binary wraps process.stdin. */
  input?: TerminalInput
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

/** Latest `workspace.provisioned` ref not followed by `workspace.released` —
 * the same projection the dispatcher's janitor scans for (§15.7). */
function openWorkspaceRef(events: AbEvent[]): string | null {
  let open: string | null = null
  for (const event of events) {
    if (event.type === 'workspace.provisioned') open = event.payload.ref
    else if (event.type === 'workspace.released') open = null
  }
  return open
}

/** Production wiring: the local (or remote) store, the configured
 * TicketSource, the GitHub forge, git worktrees, and shipped runtimes. */
async function defaultWire(config: Config, opts: DispatchOpts): Promise<DispatchWiring> {
  const storeRef = opts.storeRef ?? DEFAULT_LOCAL_ROOT
  const token = opts.env['AB_TOKEN']
  const store = resolveStore(storeRef, {
    remoteFactory: (url, tok) => new RemoteBuildStore({ url, token: tok }),
    ...(token !== undefined && token !== '' ? { token } : {}),
  })

  const tickets = createTicketSource(config.tickets, opts.env, opts.targetRepo)
  // One adapter instance carries both capabilities. A one-shot completion is
  // pre-build judgment, not a second phase runner or a resumable session.
  const claude = new ClaudeAgentRunner()
  const pi = new PiAgentRunner()

  return {
    store,
    tickets,
    forge: new GitHubForge(),
    // Worktrees live under the autobuild home, never inside the repo tree.
    workspaces: new GitWorktreeProvider({ root: join(DEFAULT_LOCAL_ROOT, 'worktrees') }),
    // Two registered runtimes (§9): claude serves Claude models (its own SDK
    // default model ⇒ no `defaultModel`); pi validates configured models against
    // its provider catalog. Pi model ids are provider-qualified
    // (`<provider>/<id>`), so pi's prefixes are provider names — no overlap with
    // claude's bare `claude-*`. Add a provider prefix here to accept more of
    // Pi's catalog; `ab models` lists the ids. Model ids stay in config, not here.
    runtimes: {
      claude: { runner: claude, oneShot: claude, servesModels: ['claude-'] },
      pi: {
        runner: pi,
        oneShot: pi,
        servesModels: [
          // OAuth coding providers (what `pi login` writes to auth.json).
          'openai-codex/',
          'kimi-coding/',
          // API-key providers, for keys supplied via env/auth.json.
          'openai/',
          'moonshotai/',
          'cloudflare-workers-ai/',
          'anthropic/',
          'openrouter/',
        ],
        defaultModel: 'kimi-coding/k3',
      },
    },
    defaultRuntime: 'claude',
    storeRef,
    ...(token !== undefined && token !== '' ? { token } : {}),
    ids: randomIds(),
    clock: systemClock,
  }
}

/** The dispatch loop: owns the Dispatcher, the in-process runner fleet, and
 * the tick cadence. One instance per `ab dispatch` invocation. */
class DispatchLoop {
  private readonly dispatcher: Dispatcher
  private readonly host = hostname()
  /** In-flight build and harvest runs (fire-and-forget) — awaited before a
   * `--once` exit so every visible workflow reaches a durable boundary. */
  private readonly inFlight = new Set<Promise<void>>()
  /** Process-local fast path; the repository lease is the cross-process gate. */
  private harvestInFlight: Promise<void> | undefined
  /** Outcomes settle outside Dispatcher.tick(), then merge into the next
   * printed report (or the final --once report after drain). */
  private pendingHarvest = {
    harvestStarted: 0,
    harvestResumed: 0,
    harvestCompleted: 0,
    harvestEscalated: 0,
    harvestFailed: 0,
  }
  /**
   * Interactive dashboard on. `opts.terminal?.interactive === true` — an
   * absent terminal yields `undefined === true` ⇒ false ⇒ today's exact
   * behavior, which is what keeps every existing dispatch test passing
   * untouched and makes plain the default rather than a mode.
   */
  private readonly dashboard: boolean
  private readonly region: LiveRegion | undefined
  /** Guard against overlapping polls, exactly as pollingSubscribe does. */
  private rendering = false
  private timer: ReturnType<typeof setInterval> | undefined
  /** Watch-mode paint timer (AC 8): repaints the CACHED model against a fresh
   * clock so running elapsed ticks between store reads. Absent in `--once`. */
  private tickTimer: ReturnType<typeof setInterval> | undefined
  /** The last projected model, repainted by `paint()` against a moving clock.
   * Read from the store by `renderOnce`; timing is now-independent so the same
   * model ticks without a re-read. */
  private model: DashboardModel | undefined
  /** Ephemeral per-process controls — deliberately absent from durable state. */
  private selectedSlug: string | undefined
  private drained = false
  /** One queue defines order between ticks and mutating keys. */
  private operationTail: Promise<void> = Promise.resolve()
  private acceptingKeys = false
  private cleanupInput: (() => void) | undefined
  /** Raw Ctrl-C does not raise SIGINT; this wakes the same watch loop. */
  private readonly inputStop = new AbortController()

  constructor(
    private readonly config: Config,
    private readonly wiring: DispatchWiring,
    private readonly opts: DispatchOpts,
    resolver: RuntimeResolver,
  ) {
    this.dashboard = opts.terminal?.interactive === true && opts.plain !== true
    this.region =
      this.dashboard && opts.terminal !== undefined ? new LiveRegion(opts.terminal) : undefined

    // `slug` is an internal pre-build role on the same runtime/model resolver. A
    // runtime without the optional capability is normal: omit the seam and let
    // the dispatcher take its deterministic title fallback.
    const resolvedSlug = resolver.resolve('slug')
    const oneShot = wiring.runtimes[resolvedSlug.runtime]?.oneShot
    const nameSlug =
      oneShot === undefined
        ? undefined
        : async (spec: string, signal: AbortSignal): Promise<string> => {
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
      repo: opts.targetRepo,
      exec: opts.exec,
      launchRunner: (slug) => this.launchRunner(slug),
      startHarvest: () => this.launchHarvest(),
      ...(nameSlug !== undefined ? { nameSlug } : {}),
      ids: wiring.ids,
      clock: wiring.clock,
    })
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

  private dispatcherTick(resumeCurrent: boolean): Promise<Awaited<ReturnType<Dispatcher['tick']>>> {
    return this.serialize(() =>
      this.dispatcher.tick({
        resumeCurrent,
        acceptNewWork: !this.drained,
      }),
    )
  }

  private dashboardUser(): string {
    for (const name of ['USER', 'USERNAME']) {
      const value = this.opts.env[name]?.trim()
      if (value !== undefined && value !== '') return value
    }
    return 'dashboard'
  }

  /** Remove a stale optional selectedSlug while retaining current drain. */
  private syncModelControls(): void {
    if (this.model === undefined) return
    const { selectedSlug: _old, ...base } = this.model
    this.model = {
      ...base,
      drained: this.drained,
      ...(this.selectedSlug !== undefined
        ? { selectedSlug: this.selectedSlug }
        : {}),
    }
  }

  private moveSelection(delta: number): void {
    const slugs = this.model?.builds.map((build) => build.slug) ?? []
    this.selectedSlug = moveSelection(slugs, this.selectedSlug, delta)
    this.syncModelControls()
    this.paint()
  }

  private async selectedBuild(): Promise<
    { slug: string; state: BuildState } | undefined
  > {
    const slug = this.selectedSlug
    if (slug === undefined) {
      this.warn('dashboard action ignored: no active build is selected')
      return undefined
    }
    const record = await this.wiring.store.getBuild(slug)
    if (record === null || record.repo !== this.opts.targetRepo) {
      this.warn(`dashboard action ignored: selected build ${slug} disappeared`)
      await this.renderOnce()
      return undefined
    }
    const state = reduceBuild(await this.wiring.store.getEvents(slug))
    if (!['running', 'paused', 'blocked'].includes(state.status)) {
      this.warn(`dashboard action ignored: selected build ${slug} is no longer active`)
      await this.renderOnce()
      return undefined
    }
    return { slug, state }
  }

  private async togglePause(): Promise<void> {
    const selected = await this.selectedBuild()
    if (selected === undefined) return
    const resume = selected.state.status === 'paused'
    await this.wiring.store.append(selected.slug, {
      actor: humanActor(this.dashboardUser()),
      type: resume ? 'build.resume-requested' : 'build.pause-requested',
      payload: {},
    })
    this.say(`build ${selected.slug}: ${resume ? 'resume' : 'pause'} requested`)
    await this.renderOnce()
  }

  private async toggleAutoMerge(): Promise<void> {
    const selected = await this.selectedBuild()
    if (selected === undefined) return
    const cancel = selected.state.autoMerge.requested
    await this.wiring.store.append(selected.slug, {
      actor: humanActor(this.dashboardUser()),
      type: cancel
        ? 'build.auto-merge-cancelled'
        : 'build.auto-merge-requested',
      payload: {},
    })
    this.say(
      `build ${selected.slug}: auto-merge ${cancel ? 'cancelled' : 'requested'}`,
    )
    await this.renderOnce()
  }

  private async handleKey(key: Exclude<DashboardKey, 'interrupt'>): Promise<void> {
    switch (key) {
      case 'up':
        this.moveSelection(-1)
        return
      case 'down':
        this.moveSelection(1)
        return
      case 'drain':
        this.drained = !this.drained
        this.syncModelControls()
        this.paint()
        this.say(`dispatcher drain ${this.drained ? 'on' : 'off'}`)
        return
      case 'pause':
        await this.togglePause()
        return
      case 'auto-merge':
        await this.toggleAutoMerge()
        return
    }
  }

  private onKey(key: DashboardKey): void {
    if (!this.acceptingKeys) return
    if (key === 'interrupt') {
      this.acceptingKeys = false
      this.inputStop.abort()
      return
    }
    void this.serialize(() => this.handleKey(key)).catch((error: unknown) => {
      this.warn(
        `dashboard ${key} action failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
  }

  private startInput(): void {
    if (!this.dashboard || this.opts.input === undefined) return
    this.acceptingKeys = true
    this.cleanupInput = this.opts.input.start((key) => this.onKey(key))
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

    const { store, tickets, runtimes, defaultRuntime, ids, clock, storeRef, token } =
      this.wiring
    const runner = new HarvestRunner({
      store,
      tickets,
      config: this.config,
      runtimes,
      defaultRuntime,
      repo: this.opts.targetRepo,
      workspacePath: this.opts.targetRepo,
      ids,
      clock,
      instance: `${this.host}-harvest-${ids('inst')}`,
      sessionEnv: {
        AB_STORE: storeRef,
        ...(token !== undefined ? { AB_TOKEN: token } : {}),
      },
    })

    let tracked: Promise<void>
    tracked = runner
      .run()
      .then((result) => {
        this.recordHarvestResult(result)
        if (
          !this.stopped &&
          result.outcome !== 'idle' &&
          result.outcome !== 'held'
        ) {
          this.say(`harvest ${result.run} ${result.outcome}`)
        }
      })
      .catch((error: unknown) => {
        this.pendingHarvest.harvestFailed += 1
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

  /** Merge asynchronously settled harvest outcomes exactly once. */
  private consumeHarvestResults(report: TickReport): TickReport {
    report.harvestStarted += this.pendingHarvest.harvestStarted
    report.harvestResumed += this.pendingHarvest.harvestResumed
    report.harvestCompleted += this.pendingHarvest.harvestCompleted
    report.harvestEscalated += this.pendingHarvest.harvestEscalated
    report.harvestFailed += this.pendingHarvest.harvestFailed
    this.pendingHarvest = {
      harvestStarted: 0,
      harvestResumed: 0,
      harvestCompleted: 0,
      harvestEscalated: 0,
      harvestFailed: 0,
    }
    return report
  }

  /** Construct a BuildRunner over the shared store/workspace and start it
   * without blocking the dispatcher. Capacity is enforced by the dispatcher's
   * active-count gate; the tracked promise lets `--once` drain it. */
  private async launchRunner(slug: string): Promise<void> {
    const { store, runtimes, defaultRuntime, ids, clock, storeRef, token } = this.wiring
    const record = await store.getBuild(slug)
    const wsRef = openWorkspaceRef(await store.getEvents(slug))
    if (record === null || wsRef === null) {
      throw new Error(
        `launchRunner("${slug}"): no build record or open workspace — the ` +
          'dispatcher provisions both before launching (§12)',
      )
    }

    const runner = new BuildRunner({
      store,
      config: this.config,
      runtimes,
      defaultRuntime,
      workspacePath: wsRef,
      branch: record.branch ?? `ab/${slug}`,
      slug,
      exec: this.opts.exec,
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

    const run = runner
      .run()
      .then(
        (state: BuildState) => {
          this.say(`build ${slug} parked (${state.status})`)
        },
        (error: unknown) => {
          if (error instanceof LeaseHeldError) {
            this.say(`build ${slug} already held by another runner — skipped`)
            return
          }
          this.warn(
            `build ${slug} runner failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        },
      )
      .finally(() => {
        this.inFlight.delete(run)
      })
    this.inFlight.add(run)
  }

  private get stopped(): boolean {
    return this.opts.signal?.aborted === true || this.inputStop.signal.aborted
  }

  private async drainInFlight(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight])
    }
  }

  // ── Message routing (dashboard mode) ──────────────────────────────────────
  //
  // ONE rule: the dashboard is a SUPPLEMENT to the line output, never a
  // replacement. The only line it suppresses is a literal no-op `tick: idle`.
  // Every other line still prints, on the stream it uses today — routed
  // through the region so it scrolls above the frame instead of being eaten by
  // the next repaint. A parked-`done` build is filtered OUT of the dashboard
  // by construction, and TickReport carries bounced/claimRaces/merged/abandoned
  // counts no row ever shows, so suppressing these would be an information
  // regression — worst in the interactive `--once` an operator runs by hand.
  //
  // Net effect: interactive `ab dispatch` prints strictly MORE than plain.

  /** A line on stdout, above the frame. */
  private say(line: string): void {
    if (this.region !== undefined) this.region.log(line, this.opts.stdout)
    else this.opts.stdout(line)
  }

  /** A line on stderr, above the frame — the stream is never rewritten. */
  private warn(line: string): void {
    if (this.region !== undefined) this.region.log(line, this.opts.stderr)
    else this.opts.stderr(line)
  }

  /**
   * Dependency diagnostics print as their own lines above the counts — this
   * is the operator's only view of why a ready ticket is sitting still, and
   * the acceptance criterion is that it needs no provider, filesystem, or
   * database inspection. The counts map guards on `typeof count === 'number'`
   * because a non-numeric TickReport field would otherwise be dropped here
   * silently (`count > 0` is false for an array, with no type error).
   *
   * The diagnostics route through `say()` rather than `opts.stdout` for the
   * reason given above: on a TTY a raw write would land inside the frame the
   * region is about to repaint. `say()` is the identity in plain mode, so
   * their line-oriented behavior is unchanged.
   */
  private printReport(
    report: Awaited<ReturnType<Dispatcher['tick']>>,
    printIdle = true,
  ): boolean {
    const { dependencyDiagnostics, ...counts } = report
    for (const line of dependencyDiagnostics) this.say(line)
    const parts = Object.entries(counts)
      .filter(([, count]) => typeof count === 'number' && count > 0)
      .map(([name, count]) => `${name}=${count}`)
    if (parts.length > 0) {
      this.say(`tick: ${parts.join(' ')}`)
      return true
    }
    // A tick that did something is worth a scroll line; a tick that did
    // nothing is the every-10s noise the dashboard replaces.
    if (!this.dashboard && printIdle) {
      this.opts.stdout('tick: idle')
      return true
    }
    return dependencyDiagnostics.length > 0
  }

  // ── The live region ───────────────────────────────────────────────────────

  /**
   * The store READ half of a frame: read every build this repo owns, reduce
   * each, project into a cached model, then paint it. Read-only — it appends
   * nothing and decides nothing. Paint is split out so the watch-mode tick timer
   * can repaint the cached model against a moving clock without re-reading.
   */
  private async renderOnce(): Promise<void> {
    const { terminal } = this.opts
    if (this.region === undefined || terminal === undefined) return
    const records = await this.wiring.store.listBuilds()
    const entries = []
    for (const record of records) {
      // §12 scoping, mirroring the dispatcher: a shared store holds other
      // repos' builds, and aggregating across repos is out of scope.
      if (record.repo !== this.opts.targetRepo) continue
      const events = await this.wiring.store.getEvents(record.slug)
      entries.push({ record, state: reduceBuild(events), events })
    }
    const previousSlugs = this.model?.builds.map((build) => build.slug) ?? []
    const repoRecord = await this.wiring.store.getRepo(this.opts.targetRepo)
    const harvestEvents =
      repoRecord === null
        ? []
        : await this.wiring.store.getRepoEvents(this.opts.targetRepo)
    const projected = buildDashboard(
      entries,
      this.config,
      {
        repo: this.opts.targetRepo,
        mode: this.opts.once === true ? 'once' : 'watch',
        capacity: this.config.dispatcher.capacity,
        drained: this.drained,
      },
      harvestEvents,
    )
    const nextSlugs = projected.builds.map((build) => build.slug)
    this.selectedSlug = reconcileSelection(
      previousSlugs,
      nextSlugs,
      this.selectedSlug,
    )
    this.model = {
      ...projected,
      ...(this.selectedSlug !== undefined
        ? { selectedSlug: this.selectedSlug }
        : {}),
    }
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
    this.region.update(
      renderDashboard(this.model, {
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

  private startRendering(): void {
    if (!this.dashboard || this.timer !== undefined) return
    const tick = (): void => {
      if (this.rendering) return // no overlapping polls
      this.rendering = true
      void this.renderOnce()
        .catch((error: unknown) => {
          // A transient store error must never kill dispatch — the dashboard
          // is a view, and a view that throws is a bug in the view.
          this.warn(
            `dashboard render failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        })
        .finally(() => {
          this.rendering = false
        })
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

  private stopRendering(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    if (this.tickTimer !== undefined) clearInterval(this.tickTimer)
    this.tickTimer = undefined
  }

  /** Stop polling, paint the truth one last time, release the region. Every
   * exit path runs this — including SIGINT — or the operator's shell is left
   * without a cursor. */
  private async finishRendering(): Promise<void> {
    if (!this.dashboard) return
    // No new keys or polls may begin once teardown starts. Already queued
    // actions finish before the final truth is painted and raw mode/cursor are
    // considered released.
    try {
      this.stopInput()
    } catch (error) {
      // Cursor restoration must not be skipped just because stdin restoration
      // itself failed. Keep the failure visible above the final frame.
      this.warn(
        `dashboard input cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    this.stopRendering()
    await this.operationTail
    try {
      await this.renderOnce()
    } catch {
      // Best-effort: a failed final frame must not mask the run's outcome.
    } finally {
      this.region?.finish()
    }
  }

  async run(): Promise<void> {
    const capacity = this.config.dispatcher.capacity
    if (this.opts.once) {
      this.say(`ab dispatch — one pass over ${this.opts.targetRepo} (capacity ${capacity})`)
      // Render BEFORE the tick and until the drain finishes, so the operator
      // watches the initial pass's builds change state while they run. The
      // render loop only reads: `--once` still calls tick() exactly ONCE, so
      // it never claims a ticket that becomes Ready mid-drain.
      try {
        this.startInput()
        this.startRendering()
        const initial = this.consumeHarvestResults(
          await this.dispatcherTick(true),
        )
        const initialPrinted = this.printReport(initial, false)
        await this.drainInFlight()
        const settledPrinted = this.printReport(
          this.consumeHarvestResults(emptyTickReport()),
          false,
        )
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
      ((ms: number) =>
        interruptibleSleep(ms, [this.opts.signal, this.inputStop.signal]))
    this.say(
      `ab dispatch — watching ${this.opts.targetRepo} (capacity ${capacity}, ` +
        `every ${Math.round(intervalMs / 1000)}s) — Ctrl-C to stop`,
    )
    try {
      this.startInput()
      this.startRendering()
      let startup = true
      while (!this.stopped) {
        try {
          const report = this.consumeHarvestResults(
            await this.dispatcherTick(startup),
          )
          this.printReport(report, this.harvestInFlight === undefined)
          startup = false
        } catch (error) {
          this.warn(`tick failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (this.stopped) break
        await sleep(intervalMs)
      }
    } finally {
      // A result that settled after the final tick still gets one attributed
      // counter line; active work is deliberately not awaited in watch mode.
      this.printReport(
        this.consumeHarvestResults(emptyTickReport()),
        false,
      )
      // SIGINT lands here too: without it the region keeps the cursor hidden.
      await this.finishRendering()
    }
    this.say('ab dispatch stopped')
  }
}

/**
 * Entry point (§8.2). Loads the repo's config — whose required [tickets]
 * table selects the TicketSource and names its ready state. A file source with
 * no `dir` still defaults to `.autobuild/tickets` (§13). Then wires the ports
 * and runs until one pass finishes (`--once`) or `opts.signal` aborts (SIGINT).
 */
export async function abDispatch(opts: DispatchOpts): Promise<void> {
  const configPath = join(opts.targetRepo, 'autobuild.toml')
  let config: Config
  try {
    config = await loadConfig(configPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `${configPath}: not found — 'ab dispatch' runs from the repo root and ` +
          'reads its autobuild.toml (SPEC §8.2, §16.1)',
      )
    }
    throw error
  }
  const wire = opts.wire ?? defaultWire
  const wiring = await wire(config, opts)
  // §9: resolve the whole config against the registry ONCE, at startup — a
  // config naming an unregistered runtime or an incompatible merged
  // runtime/model pair fails `ab dispatch` loudly here, before any build
  // launches, never as a silent per-build fallback. The per-build BuildRunner
  // re-resolves too (its own construction is the second guard).
  const resolver = createRuntimeResolver(
    wiring.runtimes,
    config.roles,
    wiring.defaultRuntime,
  )
  const loop = new DispatchLoop(config, wiring, opts, resolver)
  await loop.run()
}
