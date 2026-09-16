import type { Config } from '../../config/schema'
import { composeBuildConfig } from '../../config/live'
import type { PipelineSourceMeta } from '../../config/pipeline-source'
import type { AbEvent } from '../../events/catalog'
import { reduceBuild, type BuildState } from '../../kernel/reducer'
import {
  BUILD_EFFECTIVE_CONFIG_ARTIFACT,
  parseBuildConfigMetadata,
  parseEffectiveBuildConfig,
} from '../../processes/build-execution-state'
import type { Artifact, BuildRecord, StreamRecord, StreamScope } from '../../store/types'
import { projectBuild, type DashboardBuild } from './model'

/** The read-only BuildStore surface needed to construct dashboard build rows.
 * `listStreams` is optional: when present, build-scope records enrich each
 * row's session history with authoritative stream ids and statuses (SPEC §9).
 * `getArtifact` is optional: when present, the effective-config artifact's
 * metadata decorates each row with its pinned pipeline source and revision
 * (SPEC §16.1). */
export interface DashboardBuildReader {
  listBuilds(): Promise<BuildRecord[]>
  getEvents(slug: string, sinceSeq?: number): Promise<AbEvent[]>
  listStreams?(scope: StreamScope): Promise<StreamRecord[]>
  getArtifact?(slug: string, kind: string): Promise<Artifact | null>
}

export interface DashboardPollSnapshot {
  /** Monotonic process-local cache revision. */
  revision: number
  /** Every dashboard-visible row, including acknowledged abort cleanup. Objects
   * are reused while their streams are unchanged. */
  builds: DashboardBuild[]
  /** Every dashboard-visible reduction; this map and `builds` have matching
   * membership. `aborted` entries are visible but do not consume capacity. */
  states: ReadonlyMap<string, BuildState>
}

interface LiveEntry {
  kind: 'live'
  events: AbEvent[]
  state: BuildState
  build: DashboardBuild | null
}

/** A fully completed build can never become visible again, so its log is discarded. */
interface TerminalEntry {
  kind: 'terminal'
}

type PollEntry = LiveEntry | TerminalEntry

function isTerminal(state: BuildState): boolean {
  // `build.aborted` acknowledges cancellation but begins the checkpointed
  // cleanup saga. Keep polling until its final `build.completed` fact.
  return state.status === 'done'
}

/**
 * Fail closed if a reader violates BuildStore's ordered, contiguous stream
 * contract. Advancing past a gap would make every later incremental read
 * permanently unable to recover the missing event.
 */
function validateDelta(slug: string, sinceSeq: number, events: AbEvent[]): void {
  let expected = sinceSeq + 1
  for (const event of events) {
    if (event.build !== slug) {
      throw new Error(`dashboard poll for "${slug}" received an event for "${event.build}"`)
    }
    if (event.seq !== expected) {
      throw new Error(
        `dashboard poll for "${slug}" expected event seq ${expected}, got ${event.seq}`,
      )
    }
    expected += 1
  }
}

/**
 * Process-local, display-only acceleration for the interactive dispatch frame.
 *
 * Every refresh still discovers records with `listBuilds()`. A first-seen
 * stream is hydrated from seq 0; a cached dashboard-visible stream is read only
 * after its reduced `lastSeq`. Empty deltas preserve the exact reduction and
 * projected row, so phase timing is not recomputed. Only fully completed
 * streams compact to tombstones; acknowledged aborts remain live through their
 * cleanup checkpoints and final completion.
 *
 * Refreshes are serialized and committed transactionally. A failed refresh
 * leaves every entry at its last successful sequence, while concurrent callers
 * cannot publish an older snapshot after a newer one. The append-only event log
 * remains authoritative: constructing a new cache simply rehydrates it.
 */
export class DashboardBuildPollCache {
  private entries = new Map<string, PollEntry>()
  private committedRevision = 0
  private refreshTail: Promise<void> = Promise.resolve()

  private configRevision = 0

  constructor(
    private readonly reader: DashboardBuildReader,
    private readonly repo: string,
    private config: Config,
  ) {}

  /** Authoritative stream records for one build, when the reader supports
   * the stream primitive (SPEC §9). Failures are display-only: an absent
   * enrichment degrades to the pairing-derived status. */
  private async readStreams(slug: string): Promise<StreamRecord[] | undefined> {
    if (this.reader.listStreams === undefined) return undefined
    try {
      return await this.reader.listStreams({ kind: 'build', build: slug })
    } catch {
      return undefined
    }
  }

  /** True only while no later refresh has committed. */
  isCurrent(snapshot: DashboardPollSnapshot): boolean {
    return snapshot.revision === this.committedRevision
  }

