/**
 * The repository half of a dashboard frame: every header fact that comes from
 * repository-scope values only. The terminal dashboard and the web UI both
 * project it through these functions, so the two frontends share one
 * vocabulary. Pure: no IO.
 */
import type { DispatchUpgradeState } from '../../kernel/dispatch-upgrade'
import { dispatchUpgradeReducer } from '../../kernel/dispatch-upgrade'
import { reduceDispatchSettings } from '../../kernel/dispatch-settings'
import { type DispatchStatus, forgeReadinessWarnings } from '../../kernel/dispatch-status'
import { repositoryReadFactsReducer } from '../../kernel/read-facts'
import type { RepositoryEvent } from '../../events/repository'
import type { RepositoryReadFacts } from '../../store/reduced-reads'
import { projectHandoffs } from './handoff'
import { type DashboardHeader, type DashboardModel, projectRepositoryHarvest } from './model'
import { projectRollback } from './rollback'

/** The dispatcher's published warnings, in render order. */
export function dispatchWarningLines(status: Readonly<DispatchStatus>): string[] {
  return [
    ...status.roleWarnings,
    ...forgeReadinessWarnings(status),
    ...(status.warningNotice !== undefined ? [status.warningNotice] : []),
  ]
}

/** The repository-scope members of a dashboard model. */
export type DashboardRepositoryHeader = Pick<
  DashboardModel,
  | 'repo'
  | 'rollback'
  | 'handoffs'
  | 'triage'
  | 'queued'
  | 'drained'
  | 'repositoryPaused'
  | 'defaultAutoMerge'
  | 'harvestPaused'
  | 'standby'
  | 'availableUpgrade'
  | 'warningLines'
  | 'harvest'
>

export type RepositoryHeaderInput = Pick<
  DashboardHeader,
  'repo' | 'queued' | 'triage' | 'standby' | 'availableUpgrade' | 'warningLines'
>

/**
 * Project the repository header from repository facts (or raw repository
 * events for uncached callers). Also returns the builds a handoff is
 * draining, which row decoration needs.
 */
export function projectRepositoryHeader(
  header: RepositoryHeaderInput,
  repositoryEvents: RepositoryEvent[] | RepositoryReadFacts = [],
  // Filtered frontend feeds omit operational facts; use the durable reduced read there.
  upgrades?: DispatchUpgradeState,
): { header: DashboardRepositoryHeader; draining: ReadonlySet<string> } {
  const upgradeState =
    upgrades ??
    (Array.isArray(repositoryEvents)
      ? dispatchUpgradeReducer.reduce(repositoryEvents)
      : repositoryEvents.upgrades)
  const upgrade = projectHandoffs(upgradeState)
  const rollback = projectRollback(upgradeState)
  const missingAccounts = Array.isArray(repositoryEvents)
    ? repositoryReadFactsReducer.reduce(repositoryEvents).missingAccounts
    : repositoryEvents.missingAccounts
  const warningLines = [
    ...(header.warningLines ?? []),
    ...Object.values(missingAccounts).map(
      (account) => `Missing credentials: ${account.remedy} [${account.source}]`,
    ),
  ]
  const harvestProjection = projectRepositoryHarvest(repositoryEvents)
  const settings = Array.isArray(repositoryEvents)
    ? reduceDispatchSettings(repositoryEvents)
    : repositoryEvents.settings
  return {
    draining: upgrade.draining,
    header: {
      repo: header.repo,
      ...(rollback ? { rollback } : {}),
      ...(upgrade.handoffs.length ? { handoffs: upgrade.handoffs } : {}),
      ...(header.triage !== undefined ? { triage: header.triage } : {}),
      queued: header.queued,
      drained: !settings.intake,
      repositoryPaused: settings.paused,
      defaultAutoMerge: settings.defaultAutoMerge,
      harvestPaused: harvestProjection.harvestPaused,
      ...(header.standby !== undefined ? { standby: header.standby } : {}),
      ...(header.availableUpgrade !== undefined
        ? { availableUpgrade: header.availableUpgrade }
        : {}),
      ...(warningLines.length > 0 ? { warningLines } : {}),
      ...(harvestProjection.harvest !== undefined ? { harvest: harvestProjection.harvest } : {}),
    },
  }
}
