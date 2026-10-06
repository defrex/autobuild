import type { AbEvent } from '../events/catalog'
import { defineReducer, type IncrementalReducer } from '../kernel/incremental'

export type PublicationRequest = Extract<AbEvent, { type: 'publication.requested' }>

/** One entry of the order-preserving publication ledger: the fields the
 * publication selectors read from each relevant event, in array order. */
type LedgerItem =
  | { t: 'request'; seq: number; event: PublicationRequest }
  | { t: 'lost'; seq: number; request: number }
  | { t: 'provisioned'; seq: number; ref: string }
  | { t: 'released'; seq: number; ref?: string | null }
  | { t: 'implement'; seq: number; round: number; base: string; head: string }
  | { t: 'reconcile'; seq: number; mergeCommit: string }
  | { t: 'finalize'; seq: number; headSha: string }
  | { t: 'step'; seq: number; step: string; ok: boolean; headSha?: string }
  /** A maximal run of consecutive irrelevant events. Only its max seq
   * matters: the workspace scan's `seq > request.seq` break test. */
  | { t: 'barrier'; seq: number }

/** The publication family's accumulator: the whole event sequence in array
 * order, relevant events compacted and each run of irrelevant ones collapsed
 * to a barrier. Filtering to relevant types alone would be wrong, because
 * `publicationRequestSettled` stops its workspace scan at the first event (of
 * any type) whose seq exceeds the request's. */
export interface PublicationLedger {
  ledger: LedgerItem[]
}

/** Bump when `PublicationLedger` or its fold changes. */
export const PUBLICATION_STATE_REDUCER_VERSION = 1

function compact(event: AbEvent): LedgerItem | undefined {
  switch (event.type) {
    case 'publication.requested':
      return { t: 'request', seq: event.seq, event }
    case 'publication.lost':
      return { t: 'lost', seq: event.seq, request: event.payload.request }
    case 'workspace.provisioned':
      return { t: 'provisioned', seq: event.seq, ref: event.payload.ref }
    case 'workspace.released': {
      const payload = event.payload as { ref?: string }
      return 'ref' in payload
        ? { t: 'released', seq: event.seq, ref: payload.ref ?? null }
        : { t: 'released', seq: event.seq }
    }
    case 'implement.completed':
      return {
        t: 'implement',
        seq: event.seq,
        round: event.payload.round,
        base: event.payload.commits.base,
        head: event.payload.commits.head,
      }
    case 'reconcile.completed':
      return { t: 'reconcile', seq: event.seq, mergeCommit: event.payload.mergeCommit }
    case 'finalize.completed':
      return { t: 'finalize', seq: event.seq, headSha: event.payload.pr.headSha }
    case 'finalize.step-completed': {
      const item: LedgerItem = {
        t: 'step',
        seq: event.seq,
        step: event.payload.step,
        ok: event.payload.ok,
      }
      const headSha = (event.payload as { headSha?: string }).headSha
      if (headSha !== undefined) item.headSha = headSha
      return item
    }
    default:
      return undefined
  }
}

function itemCompletes(item: LedgerItem, request: PublicationRequest): boolean {
  if (item.seq <= request.seq) return false
  const payload = request.payload
  if (payload.operation === 'implement')
    return (
      item.t === 'implement' &&
      item.round === payload.round &&
      item.base === payload.base &&
      item.head === payload.sha
    )
  if (payload.operation === 'reconcile')
    return item.t === 'reconcile' && item.mergeCommit === payload.sha
  if (payload.operation === 'finalize') return item.t === 'finalize' && item.headSha === payload.sha
  return (
    item.t === 'step' && item.step === payload.step && (!item.ok || item.headSha === payload.sha)
  )
}

/** The publication selectors, derived from one ledger. */
export interface PublicationView {
  requestCompleted(request: PublicationRequest): boolean
  requestSettled(request: PublicationRequest): boolean
  latestUncompletedRequest(): PublicationRequest | undefined
  lostRecorded(request: PublicationRequest): boolean
  abandonedPending(): boolean
  pending(): boolean
}

function viewOf(ledger: readonly LedgerItem[]): PublicationView {
  const requestCompleted = (request: PublicationRequest): boolean =>
    ledger.some((item) => itemCompletes(item, request))

  const requestSettled = (request: PublicationRequest): boolean => {
    let workspaceRef: string | undefined
    for (const item of ledger) {
      if (item.seq > request.seq) break
      if (item.t === 'provisioned') workspaceRef = item.ref
      else if (item.t === 'released') workspaceRef = undefined
    }
    return (
      requestCompleted(request) ||
      ledger.some(
        (item) =>
          item.seq > request.seq &&
          item.t === 'released' &&
          (item.ref === undefined || workspaceRef === undefined || item.ref === workspaceRef),
      )
    )
  }

  const latestUncompletedRequest = (): PublicationRequest | undefined => {
    const item = ledger.findLast((entry) => entry.t === 'request' && !requestCompleted(entry.event))
    return item?.t === 'request' ? item.event : undefined
  }

  return {
    requestCompleted,
    requestSettled,
    latestUncompletedRequest,
    lostRecorded: (request) =>
      ledger.some((item) => item.t === 'lost' && item.request === request.seq),
    abandonedPending() {
      const request = latestUncompletedRequest()
      return request !== undefined && requestSettled(request)
    },
    pending: () => ledger.some((item) => item.t === 'request' && !requestSettled(item.event)),
  }
}

export const publicationStateReducer: IncrementalReducer<
  PublicationLedger,
  AbEvent,
  PublicationView
> = defineReducer<PublicationLedger, AbEvent, PublicationView>({
  version: PUBLICATION_STATE_REDUCER_VERSION,
  initial: () => ({ ledger: [] }),
  fold(acc, events) {
    for (const event of events) {
      const item = compact(event)
      const last = acc.ledger[acc.ledger.length - 1]
      if (item !== undefined) acc.ledger.push(item)
      else if (last?.t === 'barrier') last.seq = Math.max(last.seq, event.seq)
      else acc.ledger.push({ t: 'barrier', seq: event.seq })
    }
  },
  finish: (acc) => viewOf(acc.ledger),
})

export function publicationRequestCompleted(
  events: readonly AbEvent[],
  request: PublicationRequest,
): boolean {
  return publicationStateReducer.reduce(events).requestCompleted(request)
}

/** A request is no longer publishable after its workspace is released. The
 * commit may have existed only in that disposable environment, so replacement
 * runners must rerun the phase rather than trying to settle the stale SHA. */
export function publicationRequestSettled(
  events: readonly AbEvent[],
  request: PublicationRequest,
): boolean {
  return publicationStateReducer.reduce(events).requestSettled(request)
}

/** The latest `publication.requested` with no settling completion fact — the
 * single settlement target for every caller that would previously re-derive it
 * with a private `findLast`. */
export function latestUncompletedPublicationRequest(
  events: readonly AbEvent[],
): PublicationRequest | undefined {
  return publicationStateReducer.reduce(events).latestUncompletedRequest()
}

/** Whether the durable loss record (AUT-328) has already been appended for
 * `request`. The release guard and the settlement backstop both consult this
 * so repeated ticks append at most one `publication.lost` per request. */
export function publicationLostRecorded(
  events: readonly AbEvent[],
  request: PublicationRequest,
): boolean {
  return publicationStateReducer.reduce(events).lostRecorded(request)
}

export function abandonedPublicationPending(events: readonly AbEvent[]): boolean {
  return publicationStateReducer.reduce(events).abandonedPending()
}

export function publicationPending(events: readonly AbEvent[]): boolean {
  return publicationStateReducer.reduce(events).pending()
}
