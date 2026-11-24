import { NO_DISPATCHER_RUN_LINE } from '../cli/dashboard/configuration'
import { dispatchWarningLines, projectRepositoryHeader } from '../cli/dashboard/header'
import type { RepositoryReadFacts } from '../store/reduced-reads'
import type { WebFrame } from './protocol'

/**
 * The web UI's repository frame for `facts`, the repository value a store
 * read returned: the dashboard header facts that come from repository-scope
 * values only, plus the notice. Pure. `ab dispatch --web` pushes exactly this
 * frame; `ab web` adds the overview to it (`overview-source.ts`). `live` asks
 * for the fast cadence.
 */
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
