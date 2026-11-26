/** JSON-safe repository projections for persisted current-state consumers. */
import { ticketPreparationReducer } from './ticket-preparation'
import { ticketHandbacksReducer } from './ticket-handbacks'
import { ticketStartsReducer } from './ticket-starts'
import { ticketMigrationsReducer } from './ticket-migrations'
import { dispatchUpgradeReducer } from './dispatch-upgrade'
import {
  advanceCompatibility,
  initialCompatibility,
  projectEvents,
  type CompatibilityState,
} from '../events/compatibility'
import { defineReducer } from './incremental'

import type { RepositoryEvent } from '../events/repository'
import { repositoryAttentionReducer } from './repository-attention'
import { dispatchSettingsReducer } from './dispatch-settings'
import { harvestReducer } from './harvest'
import { forgeCredentialLimitsReducer, forgeHealthReducer } from './forge-health'
import { kernelGitHealthReducer } from './kernel-git'
import { openPrBackpressureReducer } from './open-pr-backpressure-state'
import { ticketSourceHealthReducer } from './ticket-source-health'
import { autoMergeDefaultReducer } from './auto-merge-default'
import { effectiveConfigReducer } from './service-facts'
import { sandboxStatesReducer } from '../processes/sandbox-state'
import { openHarvestExecutionsReducer } from '../processes/harvest-execution-state'
import {
  dispatchStatusReducer,
  foldReportedDispatch,
  initialReportedDispatch,
  RECENT_DISPATCH_RUN_LIMIT,
  type ReportedDispatch,
} from './dispatch-status'

export { RECENT_DISPATCH_RUN_LIMIT } from './dispatch-status'
export interface RepositoryReadAcc {
  missingAccounts: Record<string, import('../accounts/availability').MissingAccountCredential>
  preparation: ReturnType<typeof ticketPreparationReducer.initial>
  handbacks: ReturnType<typeof ticketHandbacksReducer.initial>
  ticketStarts: ReturnType<typeof ticketStartsReducer.initial>
  compatibility: CompatibilityState
  presence: Record<
    string,
    Extract<RepositoryEvent, { type: 'change-presence.observed' }>['payload']
  >

