import { normalizeEffectiveConfigArtifact } from '../config/effective-artifact'
import { migrationIdentity, ticketMigrationsReducer } from '../kernel/ticket-migrations'
import type { DispatchUpgradeState } from '../kernel/dispatch-upgrade'
import { releaseDispatchPresentation } from './dispatch-presentation-ownership'
import {
  readDispatchUpgrade,
  readRepositoryFacts,
  type RepositoryReadFacts,
} from '../store/reduced-reads'
import { DISPATCHER } from '../events/envelope'
import { launchContext } from './dispatch-launch-contract'
import { dispatchCapacity } from '../kernel/dispatch-capacity'
import { forgeReadinessWarnings } from '../kernel/dispatch-status'
import { RepositoryPollCache } from './dashboard/repository-poll'
import {
  DashboardRefresh,
  interactionRead,
  presentationReader,
  type RefreshScheduler,
} from './dashboard/refresh'
import { FOCUS_REPORTING_MODE, installPresentationSuspension } from './terminal-restore'
import { DispatchRepositoryFeed } from './dispatch-repository-feed'
import { StandbyIdentityResolver } from './dispatcher-liveness'
import { configSchema, type Config } from '../config/schema'
import { humanActor } from '../events/envelope'
import type { RepositoryEvent } from '../events/repository'
import { reduceDispatchStatus, type DispatchStatus } from '../kernel/dispatch-status'
import type { BuildState } from '../kernel/reducer'
import { unclaimedObservationCount } from '../processes/harvest'
import {
  controlHarvestRun,
  OperatorControlError,
  toggleHarvestGate,
  toggleRepositorySetting,
} from '../operator/control'
import type { BuildStore, Clock } from '../store/types'
import { systemClock } from '../store/types'
import { BuildControlError, buildControlUser, controlBuild } from './build-control'
import { bulkControlReport, bulkControlRepository } from './bulk-control'
import { deleteBefore, insertText, moveCursor, type ComposerMotion } from './dashboard/composer'
import { dashboardBuildControl } from './dashboard/actions'
import {
  buildDashboardFromProjected,
  type DashboardBuild,
  type DashboardModel,
  type DashboardSelection,
  type DashboardView,
} from './dashboard/model'
import { DashboardBuildPollCache, type DashboardPollSnapshot } from './dashboard/poll'
import {
  dashboardContentWidth,
  detailScrollLimit,
  moveDetailScroll,
  moveTranscriptScroll,
  renderDashboard,
  viewerIndicator,
  renderViewerNotice,
  revealDetailFocus,
  type DashboardRendererResolver,
} from './dashboard/render'
import { dashboardSelections, moveSelection, reconcileSelection } from './dashboard/selection'
import { parseTranscript } from './dashboard/transcript'
import { applySessionFeedUpdate, SessionStreamFeed } from './dashboard/session-feed'
import { moveSessionScroll, sessionScrollLimit } from './dashboard/render'
import { LiveRegion, paintableRows } from './dashboard/live'
import { createKeyboardProtocol } from './keyboard'
import type { TerminalInput, TerminalInputEvent, TerminalOut } from './terminal'
import {
  superviseDispatchChild,
  type DispatchChildHandle,
  type DispatchChildOptions,
} from './dispatch-process'

import type { TicketSource } from '../ports/types'

const PAINT_MS = 250
const ABORTABLE_STATUSES = new Set(['queued', 'running', 'collecting', 'paused', 'blocked'])

function validAbortConfirmation(state: BuildState | undefined): boolean {
  return (
    state !== undefined &&
    ABORTABLE_STATUSES.has(state.status) &&
    !state.pendingCommands.some((command) => command.command === 'abort')
  )
}

function isStaleAbortControlError(error: unknown): error is BuildControlError {
  return (
    error instanceof BuildControlError &&
    ['not-found', 'wrong-repository', 'inactive', 'no-longer-active', 'abort-pending'].includes(
      error.code,
    )
  )
}

interface ResumePrompt {
  slug: string
  escalationIds: string[]
  value: string
  cursor: number
}

export interface DispatchFrontendOptions {
  viewer?: { dispatchedBy?: string }
  plainOutput?: (line: string) => void
  /** Repository identity (§12): the normalized origin, or the checkout path
   * when there is no origin. Every Store key uses this. */
  repo: string
  /** The physical main checkout — the supervised kernel's process cwd. */
  checkout?: string
  storeRef: string
  store: BuildStore
  ticketSource?: () => Promise<TicketSource>
  env: Record<string, string | undefined>
  terminal: TerminalOut
  input: TerminalInput
  signal?: AbortSignal
  once: boolean
  intervalMs?: number
  intake?: boolean
  defaultAutoMerge?: boolean
  refreshScheduler?: RefreshScheduler
  clock?: Clock
  resolveDashboardRenderer?: DashboardRendererResolver
  launchChild?: (input: {
    store: BuildStore
    repo: string
    cwd?: string
    run: string
    env: Record<string, string | undefined>
    options: DispatchChildOptions
  }) => DispatchChildHandle
}

/** Terminal controller with a deliberately narrow wiring surface: terminal,
 * BuildStore, immutable repository identity, clock, and child supervision. */
