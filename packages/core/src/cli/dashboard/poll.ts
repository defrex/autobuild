import { enrichIntegrationRows } from './integration-row'
import {
  dispatchCapacity,
  startClaimDemand,
  urgentClaimDemand,
  type CapacityBuild,
} from '../../kernel/dispatch-capacity'
import type { DispatchStatus } from '../../kernel/dispatch-status'
import {
  openBuildWorkspaceReducer,
  provisionMarkerReducer,
} from '../../processes/dispatcher-selectors'
import type { Config } from '../../config/schema'
import { composeBuildConfig } from '../../config/live'
import type { PipelineSourceMeta } from '../../config/pipeline-source'
import type { AbEvent } from '../../events/catalog'
import { buildReducer, type BuildAcc, type BuildState } from '../../kernel/reducer'
import { landingRestackDue } from '../../kernel/engine'
import { capacityBuildFromFacts } from '../../kernel/capacity-build'
import { leafRestackReducer, type LeafRestackState } from '../../kernel/leaf-restack-state'
import {
  BUILD_EFFECTIVE_CONFIG_ARTIFACT,
  parseBuildConfigMetadata,
  parseEffectiveBuildConfig,
} from '../../processes/build-execution-state'
import type {
  Artifact,
  BuildRecord,
  BuildStore,
  StreamRecord,
  StreamScope,
} from '../../store/types'
import { readBuildFacts, type RepositoryReadFacts } from '../../store/reduced-reads'
import { dispatchWarningLines, repositoryQueueDepth } from './header'
import {
  projectBuild,
  projectBuildFromFacts,
  type DashboardBuild,
  type DashboardHeader,
  type DashboardRowFacts,
} from './model'

/** The read-only BuildStore surface needed to construct dashboard build rows.
 * `listStreams` is optional: when present, build-scope records enrich each
 * row's session history with authoritative stream ids and statuses (SPEC §9).
 * `getArtifact` is optional: when present, the effective-config artifact's
 * metadata decorates each row with its pinned pipeline source and revision
 * (SPEC §16.1). */
export interface DashboardBuildReader {
  getReducerValue?: BuildStore['getReducerValue']
  listBuildsForRepo(repo: string): Promise<BuildRecord[]>
  getEvents(slug: string, sinceSeq?: number): Promise<AbEvent[]>
  listStreams?(scope: StreamScope): Promise<StreamRecord[]>
  getArtifact?(slug: string, kind: string, rev?: number): Promise<Artifact | null>
}

export interface DashboardPollSnapshot {
  /** Monotonic process-local cache revision. */
  revision: number
  capacityBuilds?: CapacityBuild[]
  /** Every dashboard-visible row, including acknowledged abort cleanup. Objects
   * are reused while their streams are unchanged. */
  builds: DashboardBuild[]
  /** Every dashboard-visible reduction; this map and `builds` have matching
   * membership. `aborted` entries are visible but do not consume capacity. */
  states: ReadonlyMap<string, BuildState>
}

interface LiveEntry {
  kind: 'live'
  record: BuildRecord
  workspace: ReturnType<typeof openBuildWorkspaceReducer.initial>
  provisionMarker: ReturnType<typeof provisionMarkerReducer.initial>
  events: AbEvent[]
  /** The reducer accumulator `state` was derived from; the next delta is
   * folded into a copy of it instead of re-reducing the whole log. */
  acc: BuildAcc
  state: BuildState
  /** Advanced with every delta, for `landingRestackDue`. */
  restack: LeafRestackState
  build: DashboardBuild | null
}

/** A fully completed build can never become visible again, so its log is discarded. */
interface TerminalEntry {
  kind: 'terminal'
  record: BuildRecord
}

interface ReducedEntry {
  kind: 'reduced'
  cursor: number
  record: BuildRecord
  state: BuildState
  workspace: boolean
  provisioning: boolean
  provisioningSeq?: number
  restackDue: boolean
  build: DashboardBuild | null
}

type PollEntry = LiveEntry | TerminalEntry | ReducedEntry

/** A build the dashboard no longer shows. `build.aborted` acknowledges
 * cancellation but begins the checkpointed cleanup saga, so an aborted build
 * stays visible until its final `build.completed` fact. */
export function isDashboardTerminal(state: BuildState): boolean {
  return state.status === 'done'
}

export { capacityBuildFromFacts }

function provisioningSeqOf(seq: number | undefined): Pick<CapacityBuild, 'provisioningSeq'> {
  return seq === undefined ? {} : { provisioningSeq: seq }
}

/** The display-only reads that decorate one row: authoritative stream
 * records (SPEC §9) and the pinned effective-config artifact (SPEC §16.1). */
export interface RowEnrichment {
  streams: StreamRecord[] | undefined
  artifact: { revision?: number; pipelineSource?: PipelineSourceMeta; config?: Config } | undefined
}

