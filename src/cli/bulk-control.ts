/**
 * Repository-wide quiescence: one keypress that parks every running build and
 * stops intake, and one that reverses it.
 *
 * This is deliberately NOT a per-build control, so it does not live in
 * `build-control.ts`. Two contracts differ at their core:
 *
 * - `controlBuild` throws a typed `BuildControlError` when its one target is
 *   inapplicable. A bulk walk crosses builds the operator never named, so an
 *   ineligible build is SKIPPED silently instead.
 * - `controlBuild`'s `dashboard-pause` deliberately toggles, appending a
 *   `resume` to cancel a pending pause. The bulk control must NEVER cancel a
 *   pending pause — a build already on its way to `paused` is exactly the state
 *   the operator is asking for, so it is skipped, not reversed.
 *
 * Every per-build write is a compare-and-set against the reduced stream tail.
 * The walk reduces a stream and then writes to it, and nothing serializes those
 * two operations against the rest of the world: the in-process runner fleet is
 * fire-and-forget, a second `ab dispatch` may hold a dashboard, and
 * `ab pause <slug>` runs sessionless. An unconditional append could add a
 * second entry to `pending.pause` (the reducer pushes rather than replaces, so
 * "exactly one pending pause" is observable), or write a pause to a build a
 * runner has already acknowledged to `paused`, or completed. So each build goes
 * through `appendIfCurrent` and retries on a miss, re-reading and re-evaluating
 * eligibility every attempt — the idiom `recordAutoMergeDeferralObservation`
 * already establishes in this codebase.
 *
 * Intake is written FIRST and ABSOLUTELY. First, because if a per-build write
 * fails midway the repository is left in the safer of the two partial states
 * (not taking on new work) and the operator's retry is naturally idempotent: a
 * build that already carries a pending pause fails the same predicate and is
 * skipped. Absolutely — an unconditional append rather than a read-then-write
 * on a difference — because this is a setter, not a toggle: last-write-wins is
 * race-free and is exactly what the operator asked for, at the cost of one
 * redundant repository event when intake already held the target value.
 *
 * Eligibility is expressed against `BuildState` rather than by importing
 * `effectiveStatus` from `dashboard/model.ts`, whose contract is
 * "DISPLAY-ONLY — nothing consults this"; a durable write path must not become
 * its first consumer. The predicates are nevertheless defined to coincide with
 * what the operator sees, and a unit test pins that agreement.
 */
import { humanActor, type Actor } from '../events/envelope'
import { reduceBuild, type BuildState } from '../kernel/reducer'
import type { BuildStore } from '../store/types'
import { buildControlUser } from './build-control'

export type BulkDirection = 'pause' | 'resume'

export interface BulkControlSummary {
  direction: BulkDirection
  /** Slugs that received a durable request, in the order written. */
  slugs: string[]
  /** The durable intake value this action wrote. */
  intake: boolean
}

/**
 * Pausable for the bulk control: actually running, with no pause already in
 * flight. The pending-pause exclusion is the "never cancels a pending pause /
 * still exactly one pending pause" rule, and it also means a row displaying
 * `PAUSING` is left alone. `queued`, `paused`, `blocked`, `done`, and `aborted`
 * all fail the first clause, so they are skipped with no error. A `running`
 * build carrying a pending *resume* (a just-cancelled pause) is eligible: the
 * reducer clears `pending.resume` when the pause request lands, which is the
 * existing opposing-command supersession.
 */
export function bulkPausable(state: BuildState): boolean {
  if (state.status !== 'running') return false
  return !state.pendingCommands.some((command) => command.command === 'pause')
}

/**
 * Resumable for the bulk control: paused, unblocked, with no resume in flight.
 * The escalation clause is what keeps bulk resume off display-`BLOCKED` builds:
 * §15.5 gives `paused` precedence in the reducer, so a paused-and-blocked build
 * reduces to `paused` while the dashboard shows `BLOCKED`. Clearing a blocker
 * stays the per-build `r` prompt with its feedback field. Reducer-status
 * `blocked` fails the first clause.
 */