export class DispatchFrontend {
  private readonly standbyResolver: StandbyIdentityResolver
  private readonly runId: string
  private readonly clock: Clock
  private readonly region: LiveRegion
  private readonly keyboard
  private child: DispatchChildHandle | undefined
  private readonly repositoryFeed: DispatchRepositoryFeed
  private dispatchStatus: DispatchStatus
  private eventRefreshTail: Promise<void> = Promise.resolve()
  private cache: DashboardBuildPollCache | undefined
  private config: Config | undefined
  private configRef: string | undefined
  private configRevision = 0
  /** Display-only pressure is sampled by the Store-only frontend. Undefined
   * means no factual sample has succeeded yet; failures retain the last value. */
  private observationCount: number | undefined
  private model: DashboardModel | undefined
  private selection: DashboardSelection | undefined = { kind: 'global' }
  private view: DashboardView | undefined
  /** The session view's live-read cycle, created with the view it serves and
   * discarded on Escape. All read semantics live in the shared feed module —
   * the same instance contract the DispatchLoop path uses. */
  private sessionFeed: SessionStreamFeed | undefined
  private resumePrompt: ResumePrompt | undefined
  private abortConfirmation: { slug: string } | undefined
  private accepting = false
  private cleanupInput: (() => void) | undefined
  private refresh: DashboardRefresh | undefined
  private suspension: ReturnType<typeof installPresentationSuspension> | undefined
  private readonly reader: BuildStore
  private paintTimer: ReturnType<typeof setInterval> | undefined
  private actionTail: Promise<void> = Promise.resolve()
  private presentationRestored = false
  private operatorStopRequested = false
  private viewerStopped: (() => void) | undefined
  private viewerFacts: RepositoryReadFacts | undefined
  private viewerPosition: string | undefined
  private viewerReadAt = -Infinity
  private lastPlainFrame: string | undefined

  constructor(private readonly opts: DispatchFrontendOptions) {
    this.runId = launchContext(opts.env)?.run ?? crypto.randomUUID()
    this.dispatchStatus = reduceDispatchStatus([], this.runId)
    this.reader = presentationReader(
      opts.store,
      () => !this.presentationRestored && (this.refresh?.admitted ?? true),
    )
    this.clock = opts.clock ?? systemClock
    this.repositoryFeed = new DispatchRepositoryFeed(this.reader, opts.repo, this.clock)
    this.standbyResolver = new StandbyIdentityResolver(this.reader, opts.repo, {
      selectHolder: (holder) => this.repositoryFeed.selectHolder(holder),
      allowLookup: () => this.repositoryFeed.incompleteIdentities,
      remember: (events, complete) => this.repositoryFeed.remember(events, complete),
    })
    this.keyboard = createKeyboardProtocol(
      (chunk) => opts.terminal.write(chunk),
      opts.terminal.modes,
    )
    this.region = new LiveRegion(opts.terminal, this.keyboard)
  }

  /** Advance the repository cursor exactly once even when polling overlaps an
   * operator action. High-frequency dispatcher status is folded from deltas;
   * only the low-volume settings/Harvest facts needed by the dashboard model
   * are retained for their existing replay reducers. */
  private async events(sampledPosition?: string): Promise<RepositoryEvent[]> {
    if (this.opts.viewer) {
      const position = sampledPosition ?? (await this.reader.getRepoChangePosition(this.opts.repo))
      if (
        position !== this.viewerPosition ||
        this.clock().getTime() - this.viewerReadAt >= 10_000
      ) {
        this.viewerFacts = (await readRepositoryFacts(this.reader, this.opts.repo)).value
        this.viewerPosition = position
        this.viewerReadAt = this.clock().getTime()
      }
      this.dispatchStatus = this.viewerFacts!.status ?? reduceDispatchStatus([], this.runId)
      return []
    }
    const refresh = this.eventRefreshTail.then(async () => {
      const delta = await this.repositoryFeed.refresh(false)
      this.standbyResolver.ingest(this.repositoryFeed.identities)
      this.standbyResolver.ingest(delta)
      this.dispatchStatus = reduceDispatchStatus(delta, this.runId, this.dispatchStatus)
    })
    this.eventRefreshTail = refresh.catch(() => {})
    await refresh
    return this.repositoryFeed.events
  }

  private async report(message: string, level: 'info' | 'warning' = 'info'): Promise<void> {
    await this.opts.store.appendRepo(this.opts.repo, {
      actor: humanActor(buildControlUser(this.opts.env)),
      type: 'dispatcher.operator-reported',
      payload: { run: this.runId, level, message },
    })
  }

  private queue(operation: () => Promise<void>, interaction = true): void {
    const result = this.actionTail.then(() =>
      interaction ? interactionRead(operation) : operation(),
    )
    this.actionTail = result.then(
      () => undefined,
      async (error) => {
        try {
          await this.report(
            `dashboard action failed: ${error instanceof Error ? error.message : String(error)}`,
            'warning',
          )
          await this.renderOnce(interaction)
        } catch {
          // The next poll remains the recovery boundary.
        }
      },
    )
  }

  private selectedSlug(): string | undefined {
    return this.view?.slug ?? (this.selection?.kind === 'build' ? this.selection.slug : undefined)
  }

  private selectedBuild(): DashboardBuild | undefined {
    const slug = this.selectedSlug()
    return this.model?.builds.find((build) => build.slug === slug)
  }

  private syncControls(): void {
    if (this.model === undefined) return
    const {
      selection: _selection,
      resumeInput: _resume,
      abortConfirmation: _abort,
      view: _view,
      ...base
    } = this.model
    let next: DashboardModel = {
      ...base,
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
      this.view = {
        ...this.view,
        scroll: Math.max(
          0,
          Math.min(
            this.view.scroll,
            detailScrollLimit(
              next,
              dashboardContentWidth(this.opts.terminal.columns),
              this.contentHeight(),
            ),
          ),
        ),
      }
      next = { ...next, view: this.view }
    }
    this.model = next
  }

