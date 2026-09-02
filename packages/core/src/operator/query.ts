import { configSchema, type Config } from '../config/schema'
import { detail, statusFilter, summarize, type BuildDetail, type BuildSummary } from '../cli/status'
import { projectRepositoryStatus, type RepositoryStatus } from '../cli/repository-status'
import { projectHarvestStatus, type HarvestStatusView } from '../cli/harvest'
import {
  buildDashboardFromProjected,
  projectBuild,
  type DashboardBuild,
  type DashboardModel,
} from '../cli/dashboard/model'
import { reduceBuild } from '../kernel/reducer'
import { reduceDispatchStatus } from '../kernel/dispatch-status'
import { scanUnclaimedObservations } from '../processes/harvest'
import type { BuildStore, Clock } from '../store/types'

export type BuildListScope = 'active' | 'queued' | 'all'

export class OperatorQueryError extends Error {
  constructor(
    readonly code: 'not-found' | 'effective-config-unavailable',
    message: string,
  ) {
    super(message)
    this.name = 'OperatorQueryError'
  }
}

async function repoEvents(store: BuildStore, repo: string) {
  return (await store.getRepo(repo)) === null ? [] : store.getRepoEvents(repo)
}

export async function listOperatorBuilds(opts: {
  store: BuildStore
  repo: string
  scope: BuildListScope
  now: Date
}): Promise<BuildSummary[]> {
  const statuses = new Set(statusFilter(opts.scope === 'all', opts.scope === 'queued'))
  const output: BuildSummary[] = []
  for (const record of await opts.store.listBuilds()) {
    if (record.repo !== opts.repo) continue
    const projected = summarize(record, await opts.store.getEvents(record.slug), opts.now)
    if (statuses.has(projected.status)) output.push(projected)
  }
  return output.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

async function requireBuild(store: BuildStore, repo: string, slug: string) {
  const record = await store.getBuild(slug)
  if (record === null) throw new OperatorQueryError('not-found', `no build "${slug}" in this store`)
  if (record.repo !== repo) {
    throw new OperatorQueryError('not-found', `unknown build "${slug}"`)
  }
  return record
}

async function effectiveConfig(
  store: BuildStore,
  repo: string,
): Promise<{
  config: Config
  repositoryEvents: Awaited<ReturnType<typeof repoEvents>>
  status: ReturnType<typeof reduceDispatchStatus>
}> {
  const repositoryEvents = await repoEvents(store, repo)
  let latestRun: string | undefined
  for (const event of repositoryEvents) {
    if (event.type === 'dispatcher.run-started') latestRun = event.payload.run
  }
  if (latestRun === undefined) {
    throw new OperatorQueryError(
      'effective-config-unavailable',
      `effective config unavailable for repository "${repo}": no dispatcher run is recorded`,
    )
  }
  const status = reduceDispatchStatus(repositoryEvents, latestRun)
  const ref = status.effectiveConfig
  if (ref === undefined) {
    throw new OperatorQueryError(
      'effective-config-unavailable',
      `effective config unavailable for repository "${repo}"`,
    )
  }
  const artifact = await store.getRepoArtifact(repo, ref.kind, ref.rev)
  if (artifact === null) {
    throw new OperatorQueryError(
      'effective-config-unavailable',
      `effective config ${ref.kind}@${ref.rev} is not retrievable`,
    )
  }
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder().decode(artifact.content))
  } catch {
    throw new OperatorQueryError(
      'effective-config-unavailable',
      `effective config ${ref.kind}@${ref.rev} is not valid JSON`,
    )
  }
  const parsed = configSchema.safeParse(raw)
  if (!parsed.success) {
    throw new OperatorQueryError(
      'effective-config-unavailable',
      `effective config ${ref.kind}@${ref.rev} is invalid: ${parsed.error.message}`,
    )
  }
  return { config: parsed.data, repositoryEvents, status }
}

export interface OperatorBuildView {
  detail: BuildDetail
  dashboardRow: DashboardBuild | null
}

export async function getOperatorBuild(opts: {
  store: BuildStore
  repo: string
  slug: string
  now: Date
}): Promise<OperatorBuildView> {
  const record = await requireBuild(opts.store, opts.repo, opts.slug)
  const events = await opts.store.getEvents(opts.slug)
  const state = reduceBuild(events)
  const { config } = await effectiveConfig(opts.store, opts.repo)
  const dashboardRow = projectBuild(record, state, config, events)
  return { detail: detail(record, events, opts.now), dashboardRow }
}

export async function getRepositoryStatus(
  store: BuildStore,
  repo: string,
): Promise<RepositoryStatus> {
  return projectRepositoryStatus(repo, await repoEvents(store, repo))
}

export async function getHarvestStatus(
  store: BuildStore,
  repo: string,
): Promise<HarvestStatusView> {
  return projectHarvestStatus(repo, await repoEvents(store, repo))
}

export interface OperatorDashboardSnapshot {
  generatedAt: string
  model: DashboardModel
  settingsHeader: {
    intake: boolean
    repositoryPaused: boolean
    defaultAutoMerge: boolean
    harvestPaused: boolean
  }
}

export async function getOperatorDashboard(opts: {
  store: BuildStore
  repo: string
  clock: Clock
}): Promise<OperatorDashboardSnapshot> {
  const { config, repositoryEvents, status } = await effectiveConfig(opts.store, opts.repo)
  const projected: DashboardBuild[] = []
  let activeCount = 0
  for (const record of await opts.store.listBuilds()) {
    if (record.repo !== opts.repo) continue
    const events = await opts.store.getEvents(record.slug)
    const state = reduceBuild(events)
    if (state.status !== 'done' && state.status !== 'aborted') activeCount += 1
    const row = projectBuild(record, state, config, events)
    if (row !== null) projected.push(row)
  }
  const scan = await scanUnclaimedObservations(opts.store, opts.repo)
  const warningLines = [
    ...status.roleWarnings,
    ...(status.warningNotice !== undefined ? [status.warningNotice] : []),
  ]
  const model = buildDashboardFromProjected(
    projected,
    {
      repo: opts.repo,
      queued: status.queued ?? 0,
      activeCount,
      capacity: config.capacity,
      observationCount: scan.observations.length,
      observationLimit: config.policy.harvestThreshold,
      ...(status.availableUpgrade !== undefined
        ? { availableUpgrade: status.availableUpgrade }
        : {}),
      ...(warningLines.length > 0 ? { warningLines } : {}),
    },
    repositoryEvents,
  )
  return {
    generatedAt: opts.clock().toISOString(),
    model,
    settingsHeader: {
      intake: !model.drained,
      repositoryPaused: model.repositoryPaused,
      defaultAutoMerge: model.defaultAutoMerge,
      harvestPaused: model.harvestPaused,
    },
  }
}
