/** Bounded journal state has three disjoint, exhaustive categories:
 * durable facts retain all history; run-scoped facts retain the latest run
 * tail; latest-only facts retain exactly the greatest sequence per type,
 * including before any run anchor. The full journal remains append-only.
 */
import type { RepositoryEvent, RepositoryEventType } from '../events/repository'
import { defineReducer, type IncrementalReducer } from '../kernel/incremental'
import {
  ticketPreparationEventPayloadSchemas,
  changePresenceEventPayloadSchemas,
  ticketSourceHealthEventPayloadSchemas,
  dispatcherSettingEventPayloadSchemas,
  dispatcherStatusEventPayloadSchemas,
  harvestEventPayloadSchemas,
  orchestratorSandboxEventPayloadSchemas,
} from '../events/repository'

/** The anchor fact a bounded read's tail hangs from. */
const RUN_STARTED = 'dispatcher.run-started'

/** Handoff correlation spans dispatcher generations. These facts must survive
 * later run anchors, including failures that invalidate prepared requests. */
export const DISPATCH_HANDOFF_EVENT_TYPES = [
  'dispatcher.target-prepared',
  'dispatcher.yield-requested',
  'dispatcher.upgrade-failed',
  'dispatcher.handoff-started',
  'dispatcher.terminal-released',
  'dispatcher.takeover',
  'dispatcher.drain-deadline',
  'dispatcher.drain-settled',
  'dispatcher.handoff-completed',
] as const satisfies readonly RepositoryEventType[]

/** Durable, slow-growing repository event types: every fact a state reducer
 * may consult at full replay depth. Derived from the catalog groups so a new
 * harvest or sandbox event type joins automatically; the three dispatcher
 * setting types are enumerated because they share one schema group with the
 * run-correlated `dispatcher.config-reloaded`. */
export const REPOSITORY_STATE_EVENT_TYPES: readonly RepositoryEventType[] = [
  ...Object.keys(ticketPreparationEventPayloadSchemas),
  'tickets.migration-recorded',
  ...DISPATCH_HANDOFF_EVENT_TYPES,
  'dispatcher.forge-degraded',
  'dispatcher.forge-recovered',
  ...Object.keys(changePresenceEventPayloadSchemas),
  ...Object.keys(ticketSourceHealthEventPayloadSchemas),
  ...Object.keys(harvestEventPayloadSchemas),
  ...Object.keys(orchestratorSandboxEventPayloadSchemas),
  ...Object.keys(dispatcherSettingEventPayloadSchemas).filter(
    (type) => type !== 'dispatcher.config-reloaded',
  ),
] as RepositoryEventType[]

/** Latest-only facts survive run turnover without retaining publication history. */
export const REPOSITORY_LATEST_EVENT_TYPES: readonly RepositoryEventType[] = [
  'dispatcher.ticket-scan-completed',
  'dispatcher.placement-set',
]
const LATEST_TYPES = new Set<string>(REPOSITORY_LATEST_EVENT_TYPES)

/** Run-correlated repository event types: facts whose only state consumers
 * reduce them for the latest dispatcher run, so the tail from the latest
 * `dispatcher.run-started` contains everything those consumers keep. */
export const REPOSITORY_RUN_SCOPED_EVENT_TYPES: readonly RepositoryEventType[] = [
  ...Object.keys(dispatcherStatusEventPayloadSchemas).filter(
    (type) =>
      !REPOSITORY_LATEST_EVENT_TYPES.includes(type as RepositoryEventType) &&
      !REPOSITORY_STATE_EVENT_TYPES.includes(type as RepositoryEventType),
  ),
  'dispatcher.config-reloaded',
] as RepositoryEventType[]

const STATE_TYPES = new Set<string>(REPOSITORY_STATE_EVENT_TYPES)

/**
 * The race-closed read shape every SQL adapter delegates `getRepoStateEvents`
 * to (AUT-551). Both adapters issue the anchor probe and the selection as two
 * separate statements, so a concurrent append of the journal's first
 * `dispatcher.run-started` between them is invisible to the probe, absent
 * from the durable-only selection, yet present in the journal by the time the
 * method returns — a stateless reader can transiently throw
 * `effective-config-unavailable` where a moment-later full replay would
 * succeed.
 *
 * The fix is a **one-shot anchor re-check on the durable-only outcome**:
 * after a selection that took the durable-only branch (the probe saw no
 * anchor), re-probe the anchor once; if an anchor now exists, re-run the
 * anchored selection against it. The invariant this achieves: a durable-only
 * result is returned only when the journal was anchor-free as of the final
 * probe — so a run-started appended between the original probe and the
 * selection can never be missed while present. When the first probe *did*
 * find an anchor, no re-check is needed: the anchored select's
 * `seq >= anchor` arm is monotone-inclusive, so any later run-started (higher
 * seq) is picked up by that same select. A run-started appended after the
 * final re-probe is an ordinary post-read concurrent append — outside this
 * read's snapshot, exactly as if it had landed after the method returned —
 * and is not this race; that bound is why the re-check is one-shot and never
 * a loop.
 *
 * Non-concurrent behavior is byte-identical: the same two statements run in
 * the same order; only the durable-only outcome may trigger one extra
 * probe+select pair.
 */