  private paint(): void {
    if (this.presentationRestored) return
    if (this.refresh !== undefined && !this.refresh.painting) return
    if (this.model === undefined) return
    const renderer = this.opts.resolveDashboardRenderer?.() ?? renderDashboard
    const lines = renderer(this.model, {
      color: this.opts.plainOutput === undefined,
      width: this.opts.terminal.columns,
      height: paintableRows(this.opts.terminal.rows),
      now: this.clock().getTime(),
    })
    this.outputFrame(lines)
  }

  private outputFrame(lines: string[]): void {
    if (this.presentationRestored) return
    if (this.opts.plainOutput) {
      const frame = lines.join('\n')
      if (frame !== this.lastPlainFrame) this.opts.plainOutput(frame)
      this.lastPlainFrame = frame
    } else this.region.update(lines)
  }

  private contentHeight(): number {
    return Math.max(0, paintableRows(this.opts.terminal.rows) - (this.opts.viewer ? 1 : 0))
  }

  private async loadConfig(kind: string, rev: number): Promise<Config> {
    const key = `${kind}@${rev}`
    if (this.config !== undefined && this.configRef === key) return this.config
    const artifact = await this.reader.getRepoArtifact(this.opts.repo, kind, rev)
    if (artifact === null) throw new Error(`effective config ${key} is not retrievable`)
    const parsed = configSchema.parse(
      normalizeEffectiveConfigArtifact(JSON.parse(new TextDecoder().decode(artifact.content))),
    )
    this.config = parsed
    this.configRef = key
    this.configRevision += 1
    return parsed
  }

  private async renderOnce(interaction = true): Promise<void> {
    if (this.refresh !== undefined) return this.refresh.request(interaction)
    return this.readFrame()
  }

  private readonly repositoryPoll = new RepositoryPollCache<{
    repositoryEvents: RepositoryEvent[]
    upgrades: DispatchUpgradeState
    repositoryFacts: RepositoryReadFacts
    status: DispatchStatus
    config: Config
    observationCount: number
    snapshot: DashboardPollSnapshot
  }>()

  private async readFrame(): Promise<void> {
    if (this.refresh !== undefined && !this.refresh.admitted) return
    let sampledPosition: string | undefined
    const frame = await this.repositoryPoll.refresh({
      position: async () => {
        sampledPosition = await this.reader.getRepoChangePosition(this.opts.repo)
        return sampledPosition
      },
      now: () => this.clock().getTime(),
      revision: 0,
      enabled: !this.opts.once,
      valid: (frame) => this.cache?.isCurrent(frame.snapshot) ?? false,
      admitted: () => this.refresh === undefined || this.refresh.admitted,
      nextPollMs: this.refresh?.intervalMs ?? 0,
      read: async ({ fullEnrichment }) => {
        const repositoryEvents = await this.events(sampledPosition)
        // Authority and rollback holds need the full durable reduction, not the
        // low-volume replay feed (which deliberately discards per-tick facts).
        const repositoryFacts =
          this.viewerFacts ??
          (
            await readRepositoryFacts(
              this.reader,
              this.opts.repo,
              repositoryEvents.length || this.repositoryFeed.identities.length ? true : undefined,
            )
          ).value
        const upgrades = repositoryFacts.upgrades
        const status = this.dispatchStatus
        const ref = status.effectiveConfig
        if (ref === undefined) {
          if (this.opts.viewer) {
            this.model = undefined
            this.outputFrame(
              renderViewerNotice(
                this.opts.viewer,
                status.warningNotice ?? 'Waiting for dispatcher configuration',
                this.opts.terminal.columns,
                paintableRows(this.opts.terminal.rows),
              ),
            )
          } else if (status.health === 'failed' && status.warningNotice !== undefined)
            this.region.update([status.warningNotice])
          // Startup is incomplete: retry at the same position.
          return undefined
        }
        const config = await this.loadConfig(ref.kind, ref.rev)
        let observationCount: number
        try {
          observationCount = unclaimedObservationCount({
            digests: await this.reader.getRepoBuildDigests(this.opts.repo),
            harvestEvents: this.opts.viewer ? repositoryFacts.harvest : repositoryEvents,
          })
        } catch {
          // Incomplete snapshots never acknowledge the sampled position.
          this.syncControls()
          this.paint()
          return undefined
        }
        this.cache ??= new DashboardBuildPollCache(this.reader, this.opts.repo, config)
        const snapshot = await this.cache.refresh(config, this.configRevision, fullEnrichment)
        if (!this.opts.once && !this.opts.viewer)
          await this.standbyResolver.refresh(this.runId, status.yieldedHolder, this.clock())
        if (!this.opts.viewer) await this.repositoryFeed.save()
        if (!this.cache.isCurrent(snapshot)) return undefined
        return {
          repositoryEvents,
          repositoryFacts,
          upgrades,
          status,
          config,
          observationCount,
          snapshot,
        }
      },
    })
    if (frame === undefined) return
    let { repositoryEvents, repositoryFacts, upgrades, status } = frame
    const { config, snapshot } = frame
    const standby =
      this.opts.once || this.opts.viewer
        ? undefined
        : this.standbyResolver.current(this.runId, status.yieldedHolder, this.clock())
    this.observationCount = frame.observationCount
    this.refresh?.activity(snapshot.states.size > 0)

    if (this.resumePrompt !== undefined) {
      const state = snapshot.states.get(this.resumePrompt.slug)
      const open = new Set(state?.openEscalations.map((item) => item.id) ?? [])
      const remaining = this.resumePrompt.escalationIds.filter((id) => open.has(id))
      if (remaining.length === 0) this.resumePrompt = undefined
      else this.resumePrompt = { ...this.resumePrompt, escalationIds: remaining }
    }
    if (this.abortConfirmation !== undefined) {
      const slug = this.abortConfirmation.slug
      if (!validAbortConfirmation(snapshot.states.get(slug))) {
        await this.dismissStaleAbortConfirmation(slug)
        repositoryEvents = await this.events()
        repositoryFacts = (
          await readRepositoryFacts(
            this.reader,
            this.opts.repo,
            repositoryEvents.length || this.repositoryFeed.identities.length ? true : undefined,
          )
        ).value
        upgrades = repositoryFacts.upgrades
        status = this.dispatchStatus
      }
    }

    const previous = this.model === undefined ? [] : dashboardSelections(this.model)
    const warningLines = [
      ...status.roleWarnings,
      ...forgeReadinessWarnings(status),
      ...(status.warningNotice !== undefined ? [status.warningNotice] : []),
    ]
    const projected = buildDashboardFromProjected(
      snapshot.builds,
      {
        repo: this.opts.repo,
        ...(standby !== undefined ? { standby } : {}),
        queued: status.queued ?? 0,
        activeCount: [...snapshot.states.values()].filter(
          (state) => state.kind !== 'node' && state.status !== 'done' && state.status !== 'aborted',
        ).length,
        capacity: config.capacity,
        capacityProjection: dispatchCapacity(
          snapshot.capacityBuilds ?? [],
          config.capacity,
          this.clock(),
          migrationIdentity(
            this.opts.viewer
              ? repositoryFacts.ticketMigrations
              : ticketMigrationsReducer.reduce(repositoryEvents),
            config.tickets.source,
          ),
        ),
        observationCount: this.observationCount,
        observationLimit: config.policy.harvestThreshold,
        ...(status.availableUpgrade !== undefined
          ? { availableUpgrade: status.availableUpgrade }
          : {}),
        ...(warningLines.length > 0 ? { warningLines } : {}),
      },
      repositoryFacts,
      upgrades,
    )
    this.selection = reconcileSelection(previous, dashboardSelections(projected), this.selection)
    if (
      this.view !== undefined &&
      !projected.builds.some((build) => build.slug === this.view!.slug)
    ) {
      this.view = undefined
    }
    this.model = { ...projected, ...(this.opts.viewer ? { viewer: this.opts.viewer } : {}) }
    this.syncControls()
    this.paint()
    // The session view's live-read cycle rides the poll tick: one immediate
    // read per interval, applied through the action queue under the fence.
    this.pollSessionFeed()
  }

