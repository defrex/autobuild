import { composeBuildConfig } from '../config/live'
import type { PipelineSourceMeta } from '../config/pipeline-source'
import { configSchema, type Config } from '../config/schema'
import {
  BUILD_EFFECTIVE_CONFIG_ARTIFACT,
  parseBuildConfigMetadata,
  parseEffectiveBuildConfig,
} from '../processes/build-execution-state'
import type { Artifact } from '../store/types'
import { detail, statusFilter, summarize, type BuildDetail, type BuildSummary } from '../cli/status'
import { projectRepositoryStatus, type RepositoryStatus } from '../cli/repository-status'
import { projectHarvestStatus, type HarvestStatusView } from '../cli/harvest'
import {
  buildDashboardFromProjected,
  effectiveStatus,
  projectBuild,
  type DashboardBuild,
  type DashboardModel,
} from '../cli/dashboard/model'
import { reduceBuild, type BuildState } from '../kernel/reducer'
import { reduceDispatchStatus } from '../kernel/dispatch-status'
import { readRepoEventsIfRecorded, unclaimedObservationCount } from '../processes/harvest'
import type { RepositoryEvent } from '../events/repository'
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

export async function listOperatorBuilds(opts: {
  store: BuildStore
  repo: string
  scope: BuildListScope
  now: Date
}): Promise<BuildSummary[]> {
  const statuses = new Set(statusFilter(opts.scope === 'all', opts.scope === 'queued'))
  // Records are read and held before the digest read: builds are never
  // deleted, so every record iterated below is guaranteed an entry in the
  // digest map fetched after it — a build created between the two reads
  // appears only in the digest map, which is harmless — and the completeness
  // check can only ever catch a genuine adapter bug, never a concurrent
  // dispatch. The reverse order would let a concurrent creation abort the
  // whole listing (AUT-488 finding f_3cb67aba).
  const records = await opts.store.listBuilds()
  // One digest read gates the per-build history reads (AUT-488): the active
  // and queued scopes never show a terminal build, so a build whose digest
  // already carries a terminal fact skips its `getEvents` round trip and the
  // listing's store cost stays flat as finished builds accumulate. The `--all`
  // scope includes terminal statuses, so it takes no digest read and skips
  // nothing — byte-for-byte the old loop.
  const digests = opts.scope === 'all' ? undefined : await opts.store.getRepoBuildDigests(opts.repo)
  const output: BuildSummary[] = []
  for (const record of records) {
    if (record.repo !== opts.repo) continue
    if (digests !== undefined) {
      // Completeness is contractual (one entry per repo build); a missing
      // entry is an adapter bug and must fail loudly rather than silently
      // drop the build from the listing.
      const digest = digests.get(record.slug)
      if (digest === undefined) {
        throw new Error(`getRepoBuildDigests is missing an entry for build "${record.slug}"`)
      }
      // The digest's `terminal` follows `reduceBuild`'s terminal rule exactly
      // (in-order overwrite of `build.completed`/`build.aborted`, never
      // cleared — pinned against `reduceBuild` in store/digest.test.ts), so
      // `terminal !== undefined` is exactly reduced status `done`/`aborted`,
      // which the active and queued status sets never include. Skipping the
      // history read therefore cannot change the emitted summaries.
      if (digest.terminal !== undefined) continue
    }
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

export async function effectiveConfig(
  store: BuildStore,
  repo: string,
): Promise<{
  config: Config
  repositoryEvents: RepositoryEvent[]
  status: ReturnType<typeof reduceDispatchStatus>
}> {
  const repositoryEvents = await readRepoEventsIfRecorded(store, repo)
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

interface PinnedProjection {
  config: Config
  revision?: number
  pipelineSource?: PipelineSourceMeta
}

/** Read one build's pinned effective-config artifact (SPEC §16.1): its parsed
 * build-owned sections composed over the live snapshot's deployment-owned
 * ones, plus the artifact's metadata projection. Every row must be projected
 * against the pipeline the build actually runs — the artifact's build-owned
 * sections — never the dispatcher's live base-branch snapshot, which a pinned
 * build may never execute. All read failures are display-only: an absent or
 * malformed artifact degrades to the live config, the pre-pin behavior. */
async function readPinnedConfig(
  store: BuildStore,
  slug: string,
  live: Config,
): Promise<PinnedProjection> {
  let artifact: Artifact | null
  try {
    artifact = await store.getArtifact(slug, BUILD_EFFECTIVE_CONFIG_ARTIFACT)
  } catch {
    artifact = null
  }
  if (artifact === null) return { config: live }
  let config: Config
  try {
    config = composeBuildConfig(parseEffectiveBuildConfig(artifact), live)
  } catch {
    config = live
  }
  return { config, ...parseBuildConfigMetadata(artifact) }
}

/** The shared null-row gate (AUT-486 snapshot, AUT-496 getOperatorBuild,
 * AUT-487 digest): `effectiveStatus` maps only `done` outside the visible set
 * (cli/dashboard/model.ts `isVisible`), so `projectBuild` returns null
 * exactly for this state, and a pinned effective-config read for such a
 * build could never be surfaced. One predicate so every consumer cannot
 * diverge from each other or from the row projection: the digest's `terminal`
 * is a third consumer of the same gate — `terminal === 'done'` is exactly
 * `reduceBuild(...).status === 'done'` — and the snapshot uses it to skip a
 * finished build's history and pinned-config reads without weakening this
 * predicate as the authority. If cli/dashboard/model.ts ever adds a
 * non-visible status, this predicate must follow — the snapshot
 * byte-identical differential test and the done/aborted query tests pin the
 * coupling. */
function projectsNoDashboardRow(state: BuildState): boolean {
  return effectiveStatus(state) === 'done'
}

/** Attach the effective-config metadata (SPEC §16.1) to a projected row so an
 * operator can see which autobuild.toml the build runs under. */
function decorateWithPinnedMeta(row: DashboardBuild, pinned: PinnedProjection): DashboardBuild {
  if (pinned.revision !== undefined) row.effectiveConfigRev = pinned.revision
  if (pinned.pipelineSource !== undefined) row.pipelineSource = pinned.pipelineSource
  return row
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
  let dashboardRow: DashboardBuild | null = null
  if (!projectsNoDashboardRow(state)) {
    const pinned = await readPinnedConfig(opts.store, opts.slug, config)
    const row = projectBuild(record, state, config, events, undefined, pinned.config)
    // Implied by the gate; kept as an explicit check (not an assertion) so the
    // code never lies if `effectiveStatus` and `projectBuild` ever drift.
    if (row !== null) dashboardRow = decorateWithPinnedMeta(row, pinned)
  }
  return {
    detail: detail(record, events, opts.now),
    dashboardRow,
  }
}

export async function getRepositoryStatus(
  store: BuildStore,
  repo: string,
): Promise<RepositoryStatus> {
  return projectRepositoryStatus(repo, await readRepoEventsIfRecorded(store, repo))
}

export async function getHarvestStatus(
  store: BuildStore,
  repo: string,
): Promise<HarvestStatusView> {
  return projectHarvestStatus(repo, await readRepoEventsIfRecorded(store, repo))
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
  const records = await opts.store.listBuilds()
  // One digest read covers every build of the repository (AUT-487): the
  // row gate (a `done` digest means no row) and the observation count no
  // longer need per-build histories, so the snapshot's store traffic stays
  // flat as finished builds accumulate. Row-rendering builds still get their
  // full history below, and the digest itself is derived from the event log
  // on every call — nothing is persisted or cached between snapshots.
  const digests = await opts.store.getRepoBuildDigests(opts.repo)
  const projected: DashboardBuild[] = []
  let activeCount = 0
  for (const record of records) {
    if (record.repo !== opts.repo) continue
    const digest = digests.get(record.slug)
    // Completeness is contractual (one entry per repo build); a missing entry
    // is an adapter bug and must fail loudly rather than silently drop the
    // build from the active count or the row list.
    if (digest === undefined) {
      throw new Error(`getRepoBuildDigests is missing an entry for build "${record.slug}"`)
    }
    // Reduced status is `done`/`aborted` exactly when a terminal fact exists,
    // so `terminal === undefined` is exactly the old active test — no history
    // read needed for the count.
    if (digest.terminal === undefined) activeCount += 1
    if (digest.terminal === 'done') continue
    // Both query surfaces share the `projectsNoDashboardRow` gate (AUT-486
    // snapshot, AUT-496 detail query): a build that projects no row —
    // `effectiveStatus` maps only `done` outside the visible set — never
    // reads its pinned effective-config artifact, because the read result
    // could never be surfaced. The digest already excluded `done` builds
    // above; the gate stays as the authority for the row projection so the
    // digest and the reducer cannot silently diverge. Every row-rendering
    // build still gets its full history and pinned pipeline.
    const events = await opts.store.getEvents(record.slug)
    const state = reduceBuild(events)
    if (projectsNoDashboardRow(state)) continue
    const pinned = await readPinnedConfig(opts.store, record.slug, config)
    const row = projectBuild(record, state, config, events, undefined, pinned.config)
    if (row !== null) projected.push(decorateWithPinnedMeta(row, pinned))
  }
  // The unclaimed-observation count comes from the digests and the journal
  // `effectiveConfig` already returned — no per-build history reads (AUT-487).
  // The pure core writes nothing — a snapshot performs no store writes and
  // never creates or locks the repository record.
  const observationCount = unclaimedObservationCount({ digests, harvestEvents: repositoryEvents })
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
      observationCount,
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
