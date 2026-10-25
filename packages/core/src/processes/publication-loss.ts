import { PublicationRetryPersistenceError } from '../kernel/publication-retry'
import { ForgeRequestDeferred } from '../ports/forge-request-context'
import { isRemoteWorkspace } from '../events/workspace-remote'
/**
 * Last-chance publication settlement at the workspace-release boundary
 * (AUT-328). A pending `publication.requested` whose workspace is destroyed
 * takes its only copy of un-pushed commits with it, so every destructive
 * release path must first attempt trusted settlement and then, if the request
 * still cannot be completed, durably record the loss BEFORE the release fact.
 * A release must never proceed past an unrecorded pending request: if the
 * loss record cannot be written, the append failure propagates and the caller
 * aborts the release (the next tick retries it).
 */
import { DISPATCHER } from '../events/envelope'
import type { AbEvent } from '../events/catalog'
import type { BuildStore } from '../store/types'

export interface PublicationLossDeps {
  store: BuildStore
  /** Trusted publication settlement (dispatcher-injected). A throw means the
   * request is uncompleted — the guard continues to the loss record,
   * except forge scheduling deferrals, which abort release until recovery. */
  settlePublication?: (slug: string) => Promise<void>
}

/**
 * Settle or record the loss for the latest uncompleted publication request
 * ahead of a workspace release. Returns refreshed events for the caller's
 * subsequent reads. Idempotent: a completed or already-recorded request
 * changes nothing, and repeated runs append at most one `publication.lost`.
 */
export async function settlePublicationBeforeRelease(
  deps: PublicationLossDeps,
  slug: string,
  _events: AbEvent[],
  reason: string,
): Promise<AbEvent[]> {
  const { readBuildFacts } = await import('../store/reduced-reads')
  await settlePublicationFactsBeforeRelease(
    deps,
    slug,
    (await readBuildFacts(deps.store, slug)).value,
    reason,
  )
  // Legacy callers explicitly requested the raw event output.
  return deps.store.getEvents(slug)
}

/** Current-state release guard; the returned facts follow every settlement write. */
export async function settlePublicationFactsBeforeRelease(
  deps: PublicationLossDeps,
  slug: string,
  facts: import('../store/reduced-reads').CurrentBuildFacts,
  reason: string,
) {
  const { readBuildFacts } = await import('../store/reduced-reads')
  const request = facts.publication.latestUncompletedRequest()
  if (request === undefined) {
    if (
      facts.workspace &&
      isRemoteWorkspace(facts.workspace) &&
      facts.summaryBoundary !== undefined
    ) {
      try {
        await deps.settlePublication?.(slug)
      } catch (error) {
        if (
          error instanceof ForgeRequestDeferred ||
          error instanceof PublicationRetryPersistenceError
        )
          throw error
        /* Summary is best effort. */
      }
      return (await readBuildFacts(deps.store, slug)).value
    }
    return facts
  }
  try {
    await deps.settlePublication?.(slug)
  } catch (error) {
    if (error instanceof ForgeRequestDeferred || error instanceof PublicationRetryPersistenceError)
      throw error
    /* Record loss before release. */
  }
  const refreshed = (await readBuildFacts(deps.store, slug)).value
  if (
    refreshed.publication.requestCompleted(request) ||
    refreshed.publication.lostRecorded(request)
  )
    return refreshed
  await deps.store.append(slug, {
    actor: DISPATCHER,
    type: 'publication.lost',
    payload: {
      request: request.seq,
      operation: request.payload.operation,
      branch: request.payload.branch,
      sha: request.payload.sha,
      reason,
    },
  })
  return (await readBuildFacts(deps.store, slug)).value
}
