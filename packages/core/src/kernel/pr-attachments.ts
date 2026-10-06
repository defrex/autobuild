import type { AbEvent } from '../events/catalog'
import type { PrImageHostTarget } from '../ontology'
import { defineReducer, type IncrementalReducer } from './incremental'

export type PrAttachmentDesignationEvent = Extract<AbEvent, { type: 'pr-attachment.designated' }>
export type PrAttachmentHostedEvent = Extract<AbEvent, { type: 'pr-attachment.hosted' }>

/** The host consent frozen into the build at claim time: the lowest-seq
 * `build.created` seen so far (first in array order on a tie). */
export interface FrozenPrImageHostAcc {
  created?: { seq: number; imageHost?: PrImageHostTarget }
}

/** Bump when `FrozenPrImageHostAcc` or its fold changes. */
export const FROZEN_PR_IMAGE_HOST_REDUCER_VERSION = 1

export const frozenPrImageHostReducer: IncrementalReducer<
  FrozenPrImageHostAcc,
  AbEvent,
  PrImageHostTarget | undefined
> = defineReducer<FrozenPrImageHostAcc, AbEvent, PrImageHostTarget | undefined>({
  version: FROZEN_PR_IMAGE_HOST_REDUCER_VERSION,
  initial: () => ({}),
  fold(acc, events) {
    for (const event of events) {
      if (
        event.type === 'build.created' &&
        (acc.created === undefined || event.seq < acc.created.seq)
      ) {
        const imageHost = event.payload.pr?.imageHost
        acc.created = imageHost === undefined ? { seq: event.seq } : { seq: event.seq, imageHost }
      }
    }
  },
  finish: (acc) => acc.created?.imageHost,
})

/** The host consent frozen into the build at claim time. */
export function frozenPrImageHost(events: readonly AbEvent[]): PrImageHostTarget | undefined {
  return frozenPrImageHostReducer.reduce(events)
}

/** Designation state shared by the current and hosted projections: the
 * restart fence plus the highest-seq designation per artifact kind (first in
 * array order on a tie). Keeping only the latest per kind is exact: if it is
 * at or below the restart, every earlier one is too. */
interface DesignationAcc {
  restartSeq: number
  byKind: Record<string, PrAttachmentDesignationEvent>
}

function initialDesignations(): DesignationAcc {
  return { restartSeq: 0, byKind: {} }
}

function foldDesignations(acc: DesignationAcc, event: AbEvent): void {
  if (event.type === 'spec.revised') {
    acc.restartSeq = Math.max(acc.restartSeq, event.seq)
  } else if (event.type === 'pr-attachment.designated') {
    const kind = event.payload.artifact.kind
    const previous = Object.hasOwn(acc.byKind, kind) ? acc.byKind[kind] : undefined
    if (previous === undefined || event.seq > previous.seq) acc.byKind[kind] = event
  }
}

function finishDesignations(acc: DesignationAcc): PrAttachmentDesignationEvent[] {
  return Object.values(acc.byKind)
    .filter((event) => event.seq > acc.restartSeq)
    .sort((left, right) => left.seq - right.seq)
}

export type CurrentPrAttachmentsAcc = DesignationAcc

/** Bump when `CurrentPrAttachmentsAcc` or its fold changes. */
export const CURRENT_PR_ATTACHMENTS_REDUCER_VERSION = 1

export const currentPrAttachmentsReducer: IncrementalReducer<
  CurrentPrAttachmentsAcc,
  AbEvent,
  PrAttachmentDesignationEvent[]
> = defineReducer<CurrentPrAttachmentsAcc, AbEvent, PrAttachmentDesignationEvent[]>({
  version: CURRENT_PR_ATTACHMENTS_REDUCER_VERSION,
  initial: initialDesignations,
  fold(acc, events) {
    for (const event of events) foldDesignations(acc, event)
  },
  finish: finishDesignations,
})

/**
 * Current PR attachments are explicit designations after the latest spec
 * restart, with the newest exact revision replacing earlier designations of
 * the same artifact kind. Distinct kinds remain distinct attachments.
 */
export function currentPrAttachments(events: readonly AbEvent[]): PrAttachmentDesignationEvent[] {
  return currentPrAttachmentsReducer.reduce(events)
}

/** The designation state plus the highest-seq hosted copy per designation seq
 * (first in array order on a tie). If the highest fails the `seq >
 * designation.seq` check, every lower one does too. */
export interface HostedPrAttachmentsAcc extends DesignationAcc {
  hostedByDesignation: Record<string, PrAttachmentHostedEvent>
}