export async function readRepoStateEventsWithAnchorRecheck(
  probeAnchor: () => Promise<number | undefined>,
  select: (anchor: number | undefined) => Promise<RepositoryEvent[]>,
): Promise<RepositoryEvent[]> {
  const anchor = await probeAnchor()
  const events = await select(anchor)
  if (anchor !== undefined) return events
  const rechecked = await probeAnchor()
  return rechecked === undefined ? events : select(rechecked)
}

/** Carried state for the bounded read: the latest run-started seq (the last
 * in array order, as the whole-array pass overwrites it) and every ordinary event seen,
 * in array order, plus one latest-only fact per type. Ordinary history is retained: a later run-started may carry a lower seq
 * than an earlier one and restore events below the earlier anchor, so only
 * `finish` can apply the filter exactly. Pruning below a monotone anchor is
 * valid only for seq-ordered input and belongs with the cached-state
 * follow-up. */
export interface RepositoryStateEventsAcc {
  anchor?: number
  retained: RepositoryEvent[]
}

/** Bump when `RepositoryStateEventsAcc` or its fold changes. */
export const REPOSITORY_STATE_EVENTS_REDUCER_VERSION = 8

const keeps = (event: RepositoryEvent, anchor: number | undefined): boolean =>
  STATE_TYPES.has(event.type) ||
  (!LATEST_TYPES.has(event.type) && anchor !== undefined && event.seq >= anchor)

export const repositoryStateEventsReducer: IncrementalReducer<
  RepositoryStateEventsAcc,
  RepositoryEvent,
  RepositoryEvent[]
> = defineReducer<RepositoryStateEventsAcc, RepositoryEvent, RepositoryEvent[]>({
  version: REPOSITORY_STATE_EVENTS_REDUCER_VERSION,
  initial: () => ({ retained: [] }),
  fold(acc, events) {
    for (const event of events) {
      if (event.type === RUN_STARTED) acc.anchor = event.seq
      if (LATEST_TYPES.has(event.type)) {
        const held = acc.retained.find((held) => held.type === event.type)
        if (held !== undefined && held.seq >= event.seq) continue
        acc.retained = acc.retained.filter((held) => held.type !== event.type)
      }
      acc.retained.push(event)
    }
  },
  finish: (acc) => {
    const latest = new Map<string, RepositoryEvent>()
    for (const event of acc.retained) {
      if (LATEST_TYPES.has(event.type) && event.seq > (latest.get(event.type)?.seq ?? -1))
        latest.set(event.type, event)
    }
    return [...acc.retained.filter((event) => keeps(event, acc.anchor)), ...latest.values()].sort(
      (a, b) => a.seq - b.seq,
    )
  },
})

/** Carried state for the pruned journal view: the latest run-started seq and
 * the subset the bounded read would return as of the events folded so far. Unlike
 * `RepositoryStateEventsAcc` it prunes on every `dispatcher.run-started`
 * (everything before the new anchor that is not durable leaves the tail), which
 * is exact for seq-ordered input — the only input a real journal produces — and
 * holds the tail only in process memory. It is never persisted as a snapshot. */
export interface JournalViewAcc {
  anchor?: number
  retained: RepositoryEvent[]
}

/** Bump when `JournalViewAcc` or its fold changes. */
export const JOURNAL_VIEW_REDUCER_VERSION = 9

/** Fold seq-ordered events into a journal view in place. */
export function foldJournalView(acc: JournalViewAcc, events: readonly RepositoryEvent[]): void {
  for (const event of events) {
    if (event.type === RUN_STARTED) {
      acc.anchor = event.seq
      acc.retained = acc.retained.filter(
        (held) => STATE_TYPES.has(held.type) || LATEST_TYPES.has(held.type),
      )
    }
    if (LATEST_TYPES.has(event.type)) {
      const held = acc.retained.find((held) => held.type === event.type)
      if (held !== undefined && held.seq >= event.seq) continue
      acc.retained = acc.retained.filter((held) => held.type !== event.type)
      acc.retained.push(event)
    } else if (STATE_TYPES.has(event.type) || acc.anchor !== undefined) acc.retained.push(event)
  }
}

export const journalViewReducer: IncrementalReducer<
  JournalViewAcc,
  RepositoryEvent,
  RepositoryEvent[]
> = defineReducer<JournalViewAcc, RepositoryEvent, RepositoryEvent[]>({
  version: JOURNAL_VIEW_REDUCER_VERSION,
  initial: () => ({ retained: [] }),
  fold: foldJournalView,
  finish: (acc) => [...acc.retained],
})

/** The normative subset derivation every adapter implements and the contract
 * tests use as the oracle: durable types across the whole journal, plus —
 * only when the journal has one — every non-latest-only event from the latest
 * `dispatcher.run-started` onward, plus the maximum-sequence fact of each
 * latest-only type across the whole journal, ordered by seq. A journal with no
 * run-started has **no tail at all** (durable and latest-only facts only); the anchor is
 * never defaulted to 0, which would make a `seq >= anchor` clause select the
 * whole journal and defeat the bound. */
export function projectRepositoryStateEvents(
  events: readonly RepositoryEvent[],
): RepositoryEvent[] {
  return repositoryStateEventsReducer.reduce(events)
}