  private moveVertical(delta: number): void {
    if (this.view?.kind === 'session') {
      const view = this.view
      const upgrade = this.model?.availableUpgrade !== undefined
      const limit = sessionScrollLimit(
        view,
        this.opts.terminal.columns,
        this.contentHeight(),
        upgrade,
        this.model?.standby !== undefined,
      )
      const current = view.follow ? limit : view.scroll
      const scroll = moveSessionScroll(
        view,
        this.opts.terminal.columns,
        this.contentHeight(),
        current,
        delta,
        upgrade,
        this.model?.standby !== undefined,
      )
      let follow = view.follow
      if (delta < 0 && follow && scroll < limit) follow = false
      if (delta > 0 && !follow && scroll >= limit) follow = true
      this.view = { ...view, scroll, follow }
      this.syncControls()
      this.paint()
      return
    }
    if (this.view?.kind === 'transcript') {
      this.view = {
        ...this.view,
        scroll: moveTranscriptScroll(
          this.view.transcript,
          this.opts.terminal.columns,
          this.contentHeight(),
          this.view.scroll,
          delta,
          this.model?.availableUpgrade !== undefined,
          this.model?.standby !== undefined,
        ),
      }
    } else if (this.view?.kind === 'detail' && this.model !== undefined) {
      this.view = {
        ...this.view,
        scroll: moveDetailScroll(
          this.model,
          dashboardContentWidth(this.opts.terminal.columns),
          this.contentHeight(),
          this.view.scroll,
          delta,
        ),
      }
    } else {
      const rows =
        this.model === undefined ? [{ kind: 'global' } as const] : dashboardSelections(this.model)
      this.selection = moveSelection(rows, this.selection, delta)
    }
    this.syncControls()
    this.paint()
  }

  private moveSession(delta: number): void {
    if (this.view?.kind !== 'detail') return
    const build = this.model?.builds.find((item) => item.slug === this.view!.slug)
    const sessions = build?.sessions ?? []
    if (sessions.length === 0) return
    const current = sessions.findIndex((session) => session.id === this.view!.sessionId)
    const sessionId =
      sessions[Math.max(0, Math.min(sessions.length - 1, (current < 0 ? 0 : current) + delta))]!.id
    const candidate = { ...this.view, sessionId }
    this.view = {
      ...candidate,
      scroll: revealDetailFocus(
        { ...this.model!, view: candidate },
        dashboardContentWidth(this.opts.terminal.columns),
        this.contentHeight(),
        'session',
        candidate.scroll,
      ),
    }
    this.syncControls()
    this.paint()
  }

