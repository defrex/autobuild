import type { AbEvent } from '../events/catalog'

export type PublicationRequest = Extract<AbEvent, { type: 'publication.requested' }>

export function publicationRequestCompleted(
  events: readonly AbEvent[],
  request: PublicationRequest,
): boolean {
  return events.some((event) => {
    if (event.seq <= request.seq) return false
    if (request.payload.operation === 'implement')
      return (
        event.type === 'implement.completed' &&
        event.payload.round === request.payload.round &&
        event.payload.commits.base === request.payload.base &&
        event.payload.commits.head === request.payload.sha
      )
    if (request.payload.operation === 'reconcile')
      return (
        event.type === 'reconcile.completed' && event.payload.mergeCommit === request.payload.sha
      )
    if (request.payload.operation === 'finalize')
      return event.type === 'finalize.completed' && event.payload.pr.headSha === request.payload.sha
    return (
      event.type === 'finalize.step-completed' &&
      event.payload.step === request.payload.step &&
      (!event.payload.ok || event.payload.headSha === request.payload.sha)
    )
  })
}

/** A request is no longer publishable after its workspace is released. The
 * commit may have existed only in that disposable environment, so replacement
 * runners must rerun the phase rather than trying to settle the stale SHA. */
export function publicationRequestSettled(
  events: readonly AbEvent[],
  request: PublicationRequest,
): boolean {
  let workspaceRef: string | undefined
  for (const event of events) {
    if (event.seq > request.seq) break
    if (event.type === 'workspace.provisioned') workspaceRef = event.payload.ref
    else if (event.type === 'workspace.released') workspaceRef = undefined
  }
  return (
    publicationRequestCompleted(events, request) ||
    events.some(
      (event) =>
        event.seq > request.seq &&
        event.type === 'workspace.released' &&
        (!('ref' in event.payload) ||
          workspaceRef === undefined ||
          event.payload.ref === workspaceRef),
    )
  )
}

/** The latest `publication.requested` with no settling completion fact — the
 * single settlement target for every caller that would previously re-derive it
 * with a private `findLast`. */
export function latestUncompletedPublicationRequest(
  events: readonly AbEvent[],
): PublicationRequest | undefined {
  const request = events.findLast(
    (event) =>
      event.type === 'publication.requested' && !publicationRequestCompleted(events, event),
  )
  return request?.type === 'publication.requested' ? request : undefined
}

/** Whether the durable loss record (AUT-328) has already been appended for
 * `request`. The release guard and the settlement backstop both consult this
 * so repeated ticks append at most one `publication.lost` per request. */
export function publicationLostRecorded(
  events: readonly AbEvent[],
  request: PublicationRequest,
): boolean {
  return events.some(
    (event) => event.type === 'publication.lost' && event.payload.request === request.seq,
  )
}

export function abandonedPublicationPending(events: readonly AbEvent[]): boolean {
  const request = latestUncompletedPublicationRequest(events)
  return request !== undefined && publicationRequestSettled(events, request)
}

export function publicationPending(events: readonly AbEvent[]): boolean {
  return events.some(
    (request) =>
      request.type === 'publication.requested' && !publicationRequestSettled(events, request),
  )
}
