import { configSchema, type Config } from '../config/schema'
import { humanActor } from '../events/envelope'
import type { RepositoryEvent } from '../events/repository'
import { reduceDispatchSettings } from '../kernel/dispatch-settings'
import { reduceDispatchStatus, type DispatchStatus } from '../kernel/dispatch-status'
import { reduceHarvest } from '../kernel/harvest'
import type { BuildState } from '../kernel/reducer'
import { scanUnclaimedObservations } from '../processes/harvest'
import type { BuildStore, Clock } from '../store/types'
import { systemClock } from '../store/types'
import { BuildControlError, buildControlUser, controlBuild } from './build-control'
import { bulkControlReport, bulkControlRepository } from './bulk-control'
import { deleteBefore, insertText, moveCursor, type ComposerMotion } from './dashboard/composer'
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
import { dashboardSelections, moveSelection, reconcileSelection } from './dashboard/selection'
import { parseTranscript } from './dashboard/transcript'
import { LiveRegion, paintableRows } from './dashboard/live'
import { createKeyboardProtocol } from './keyboard'
import type { TerminalInput, TerminalInputEvent, TerminalOut } from './terminal'
import {
  superviseDispatchChild,
  type DispatchChildHandle,
  type DispatchChildOptions,
} from './dispatch-process'

const POLL_MS = 500
const PAINT_MS = 250
const ABORTABLE_STATUSES = new Set(['queued', 'running', 'paused', 'blocked'])

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

function isDashboardRepositoryEvent(event: RepositoryEvent): boolean {
  return (
    event.type.startsWith('harvest.') ||
    event.type === 'dispatcher.intake-set' ||
    event.type === 'dispatcher.pause-set' ||
    event.type === 'dispatcher.auto-merge-default-set'
  )
}

interface ResumePrompt {
  slug: string
  escalationIds: string[]
  value: string
  cursor: number
}

export interface DispatchFrontendOptions {
  repo: string
  storeRef: string
  store: BuildStore
  env: Record<string, string | undefined>
  terminal: TerminalOut
  input: TerminalInput
  signal?: AbortSignal
  once: boolean
  intervalMs?: number
  intake?: boolean
  defaultAutoMerge?: boolean
  clock?: Clock
  resolveDashboardRenderer?: DashboardRendererResolver
  launchChild?: (input: {
    store: BuildStore
    repo: string
    run: string
    env: Record<string, string | undefined>
    options: DispatchChildOptions
  }) => DispatchChildHandle
}

/** Terminal controller with a deliberately narrow wiring surface: terminal,
 * BuildStore, immutable repository identity, clock, and child supervision. */
export class DispatchFrontend {
  private readonly runId = crypto.randomUUID()
  private readonly clock: Clock
  private readonly region: LiveRegion
  private readonly keyboard
  private child: DispatchChildHandle | undefined
  private repositorySeq = 0
  private repositoryEvents: RepositoryEvent[] = []
  private dispatchStatus: DispatchStatus = reduceDispatchStatus([], this.runId)
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
  private resumePrompt: ResumePrompt | undefined
  private abortConfirmation: { slug: string } | undefined
  private accepting = false
  private cleanupInput: (() => void) | undefined
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private paintTimer: ReturnType<typeof setInterval> | undefined
  private polling = false
  private pollInFlight: Promise<void> | undefined
  private actionTail: Promise<void> = Promise.resolve()
  private presentationRestored = false
  private operatorStopRequested = false