  private async openSelected(): Promise<void> {
    if (this.view === undefined) {
      const build = this.selectedBuild()
      if (build === undefined) return
      this.view = {
        kind: 'detail',
        slug: build.slug,
        scroll: 0,
        ...(build.sessions?.[0] !== undefined ? { sessionId: build.sessions[0].id } : {}),
      }
      this.syncControls()
      this.paint()
      return
    }
    if (this.view.kind !== 'detail') return
    const captured = this.view
    const session = this.selectedBuild()?.sessions?.find((item) => item.id === captured.sessionId)
    if (session === undefined) return
    // The stream branch outranks every transcript outcome: a session with a
    // stream — open or closed — opens the read-only live view. Sessions
    // without a stream keep the frontend's existing behavior byte-for-byte
    // (the silent open-session return, the reclaimed message, the transcript).
    if (session.stream !== undefined) {
      this.view = {
        kind: 'session',
        slug: captured.slug,
        sessionId: session.id,
        stream: session.stream,
        status: session.streamStatus,
        source: { kind: 'parts', parts: [], lastSeq: 0 },
        follow: true,
        scroll: 0,
      }
      this.sessionFeed = new SessionStreamFeed(this.reader, captured.slug)
      this.syncControls()
      this.paint()
      // Kick the first read immediately rather than waiting one interval.
      this.pollSessionFeed()
      return
    }
    if (session.status === 'reclaimed') {
      const { message: _message, messageWhileSessionOpen: _fence, ...stable } = captured
      const candidate = {
        ...stable,
        message: 'This session was reclaimed by a recovering runner; transcript unavailable.',
      }
      this.view = {
        ...candidate,
        scroll: revealDetailFocus(
          { ...this.model!, view: candidate },
          dashboardContentWidth(this.opts.terminal.columns),
          this.contentHeight(),
          'message',
          candidate.scroll,
        ),
      }
      this.syncControls()
      this.paint()
      return
    }
    if (session.status === 'open' || session.transcript === undefined) return
    const artifact = await this.opts.store.getArtifact(
      captured.slug,
      session.transcript.kind,
      session.transcript.rev,
    )
    if (
      artifact === null ||
      this.view?.kind !== 'detail' ||
      this.view.slug !== captured.slug ||
      this.view.sessionId !== captured.sessionId
    ) {
      return
    }
    this.view = {
      kind: 'transcript',
      slug: captured.slug,
      sessionId: session.id,
      transcript: parseTranscript(new TextDecoder().decode(artifact.content)),
      scroll: 0,
    }
    this.syncControls()
    this.paint()
  }

  /** Fire-and-forget live-read cycle for an open session view (or one whose
   * last read failed). The apply runs through the action queue under the
   * feed's identity+cursor fence — the same pattern the DispatchLoop path
   * uses, from the same shared feed module. */
  private pollSessionFeed(): void {
    if (this.refresh !== undefined && !this.refresh.admitted) return
    const view = this.view
    if (view?.kind !== 'session') return
    if (view.status !== 'open' && view.error === undefined) {
      // A closed view is final once its content is in hand; an unloaded one
      // (a closed session just opened, empty chunk log so far) still needs
      // its read — which is where the artifact fallback happens too.
      if (view.source.kind !== 'parts' || view.source.lastSeq !== 0) return
    }
    const feed = this.sessionFeed
    if (feed === undefined) return
    void feed
      .poll(view)
      .then((update) => {
        if (update === undefined) return
        this.queue(async () => {
          const next = applySessionFeedUpdate(
            this.view?.kind === 'session' ? this.view : undefined,
            update,
          )
          if (next === undefined) return
          const terminal = this.opts.terminal
          const limit = sessionScrollLimit(
            next,
            terminal.columns,
            this.contentHeight(),
            this.model?.availableUpgrade !== undefined,
            this.model?.standby !== undefined,
          )
          this.view = {
            ...next,
            scroll: next.follow ? limit : Math.min(next.scroll, limit),
          }
          this.syncControls()
          this.paint()
        }, false)
      })
      .catch(() => {
        // The feed contains its own failures; the next poll retries.
      })
  }

  private leaveView(): void {
    if (this.view?.kind === 'session') {
      this.sessionFeed = undefined
      this.view = {
        kind: 'detail',
        slug: this.view.slug,
        sessionId: this.view.sessionId,
        scroll: 0,
      }
    } else if (this.view?.kind === 'transcript') {
      this.view = {
        kind: 'detail',
        slug: this.view.slug,
        sessionId: this.view.sessionId,
        scroll: 0,
      }
    } else if (this.view?.kind === 'detail') this.view = undefined
    else return
    this.syncControls()
    this.paint()
  }

  private async dismissStaleAbortConfirmation(slug: string): Promise<void> {
    if (this.abortConfirmation?.slug === slug) this.abortConfirmation = undefined
    await this.report(
      `build ${slug}: abort confirmation dismissed because the build state changed`,
      'warning',
    )
  }

  private async confirmAbort(slug: string): Promise<void> {
    await this.events()
    const ref = this.dispatchStatus.effectiveConfig
    if (ref === undefined) throw new Error('effective config is not available')
    const config = await this.loadConfig(ref.kind, ref.rev)
    this.cache ??= new DashboardBuildPollCache(this.reader, this.opts.repo, config)
    let snapshot = await this.cache.refresh(config, this.configRevision)
    while (!this.cache.isCurrent(snapshot)) {
      snapshot = await this.cache.refresh(config, this.configRevision)
    }

    if (!validAbortConfirmation(snapshot.states.get(slug))) {
      await this.dismissStaleAbortConfirmation(slug)
      await this.renderOnce()
      return
    }

    try {
      await this.buildAction('abort', slug)
    } catch (error) {
      if (!isStaleAbortControlError(error)) throw error
      await this.dismissStaleAbortConfirmation(slug)
      await this.renderOnce()
    }
  }