export function bulkResumable(state: BuildState): boolean {
  if (state.status !== 'paused') return false
  if (state.openEscalations.length > 0) return false
  return !state.pendingCommands.some((command) => command.command === 'resume')
}

function eligible(state: BuildState, direction: BulkDirection): boolean {
  return direction === 'pause' ? bulkPausable(state) : bulkResumable(state)
}

/**
 * Request one direction against one build, compare-and-set. Returns whether a
 * request was durably written.
 *
 * The read/reduce/evaluate lives INSIDE the loop on purpose: hoisting it would
 * reintroduce exactly the stale-state defect the loop exists to remove. Any
 * competing write that pauses, resumes, acknowledges, or terminates the build
 * ends the loop by making the predicate false; only an unrelated append to a
 * still-eligible build causes a true retry.
 */
async function requestOne(
  store: BuildStore,
  slug: string,
  actor: Actor,
  direction: BulkDirection,
): Promise<boolean> {
  while (true) {
    const state = reduceBuild(await store.getEvents(slug))
    if (!eligible(state, direction)) return false
    // The two branches are written out rather than selecting the event type
    // into a variable so `appendIfCurrent`'s `T extends EventType` infers a
    // concrete payload type in each — the shape `build-control.ts`'s own
    // `appendCommand` switch uses.
    const appended =
      direction === 'pause'
        ? await store.appendIfCurrent(slug, state.lastSeq, {
            actor,
            type: 'build.pause-requested',
            payload: {},
          })
        : await store.appendIfCurrent(slug, state.lastSeq, {
            actor,
            type: 'build.resume-requested',
            payload: {},
          })
    if (appended !== null) return true
  }
}

export interface BulkControlOpts {
  store: BuildStore
  /** Canonical main-repository identity stored on BuildRecord.repo. */
  repo: string
  env: Record<string, string | undefined>
  direction: BulkDirection
}

/** One operator-facing line describing what a bulk action durably did. */
export function bulkControlReport(summary: BulkControlSummary): string {
  const label = summary.direction === 'pause' ? 'pause all' : 'resume all'
  const intake = `intake ${summary.intake ? 'ON' : 'OFF'}`
  if (summary.slugs.length === 0) {
    const nothing = summary.direction === 'pause' ? 'no pausable builds' : 'no paused builds'
    return `${label}: ${nothing}; ${intake}`
  }
  const count = summary.slugs.length === 1 ? '1 build' : `${summary.slugs.length} builds`
  const verb = summary.direction === 'pause' ? 'pause requested' : 'resume requested'
  return `${label}: ${verb} for ${count}; ${intake}`
}

/**
 * Put the repository into (or out of) quiescence. Intake is set first, then
 * every eligible build is requested one at a time.
 *
 * A per-build write that fails outright leaves intake already set and some
 * builds requested. That is not transactional and the store offers no way to
 * make it so; the recovery is a second keypress, which the CAS loop and the
 * predicates make idempotent — nothing is double-paused.
 */
export async function bulkControlRepository(opts: BulkControlOpts): Promise<BulkControlSummary> {
  const { store, repo, direction } = opts
  const actor = humanActor(buildControlUser(opts.env))
  const intake = direction === 'resume'

  // `getRepoEvents`/`appendRepo` throw on a repository row no tick has created
  // yet, and a keypress can precede the first tick. Mirrors toggleHarvestGate.
  await store.ensureRepo(repo)
  await store.appendRepo(repo, {
    actor,
    type: 'dispatcher.intake-set',
    payload: { enabled: intake },
  })

  const records = (await store.listBuilds())
    .filter((record) => record.repo === repo)
    // Slug order matches the dashboard's row order and makes the summary
    // deterministic.
    .sort((a, b) => a.slug.localeCompare(b.slug))

  const slugs: string[] = []
  for (const record of records) {
    if (await requestOne(store, record.slug, actor, direction)) slugs.push(record.slug)
  }

  return { direction, slugs, intake }
}
