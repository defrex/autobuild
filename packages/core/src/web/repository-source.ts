import { NO_DISPATCHER_RUN_LINE } from '../cli/dashboard/configuration'
import { dispatchWarningLines, projectRepositoryHeader } from '../cli/dashboard/header'
import { readRepositoryFacts } from '../store/reduced-reads'
import type { BuildStore } from '../store/types'
import type { WebFrame, WebFrameSource } from './protocol'

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

  async read(): Promise<{ frame: WebFrame; live: boolean }> {
    const position = await this.reader.getRepoChangePosition(this.repo)
    if (this.cached !== undefined && position === this.position) return this.cached
    const facts = (await readRepositoryFacts(this.reader, this.repo)).value
    const status = facts.status
    const { header } = projectRepositoryHeader(
      {
        repo: this.repo,
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
    // Cache only after every read succeeded, so a failure retries at the old position.
    this.cached = { frame, live }
    this.position = position
    return this.cached
  }
}
