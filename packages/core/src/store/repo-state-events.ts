/**
 * The bounded repository-journal read (AUT-489): a pure subset derivation
 * that stateless full-state readers can fetch instead of the whole journal
 * without changing what their reducers report.
 *
 * The hosted dispatcher appends ~4 journal events per invocation (run-started,
 * tick-started, tick-completed/tick-yielded, run-stopped) whether or not it
 * did anything, so the journal grows forever with wall-clock time while the
 * durable signal stays small. Every repository-state consumer reduces the
 * journal through one of four pure reducers whose event-type dependencies
 * partition the catalog:
 *
 * - `reduceDispatchSettings` — only the three dispatcher setting types
 *   (latest-wins by seq).
 * - `reduceDispatchStatus(events, latestRun)` — only run-correlated
 *   dispatcher facts, and it skips every event whose `payload.run` is not the
 *   latest run. A run's facts are appended under its own run id, which is
 *   minted at `dispatcher.run-started`, so all facts the reducer keeps live at
 *   or after the latest run-started.
 * - `reduceHarvest` (and everything built on it) — only `harvest.*` events
 *   plus the three setting types, which it explicitly ignores.
 * - `sandboxStates` — only `orchestrator.sandbox.*` events.
 *
 * So the bounded subset is: **every event of a durable (slow-growing) type —
 * all `harvest.*`, all `orchestrator.sandbox.*`, and the three dispatcher
 * setting types — plus, when the journal contains at least one
 * `dispatcher.run-started`, the tail from that latest run-started to the end
 * of the journal.** For a hosted repository with N no-op invocations this
 * subset's size is a constant (one invocation's ~4 facts plus the durable
 * signal), independent of N.
 *
 * INVARIANT FOR AUTHORS OF NEW REPOSITORY EVENT TYPES: a new type must either
 * (a) join `REPOSITORY_STATE_EVENT_TYPES` — it is durable, slow-growing state
 * some reducer depends on at full replay depth — or (b) join
 * `REPOSITORY_RUN_SCOPED_EVENT_TYPES` — it is run-correlated and its only
 * consumers reduce it for the latest run, so the tail from the latest
 * `dispatcher.run-started` covers it. `tests/store/repo-state-events.test.ts`
 * asserts the two sets exactly partition `REPOSITORY_EVENT_TYPES`; adding a
 * type to neither fails the build until the author makes the call. A type in
 * neither set would be silently dropped from bounded reads.
 *
 * Reducing this subset with the state readers yields exactly what a full
 * replay yields: `reduceDispatchSettings`, `reduceHarvest`, `sandboxStates`
 * see identical event lists, and `reduceDispatchStatus` sees every event it
 * keeps (the rest are skipped by the `payload.run !== latestRun` guard). The
 * journal itself stays append-only; no event is deleted, rewritten, or
 * re-ordered, and a replay from the start is untouched.
 */
import type { RepositoryEvent, RepositoryEventType } from '../events/repository'
import {
  dispatcherSettingEventPayloadSchemas,
  dispatcherStatusEventPayloadSchemas,
  harvestEventPayloadSchemas,
  orchestratorSandboxEventPayloadSchemas,
} from '../events/repository'

/** The anchor fact a bounded read's tail hangs from. */
const RUN_STARTED = 'dispatcher.run-started'

/** Durable, slow-growing repository event types: every fact a state reducer
 * may consult at full replay depth. Derived from the catalog groups so a new
 * harvest or sandbox event type joins automatically; the three dispatcher
 * setting types are enumerated because they share one schema group with the
 * run-correlated `dispatcher.config-reloaded`. */
export const REPOSITORY_STATE_EVENT_TYPES: readonly RepositoryEventType[] = [
  ...Object.keys(harvestEventPayloadSchemas),
  ...Object.keys(orchestratorSandboxEventPayloadSchemas),
  ...Object.keys(dispatcherSettingEventPayloadSchemas).filter(
    (type) => type !== 'dispatcher.config-reloaded',
  ),
] as RepositoryEventType[]

/** Run-correlated repository event types: facts whose only state consumers
 * reduce them for the latest dispatcher run, so the tail from the latest
 * `dispatcher.run-started` contains everything those consumers keep. */
export const REPOSITORY_RUN_SCOPED_EVENT_TYPES: readonly RepositoryEventType[] = [
  ...Object.keys(dispatcherStatusEventPayloadSchemas),
  'dispatcher.config-reloaded',
] as RepositoryEventType[]

const STATE_TYPES = new Set<string>(REPOSITORY_STATE_EVENT_TYPES)

/** The normative subset derivation every adapter implements and the contract
 * tests use as the oracle: durable types across the whole journal, plus —
 * only when the journal has one — every event from the latest
 * `dispatcher.run-started` onward, ordered by seq. A journal with no
 * run-started has **no tail at all** (durable types only); the anchor is
 * never defaulted to 0, which would make a `seq >= anchor` clause select the
 * whole journal and defeat the bound. */
export function projectRepositoryStateEvents(
  events: readonly RepositoryEvent[],
): RepositoryEvent[] {
  let anchor: number | undefined
  for (const event of events) {
    if (event.type === RUN_STARTED) anchor = event.seq
  }
  return events.filter(
    (event) => STATE_TYPES.has(event.type) || (anchor !== undefined && event.seq >= anchor),
  )
}