/** Bump when `HostedPrAttachmentsAcc` or its fold changes. */
export const HOSTED_PR_ATTACHMENTS_REDUCER_VERSION = 1

function finishHosted(
  acc: HostedPrAttachmentsAcc,
  designations: readonly PrAttachmentDesignationEvent[],
): Map<number, PrAttachmentHostedEvent> {
  const hosted = new Map<number, PrAttachmentHostedEvent>()
  for (const designation of designations) {
    const event = Object.hasOwn(acc.hostedByDesignation, designation.seq)
      ? acc.hostedByDesignation[designation.seq]
      : undefined
    if (event !== undefined && event.seq > designation.seq) hosted.set(designation.seq, event)
  }
  return hosted
}

export const hostedPrAttachmentsReducer: IncrementalReducer<
  HostedPrAttachmentsAcc,
  AbEvent,
  Map<number, PrAttachmentHostedEvent>
> = defineReducer<HostedPrAttachmentsAcc, AbEvent, Map<number, PrAttachmentHostedEvent>>({
  version: HOSTED_PR_ATTACHMENTS_REDUCER_VERSION,
  initial: () => ({ ...initialDesignations(), hostedByDesignation: {} }),
  fold: foldHosted,
  finish: (acc) => finishHosted(acc, finishDesignations(acc)),
})

function foldHosted(acc: HostedPrAttachmentsAcc, events: readonly AbEvent[]): void {
  for (const event of events) {
    foldDesignations(acc, event)
    if (event.type !== 'pr-attachment.hosted') continue
    const key = String(event.payload.designationSeq)
    const previous = Object.hasOwn(acc.hostedByDesignation, key)
      ? acc.hostedByDesignation[key]
      : undefined
    if (previous === undefined || event.seq > previous.seq) acc.hostedByDesignation[key] = event
  }
}

/**
 * Correlate one durable hosted copy to each current designation. Unknown,
 * backwards, and stale correlations are ignored rather than throwing so the
 * selector remains total over any structurally valid event ordering.
 */
export function hostedPrAttachments(
  events: readonly AbEvent[],
  designations?: readonly PrAttachmentDesignationEvent[],
): Map<number, PrAttachmentHostedEvent> {
  const acc = hostedPrAttachmentsReducer.initial()
  foldHosted(acc, events)
  return finishHosted(acc, designations ?? finishDesignations(acc))
}

/** Every hosted copy plus the highest-seq reclaim fact per hosted seq. A
 * reclaim may precede its hosted event in array order, so both are kept and
 * correlated in `finish`. */
export interface PendingPrAttachmentReclaimsAcc {
  hosted: PrAttachmentHostedEvent[]
  reclaimedAt: Record<string, number>
}

/** Bump when `PendingPrAttachmentReclaimsAcc` or its fold changes. */
export const PENDING_PR_ATTACHMENT_RECLAIMS_REDUCER_VERSION = 1

export const pendingPrAttachmentReclaimsReducer: IncrementalReducer<
  PendingPrAttachmentReclaimsAcc,
  AbEvent,
  PrAttachmentHostedEvent[]
> = defineReducer<PendingPrAttachmentReclaimsAcc, AbEvent, PrAttachmentHostedEvent[]>({
  version: PENDING_PR_ATTACHMENT_RECLAIMS_REDUCER_VERSION,
  initial: () => ({ hosted: [], reclaimedAt: {} }),
  fold(acc, events) {
    for (const event of events) {
      if (event.type === 'pr-attachment.hosted') acc.hosted.push(event)
      else if (event.type === 'pr-attachment.reclaimed') {
        const key = String(event.payload.hostedSeq)
        const previous = Object.hasOwn(acc.reclaimedAt, key) ? acc.reclaimedAt[key] : undefined
        if (previous === undefined || event.seq > previous) acc.reclaimedAt[key] = event.seq
      }
    }
  },
  finish(acc) {
    const hosted = [...acc.hosted].sort((left, right) => left.seq - right.seq)
    return hosted.filter((event) => {
      const at = Object.hasOwn(acc.reclaimedAt, event.seq) ? acc.reclaimedAt[event.seq] : undefined
      return !(at !== undefined && at > event.seq)
    })
  },
})

/** Every durable hosted copy that has not yet received a later reclaim fact. */
export function pendingPrAttachmentReclaims(events: readonly AbEvent[]): PrAttachmentHostedEvent[] {
  return pendingPrAttachmentReclaimsReducer.reduce(events)
}
