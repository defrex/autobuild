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
import { join, resolve } from 'node:path'
import { loadConfig } from '../config/load'
import type { Config, TicketsConfig } from '../config/schema'
import type { AbEvent } from '../events/catalog'
import { randomIds, type IdSource } from '../ids'
import { reduceBuild, type BuildState } from '../kernel/reducer'
import { buildDashboard } from './dashboard/model'
import { renderDashboard } from './dashboard/render'
import { LiveRegion, paintableRows } from './dashboard/live'
import type { TerminalOut } from './terminal'
import { GitHubForge } from '../ports/forge/github'
import { ClaudeAgentRunner } from '../ports/runner/claude'
import { createTicketSource } from '../ports/tickets/create'
import type {
  AgentRunner,
  Forge,
  TicketSource,
  WorkspaceProvider,
} from '../ports/types'
import { GitWorktreeProvider, type Exec } from '../ports/workspace/git-worktree'
import { BuildRunner, LeaseHeldError } from '../processes/build-runner'
import { Dispatcher } from '../processes/dispatcher'
import { RemoteBuildStore } from '../store/remote/client'
import { DEFAULT_LOCAL_ROOT } from '../store/local/store'
import { resolveStore } from './store-ref'
import { systemClock, type BuildStore, type Clock } from '../store/types'

/** Watch-loop default cadence between ticks (§3.3 re-run safety makes this a
 * pure knob — a shorter interval only polls the forge more often). */
const DEFAULT_INTERVAL_MS = 10_000

/** Dashboard redraw cadence. `listBuilds` is not subscribable, so polling the
 * list is the honest mechanism; the identical-frame check in `live.ts` makes a
 * poll that finds nothing new cost zero writes. Near subscribe's
 * DEFAULT_POLL_MS (store/subscribe.ts:10) — a pure knob: raise it if a
 * RemoteBuildStore makes each frame's HTTP calls bite. */
const DASHBOARD_POLL_MS = 500

/** The real adapters the loop drives — resolved by `wire` (default: the
 * production ports; tests inject fakes). */
export interface DispatchWiring {
  store: BuildStore
  tickets: TicketSource
  forge: Forge
  workspaces: WorkspaceProvider
  /** Runner registry (§9): `[roles]` routes into it; `defaultRunner` is the
   * fallback. */
  runners: Record<string, AgentRunner>
  defaultRunner: string
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
}

/** setTimeout that also resolves the moment `signal` aborts, so Ctrl-C
 * doesn't wait out the whole interval. */
function interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolveSleep) => {
    if (signal?.aborted === true) return resolveSleep()
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolveSleep()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolveSleep()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
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
 * TicketSource, the GitHub forge, git worktrees, and the Claude runner. */
async function defaultWire(config: Config, opts: DispatchOpts): Promise<DispatchWiring> {
  const storeRef = opts.storeRef ?? DEFAULT_LOCAL_ROOT
  const token = opts.env['AB_TOKEN']
  const store = resolveStore(storeRef, {
    remoteFactory: (url, tok) => new RemoteBuildStore({ url, token: tok }),
    ...(token !== undefined && token !== '' ? { token } : {}),
  })

  // A relative [tickets].dir is relative to the repo, not this process's cwd
  // (mirrors `ab ticket create`).
  if (config.tickets === undefined) {
    throw new Error('unreachable: abDispatch checks config.tickets before wiring')
  }
  const ticketsConfig: TicketsConfig =
    config.tickets.dir !== undefined
      ? { ...config.tickets, dir: resolve(opts.targetRepo, config.tickets.dir) }
      : config.tickets
  const tickets = createTicketSource(ticketsConfig, opts.env)

  return {
    store,
    tickets,
    forge: new GitHubForge(),
    // Worktrees live under the autobuild home, never inside the repo tree.
    workspaces: new GitWorktreeProvider({ root: join(DEFAULT_LOCAL_ROOT, 'worktrees') }),
    runners: { claude: new ClaudeAgentRunner() },
    defaultRunner: 'claude',
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
  /** In-flight runner runs (fire-and-forget) — awaited before a `--once`
   * exit so builds actually reach a park point. */
  private readonly inFlight = new Set<Promise<void>>()
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

  constructor(
    private readonly config: Config,
    private readonly wiring: DispatchWiring,
    private readonly opts: DispatchOpts,
  ) {
    this.dashboard = opts.terminal?.interactive === true && opts.plain !== true
    this.region =
      this.dashboard && opts.terminal !== undefined ? new LiveRegion(opts.terminal) : undefined
    this.dispatcher = new Dispatcher({
      store: wiring.store,
      tickets: wiring.tickets,
      workspaces: wiring.workspaces,
      forge: wiring.forge,
      config,
      repo: opts.targetRepo,
      exec: opts.exec,
      launchRunner: (slug) => this.launchRunner(slug),
      ids: wiring.ids,
      clock: wiring.clock,
    })
  }

  /**
   * §3.3, §15.6-C, §15.7: construct a BuildRunner over the shared store and
   * the build's provisioned workspace, and start it WITHOUT blocking the
   * dispatcher — capacity (§16.1) is enforced by the dispatcher's active-count
   * gate, not by serializing runs here. The run is tracked so a `--once` exit
   * can drain it; a LeaseHeldError is expected (another runner owns it) and
   * only noted.
   */
  private async launchRunner(slug: string): Promise<void> {
    const { store, runners, defaultRunner, ids, clock, storeRef, token } = this.wiring
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
      runners,
      defaultRunner,
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
    return this.opts.signal?.aborted === true
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

  private printReport(report: Awaited<ReturnType<Dispatcher['tick']>>): void {
    const parts = Object.entries(report)
      .filter(([, count]) => count > 0)
      .map(([name, count]) => `${name}=${count}`)
    if (parts.length > 0) {
      this.say(`tick: ${parts.join(' ')}`)
      return
    }
    // A tick that did something is worth a scroll line; a tick that did
    // nothing is the every-10s noise the dashboard replaces.
    if (!this.dashboard) this.opts.stdout('tick: idle')
  }

  // ── The live region ───────────────────────────────────────────────────────

  /**
   * One frame: read every build this repo owns, reduce each, project, render,
   * repaint. Read-only — it appends nothing and decides nothing.
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
      entries.push({ record, state: reduceBuild(await this.wiring.store.getEvents(record.slug)) })
    }
    const model = buildDashboard(entries, this.config, {
      repo: this.opts.targetRepo,
      mode: this.opts.once === true ? 'once' : 'watch',
      capacity: this.config.dispatcher.capacity,
    })
    this.region.update(
      renderDashboard(model, {
        color: true,
        width: terminal.columns,
        // NOT `terminal.rows` — the region's trailing newline needs a row of
        // its own, so a frame of exactly `rows` scrolls its own header off.
        // See `paintableRows`.
        height: paintableRows(terminal.rows),
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
    tick()
  }

  private stopRendering(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  /** Stop polling, paint the truth one last time, release the region. Every
   * exit path runs this — including SIGINT — or the operator's shell is left
   * without a cursor. */
  private async finishRendering(): Promise<void> {
    if (!this.dashboard) return
    this.stopRendering()
    try {
      await this.renderOnce()
    } catch {
      // Best-effort: a failed final frame must not mask the run's outcome.
    }
    this.region?.finish()
  }

  async run(): Promise<void> {
    const capacity = this.config.dispatcher.capacity
    if (this.opts.once) {
      this.say(`ab dispatch — one pass over ${this.opts.targetRepo} (capacity ${capacity})`)
      // Render BEFORE the tick and until the drain finishes, so the operator
      // watches the initial pass's builds change state while they run. The
      // render loop only reads: `--once` still calls tick() exactly ONCE, so
      // it never claims a ticket that becomes Ready mid-drain.
      this.startRendering()
      try {
        this.printReport(await this.dispatcher.tick({ resumeCurrent: true }))
        await this.drainInFlight()
      } finally {
        await this.finishRendering()
      }
      return
    }

    const intervalMs = this.opts.intervalMs ?? DEFAULT_INTERVAL_MS
    const sleep =
      this.opts.sleep ?? ((ms: number) => interruptibleSleep(ms, this.opts.signal))
    this.say(
      `ab dispatch — watching ${this.opts.targetRepo} (capacity ${capacity}, ` +
        `every ${Math.round(intervalMs / 1000)}s) — Ctrl-C to stop`,
    )
    this.startRendering()
    try {
      let startup = true
      while (!this.stopped) {
        try {
          this.printReport(await this.dispatcher.tick({ resumeCurrent: startup }))
          startup = false
        } catch (error) {
          this.warn(`tick failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (this.stopped) break
        await sleep(intervalMs)
      }
    } finally {
      // SIGINT lands here too: without it the region keeps the cursor hidden.
      await this.finishRendering()
    }
    this.say('ab dispatch stopped')
  }
}

/**
 * Entry point (§8.2). Loads the repo's config, requires a [tickets] table
 * (the dispatcher has nothing to watch without one), wires the ports, and
 * runs the loop until a single pass finishes (`--once`) or `opts.signal`
 * aborts (SIGINT).
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
  if (config.tickets === undefined) {
    throw new Error(
      "autobuild.toml has no [tickets] table — 'ab dispatch' watches the " +
        'configured TicketSource for Ready tickets (§3.3); add [tickets] with ' +
        'source = "linear" (teamKey = "…") or source = "file" (dir = "…")',
    )
  }

  const wire = opts.wire ?? defaultWire
  const wiring = await wire(config, opts)
  const loop = new DispatchLoop(config, wiring, opts)
  await loop.run()
}