  private async buildAction(
    kind: 'pause' | 'resume' | 'discard' | 'hold' | 'land' | 'abort',
    slug: string,
  ): Promise<void> {
    const result = await controlBuild({
      store: this.opts.store,
      ticketSource: this.opts.ticketSource,
      repo: this.opts.repo,
      slug,
      env: this.opts.env,
      action:
        kind === 'pause'
          ? { kind: 'dashboard-pause' }
          : kind === 'resume'
            ? { kind: 'dashboard-resume' }
            : { kind },
    })
    if (result.kind === 'answer-required') {
      this.resumePrompt = { slug, escalationIds: result.escalationIds, value: '', cursor: 0 }
      this.syncControls()
      this.paint()
      return
    }
    const message =
      result.kind !== 'command'
        ? `build ${slug}: action recorded`
        : result.command === 'pause'
          ? `build ${slug}: pause requested`
          : result.command === 'resume'
            ? kind === 'pause'
              ? `build ${slug}: pending pause cancelled`
              : `build ${slug}: resume requested`
            : result.command === 'discard'
              ? `build ${slug}: discard requested`
              : result.command === 'abort'
                ? `build ${slug}: abort requested`
                : result.command === 'land'
                  ? `build ${slug}: merge consent requested`
                  : `build ${slug}: merge hold requested`
    await this.report(message)
    await this.renderOnce()
  }

  private async toggleIntake(): Promise<void> {
    const event = await toggleRepositorySetting({
      store: this.opts.store,
      repo: this.opts.repo,
      user: buildControlUser(this.opts.env),
      setting: 'intake',
      run: this.runId,
    })
    await this.report(`dispatcher intake ${event.enabled ? 'ON' : 'OFF'}`)
    await this.renderOnce()
  }

  private async bulk(direction: 'pause' | 'resume'): Promise<void> {
    const summary = await bulkControlRepository({
      store: this.opts.store,
      repo: this.opts.repo,
      env: this.opts.env,
      direction,
    })
    await this.report(bulkControlReport(summary))
    await this.renderOnce()
  }

  private async toggleHarvest(): Promise<void> {
    const result = await toggleHarvestGate({
      store: this.opts.store,
      repo: this.opts.repo,
      user: buildControlUser(this.opts.env),
    })
    await this.report(`harvest gate: ${result.command} requested`)
    await this.renderOnce()
  }

  private async harvestRun(expectedRun: string | undefined): Promise<void> {
    if (expectedRun === undefined) {
      await this.report('harvest run action ignored: selected run is no longer active')
      await this.renderOnce()
      return
    }
    try {
      const result = await controlHarvestRun({
        store: this.opts.store,
        repo: this.opts.repo,
        user: buildControlUser(this.opts.env),
        run: expectedRun,
      })
      await this.report(`harvest: ${result.action} requested`)
    } catch (error) {
      await this.report(
        error instanceof OperatorControlError && error.code === 'harvest-unavailable'
          ? 'harvest run action ignored: selected run is no longer active'
          : error instanceof Error
            ? error.message
            : String(error),
      )
    }
    await this.renderOnce()
  }

  private async submitResume(prompt: ResumePrompt): Promise<void> {
    const result = await controlBuild({
      store: this.opts.store,
      repo: this.opts.repo,
      slug: prompt.slug,
      env: this.opts.env,
      action: { kind: 'answer', text: prompt.value, escalationIds: prompt.escalationIds },
    })
    this.resumePrompt = undefined
    await this.report(
      `build ${prompt.slug}: blocked resume requested${
        result.kind === 'answered' && result.resolution === 'guidance' ? ' with guidance' : ''
      }`,
    )
    await this.renderOnce()
  }

  private editResume(input: TerminalInputEvent): void {
    const prompt = this.resumePrompt
    if (prompt === undefined) return
    const update = (value: string, cursor: number): void => {
      this.resumePrompt = { ...prompt, value, cursor }
      this.syncControls()
      this.paint()
    }
    if (input.type === 'text' || input.type === 'paste') {
      const next = insertText(prompt.value, prompt.cursor, input.text)
      update(next.value, next.cursor)
    } else if (input.type === 'newline') {
      const next = insertText(prompt.value, prompt.cursor, '\n')
      update(next.value, next.cursor)
    } else if (input.type === 'backspace') {
      const next = deleteBefore(prompt.value, prompt.cursor)
      update(next.value, next.cursor)
    } else if (['left', 'right', 'up', 'down', 'home', 'end'].includes(input.type)) {
      update(prompt.value, moveCursor(prompt.value, prompt.cursor, input.type as ComposerMotion))
    } else if (input.type === 'escape') {
      this.resumePrompt = undefined
      this.syncControls()
      this.paint()
    } else if (input.type === 'enter') this.queue(() => this.submitResume(prompt))
  }

