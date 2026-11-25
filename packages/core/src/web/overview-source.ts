/**
 * `ab web`'s frame source: the repository header plus the overview page, at a
 * cost bounded by live builds, never by history.
 *
 * Recurring reads, while at least one browser is subscribed (SPEC §14):
 *
 * - Poll, nothing changed: `getRepoChangePosition` only; zero event rows.
 * - Poll, position moved: the saved `repositoryReadFacts` value (with
 *   `getRepo`) and one `listBuildsChangedSince` from the saved watermark.
 * - Per changed build: `getBuild` and the saved `buildReadFacts` value, plus
 *   `listStreams` and the pinned `getArtifact` while it is still visible.
 * - One `buildRoster` rollup read per poll, only when a changed build entered
 *   or left the visible set, became aborted, or is done (including one the
 *   source never saw, created and completed between two polls).
 * - One `getRepoArtifact` per new effective-config ref.
 * - Cold start (first read of a process, a repository reset, a config first
 *   appearing): the `buildRoster` rollup plus the per-build reads for each
 *   live build and each aborted entry among its newest finished builds.
 *
 * It never lists builds or reads events. A remote store that lacks the roster
 * or the feed fails the read with its typed error; there is no fallback.
 *
 * An abort older than the roster's newest finished entries that is still
 * cleaning up at cold start is missed until its next event, which the feed
 * reports.
 */
import { normalizeEffectiveConfigArtifact } from '../config/effective-artifact'
import { configSchema, type Config } from '../config/schema'
import { enrichIntegrationRows } from '../cli/dashboard/integration-row'
import { buildDashboardFromProjected, type DashboardBuild } from '../cli/dashboard/model'
import {
  capacityBuildFromFacts,
  isDashboardTerminal,
  projectRowWithEnrichment,
  readRowEnrichment,
  repositoryDashboardHeader,
  type RowEnrichment,
} from '../cli/dashboard/poll'
import { projectOverview } from '../cli/dashboard/row-text'
import type { BuildRosterFinished, BuildRosterValue } from '../kernel/build-roster'
import type { CapacityBuild } from '../kernel/dispatch-capacity'
import type { BuildState } from '../kernel/reducer'
import {
  readBuildFacts,
  readRepositoryFacts,
  type CurrentBuildFacts,
  type RepositoryReadFacts,
} from '../store/reduced-reads'
import type { BuildRecord, BuildStore } from '../store/types'
import { mapBounded } from './bounded'
import { type WebFrame, type WebFrameSource, WebReadFencedError } from './protocol'
import { projectRepositoryFrame } from './repository-source'

/** The only store reads the overview may make. Listing builds and reading
 * events are deliberately absent, so a history scan cannot type-check. */
export type OverviewFrameReader = Pick<
  BuildStore,
  | 'getRepoChangePosition'
  | 'getRepo'
  | 'getReducerValue'
  | 'getRepoArtifact'
  | 'getBuild'
  | 'listBuildsChangedSince'
  | 'listStreams'
  | 'getArtifact'
>

/** One visible build: everything its row and capacity facts need, so a
 * config change re-projects it without reading. */
interface LiveBuild {
  record: BuildRecord
  facts: CurrentBuildFacts
  enrichment: RowEnrichment
  capacity: CapacityBuild
  row: DashboardBuild | null
  /** The config key `row` was projected with. */
  projectedWith: string
}

interface BuildsState {
  /** The changed-builds watermark. */
  feed: string
  live: Map<string, LiveBuild>
  finished: readonly BuildRosterFinished[]
}

interface LoadedConfig {
  key: string
  config: Config
}

type Result = { frame: WebFrame; live: boolean }

export interface OverviewFrameSourceOptions {
  /** Capacity projection time; defaults to the wall clock. */
  clock?: () => Date
}

/**
 * The overview source. Its process-local state (gate position, feed
 * watermark, visible builds, finished list, config) is rebuilt from saved
 * values on a cold start, and every poll commits only after all its reads
 * succeeded, so a failed poll retries from the old state.
 */