  upgrades: ReturnType<typeof dispatchUpgradeReducer.initial>
  openHarvest: ReturnType<typeof openHarvestExecutionsReducer.initial>
  attention: ReturnType<typeof repositoryAttentionReducer.initial>
  harvestFailures: Record<
    string,
    { count: number; latest: Extract<RepositoryEvent, { type: 'harvest.failed' }> }
  >
  harvestTerminals: Record<
    string,
    Extract<RepositoryEvent, { type: 'harvest.proposals.submitted' | 'harvest.review.verdict' }>
  >
  harvestVerdicts: Record<
    string,
    {
      first: Extract<RepositoryEvent, { type: 'harvest.review.verdict' }>
      latest: Extract<RepositoryEvent, { type: 'harvest.review.verdict' }>
    }
  >
  harvestAuthorizations: Record<
    string,
    Extract<RepositoryEvent, { type: 'harvest.execution.authorized' }>
  >
  harvestExecutionStarts: Record<string, string>
  latestHarvestResumedSeq: number
  harvestSessionEndings: Record<string, number>
  harvestSessions: (import('../cli/harvest').HarvestSessionStatusView & { run: string })[]
  pendingHumanResume?: number
  dismissedThrough: number
  failedAt: Record<string, string>
  settings: ReturnType<typeof dispatchSettingsReducer.initial>
  harvest: ReturnType<typeof harvestReducer.initial>
  forgeHealth: ReturnType<typeof forgeHealthReducer.initial>
  forgeCredentialLimits: ReturnType<typeof forgeCredentialLimitsReducer.initial>
  kernelGit: ReturnType<typeof kernelGitHealthReducer.initial>
  openPrBackpressure: ReturnType<typeof openPrBackpressureReducer.initial>
  ticketMigrations: ReturnType<typeof ticketMigrationsReducer.initial>
  health: ReturnType<typeof ticketSourceHealthReducer.initial>
  autoMerge: ReturnType<typeof autoMergeDefaultReducer.initial>
  config: ReturnType<typeof effectiveConfigReducer.initial>
  sandboxes: ReturnType<typeof sandboxStatesReducer.initial>
  /** The dispatcher run the reduced status describes; see `foldReportedDispatch`. */
  dispatch: ReportedDispatch
  scanSeq?: number
  scan?: Extract<RepositoryEvent, { type: 'dispatcher.ticket-scan-completed' }>['payload']
  recentRuns: [string, DispatcherRunFacts][]
  latestRun?: string
  latestStoppedRun?: string
  publications: Extract<RepositoryEvent, { type: 'orchestrator.sandbox.published' }>[]
}
export const repositoryReadFactsReducer = defineReducer({
  rawEvents: true,
  identity: 'repositoryReadFacts',
  parts: [
    ticketMigrationsReducer,
    dispatchUpgradeReducer,
    ticketPreparationReducer,
    ticketHandbacksReducer,
    ticketStartsReducer,
    dispatcherRunFactsReducer('version'),
    openHarvestExecutionsReducer,
    forgeHealthReducer,
    forgeCredentialLimitsReducer,
    kernelGitHealthReducer,
    openPrBackpressureReducer,
    repositoryAttentionReducer,
    dispatchSettingsReducer,
    harvestReducer,
    ticketSourceHealthReducer,
    autoMergeDefaultReducer,
    effectiveConfigReducer,
    sandboxStatesReducer,
    dispatchStatusReducer('version'),
  ],
  initial: (): RepositoryReadAcc => ({
    missingAccounts: {},
    compatibility: initialCompatibility(),
    presence: {},
    preparation: ticketPreparationReducer.initial(),
    handbacks: ticketHandbacksReducer.initial(),
    ticketStarts: ticketStartsReducer.initial(),
    upgrades: dispatchUpgradeReducer.initial(),
    recentRuns: [],
    openHarvest: openHarvestExecutionsReducer.initial(),
    attention: repositoryAttentionReducer.initial(),
    dismissedThrough: 0,
    failedAt: {},
    harvestSessions: [],
    harvestSessionEndings: {},
    harvestFailures: {},
    harvestTerminals: {},
    harvestVerdicts: {},
    harvestAuthorizations: {},
    latestHarvestResumedSeq: 0,
    harvestExecutionStarts: {},
    settings: dispatchSettingsReducer.initial(),
    harvest: harvestReducer.initial(),
    forgeHealth: forgeHealthReducer.initial(),
    forgeCredentialLimits: forgeCredentialLimitsReducer.initial(),
    kernelGit: kernelGitHealthReducer.initial(),
    openPrBackpressure: openPrBackpressureReducer.initial(),
    ticketMigrations: ticketMigrationsReducer.initial(),
    health: ticketSourceHealthReducer.initial(),
    autoMerge: autoMergeDefaultReducer.initial(),
    config: effectiveConfigReducer.initial(),
    sandboxes: sandboxStatesReducer.initial(),
    dispatch: initialReportedDispatch(),
    publications: [],
  }),
  fold(acc: RepositoryReadAcc, events: readonly RepositoryEvent[]) {
    acc.preparation = ticketPreparationReducer.advance(acc.preparation, events)
    acc.handbacks = ticketHandbacksReducer.advance(acc.handbacks, events)
    acc.ticketStarts = ticketStartsReducer.advance(acc.ticketStarts, events)
    advanceCompatibility(acc.compatibility, events)
    acc.upgrades = dispatchUpgradeReducer.advance(acc.upgrades, events)
    acc.attention = repositoryAttentionReducer.advance(acc.attention, events)
    acc.openHarvest = openHarvestExecutionsReducer.advance(acc.openHarvest, events)
    acc.settings = dispatchSettingsReducer.advance(acc.settings, events)
    acc.harvest = harvestReducer.advance(acc.harvest, events)
    acc.forgeHealth = forgeHealthReducer.advance(acc.forgeHealth, events)
    acc.forgeCredentialLimits = forgeCredentialLimitsReducer.advance(
      acc.forgeCredentialLimits,
      events,
    )
    acc.kernelGit = kernelGitHealthReducer.advance(acc.kernelGit, events)
    acc.openPrBackpressure = openPrBackpressureReducer.advance(acc.openPrBackpressure, events)
    acc.ticketMigrations = ticketMigrationsReducer.advance(acc.ticketMigrations, events)
    acc.health = ticketSourceHealthReducer.advance(acc.health, events)
    acc.autoMerge = autoMergeDefaultReducer.advance(acc.autoMerge, events)
    acc.config = effectiveConfigReducer.advance(acc.config, events)
    acc.sandboxes = sandboxStatesReducer.advance(acc.sandboxes, events)
    for (const event of projectEvents(events)) {
      if (event.type === 'account.credentials-unavailable')
        acc.missingAccounts[event.payload.name] = event.payload
      if (event.type === 'account.credentials-recovered')
        delete acc.missingAccounts[event.payload.name]
      if (event.type === 'change-presence.observed')
        acc.presence[event.payload.destination] = event.payload
      if (event.type === 'harvest.failed') {
        const key = JSON.stringify([event.payload.run, event.payload.step, event.payload.round])
        acc.harvestFailures[key] = {
          count: (acc.harvestFailures[key]?.count ?? 0) + 1,
          latest: event,
        }
      }
      if (
        (event.type === 'harvest.proposals.submitted' || event.type === 'harvest.review.verdict') &&
        event.actor.kind === 'agent'
      )
        acc.harvestTerminals[event.actor.session] = event
      if (event.type === 'harvest.review.verdict') {
        const key = JSON.stringify([event.payload.run, event.payload.round])
        acc.harvestVerdicts[key] = {
          first: acc.harvestVerdicts[key]?.first ?? event,
          latest: event,
        }
      }
      if (event.type === 'harvest.execution.started')
        acc.harvestExecutionStarts[String(event.seq)] = event.payload.execution
      if (event.type === 'harvest.execution.authorized')
        acc.harvestAuthorizations[JSON.stringify(event.payload.execution)] ??= event
      if (event.type === 'harvest.resumed') acc.latestHarvestResumedSeq = event.seq
      if (event.type === 'harvest.session.started' && event.payload.continuation) {
        const prior = acc.harvestSessions.find(
          (s) => s.session === event.payload.continuation!.predecessor,
        )
        if (prior) prior.status = 'ended'
      }
      if (event.type === 'harvest.session.started')
        acc.harvestSessions.push({
          run: event.payload.run,
          session: event.payload.session,
          role: event.payload.role,
          step: event.payload.step,
          round: event.payload.round,
          status: 'open',
          ...(event.payload.continuation ? { continuation: event.payload.continuation } : {}),
          ...(event.payload.stream === undefined ? {} : { stream: event.payload.stream }),
          streamStatus: event.payload.stream === undefined ? 'closed' : 'open',
        })
      if (event.type === 'harvest.session.ended' || event.type === 'harvest.session.suspended') {
        acc.harvestSessionEndings[JSON.stringify(event.payload.session)] ??= event.seq
        const session = acc.harvestSessions.findLast(
          (session) => session.session === event.payload.session && session.status === 'open',
        )
        if (session) {
          session.status = event.type === 'harvest.session.suspended' ? 'suspended' : 'ended'
          session.transcript = event.payload.transcript
          session.streamStatus = 'closed'
        }
      }
      if (event.type === 'harvest.resume-requested' && event.actor.kind === 'human')
        acc.pendingHumanResume = event.seq
      if (event.type === 'harvest.pause-requested') delete acc.pendingHumanResume
      if (event.type === 'harvest.resumed' && acc.pendingHumanResume !== undefined)
        acc.dismissedThrough = Math.max(acc.dismissedThrough, acc.pendingHumanResume)
      if (event.type === 'harvest.failed' && !event.payload.willRetry)
        acc.failedAt[JSON.stringify(event.payload.run)] = event.ts
      foldReportedDispatch(acc.dispatch, event)
      if (event.type === 'dispatcher.ticket-scan-completed') {
        acc.scan = event.payload
        acc.scanSeq = event.seq
      }
      if (event.type === 'dispatcher.run-started') acc.latestRun = event.payload.run
      if (event.type === 'dispatcher.run-stopped') acc.latestStoppedRun = event.payload.run
      if (
        event.type.startsWith('dispatcher.') &&
        'run' in event.payload &&
        typeof event.payload.run === 'string'
      ) {
        const run = event.payload.run
        let entry = acc.recentRuns.find(([id]) => id === run)
        if (!entry) {
          entry = [run, {}]
          acc.recentRuns.push(entry)
        }
        foldDispatcherRunFact(entry[1], event)
        while (acc.recentRuns.length > RECENT_DISPATCH_RUN_LIMIT) {
          const index = acc.recentRuns.findIndex(
            ([id]) => id !== acc.latestRun && id !== acc.latestStoppedRun,
          )
          acc.recentRuns.splice(index, 1)
        }
      }
      if (event.type === 'orchestrator.sandbox.published') {
        acc.publications = acc.publications.filter(
          (prior) =>
            prior.payload.operator !== event.payload.operator ||
            prior.payload.branch !== event.payload.branch,
        )
        acc.publications.push(event)
      }
    }
  },
  finish: (acc: RepositoryReadAcc) => ({
    missingAccounts: structuredClone(acc.missingAccounts),
    compatibility: structuredClone(acc.compatibility),
    presence: structuredClone(acc.presence),
    preparation: ticketPreparationReducer.finish(acc.preparation),
    handbacks: ticketHandbacksReducer.finish(acc.handbacks),
    ticketStarts: ticketStartsReducer.finish(acc.ticketStarts),
    upgrades: dispatchUpgradeReducer.finish(acc.upgrades),
    harvestFailures: structuredClone(acc.harvestFailures),
    harvestTerminals: structuredClone(acc.harvestTerminals),
    harvestVerdicts: structuredClone(acc.harvestVerdicts),
    harvestAuthorizations: structuredClone(acc.harvestAuthorizations),
    harvestExecutionStarts: { ...acc.harvestExecutionStarts },
    latestHarvestResumedSeq: acc.latestHarvestResumedSeq,
    harvestSessionEndings: { ...acc.harvestSessionEndings },
    harvestSessions: structuredClone(acc.harvestSessions),
    attention: repositoryAttentionReducer.finish(acc.attention),
    dismissedThrough: acc.dismissedThrough,
    failedAt: { ...acc.failedAt },
    openHarvest: openHarvestExecutionsReducer.finish(acc.openHarvest),
    settings: dispatchSettingsReducer.finish(acc.settings),
    harvest: harvestReducer.finish(acc.harvest),
    forgeHealth: forgeHealthReducer.finish(acc.forgeHealth),
    forgeCredentialLimits: forgeCredentialLimitsReducer.finish(acc.forgeCredentialLimits),
    kernelGit: kernelGitHealthReducer.finish(acc.kernelGit),
    openPrBackpressure: openPrBackpressureReducer.finish(acc.openPrBackpressure),
    ticketMigrations: ticketMigrationsReducer.finish(acc.ticketMigrations),
    health: ticketSourceHealthReducer.finish(acc.health),
    autoMerge: autoMergeDefaultReducer.finish(acc.autoMerge),
    config: effectiveConfigReducer.finish(acc.config),
    sandboxes: sandboxStatesReducer.finish(acc.sandboxes),
    status: acc.dispatch.run
      ? dispatchStatusReducer(acc.dispatch.run).finish(acc.dispatch.status)
      : undefined,
    scan: acc.scan,
    scanSeq: acc.scanSeq,
    recentRuns: structuredClone(acc.recentRuns),
    latestRun: acc.latestRun,
    latestStoppedRun: acc.latestStoppedRun,
    publications: structuredClone(acc.publications),
  }),
})

