/**
 * The ticket-asset helpers the operator surface and the CLI share: the id
 * assets are keyed by, the listing projection `ab ticket show --json` and
 * `tickets.get` both print, and the active-build notice. A leaf module, so
 * `operator/tickets.ts` and `operator/ticket-assets.ts` can both import it.
 */

import { parseIssueId } from '../ports/tickets/github-issues'
import type { TicketSource } from '../ports/types'
import { readBuildFacts } from '../store/reduced-reads'
import { composeTicketAssets, type TicketAssetSummary } from '../store/ticket-assets'
import type { BuildStore } from '../store/types'

/** One current ticket asset as `ab ticket show --json` and `tickets.get` list it. */
export interface OperatorTicketAsset {
  kind: string
  name: string
  revision: number
  size: number
  layout: TicketAssetSummary['layout']
  fileCount: number
}

/** The id ticket assets are keyed by. GitHub accepts `123` and `#123` for one
 * issue, and the dispatcher reads assets by `ref.id`, so both spellings key by
 * the issue number. Other sources key by the id as given. */
export function assetTicketId(source: string, id: string): string {
  if (source !== 'github') return id
  const number = parseIssueId(id)
  return number === null ? id : String(number)
}

export function projectTicketAssets(summaries: TicketAssetSummary[]): OperatorTicketAsset[] {
  return summaries.map(({ kind, name, revision, size, layout, fileCount }) => ({
    kind,
    name,
    revision,
    size,
    layout,
    fileCount,
  }))
}

/** The ticket's current assets. One current-mode listing: bounded by the
 * ticket's asset names, never by retained history or other tickets. */
export async function listOperatorTicketAssets(
  store: BuildStore,
  source: TicketSource,
  repo: string,
  id: string,
): Promise<OperatorTicketAsset[]> {
  return projectTicketAssets(
    await composeTicketAssets(source, store).listTicketAssets(repo, assetTicketId(source.name, id)),
  )
}

/** Slugs of this repo's non-terminal builds for the ticket. A build freezes its
 * ticket assets at the claim (SPEC §6.3), so a change to them does not reach
 * it. One build listing, then one saved reduced read per build of this ticket;
 * never a log read. The notice is advisory: a failed lookup yields none. */
export async function activeTicketBuilds(
  store: BuildStore,
  repo: string,
  id: string,
): Promise<string[]> {
  try {
    const active: string[] = []
    for (const record of await store.listBuildsForRepo(repo)) {
      if (record.ticket?.id !== id) continue
      const { status } = (await readBuildFacts(store, record.slug)).value.state
      if (status !== 'done' && status !== 'aborted') active.push(record.slug)
    }
    return active
  } catch {
    return []
  }
}
