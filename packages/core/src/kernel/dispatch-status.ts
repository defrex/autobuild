import { formatReadinessFailure } from '../ports/forge/readiness'
import type { RepositoryEventPayload } from '../events/repository'
import type { RepositoryEvent } from '../events/repository'
import type { ArtifactRef } from '../ontology'
import type { IncrementalReducer } from './incremental'
import { reducerVersion } from './reducer-identity'

export type DispatchHealth = 'starting' | 'running' | 'stopped' | 'failed'

/** Store-only projection consumed by terminal (and future) frontends. */
export interface DispatchStatus {
  run: string
  health: DispatchHealth
  effectiveConfig?: ArtifactRef
  queued?: number
  /** Standing count from newer tick facts; absent for historical events. */
  creationWithheld?: number
  /** Display-only triage-state count from newer interactive tick facts;
   * absent when the dispatcher published none (unknown). */
  triage?: number
  yieldedHolder?: string
  availableUpgrade?: string
  forgeReadinessFailures?: RepositoryEventPayload<'dispatcher.forge-readiness-failed'>[]
  /** Startup configuration warnings, including forge capability gaps. */
  roleWarnings: string[]
  diagnostics: string[]
  /** Latest notice of warning/failure severity, retained independently from routine notices. */
  warningNotice?: string
  notice?: string
  lastSeq: number
}

function errorNotice(prefix: string, error: string): string {
  return `${prefix}: ${error}`
}

/** Reduce one correlated dispatch run without consulting process-local state.
 * An optional prior projection permits strictly newer repository deltas.
 * Successful ticks supersede standing diagnostics; failures retain the last
 * known queue/config values instead of fabricating replacements. */
export function reduceDispatchStatus(
  events: readonly RepositoryEvent[],
  run: string,
  previous?: Readonly<DispatchStatus>,
): DispatchStatus {
  if (previous !== undefined && previous.run !== run) {
    throw new Error(`cannot continue dispatch run "${run}" from "${previous.run}" status`)
  }
  const state: DispatchStatus =
    previous === undefined
      ? {
          run,
          health: 'starting',
          roleWarnings: [],
          diagnostics: [],
          lastSeq: 0,
        }
      : {
          ...previous,
          ...(previous.forgeReadinessFailures
            ? { forgeReadinessFailures: [...previous.forgeReadinessFailures] }
            : {}),
          roleWarnings: [...previous.roleWarnings],
          diagnostics: [...previous.diagnostics],
        }
  for (const event of events) {
    if (event.seq <= state.lastSeq) continue
    const payload = event.payload as { run?: string }
    if (payload.run !== run) continue
    state.lastSeq = event.seq
    switch (event.type) {
      case 'dispatcher.run-started':
        state.yieldedHolder = undefined
        state.health = 'running'
        state.effectiveConfig = event.payload.effectiveConfig
        state.roleWarnings = [...event.payload.roleWarnings]
        state.forgeReadinessFailures = undefined
        state.notice = undefined
        state.warningNotice = undefined
        break
      case 'dispatcher.config-reloaded':
        if (event.payload.effectiveConfig !== undefined) {
          state.effectiveConfig = event.payload.effectiveConfig
        }
        if (event.payload.roleWarnings !== undefined) {
          state.roleWarnings = [...event.payload.roleWarnings]
        }
        state.notice =
          event.payload.restartRequired.length > 0
            ? `autobuild.toml reload requires dispatch restart for: ${event.payload.restartRequired.join(', ')}`
            : 'autobuild.toml reloaded'
        if (event.payload.restartRequired.length > 0) state.warningNotice = state.notice
        break
      case 'dispatcher.forge-readiness-failed':
        state.forgeReadinessFailures ??= []
        if (!state.forgeReadinessFailures.some((failure) => failure.check === event.payload.check))
          state.forgeReadinessFailures.push({ ...event.payload })
        break
      case 'dispatcher.config-rejected':
        state.notice = errorNotice('config reload rejected', event.payload.error)
        state.warningNotice = state.notice
        break
      case 'dispatcher.config-publication-failed':
        state.notice = errorNotice(
          'config reload not applied because its durable trace failed',
          event.payload.error,
        )
        state.warningNotice = state.notice
        break
      case 'dispatcher.tick-yielded':
        state.yieldedHolder = event.payload.holder
        break
      case 'dispatcher.tick-started':
        state.yieldedHolder = undefined
        break
      case 'dispatcher.tick-completed':
        state.queued = event.payload.queued
        state.creationWithheld = event.payload.counters.creationWithheld
        if (event.payload.triage !== undefined) state.triage = event.payload.triage
        else delete state.triage
        state.diagnostics = [
          ...event.payload.janitorDiagnostics,
          ...event.payload.ticketDiagnostics,
          ...(event.payload.creationDiagnostics ?? []),
          ...event.payload.dependencyDiagnostics,
        ]
        break
      case 'dispatcher.tick-failed':
        state.notice = errorNotice('tick failed', event.payload.error)
        state.warningNotice = state.notice
        break
      case 'dispatcher.runner-settled':
        if (event.payload.outcome === 'relaunch') {
          state.notice = `build ${event.payload.slug} relaunching on the accepted runtime`
        } else if (event.payload.outcome === 'parked') {
          state.notice = `build ${event.payload.slug} parked (${event.payload.status ?? 'unknown'})`
        } else if (event.payload.outcome === 'lease-held') {
          state.notice = `build ${event.payload.slug} already held by another runner — skipped`
        } else {
          state.notice = `build ${event.payload.slug} runner failed: ${event.payload.error ?? event.payload.outcome}`
        }
        state.warningNotice = state.notice
        break
      case 'dispatcher.summary-handoff':
        // Routine guest yield for PR-summary publication: no notice at all.
        break
      case 'dispatcher.harvest-runner-failed':
        state.notice = errorNotice('harvest runner failed', event.payload.error)
        state.warningNotice = state.notice
        break
      case 'dispatcher.upgrade-available':
        state.availableUpgrade = event.payload.version
        break
      case 'dispatcher.operator-reported':
        state.notice = event.payload.message
        if (event.payload.level === 'warning') state.warningNotice = state.notice
        break
      case 'dispatcher.run-stopped':
        state.health = event.payload.outcome === 'normal' ? 'stopped' : 'failed'
        if (event.payload.outcome !== 'normal') {
          state.notice = `dispatcher stopped unexpectedly${
            event.payload.error !== undefined ? `: ${event.payload.error}` : ''
          }`
          state.warningNotice = state.notice
        } else if (event.payload.reason === 'superseded') {
          state.notice = 'dispatcher superseded by another invocation'
        }
        break
      default:
        break
    }
  }
  return state
}