export class OverviewFrameSource implements WebFrameSource {
  private gate: string | undefined
  private cached: Result | undefined
  private builds: BuildsState | undefined
  private config: LoadedConfig | undefined
  private readonly clock: () => Date

  constructor(
    private readonly reader: OverviewFrameReader,
    private readonly repo: string,
    opts: OverviewFrameSourceOptions = {},
  ) {
    this.clock = opts.clock ?? (() => new Date())
  }

  async read(admitted: () => boolean = () => true): Promise<Result> {
    // Every store call checks admission first, so a read whose last
    // subscriber left stops at the next call instead of reading on.
    const reader = fenced(this.reader, admitted)
    const position = await reader.getRepoChangePosition(this.repo)
    if (this.cached !== undefined && position === this.gate) return this.cached
    const facts = (await readRepositoryFacts(reader, this.repo)).value
    const projected = projectRepositoryFrame(this.repo, facts)
    // The position is the browser's refetch signal for explicit reads
    // (analytics, build timelines), so every frame carries the one it was
    // read at, even when nothing else in it changed.
    const repository = { ...projected, frame: { ...projected.frame, position } }
    const ref = facts.status?.effectiveConfig
    if (ref === undefined) {
      // No overview without a recorded config, and so no build reads.
      this.commit(position, repository, undefined, this.config)
      return repository
    }
    const config = await this.loadConfig(reader, `${ref.kind}@${ref.rev}`, ref.kind, ref.rev)
    let builds =
      this.builds === undefined ? undefined : await this.advance(reader, this.builds, config)
    // No state yet, or the feed reports a reset: start from the roster.
    builds ??= await this.coldStart(reader, config)
    const result = {
      frame: { ...repository.frame, overview: this.overview(facts, config, builds) },
      live: repository.live,
    }
    this.commit(position, result, builds, config)
    return result
  }

  private commit(
    position: string,
    result: Result,
    builds: BuildsState | undefined,
    config: LoadedConfig | undefined,
  ): void {
    this.gate = position
    this.cached = result
    this.builds = builds
    this.config = config
  }

  private async loadConfig(
    reader: OverviewFrameReader,
    key: string,
    kind: string,
    rev: number,
  ): Promise<LoadedConfig> {
    if (this.config?.key === key) return this.config
    const artifact = await reader.getRepoArtifact(this.repo, kind, rev)
    if (artifact === null) throw new Error(`effective config ${key} is not retrievable`)
    const config = configSchema.parse(
      normalizeEffectiveConfigArtifact(JSON.parse(new TextDecoder().decode(artifact.content))),
    )
    return { key, config }
  }

  private async coldStart(reader: OverviewFrameReader, config: LoadedConfig): Promise<BuildsState> {
    const roster = await readRoster(reader, this.repo)
    // An acknowledged abort stays visible as cleaning until its final
    // completion, so the roster's newest aborted entries are checked too.
    const slugs = [
      ...roster.live.map((entry) => entry.slug),
      ...roster.finished.filter((entry) => entry.outcome === 'aborted').map((entry) => entry.slug),
    ]
    const live = new Map<string, LiveBuild>()
    for (const read of await mapBounded(slugs, (slug) => this.readBuild(reader, slug, config)))
      if (read.build !== undefined) live.set(read.slug, read.build)
    // The roster's position is the one its answer reflects, so the feed
    // misses nothing between the roster snapshot and its next read.
    return { feed: roster.position, live, finished: roster.finished }
  }

