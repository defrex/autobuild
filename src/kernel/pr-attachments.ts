import type { AbEvent } from '../events/catalog'
import type { PrImageHostTarget } from '../ontology'

export type PrAttachmentDesignationEvent = Extract<
  AbEvent,
  { type: 'pr-attachment.designated' }
>
export type PrAttachmentHostedEvent = Extract<
  AbEvent,
  { type: 'pr-attachment.hosted' }
>

/** The host consent frozen into the build at claim time. */
export function frozenPrImageHost(
  events: readonly AbEvent[],
): PrImageHostTarget | undefined {
  let created: Extract<AbEvent, { type: 'build.created' }> | undefined
  for (const event of events) {
    if (
      event.type === 'build.created' &&
      (created === undefined || event.seq < created.seq)
    ) {
      created = event
    }
  }
  return created?.payload.pr?.imageHost
}

/**
 * Current PR attachments are explicit designations after the latest spec
 * restart, with the newest exact revision replacing earlier designations of
 * the same artifact kind. Distinct kinds remain distinct attachments.
 */
export function currentPrAttachments(
  events: readonly AbEvent[],
): PrAttachmentDesignationEvent[] {
  let restartSeq = 0
  for (const event of events) {
    if (event.type === 'spec.revised') restartSeq = Math.max(restartSeq, event.seq)
  }

  const byKind = new Map<string, PrAttachmentDesignationEvent>()
  for (const event of events) {
    if (event.type !== 'pr-attachment.designated' || event.seq <= restartSeq) {
      continue
    }
    const previous = byKind.get(event.payload.artifact.kind)
    if (previous === undefined || event.seq > previous.seq) {
      byKind.set(event.payload.artifact.kind, event)
    }
  }
  return [...byKind.values()].sort((left, right) => left.seq - right.seq)
}

/**
 * Correlate one durable hosted copy to each current designation. Unknown,
 * backwards, and stale correlations are ignored rather than throwing so the
 * selector remains total over any structurally valid event ordering.
 */
export function hostedPrAttachments(
  events: readonly AbEvent[],
  designations = currentPrAttachments(events),
): Map<number, PrAttachmentHostedEvent> {
  const designationBySeq = new Map(designations.map((event) => [event.seq, event]))
  const hosted = new Map<number, PrAttachmentHostedEvent>()
  for (const event of events) {
    if (event.type !== 'pr-attachment.hosted') continue
    const designation = designationBySeq.get(event.payload.designationSeq)
    if (designation === undefined || event.seq <= designation.seq) continue
    const previous = hosted.get(designation.seq)
    if (previous === undefined || event.seq > previous.seq) {
      hosted.set(designation.seq, event)
    }
  }
  return hosted
}

/** Every durable hosted copy that has not yet received a later reclaim fact. */
export function pendingPrAttachmentReclaims(
  events: readonly AbEvent[],
): PrAttachmentHostedEvent[] {
  const hosted = events
    .filter(
      (event): event is PrAttachmentHostedEvent =>
        event.type === 'pr-attachment.hosted',
    )
    .sort((left, right) => left.seq - right.seq)
  const hostedSeqs = new Set(hosted.map((event) => event.seq))
  const reclaimed = new Set<number>()
  for (const event of events) {
    if (
      event.type === 'pr-attachment.reclaimed' &&
      hostedSeqs.has(event.payload.hostedSeq) &&
      event.seq > event.payload.hostedSeq
    ) {
      reclaimed.add(event.payload.hostedSeq)
    }
  }
  return hosted.filter((event) => !reclaimed.has(event.seq))
}