/** The incremental form of `reduceDispatchStatus` for one run. The run is a
 * parameter, so this is a factory. */
export function dispatchStatusReducer(
  run: string,
): IncrementalReducer<DispatchStatus, RepositoryEvent, DispatchStatus> {
  return {
    identity: 'dispatchStatus',
    version: reducerVersion('dispatchStatus'),
    initial: () => ({ run, health: 'starting', roleWarnings: [], diagnostics: [], lastSeq: 0 }),
    advance: (acc, events) => reduceDispatchStatus(events, run, acc),
    finish: (acc) => ({
      ...acc,
      roleWarnings: [...acc.roleWarnings],
      diagnostics: [...acc.diagnostics],
    }),
    reduce: (events) => reduceDispatchStatus(events, run),
  }
}

/** Shared current reads retain a fixed recent window of dispatcher runs. It
 * bounds `recentRuns` in repository read facts and the pending runs the
 * reported dispatch status tracks. Historical holder correlations outside it
 * use the explicitly parameterized cache. */
export const RECENT_DISPATCH_RUN_LIMIT = 16

/** A started, unstopped run other than the reported one, folded from its own
 * `dispatcher.run-started` onward. `started` is that start's seq. */
export interface PendingDispatchRun {
  started: number
  status: DispatchStatus
}

/** Which dispatcher run the repository's reduced status describes. */
export interface ReportedDispatch {
  run?: string
  status: DispatchStatus
  /** Whether the reported run has recorded a tick boundary. */
  ticked: boolean
  /** Seq of the reported run's latest retained start; 0 when never seen. */
  started: number
  /** Sorted ascending by `started`, at most `RECENT_DISPATCH_RUN_LIMIT`. */
  pending: PendingDispatchRun[]
}