  /** Advance by the changed builds; undefined when the repository was reset. */
  private async advance(
    reader: OverviewFrameReader,
    builds: BuildsState,
    config: LoadedConfig,
  ): Promise<BuildsState | undefined> {
    const changed = await reader.listBuildsChangedSince(this.repo, builds.feed)
    if (BigInt(changed.position) < BigInt(builds.feed)) return undefined
    const reads = await mapBounded(
      changed.builds.map((build) => build.slug),
      (slug) => this.readBuild(reader, slug, config),
    )
    const live = new Map(builds.live)
    let rosterMoved = false
    for (const { slug, state, build } of reads) {
      const previous = live.get(slug)
      // The feed reports each build once, at its latest position: a build
      // created and completed between two polls arrives already done, so
      // `done` alone moves the roster, whether or not it was ever visible.
      if (state?.status === 'done') rosterMoved = true
      if (build === undefined) {
        if (previous !== undefined) rosterMoved = true
        live.delete(slug)
        continue
      }
      if (previous === undefined) rosterMoved = true
      else if (state?.status === 'aborted' && previous.facts.state.status !== 'aborted')
        rosterMoved = true
      live.set(slug, build)
    }
    const finished = rosterMoved ? (await readRoster(reader, this.repo)).finished : builds.finished
    return { feed: changed.position, live, finished }
  }

  /** One build's targeted reads: its record and saved facts, then its row
   * enrichment while it is still visible. */
  private async readBuild(
    reader: OverviewFrameReader,
    slug: string,
    config: LoadedConfig,
  ): Promise<{ slug: string; state?: BuildState; build?: LiveBuild }> {
    const [record, { value: facts }] = await Promise.all([
      reader.getBuild(slug),
      readBuildFacts(reader, slug),
    ])
    if (record === null || isDashboardTerminal(facts.state)) return { slug, state: facts.state }
    const enrichment = await readRowEnrichment(reader, slug, facts.state.verify.configPin)
    return {
      slug,
      state: facts.state,
      build: {
        record,
        facts,
        enrichment,
        capacity: capacityBuildFromFacts(record, facts),
        row: projectRowWithEnrichment(record, facts.state, [], config.config, enrichment, facts),
        projectedWith: config.key,
      },
    }
  }

  private overview(facts: RepositoryReadFacts, config: LoadedConfig, builds: BuildsState) {
    // A config change re-projects every row from its cached reads.
    for (const [slug, build] of builds.live)
      if (build.projectedWith !== config.key)
        builds.live.set(slug, {
          ...build,
          row: projectRowWithEnrichment(
            build.record,
            build.facts.state,
            [],
            config.config,
            build.enrichment,
            build.facts,
          ),
          projectedWith: config.key,
        })
    const visible = [...builds.live.values()]
    const rows = visible
      .map((build) => build.row)
      .filter((row): row is DashboardBuild => row !== null)
      .sort((a, b) => a.slug.localeCompare(b.slug))
    const status = facts.status!
    const model = buildDashboardFromProjected(
      enrichIntegrationRows(
        rows,
        visible.map((build) => build.record),
      ),
      repositoryDashboardHeader({
        repo: this.repo,
        status,
        config: config.config,
        repositoryFacts: facts,
        capacityBuilds: visible.map((build) => build.capacity),
        states: visible.map((build) => build.facts.state),
        now: this.clock(),
        ...(status.triage !== undefined ? { triage: status.triage } : {}),
      }),
      facts,
      facts.upgrades,
    )
    return projectOverview(model, {
      ...(status.health !== undefined ? { health: status.health } : {}),
      finished: builds.finished.filter((entry) => !builds.live.has(entry.slug)),
    })
  }
}

async function readRoster(reader: OverviewFrameReader, repo: string): Promise<BuildRosterValue> {
  const { value } = await reader.getReducerValue(
    { kind: 'rollup', repo },
    { reducer: 'buildRoster' },
  )
  return value as unknown as BuildRosterValue
}

/** Gate every reader call on `admitted`. */
function fenced<T extends object>(reader: T, admitted: () => boolean): T {
  return new Proxy(reader, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (typeof value !== 'function') return value
      return async (...args: unknown[]) => {
        if (!admitted()) throw new WebReadFencedError()
        return Reflect.apply(value, target, args)
      }
    },
  })
}