  private onInput(input: TerminalInputEvent): void {
    this.refresh?.interaction()
    if (!this.accepting) return
    if (input.type === 'interrupt') {
      this.requestOperatorStop()
      return
    }
    if (this.resumePrompt !== undefined) {
      this.editResume(input)
      return
    }
    // The session view is strictly read-only: before the abort-confirmation,
    // Enter, and text branches can be reached, every key except Up/Down
    // (scroll) and Escape (back) returns without queueing any action. No key
    // handled in the session view can append an event, and the abort
    // confirmation cannot be opened from it.
    if (this.view?.kind === 'session') {
      if (input.type === 'up' || input.type === 'down') {
        this.moveVertical(input.type === 'up' ? -1 : 1)
      } else if (input.type === 'escape') {
        this.leaveView()
      }
      return
    }
    const enter = input.type === 'enter' || input.type === 'newline'
    if (this.abortConfirmation !== undefined) {
      if (enter) {
        const slug = this.abortConfirmation.slug
        this.abortConfirmation = undefined
        this.queue(() => this.confirmAbort(slug))
      } else if (input.type === 'escape') {
        this.abortConfirmation = undefined
        this.syncControls()
        this.paint()
      }
      return
    }
    if (input.type === 'up' || input.type === 'down') {
      this.moveVertical(input.type === 'up' ? -1 : 1)
      return
    }
    if (input.type === 'left' || input.type === 'right') {
      this.moveSession(input.type === 'left' ? -1 : 1)
      return
    }
    if (enter) {
      // List/detail identity is captured synchronously before any Store read;
      // a later selection move cannot retarget this navigation.
      void interactionRead(() => this.openSelected()).catch((error) =>
        this.report(
          `dashboard open action failed: ${error instanceof Error ? error.message : String(error)}`,
          'warning',
        ),
      )
      return
    }
    if (input.type === 'escape') {
      this.leaveView()
      return
    }
    if (input.type !== 'text') return
    switch (input.text.toLowerCase()) {
      case 'i':
        if (this.selection?.kind === 'global' && this.view === undefined)
          this.queue(() => this.toggleIntake())
        break
      case 'o':
      case 'l': {
        const slug = this.selectedSlug()
        if (slug !== undefined)
          this.queue(() =>
            this.buildAction(input.text.toLowerCase() === 'o' ? 'hold' : 'land', slug),
          )
        break
      }
      case 'p': {
        const build = this.selectedBuild()
        if (this.selection?.kind === 'global' && this.view === undefined)
          this.queue(() => this.bulk('pause'))
        else if (this.selection?.kind === 'harvest' && this.view === undefined) {
          const run = this.model?.harvest?.run
          this.queue(() => this.harvestRun(run))
        } else if (dashboardBuildControl(build?.status ?? 'queued')?.key === 'p') {
          this.queue(() => this.buildAction('pause', build!.slug))
        }
        break
      }
      case 'r': {
        const build = this.selectedBuild()
        if (this.selection?.kind === 'global' && this.view === undefined)
          this.queue(() => this.bulk('resume'))
        else if (dashboardBuildControl(build?.status ?? 'queued')?.key === 'r')
          this.queue(() => this.buildAction('resume', build!.slug))
        break
      }
      case 'd': {
        const build = this.selectedBuild()
        if (build?.status === 'queued') this.queue(() => this.buildAction('discard', build.slug))
        break
      }
      case 'a':
        // The session-view gate above already returns for a session view; the
        // transcript guard predates it. Together they keep the abort
        // confirmation unreachable from any read-only view.
        if (this.selectedBuild() !== undefined && this.view?.kind !== 'transcript') {
          this.abortConfirmation = { slug: this.selectedBuild()!.slug }
          this.syncControls()
          this.paint()
        }
        break
      case 'h':
        if (this.selection?.kind === 'global' && this.view === undefined)
          this.queue(() => this.toggleHarvest())
        break
    }
  }

  private listen(): void {
    this.cleanupInput = this.opts.input.start((input) => this.onInput(input), {
      onListening: () => this.keyboard.query(),
      onKeyboardFlags: (flags) => this.keyboard.reported(flags),
      onDeviceAttributes: () => this.keyboard.deviceAttributes(),
      onFocus: (focused) => this.refresh?.focus(focused),
      onInteraction: () => this.refresh?.interaction(),
      onSuspend: () => this.suspension?.suspend(),
    })
  }

  private startPresentation(): void {
    this.accepting = true
    this.refresh = new DashboardRefresh(
      async () => {
        try {
          await this.readFrame()
        } catch (error) {
          if (this.refresh?.admitted)
            await this.report(
              `dashboard render failed: ${error instanceof Error ? error.message : String(error)}`,
              'warning',
            )
          throw error
        }
      },
      this.opts.refreshScheduler,
      this.opts.store.networkReads,
      this.opts.viewer ? this.opts.intervalMs : undefined,
    )
    if (!this.opts.plainOutput) this.listen()
    if (!this.opts.plainOutput) this.opts.terminal.modes.enter(FOCUS_REPORTING_MODE)
    if (!this.opts.plainOutput)
      this.suspension = installPresentationSuspension(
        this.opts.terminal.modes,
        () => {
          this.refresh?.suspend()
          this.cleanupInput?.()
          this.cleanupInput = undefined
        },
        () => {
          this.listen()
          this.region.invalidate()
          this.refresh?.resume()
        },
      )
    if (!this.opts.plainOutput) this.paintTimer = setInterval(() => this.paint(), PAINT_MS)
    this.paintTimer?.unref?.()
    void this.refresh.request()
  }

  private requestOperatorStop(): void {
    this.operatorStopRequested = true
    this.viewerStopped?.()
    this.restorePresentationForStop()
    void this.child?.stop(
      typeof this.opts.signal?.reason === 'string' ? this.opts.signal.reason : undefined,
    )
  }

  /** Stop terminal ownership synchronously before awaiting a kernel that may
   * still be finishing an unsafe ticket-claim tick. Normal/abnormal child exits
   * retain the final-frame path below; operator interruption prioritizes shell
   * restoration without force-killing that tick. */
  private restorePresentationForStop(): void {
    if (this.presentationRestored) return
    this.presentationRestored = true
    this.accepting = false
    this.refresh?.stop()
    this.suspension?.close()
    this.opts.terminal.modes.leave(FOCUS_REPORTING_MODE)
    try {
      this.cleanupInput?.()
    } finally {
      this.cleanupInput = undefined
      if (this.paintTimer !== undefined) clearInterval(this.paintTimer)
      this.paintTimer = undefined
      this.region.finish()
    }
  }