export function initialReportedDispatch(): ReportedDispatch {
  return {
    status: dispatchStatusReducer('initial').initial(),
    ticked: false,
    started: 0,
    pending: [],
  }
}

function stopped(status: Readonly<DispatchStatus>): boolean {
  return status.health === 'stopped' || status.health === 'failed'
}

function tickBoundary(event: RepositoryEvent): boolean {
  return (
    event.type === 'dispatcher.tick-started' ||
    event.type === 'dispatcher.tick-completed' ||
    event.type === 'dispatcher.tick-failed'
  )
}

/** Insert in start order, then evict the oldest starts beyond the bound. */
function retain(state: ReportedDispatch, entry: PendingDispatchRun): void {
  let index = state.pending.length
  while (index > 0 && state.pending[index - 1]!.started > entry.started) index--
  state.pending.splice(index, 0, entry)
  while (state.pending.length > RECENT_DISPATCH_RUN_LIMIT) state.pending.shift()
}

/** Move the reported run aside (while it is live) and report `status`. */
function report(
  state: ReportedDispatch,
  status: DispatchStatus,
  started: number,
  ticked: boolean,
): void {
  if (state.run !== undefined && !stopped(state.status))
    retain(state, { started: state.started, status: state.status })
  state.run = status.run
  state.status = status
  state.started = started
  state.ticked = ticked
}

/** Fold one repository event into the reported dispatcher run, in place.
 *
 * The reported run is the one that holds repository authority, or held it
 * most recently, as far as the journal shows: a run that has recorded a tick
 * boundary (`tick-started`, `tick-completed`, `tick-failed`). A run that
 * starts while a ticked, live run is reported waits in `pending` and only
 * displaces it by recording its own tick boundary, so a newcomer that yields
 * and stops never touches the holder's status. When the reported run has
 * stopped or has not ticked yet, a new start is reported at once, as is any
 * start when no run is reported. A tick boundary from a run whose start is
 * no longer retained promotes it too, carrying the last known effective
 * config until the run records its own. Other events from unknown runs are
 * ignored; a run's stop is its last event, so a stopped pending run is
 * dropped rather than remembered.
 *
 * Pending holds at most `RECENT_DISPATCH_RUN_LIMIT` runs, the most recently
 * started, so the state is bounded independent of journal length.
 *
 * `repositoryReadFacts` persists this state: changing this fold or its shape
 * requires a `repositoryReadFacts` reducer revision. */
export function foldReportedDispatch(state: ReportedDispatch, event: RepositoryEvent): void {
  const run = (event.payload as { run?: unknown }).run
  if (typeof run !== 'string') return
  if (event.type === 'dispatcher.run-started') {
    const fresh = reduceDispatchStatus([event], run)
    if (state.run === run) {
      state.status = fresh
      state.started = event.seq
      state.ticked = false
      return
    }
    const index = state.pending.findIndex((entry) => entry.status.run === run)
    if (index !== -1) state.pending.splice(index, 1)
    if (state.run === undefined || stopped(state.status) || !state.ticked)
      report(state, fresh, event.seq, false)
    else retain(state, { started: event.seq, status: fresh })
    return
  }
  if (state.run === run) {
    state.status = reduceDispatchStatus([event], run, state.status)
    if (tickBoundary(event)) state.ticked = true
    return
  }
  const index = state.pending.findIndex((entry) => entry.status.run === run)
  if (index !== -1) {
    const entry = state.pending[index]!
    if (tickBoundary(event)) {
      state.pending.splice(index, 1)
      report(state, reduceDispatchStatus([event], run, entry.status), entry.started, true)
    } else if (event.type === 'dispatcher.run-stopped') {
      state.pending.splice(index, 1)
    } else {
      entry.status = reduceDispatchStatus([event], run, entry.status)
    }
    return
  }
  if (!tickBoundary(event)) return
  const seed: DispatchStatus = {
    run,
    health: 'running',
    ...(state.status.effectiveConfig !== undefined
      ? { effectiveConfig: state.status.effectiveConfig }
      : {}),
    roleWarnings: [],
    diagnostics: [],
    lastSeq: 0,
  }
  report(state, reduceDispatchStatus([event], run, seed), 0, true)
}

export function forgeReadinessWarnings(status: Readonly<DispatchStatus>): string[] {
  return (status.forgeReadinessFailures ?? []).map(formatReadinessFailure)
}