  constructor(private readonly opts: DispatchFrontendOptions) {
    this.clock = opts.clock ?? systemClock
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
  private async events(): Promise<RepositoryEvent[]> {
    const refresh = this.eventRefreshTail.then(async () => {
      const delta = await this.opts.store.getRepoEvents(this.opts.repo, this.repositorySeq)
      if (delta.length === 0) return
      this.repositorySeq = delta.at(-1)!.seq
      this.dispatchStatus = reduceDispatchStatus(delta, this.runId, this.dispatchStatus)
      this.repositoryEvents.push(...delta.filter(isDashboardRepositoryEvent))
    })
    this.eventRefreshTail = refresh.catch(() => {})
    await refresh
    return this.repositoryEvents
  }

  private async report(message: string, level: 'info' | 'warning' = 'info'): Promise<void> {
    await this.opts.store.appendRepo(this.opts.repo, {
      actor: humanActor(buildControlUser(this.opts.env)),
      type: 'dispatcher.operator-reported',
      payload: { run: this.runId, level, message },
    })
  }

  private queue(operation: () => Promise<void>): void {
    const result = this.actionTail.then(operation)
    this.actionTail = result.then(
      () => undefined,
      async (error) => {
        try {
          await this.report(
            `dashboard action failed: ${error instanceof Error ? error.message : String(error)}`,
            'warning',
          )
          await this.renderOnce()
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
              paintableRows(this.opts.terminal.rows),
            ),
          ),
        ),
      }
      next = { ...next, view: this.view }
    }
    this.model = next
  }

  private paint(): void {
    if (this.model === undefined) return
    const renderer = this.opts.resolveDashboardRenderer?.() ?? renderDashboard
    this.region.update(
      renderer(this.model, {
        color: true,
        width: this.opts.terminal.columns,
        height: paintableRows(this.opts.terminal.rows),
        now: this.clock().getTime(),
      }),
    )
  }

  private async loadConfig(kind: string, rev: number): Promise<Config> {
    const key = `${kind}@${rev}`
    if (this.config !== undefined && this.configRef === key) return this.config
    const artifact = await this.opts.store.getRepoArtifact(this.opts.repo, kind, rev)
    if (artifact === null) throw new Error(`effective config ${key} is not retrievable`)
    const parsed = configSchema.parse(JSON.parse(new TextDecoder().decode(artifact.content)))
    this.config = parsed
    this.configRef = key
    this.configRevision += 1
    return parsed
  }

  private async renderOnce(): Promise<void> {
    let repositoryEvents = await this.events()
    let status = this.dispatchStatus
    const ref = status.effectiveConfig
    // No filesystem fallback: the first frame waits for the child's durable,
    // run-correlated effective snapshot.
    if (ref === undefined) {
      if (status.health === 'failed' && status.warningNotice !== undefined) {
        this.region.update([status.warningNotice])
      }
      return
    }
    const config = await this.loadConfig(ref.kind, ref.rev)
    try {
      const scan = await scanUnclaimedObservations(this.opts.store, this.opts.repo)
      this.observationCount = scan.observations.length
    } catch {
      // Before the first successful sample there is no factual zero to place in
      // a complete frame. Leave the prior frame untouched and retry on the next
      // ordinary poll, without manufacturing a repository notice.
      if (this.observationCount === undefined) return
    }
    this.cache ??= new DashboardBuildPollCache(this.opts.store, this.opts.repo, config)
    const snapshot = await this.cache.refresh(config, this.configRevision)
    if (!this.cache.isCurrent(snapshot)) return

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
        status = this.dispatchStatus
      }
    }

    const previous = this.model === undefined ? [] : dashboardSelections(this.model)
    const warningLines = [
      ...status.roleWarnings,
      ...(status.warningNotice !== undefined ? [status.warningNotice] : []),
    ]
    const projected = buildDashboardFromProjected(
      snapshot.builds,
      {
        repo: this.opts.repo,
        queued: status.queued ?? 0,
        activeCount: [...snapshot.states.values()].filter(
          (state) => state.status !== 'done' && state.status !== 'aborted',
        ).length,
        capacity: config.capacity,
        observationCount: this.observationCount,
        observationLimit: config.policy.harvestThreshold,
        ...(status.availableUpgrade !== undefined
          ? { availableUpgrade: status.availableUpgrade }
          : {}),
        ...(warningLines.length > 0 ? { warningLines } : {}),
      },
      repositoryEvents,
    )
    this.selection = reconcileSelection(previous, dashboardSelections(projected), this.selection)
    if (
      this.view !== undefined &&
      !projected.builds.some((build) => build.slug === this.view!.slug)
    ) {
      this.view = undefined
    }
    this.model = projected
    this.syncControls()
    this.paint()
  }

  private moveVertical(delta: number): void {
    if (this.view?.kind === 'transcript') {
      this.view = {
        ...this.view,
        scroll: moveTranscriptScroll(
          this.view.transcript,
          this.opts.terminal.columns,
          paintableRows(this.opts.terminal.rows),
          this.view.scroll,
          delta,
          this.model?.availableUpgrade !== undefined,
        ),
      }
    } else if (this.view?.kind === 'detail' && this.model !== undefined) {
      this.view = {
        ...this.view,
        scroll: moveDetailScroll(
          this.model,
          dashboardContentWidth(this.opts.terminal.columns),
          paintableRows(this.opts.terminal.rows),
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
        paintableRows(this.opts.terminal.rows),
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
          paintableRows(this.opts.terminal.rows),
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

  private leaveView(): void {
    if (this.view?.kind === 'transcript') {
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
    this.cache ??= new DashboardBuildPollCache(this.opts.store, this.opts.repo, config)
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
    kind: 'pause' | 'resume' | 'discard' | 'toggle-auto-merge' | 'abort',
    slug: string,
  ): Promise<void> {
    const result = await controlBuild({
      store: this.opts.store,
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
                : result.command === 'auto-merge-on'
                  ? `build ${slug}: auto-merge requested`
                  : `build ${slug}: auto-merge cancelled`
    await this.report(message)
    await this.renderOnce()
  }

  private async toggleIntake(): Promise<void> {
    const enabled = !reduceDispatchSettings(await this.events()).intake
    await this.opts.store.appendRepo(this.opts.repo, {
      actor: humanActor(buildControlUser(this.opts.env)),
      type: 'dispatcher.intake-set',
      payload: { enabled },
    })
    await this.report(`dispatcher intake ${enabled ? 'ON' : 'OFF'}`)
    await this.renderOnce()
  }

  private async toggleDefaultAutoMerge(): Promise<void> {
    const enabled = !reduceDispatchSettings(await this.events()).defaultAutoMerge
    await this.opts.store.appendRepo(this.opts.repo, {
      actor: humanActor(buildControlUser(this.opts.env)),
      type: 'dispatcher.auto-merge-default-set',
      payload: { enabled },
    })
    await this.report(`dispatcher auto-merge default ${enabled ? 'ON' : 'OFF'}`)
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
    const state = reduceHarvest(await this.events())
    const pending = state.pendingCommands.at(-1)
    const paused = pending === undefined ? state.paused : pending.command === 'pause'
    const type = paused ? 'harvest.resume-requested' : 'harvest.pause-requested'
    await this.opts.store.appendRepo(this.opts.repo, {
      actor: humanActor(buildControlUser(this.opts.env)),
      type,
      payload: {},
    })
    await this.report(`harvest gate: ${paused ? 'resume' : 'pause'} requested`)
    await this.renderOnce()
  }

  private async harvestRun(expectedRun: string | undefined): Promise<void> {
    const events = await this.events()
    const projected = projectHarvest(events)
    if (
      expectedRun === undefined ||
      projected?.run !== expectedRun ||
      projected.action === undefined
    ) {
      await this.report('harvest run action ignored: selected run is no longer active')
      await this.renderOnce()
      return
    }
    await this.opts.store.appendRepo(this.opts.repo, {
      actor: humanActor(buildControlUser(this.opts.env)),
      type: 'harvest.resume-requested',
      payload: {},
    })
    await this.report(`harvest: ${projected.action} requested`)
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
    if (!this.accepting) return
    if (input.type === 'interrupt') {
      this.requestOperatorStop()
      return
    }
    if (this.resumePrompt !== undefined) {
      this.editResume(input)
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
      void this.openSelected().catch((error) =>
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
      case 'm': {
        const slug = this.selectedSlug()
        if (this.view === undefined && this.selection?.kind === 'global') {
          this.queue(() => this.toggleDefaultAutoMerge())
        } else if (slug !== undefined) {
          this.queue(() => this.buildAction('toggle-auto-merge', slug))
        }
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

  private startPresentation(): void {
    this.accepting = true
    this.cleanupInput = this.opts.input.start((input) => this.onInput(input), {
      onListening: () => this.keyboard.query(),
      onKeyboardFlags: (flags) => this.keyboard.reported(flags),
      onDeviceAttributes: () => this.keyboard.deviceAttributes(),
    })
    const poll = (): void => {
      if (this.polling) return
      this.polling = true
      const current = this.renderOnce()
        .catch(async (error) => {
          try {
            await this.report(
              `dashboard render failed: ${error instanceof Error ? error.message : String(error)}`,
              'warning',
            )
          } catch {
            // retry on the next poll
          }
        })
        .finally(() => {
          if (this.pollInFlight === current) this.pollInFlight = undefined
          this.polling = false
        })
      this.pollInFlight = current
    }
    this.pollTimer = setInterval(poll, POLL_MS)
    this.paintTimer = setInterval(() => this.paint(), PAINT_MS)
    this.pollTimer.unref?.()
    this.paintTimer.unref?.()
    poll()
  }

  private requestOperatorStop(): void {
    this.operatorStopRequested = true
    this.restorePresentationForStop()
    void this.child?.stop()
  }

  /** Stop terminal ownership synchronously before awaiting a kernel that may
   * still be finishing an unsafe ticket-claim tick. Normal/abnormal child exits
   * retain the final-frame path below; operator interruption prioritizes shell
   * restoration without force-killing that tick. */
  private restorePresentationForStop(): void {
    if (this.presentationRestored) return
    this.presentationRestored = true
    this.accepting = false
    try {
      this.cleanupInput?.()
    } finally {
      this.cleanupInput = undefined
      if (this.pollTimer !== undefined) clearInterval(this.pollTimer)
      if (this.paintTimer !== undefined) clearInterval(this.paintTimer)
      this.pollTimer = undefined
      this.paintTimer = undefined
      this.region.finish()
    }
  }

  private async finishPresentation(): Promise<void> {
    if (!this.presentationRestored) {
      this.accepting = false
      try {
        this.cleanupInput?.()
      } finally {
        this.cleanupInput = undefined
      }
      if (this.pollTimer !== undefined) clearInterval(this.pollTimer)
      if (this.paintTimer !== undefined) clearInterval(this.paintTimer)
      this.pollTimer = undefined
      this.paintTimer = undefined
    }
    try {
      await this.pollInFlight
      await this.actionTail
      await this.renderOnce()
    } catch {
      // final frame is best-effort
    } finally {
      this.region.finish()
    }
  }

  async run(): Promise<void> {
    await this.opts.store.ensureRepo(this.opts.repo)
    const actor = humanActor(buildControlUser(this.opts.env))
    if (this.opts.intake !== undefined) {
      await this.opts.store.appendRepo(this.opts.repo, {
        actor,
        type: 'dispatcher.intake-set',
        payload: { enabled: this.opts.intake },
      })
    }
    if (this.opts.defaultAutoMerge !== undefined) {
      await this.opts.store.appendRepo(this.opts.repo, {
        actor,
        type: 'dispatcher.auto-merge-default-set',
        payload: { enabled: this.opts.defaultAutoMerge },
      })
    }

    const options: DispatchChildOptions = {
      targetRepo: this.opts.repo,
      storeRef: this.opts.storeRef,
      run: this.runId,
      once: this.opts.once,
      ...(this.opts.intervalMs !== undefined ? { intervalMs: this.opts.intervalMs } : {}),
    }
    this.child = (this.opts.launchChild ?? ((input) => superviseDispatchChild(input)))({
      store: this.opts.store,
      repo: this.opts.repo,
      run: this.runId,
      env: this.opts.env,
      options,
    })
    const stop = (): void => this.requestOperatorStop()
    this.opts.signal?.addEventListener('abort', stop, { once: true })
    try {
      if (!this.opts.once) this.startPresentation()
      if (this.opts.signal?.aborted) this.requestOperatorStop()
      const result = await this.child.completed
      if (
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
      this.opts.signal?.removeEventListener('abort', stop)
      await this.child.stop()
      await this.finishPresentation()
    }
  }
}