  private async finishPresentation(): Promise<void> {
    if (!this.presentationRestored) {
      this.accepting = false
      this.refresh?.stop()
      this.suspension?.close()
      this.opts.terminal.modes.leave(FOCUS_REPORTING_MODE)
      try {
        this.cleanupInput?.()
      } finally {
        this.cleanupInput = undefined
      }
      if (this.paintTimer !== undefined) clearInterval(this.paintTimer)
      this.paintTimer = undefined
    }
    try {
      await this.refresh?.join()
      await this.actionTail
      if (this.opts.once) await this.readFrame()
      else if (!this.presentationRestored) await this.refresh?.finalRefresh()
    } catch {
      // Final presentation remains best-effort.
    } finally {
      if (!this.presentationRestored) this.region.finish()
    }
  }

  private async runViewer(): Promise<void> {
    // Viewing has no repository creation, lease, child, or dispatcher lifecycle writes.
    if (this.opts.plainOutput) this.opts.plainOutput(viewerIndicator(this.opts.viewer!, 1000))
    if (this.opts.signal?.aborted) return
    const stopped = new Promise<void>((resolve) => {
      this.viewerStopped = resolve
    })
    const stop = () => this.requestOperatorStop()
    // A pending Promise and the adaptive scheduler's unref timers do not keep
    // a plain viewer alive. This timer owns only the presentation lifetime.
    const lifetime = setInterval(() => {}, 60_000)
    this.opts.signal?.addEventListener('abort', stop, { once: true })
    try {
      await this.readFrame()
      if (!this.opts.once && !this.operatorStopRequested) {
        this.startPresentation()
        await stopped
      }
    } catch (error) {
      if (this.operatorStopRequested) return
      this.outputFrame(
        renderViewerNotice(
          this.opts.viewer!,
          `Viewer unavailable: ${error instanceof Error ? error.message : String(error)}`,
          this.opts.terminal.columns,
          paintableRows(this.opts.terminal.rows),
        ),
      )
      throw error
    } finally {
      clearInterval(lifetime)
      this.opts.signal?.removeEventListener('abort', stop)
      this.restorePresentationForStop()
      await this.refresh?.join()
      await this.actionTail
      this.viewerStopped = undefined
    }
  }

  async run(): Promise<void> {
    if (this.opts.viewer) return this.runViewer()
    await this.opts.store.ensureRepo(this.opts.repo)
    const actor = humanActor(buildControlUser(this.opts.env))
    if (this.opts.intake !== undefined) {
      await this.opts.store.appendRepo(this.opts.repo, {
        actor,
        type: 'dispatcher.intake-set',
        payload: { enabled: this.opts.intake, run: this.runId },
      })
    }

    try {
      const delta = await this.repositoryFeed.warm()
      this.standbyResolver.ingest(this.repositoryFeed.identities)
      this.dispatchStatus = reduceDispatchStatus(delta, this.runId, this.dispatchStatus)
    } catch {
      /* Display initialization must not gate the kernel. */
    }

    const options: DispatchChildOptions = {
      targetRepo: this.opts.checkout ?? this.opts.repo,
      storeRef: this.opts.storeRef,
      run: this.runId,
      once: this.opts.once,
      ...(this.opts.intervalMs !== undefined ? { intervalMs: this.opts.intervalMs } : {}),
    }
    this.child = (this.opts.launchChild ?? ((input) => superviseDispatchChild(input)))({
      store: this.opts.store,
      repo: this.opts.repo,
      cwd: this.opts.checkout,
      run: this.runId,
      env: this.opts.env,
      options,
    })
    let releaseWork: Promise<void> | undefined
    let releaseAcknowledged = false
    const releaseTimer = setInterval(() => {
      if (releaseWork || releaseAcknowledged || this.operatorStopRequested) return
      releaseWork = (async () => {
        const state = (await readDispatchUpgrade(this.opts.store, this.opts.repo)).value.runs[
          this.runId
        ]
        if (!state?.request || !state.handoff || state.failure) return
        if (state.released) {
          releaseAcknowledged = true
          return
        }
        if (!this.presentationRestored) {
          await this.finishPresentation()
          this.presentationRestored = true
          releaseDispatchPresentation()
        }
        await this.opts.store.appendRepo(this.opts.repo, {
          actor: DISPATCHER,
          type: 'dispatcher.terminal-released',
          payload: state.prepared!.payload,
        })
        releaseAcknowledged = true
      })()
        .catch(() => {})
        .finally(() => {
          releaseWork = undefined
        })
    }, 1_000)
    const stop = (): void => this.requestOperatorStop()
    this.opts.signal?.addEventListener('abort', stop, { once: true })
    try {
      if (!this.opts.once) this.startPresentation()
      if (this.opts.signal?.aborted) this.requestOperatorStop()
      const result = await this.child.completed
      if (
        !this.presentationRestored &&
        !(result.outcome === 'normal' && result.exitCode === 0) &&
        !(result.outcome === 'forced' && this.operatorStopRequested)
      ) {
        const processDetails = [
          `exit code ${result.exitCode}`,
          ...(result.signal !== undefined ? [`signal ${result.signal}`] : []),
        ].join(', ')
        throw new Error(
          result.error !== undefined
            ? `dispatcher kernel failed: ${result.error} (${processDetails})`
            : `dispatcher kernel ${result.outcome} (${processDetails})`,
        )
      }
    } finally {
      clearInterval(releaseTimer)
      await releaseWork
      this.opts.signal?.removeEventListener('abort', stop)
      await this.child.stop()
      await this.finishPresentation()
      await this.repositoryFeed.save(true)
    }
  }
}