/** Read one build's row enrichment, when the reader exposes the stream and
 * artifact primitives. Every failure is display-only: an absent enrichment
 * degrades to the pairing-derived status and the live config. */
export async function readRowEnrichment(
  reader: Pick<DashboardBuildReader, 'listStreams' | 'getArtifact'>,
  slug: string,
  pin?: BuildState['verify']['configPin'],
): Promise<RowEnrichment> {
  const [streams, artifact] = await Promise.all([
    readStreams(reader, slug),
    readEffectiveConfig(reader, slug, pin),
  ])
  return { streams, artifact }
}

async function readStreams(
  reader: Pick<DashboardBuildReader, 'listStreams'>,
  slug: string,
): Promise<StreamRecord[] | undefined> {
  if (reader.listStreams === undefined) return undefined
  try {
    return await reader.listStreams({ kind: 'build', build: slug })
  } catch {
    return undefined
  }
}

/** The metadata projection plus the artifact's parsed content. A malformed
 * artifact still yields its metadata (config absent). */
async function readEffectiveConfig(
  reader: Pick<DashboardBuildReader, 'getArtifact'>,
  slug: string,
  pin?: BuildState['verify']['configPin'],
): Promise<RowEnrichment['artifact']> {
  const getArtifact = reader.getArtifact
  if (getArtifact === undefined) return undefined
  try {
    const artifact = await getArtifact.call(
      reader,
      slug,
      pin?.artifact.kind ?? BUILD_EFFECTIVE_CONFIG_ARTIFACT,
      pin?.artifact.rev,
    )
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
 * or pre-pin) projects from the live config, the pre-pin behavior. Pure. */
export function projectRowWithEnrichment(
  record: BuildRecord,
  state: BuildState,
  events: AbEvent[],
  config: Config,
  { streams, artifact }: RowEnrichment,
  facts?: DashboardRowFacts,
): DashboardBuild | null {
  const pinnedConfig =
    artifact?.config !== undefined ? composeBuildConfig(artifact.config, config) : undefined
  const build = facts
    ? projectBuildFromFacts(record, state, facts, config, streams, pinnedConfig)
    : projectBuild(record, state, config, events, streams, pinnedConfig)
  if (build !== null && artifact !== undefined) {
    if (artifact.revision !== undefined) build.effectiveConfigRev = artifact.revision
    if (artifact.pipelineSource !== undefined) build.pipelineSource = artifact.pipelineSource
  }
  return build
}

/**
 * The dashboard header for one repository frame: the queue and capacity
 * terms every frontend shows. The queue term is the latest ticket scan's
 * depth (`repositoryQueueDepth`), never one dispatcher run's status. `states` are the visible builds' reductions;
 * acknowledged aborts and integration nodes do not count as active.
 */
export function repositoryDashboardHeader(input: {
  repo: string
  status: DispatchStatus
  config: Config
  repositoryFacts: RepositoryReadFacts
  capacityBuilds: readonly CapacityBuild[]
  states: Iterable<BuildState>
  now: Date
  triage?: number
  standby?: string
}): DashboardHeader {
  const { status, config, repositoryFacts } = input
  const warningLines = dispatchWarningLines(status)
  return {
    repo: input.repo,
    ...(input.standby !== undefined ? { standby: input.standby } : {}),
    queued: repositoryQueueDepth(repositoryFacts),
    activeCount: [...input.states].filter(
      (state) => state.kind !== 'node' && state.status !== 'done' && state.status !== 'aborted',
    ).length,
    capacity: config.capacity,
    capacityProjection: dispatchCapacity(input.capacityBuilds, config.capacity, input.now, {
      urgentClaims: urgentClaimDemand(repositoryFacts),
      openPrs: {
        policy: config.policy,
        engaged: repositoryFacts.openPrBackpressure !== undefined,
      },
      startRequests: startClaimDemand(repositoryFacts),
    }),
    ...(input.triage !== undefined ? { triage: input.triage } : {}),
    ...(status.availableUpgrade !== undefined ? { availableUpgrade: status.availableUpgrade } : {}),
    ...(warningLines.length > 0 ? { warningLines } : {}),
  }
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
 * Every refresh still discovers records with `listBuildsForRepo(repo)`. A first-seen
 * stream uses persisted build facts when available, with no event reads; local
 * readers without reduced values hydrate from seq 0, then read only after their
 * reduced `lastSeq`. Empty deltas preserve the exact reduction and
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

  /** True only while no later refresh has committed. */
  isCurrent(snapshot: DashboardPollSnapshot): boolean {
    return snapshot.revision === this.committedRevision
  }

  private async projectRow(
    record: BuildRecord,
    state: BuildState,
    events: AbEvent[],
    config: Config,
    facts?: DashboardRowFacts,
  ): Promise<DashboardBuild | null> {
    const enrichment = await readRowEnrichment(this.reader, record.slug, state.verify.configPin)
    return projectRowWithEnrichment(record, state, events, config, enrichment, facts)
  }

  refresh(
    config: Config = this.config,
    configRevision = this.configRevision,
    fullEnrichment = false,
  ): Promise<DashboardPollSnapshot> {
    const result = this.refreshTail.then(() =>
      this.refreshNow(config, configRevision, fullEnrichment),
    )
    this.refreshTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async refreshNow(
    config: Config,
    configRevision: number,
    fullEnrichment: boolean,
  ): Promise<DashboardPollSnapshot> {
    const configChanged = configRevision !== this.configRevision || config !== this.config
    const records = await this.reader.listBuildsForRepo(this.repo)
    const next = new Map<string, PollEntry>()

    for (const record of records) {
      const current = this.entries.get(record.slug)
      if (current?.kind === 'terminal') {
        next.set(record.slug, { ...current, record })
        continue
      }

      if (this.reader.getReducerValue !== undefined) {
        const { cursor, value } = await readBuildFacts(
          { getReducerValue: this.reader.getReducerValue.bind(this.reader) },
          record.slug,
        )
        if (isDashboardTerminal(value.state)) {
          next.set(record.slug, { kind: 'terminal', record })
        } else {
          const capacity = capacityBuildFromFacts(record, value)
          next.set(record.slug, {
            kind: 'reduced',
            cursor,
            record,
            state: value.state,
            workspace: capacity.workspace,
            provisioning: capacity.provisioning,
            ...(capacity.provisioningSeq !== undefined
              ? { provisioningSeq: capacity.provisioningSeq }
              : {}),
            restackDue: capacity.restackDue,
            build:
              current?.kind === 'reduced' &&
              current.cursor === cursor &&
              !fullEnrichment &&
              !configChanged &&
              current.build?.ticketId === record.ticket?.id
                ? current.build
                : await this.projectRow(record, value.state, [], config, value),
          })
        }
        continue
      }
      if (current?.kind === 'reduced') throw new Error('dashboard reader lost reduced values')

      const sinceSeq = current?.state.lastSeq ?? 0
      const delta = await this.reader.getEvents(record.slug, sinceSeq)
      validateDelta(record.slug, sinceSeq, delta)

      if (current !== undefined && delta.length === 0) {
        // Preserve the reduction on empty deltas. Bounded full refreshes also
        // reload mutable record, stream and artifact enrichment.
        next.set(
          record.slug,
          fullEnrichment || configChanged || current.build?.ticketId !== record.ticket?.id
            ? {
                ...current,
                record,
                build: await this.projectRow(record, current.state, current.events, config),
              }
            : { ...current, record },
        )
        continue
      }

      const events = current === undefined ? delta : [...current.events, ...delta]
      const acc = buildReducer.advance(current?.acc ?? buildReducer.initial(), delta)
      const state = buildReducer.finish(acc)
      if (isDashboardTerminal(state)) {
        next.set(record.slug, { kind: 'terminal', record })
        continue
      }
      next.set(record.slug, {
        kind: 'live',
        record,
        workspace: openBuildWorkspaceReducer.advance(
          current?.workspace ?? openBuildWorkspaceReducer.initial(),
          delta,
        ),
        provisionMarker: provisionMarkerReducer.advance(
          current?.provisionMarker ?? provisionMarkerReducer.initial(),
          delta,
        ),
        events,
        acc,
        state,
        restack: leafRestackReducer.advance(
          current?.restack ?? leafRestackReducer.initial(),
          delta,
        ),
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
    const capacityBuilds: CapacityBuild[] = []
    for (const [slug, entry] of this.entries) {
      if (entry.kind === 'terminal') continue
      capacityBuilds.push({
        record: entry.record,
        state: entry.state,
        workspace: entry.kind === 'reduced' ? entry.workspace : entry.workspace.open !== null,
        provisioning:
          entry.kind === 'reduced' ? entry.provisioning : entry.provisionMarker.marker !== null,
        ...provisioningSeqOf(
          entry.kind === 'reduced' ? entry.provisioningSeq : entry.provisionMarker.marker?.seq,
        ),
        restackDue:
          entry.kind === 'reduced'
            ? entry.restackDue
            : landingRestackDue(entry.state, { restack: entry.restack }),
      })
      states.set(slug, entry.state)
      if (entry.build !== null) builds.push(entry.build)
    }
    builds.sort((a, b) => a.slug.localeCompare(b.slug))
    return {
      revision: this.committedRevision,
      builds: enrichIntegrationRows(
        builds,
        [...this.entries.values()].map((e) => e.record),
      ),
      states,
      capacityBuilds,
    }
  }
}