  /** Effective-config artifact facts for one build (SPEC §16.1), when the
   * reader exposes the artifact primitive: the metadata projection plus the
   * artifact's parsed content. A malformed artifact still yields its metadata
   * (config absent); all failures are display-only. */
  private async readEffectiveConfig(
    slug: string,
  ): Promise<
    { revision?: number; pipelineSource?: PipelineSourceMeta; config?: Config } | undefined
  > {
    const getArtifact = this.reader.getArtifact
    if (getArtifact === undefined) return undefined
    try {
      const artifact = await getArtifact.call(this.reader, slug, BUILD_EFFECTIVE_CONFIG_ARTIFACT)
      if (artifact === null) return undefined
      let config: Config | undefined
      try {
        config = parseEffectiveBuildConfig(artifact)
      } catch {
        config = undefined
      }
      return { ...parseBuildConfigMetadata(artifact), config }
    } catch {
      return undefined
    }
  }

  /** Project one build row against its PINNED pipeline (SPEC §16.1) and
   * attach the effective-config metadata. The row's verify/finalize steps and
   * next-action must describe the pipeline the build actually runs — the
   * artifact's build-owned sections — never the dispatcher's live base-branch
   * snapshot, which a pinned build may never execute. Deployment-owned
   * sections (roles/policy) still come from the live snapshot, so a reload
   * that reaches the build is reflected. A build with no artifact yet (queued
   * or pre-pin) projects from the live config, the pre-pin behavior. */
  private async projectRow(
    record: BuildRecord,
    state: BuildState,
    events: AbEvent[],
    config: Config,
  ): Promise<DashboardBuild | null> {
    const [streams, artifact] = await Promise.all([
      this.readStreams(record.slug),
      this.readEffectiveConfig(record.slug),
    ])
    const pinnedConfig =
      artifact?.config !== undefined ? composeBuildConfig(artifact.config, config) : undefined
    const build = projectBuild(record, state, config, events, streams, pinnedConfig)
    if (build !== null && artifact !== undefined) {
      if (artifact.revision !== undefined) build.effectiveConfigRev = artifact.revision
      if (artifact.pipelineSource !== undefined) build.pipelineSource = artifact.pipelineSource
    }
    return build
  }

  refresh(
    config: Config = this.config,
    configRevision = this.configRevision,
  ): Promise<DashboardPollSnapshot> {
    const result = this.refreshTail.then(() => this.refreshNow(config, configRevision))
    this.refreshTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async refreshNow(config: Config, configRevision: number): Promise<DashboardPollSnapshot> {
    const configChanged = configRevision !== this.configRevision || config !== this.config
    const records = (await this.reader.listBuilds()).filter((record) => record.repo === this.repo)
    const next = new Map<string, PollEntry>()

    for (const record of records) {
      const current = this.entries.get(record.slug)
      if (current?.kind === 'terminal') {
        next.set(record.slug, current)
        continue
      }

      const sinceSeq = current?.state.lastSeq ?? 0
      const delta = await this.reader.getEvents(record.slug, sinceSeq)
      validateDelta(record.slug, sinceSeq, delta)

      if (current !== undefined && delta.length === 0) {
        // Dashboard rows derive from event streams and effective config only.
        // Heartbeat and lease renewals are mutable record facts, so they leave
        // both the cached reduction and projected row untouched.
        next.set(
          record.slug,
          configChanged
            ? {
                ...current,
                build: await this.projectRow(record, current.state, current.events, config),
              }
            : current,
        )
        continue
      }

      const events = current === undefined ? delta : [...current.events, ...delta]
      const state = reduceBuild(events)
      if (isTerminal(state)) {
        next.set(record.slug, { kind: 'terminal' })
        continue
      }
      next.set(record.slug, {
        kind: 'live',
        events,
        state,
        build: await this.projectRow(record, state, events, config),
      })
    }

    // Constructing `next` only from the latest listing also prunes records that
    // disappeared. Publish once, after every read/reduction succeeded.
    this.entries = next
    this.config = config
    this.configRevision = configRevision
    this.committedRevision += 1
    return this.snapshot()
  }

  private snapshot(): DashboardPollSnapshot {
    const builds: DashboardBuild[] = []
    const states = new Map<string, BuildState>()
    for (const [slug, entry] of this.entries) {
      if (entry.kind === 'terminal') continue
      states.set(slug, entry.state)
      if (entry.build !== null) builds.push(entry.build)
    }
    builds.sort((a, b) => a.slug.localeCompare(b.slug))
    return { revision: this.committedRevision, builds, states }
  }
}