import type { IncrementalReducer } from './incremental'
/** Companion for an optional finished answer: absence is represented by an
 * omitted object field, never top-level undefined. */
export function optionalValue<A, E, V>(reducer: IncrementalReducer<A, E, V>) {
  return {
    ...reducer,
    finish: (acc: A) => ({ value: reducer.finish(acc) }),
    reduce: (events: readonly E[]) => ({ value: reducer.reduce(events) }),
  }
}

/** One run's correlation facts. History for unrelated runs never enters this value. */
export interface DispatcherRunFacts {
  runtime?: RepositoryEvent
  start?: RepositoryEvent
  latestStart?: RepositoryEvent
  stop?: RepositoryEvent
  tick?: RepositoryEvent
  completed?: RepositoryEvent
  boundary?: 'dispatcher.tick-started' | 'dispatcher.tick-completed' | 'dispatcher.tick-failed'
  stopRequest?: Extract<RepositoryEvent, { type: 'dispatcher.stop-requested' }>
}
export function dispatcherRunFactsReducer(run: string) {
  return defineReducer<DispatcherRunFacts, RepositoryEvent, DispatcherRunFacts>({
    identity: 'dispatcherRunFacts',
    initial: () => ({}),
    fold(acc, events) {
      for (const event of projectEvents(events)) {
        if (!('run' in event.payload) || event.payload.run !== run) continue
        foldDispatcherRunFact(acc, event)
      }
    },
    finish: (acc) => structuredClone(acc),
  })
}

function foldDispatcherRunFact(acc: DispatcherRunFacts, event: RepositoryEvent): void {
  if (event.type === 'dispatcher.run-started') {
    acc.start ??= event
    acc.latestStart = event
  } else if (event.type === 'dispatcher.runtime-recorded') acc.runtime = event
  else if (event.type === 'dispatcher.run-stopped') acc.stop = event
  else if (event.type === 'dispatcher.stop-requested') acc.stopRequest ??= event
  else if (
    event.type === 'dispatcher.tick-started' ||
    event.type === 'dispatcher.tick-completed' ||
    event.type === 'dispatcher.tick-failed'
  ) {
    acc.boundary = event.type
    if (event.type !== 'dispatcher.tick-started') acc.tick = event
    if (event.type === 'dispatcher.tick-completed') acc.completed = event
  }
}
