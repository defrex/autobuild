import { NO_DISPATCHER_RUN_LINE } from '../cli/dashboard/configuration'
import { dispatchWarningLines, projectRepositoryHeader } from '../cli/dashboard/header'
import { readRepositoryFacts, type RepositoryReadFacts } from '../store/reduced-reads'
import type { BuildStore } from '../store/types'
import { type WebFrame, type WebFrameSource, WebReadFencedError } from './protocol'

/** The only store reads the repository frame may make. Build-scope reads are
 * deliberately absent: their cost grows with build count. */
export type RepositoryFrameReader = Pick<
  BuildStore,
  'getRepoChangePosition' | 'getRepo' | 'getReducerValue'
>

/**
 * The web UI's repository frame: the dashboard header facts that come from
 * repository-scope values only. Each read costs one change-position read
 * while nothing changes, and one saved repository value (advanced by delta)
 * when the position moves. Nothing it reads grows with history or build count.
 */
export class RepositoryFrameSource implements WebFrameSource {
  private position: string | undefined
  private cached: { frame: WebFrame; live: boolean } | undefined

  constructor(
    private readonly reader: RepositoryFrameReader,
    private readonly repo: string,
  ) {}

  async read(admitted: () => boolean = () => true): Promise<{ frame: WebFrame; live: boolean }> {
    // Every store stage checks admission first, so a read whose last
    // subscriber left stops at the next stage instead of reading on.
    const reader = fenced(this.reader, admitted)
    const position = await reader.getRepoChangePosition(this.repo)
    if (this.cached !== undefined && position === this.position) return this.cached
    const facts = (await readRepositoryFacts(reader, this.repo)).value
    const projected = projectRepositoryFrame(this.repo, facts)
    // Cache only after every read succeeded, so a failure retries at the old position.
    this.cached = projected
    this.position = position
    return this.cached
  }
}

/** The repository frame for `facts`, the repository value a store read
 * returned. Pure: `ab web` and `ab dispatch --web` show the same frame for
 * the same facts. `live` asks for the fast cadence. */
export function projectRepositoryFrame(
  repo: string,
  facts: RepositoryReadFacts,
): { frame: WebFrame; live: boolean } {
  const status = facts.status
  const { header } = projectRepositoryHeader(
    {
      repo,
      queued: status?.queued ?? 0,
      ...(status?.triage !== undefined ? { triage: status.triage } : {}),
      ...(status?.availableUpgrade !== undefined
        ? { availableUpgrade: status.availableUpgrade }
        : {}),
      warningLines: status ? dispatchWarningLines(status) : [],
    },
    facts,
    facts.upgrades,
  )
  const notice = facts.config.run === undefined ? NO_DISPATCHER_RUN_LINE : status?.notice
  const frame: WebFrame = { repository: header, ...(notice !== undefined ? { notice } : {}) }
  const live = status?.health === 'starting' || status?.health === 'running'
  return { frame, live }
}

function fenced(reader: RepositoryFrameReader, admitted: () => boolean): RepositoryFrameReader {
  const gate = () => {
    if (!admitted()) throw new WebReadFencedError()
  }
  return {
    getRepoChangePosition: async (...args) => {
      gate()
      return reader.getRepoChangePosition(...args)
    },
    getRepo: async (...args) => {
      gate()
      return reader.getRepo(...args)
    },
    getReducerValue: (async (...args: Parameters<RepositoryFrameReader['getReducerValue']>) => {
      gate()
      return reader.getReducerValue(...args)
    }) as RepositoryFrameReader['getReducerValue'],
  }
}
