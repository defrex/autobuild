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
import {
  latestUncompletedPublicationRequest,
  publicationLostRecorded,
  publicationRequestCompleted,
} from './publication-state'
import type { BuildStore } from '../store/types'

export interface PublicationLossDeps {
  store: BuildStore
  /** Trusted publication settlement (dispatcher-injected). A throw means the
   * request is uncompleted — the guard continues to the loss record. */
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
  events: AbEvent[],
  reason: string,
): Promise<AbEvent[]> {
  const request = latestUncompletedPublicationRequest(events)
  if (request === undefined) return events
  try {
    await deps.settlePublication?.(slug)
  } catch {
    // A throw means the request is still uncompleted (or settlement failed);
    // either way the loss record below is what makes the release safe.
  }
  const refreshed = await deps.store.getEvents(slug)
  if (publicationRequestCompleted(refreshed, request)) return refreshed
  if (publicationLostRecorded(refreshed, request)) return refreshed
  const appended = await deps.store.append(slug, {
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
  return [...refreshed, appended]
}
