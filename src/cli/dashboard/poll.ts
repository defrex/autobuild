import type { Config } from '../../config/schema'
import type { AbEvent } from '../../events/catalog'
import { reduceBuild, type BuildState } from '../../kernel/reducer'
import type { BuildRecord } from '../../store/types'
import { projectBuild, type DashboardBuild } from './model'

/** The read-only BuildStore surface needed to construct dashboard build rows. */
export interface DashboardBuildReader {
  listBuilds(): Promise<BuildRecord[]>
  getEvents(slug: string, sinceSeq?: number): Promise<AbEvent[]>
}

export interface DashboardPollSnapshot {
  /** Monotonic process-local cache revision. */
  revision: number
  /** Active rows only. Objects are reused while their streams are unchanged. */
  builds: DashboardBuild[]
  /** Every nonterminal reduction, including queued builds that have no row yet. */
  states: ReadonlyMap<string, BuildState>
}

interface LiveEntry {
  kind: 'live'
  record: BuildRecord
  events: AbEvent[]
  state: BuildState
  build: DashboardBuild | null
}

/** A terminal build can never become active again, so its log is discarded. */
interface TerminalEntry {
  kind: 'terminal'
}

type PollEntry = LiveEntry | TerminalEntry

function isTerminal(state: BuildState): boolean {
  return state.status === 'done' || state.status === 'aborted'
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
 * stream is hydrated from seq 0; a cached nonterminal stream is read only after
 * its reduced `lastSeq`. Empty deltas preserve the exact reduction and
 * projected row, so phase timing is not recomputed. Reducer-confirmed terminal
 * streams compact to tombstones and are never polled again.
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

  constructor(
    private readonly reader: DashboardBuildReader,
    private readonly repo: string,
    private readonly config: Config,
  ) {}

  /** True only while no later refresh has committed. */
  isCurrent(snapshot: DashboardPollSnapshot): boolean {
    return snapshot.revision === this.committedRevision
  }

  refresh(): Promise<DashboardPollSnapshot> {
    const result = this.refreshTail.then(() => this.refreshNow())
    this.refreshTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async refreshNow(): Promise<DashboardPollSnapshot> {
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
        // BuildRecord liveness fields may change without events. Keep the
        // newest record for a future projection, but preserve the expensive
        // event reduction and projected row by identity.
        next.set(record.slug, { ...current, record })
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
        record,
        events,
        state,
        build: projectBuild(record, state, this.config, events),
      })
    }

    // Constructing `next` only from the latest listing also prunes records that
    // disappeared. Publish once, after every read/reduction succeeded.
    this.entries = next
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
