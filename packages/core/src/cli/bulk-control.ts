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
 * The PAUSE FACT is written FIRST and ABSOLUTELY, with intake immediately
 * after it. `dispatcher.pause-set` is the repository's quiescence boundary —
 * it is what holds every queued build across the dispatcher's recovery,
 * startup-resume, lease-sweep, and dispatch stages — while intake gates only
 * the ready-ticket scan. Ordering them this way gives the prefix property that
 * matters: every surviving prefix of a pause-all leaves the repository at
 * least as quiesced as the operator asked for, and no prefix can leave a
 * queued build launchable once any write has landed. Under the reverse order,
 * an intake write that landed before a failing pause write would leave exactly
 * the hole this control exists to close — recovery, startup resume, and the
 * sweep all ignore intake and would still hand a queued build a runner. Resume
 * benefits symmetrically: a pause-cleared/intake-still-off prefix is the
 * conservative half, where the reverse order would re-open intake while every
 * build stayed held.
 *
 * Both are written ABSOLUTELY — an unconditional append rather than a
 * read-then-write on a difference — because they are setters, not toggles:
 * last-write-wins is race-free and is exactly what the operator asked for, at
 * the cost of one redundant repository event when the value already held.
 *
 * This is ordering, not atomicity. The per-build walk that follows is still N
 * separate CAS writes, so a partial bulk pause remains representable and a
 * failure midway leaves some running builds un-requested. The recovery is a
 * second keypress, which the CAS loop and the predicates make idempotent: a
 * build that already carries a pending pause fails the same predicate and is
 * skipped.
 *
 * Eligibility is expressed against `BuildState` rather than by importing
 * `effectiveStatus` from `dashboard/model.ts`, whose contract is
 * "DISPLAY-ONLY — nothing consults this"; a durable write path must not become
 * its first consumer. The predicates are nevertheless defined to coincide with
 * what the operator sees, and a unit test pins that agreement.
 */
import { humanActor, type Actor } from '../events/envelope'
import { reduceBuild, type BuildState } from '../kernel/reducer'
import type { Exec } from '../ports/workspace/git-worktree'
import type { BuildRecord, BuildStore } from '../store/types'
import { BuildControlError, buildControlUser } from './build-control'
import { withSessionlessStore, type StoreOpener } from './store-opening'

export type BulkDirection = 'pause' | 'resume'

export interface BulkControlSummary {
  direction: BulkDirection
  /** Slugs that received a durable request, in the order written. */
  slugs: string[]
  /** The durable repository-wide hold value this action wrote. */
  paused: boolean
  /** The durable intake value this action wrote. */
  intake: boolean
}

/**
 * Pausable for the bulk control: actually running, with neither pause nor
 * abort intent already in flight. The pending-pause exclusion is the "never
 * cancels a pending pause / still exactly one pending pause" rule, and it also
 * means a row displaying `PAUSING` is left alone. Abort intent dominates pause
 * regardless of whether it came from an explicit request or an escalation
 * answer, so a row displaying `ABORTING` is also left alone. `queued`, `paused`,
 * `blocked`, `done`, and `aborted` all fail the first clause, so they are
 * skipped with no error. A `running` build carrying a pending *resume* (a
 * just-cancelled pause) is eligible: the reducer clears `pending.resume` when
 * the pause request lands, which is the existing opposing-command
 * supersession.
 */
export function bulkPausable(state: BuildState): boolean {
  if (state.status !== 'running') return false
  return !state.pendingCommands.some(
    (command) => command.command === 'pause' || command.command === 'abort',
  )
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
  /** Explicit identity for API callers; CLI/dashboard may retain env. */
  user?: string
  env?: Record<string, string | undefined>
  direction: BulkDirection
}

/** What a walk had already done when it failed. Every field is derived from the
 * walk's own position, so a failure report cannot disagree with what was
 * actually attempted. */
export interface BulkControlProgress {
  direction: BulkDirection
  /** The repository-wide hold value the walk was asked to write. */
  paused: boolean
  pausedWritten: boolean
  /** The intake value the walk was asked to write. */
  intake: boolean
  intakeWritten: boolean
  /** Slugs that received a durable request before the failure, in write order. */
  slugs: string[]
  /** The build whose request failed; absent when the walk failed before any. */
  failedSlug?: string
  /** Candidate slugs the walk never reached. */
  remaining: string[]
}

/**
 * A walk that failed partway, carrying what it had already written.
 *
 * `message` is deliberately EXACTLY the cause's message: the dashboard's
 * `queueAction` catch renders `dashboard bulk-pause action failed:
 * ${error.message}`, and that announcement must stay byte-identical. A surface
 * that wants the partial progress reads `progress` instead.
 */
export class BulkWalkError extends Error {
  readonly progress: BulkControlProgress

  constructor(cause: unknown, progress: BulkControlProgress) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'BulkWalkError'
    this.progress = progress
  }
}

/** One operator-facing line describing what a bulk action durably did. */
export function bulkControlReport(summary: BulkControlSummary): string {
  const label = summary.direction === 'pause' ? 'pause all' : 'resume all'
  // Clauses follow write order. The hold clause is not decorative: in the
  // zero-build case it is the only thing the action did, and it is the fact
  // that makes the control trustworthy.
  const hold = summary.paused ? 'queued builds held' : 'queued builds released'
  const intake = `intake ${summary.intake ? 'ON' : 'OFF'}`
  if (summary.slugs.length === 0) {
    const nothing = summary.direction === 'pause' ? 'no pausable builds' : 'no paused builds'
    return `${label}: ${nothing}; ${hold}; ${intake}`
  }
  const count = summary.slugs.length === 1 ? '1 build' : `${summary.slugs.length} builds`
  const verb = summary.direction === 'pause' ? 'pause requested' : 'resume requested'
  return `${label}: ${verb} for ${count}; ${hold}; ${intake}`
}

/**
 * Put the repository into (or out of) quiescence. The repository-wide hold is
 * set first, then intake, then every eligible build is requested one at a time.
 *
 * A per-build write that fails outright leaves both repository facts already
 * set and some builds requested. That is not transactional and the store offers
 * no way to make it so; the recovery is a second keypress, which the CAS loop
 * and the predicates make idempotent — nothing is double-paused. The failure is
 * rethrown as a `BulkWalkError` carrying that partial progress, so a surface
 * with somewhere to print it can name what did not complete — including which
 * of the two repository facts landed, since the prefix property above is only
 * legible to an operator who is told where the walk stopped.
 */
export async function bulkControlRepository(opts: BulkControlOpts): Promise<BulkControlSummary> {
  const { store, repo, direction } = opts
  const actor = humanActor(opts.user?.trim() || buildControlUser(opts.env ?? {}))
  const paused = direction === 'pause'
  const intake = direction === 'resume'

  let pausedWritten = false
  let intakeWritten = false
  let records: BuildRecord[] = []
  let failedIndex: number | undefined
  const slugs: string[] = []

  try {
    // `getRepoEvents`/`appendRepo` throw on a repository row no tick has created
    // yet, and a keypress can precede the first tick. Mirrors toggleHarvestGate.
    await store.ensureRepo(repo)
    // The quiescence boundary, first — see the module doc's prefix property.
    await store.appendRepo(repo, {
      actor,
      type: 'dispatcher.pause-set',
      payload: { enabled: paused },
    })
    pausedWritten = true
    await store.appendRepo(repo, {
      actor,
      type: 'dispatcher.intake-set',
      payload: { enabled: intake },
    })
    intakeWritten = true

    records = (await store.listBuilds())
      .filter((record) => record.repo === repo)
      // Slug order matches the dashboard's row order and makes the summary
      // deterministic.
      .sort((a, b) => a.slug.localeCompare(b.slug))

    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!
      // Marked before the attempt and cleared after it, so the loop index is the
      // single source for both `failedSlug` and `remaining`.
      failedIndex = index
      if (await requestOne(store, record.slug, actor, direction)) slugs.push(record.slug)
      failedIndex = undefined
    }
  } catch (error) {
    const failed = failedIndex === undefined ? undefined : records[failedIndex]
    throw new BulkWalkError(error, {
      direction,
      paused,
      pausedWritten,
      intake,
      intakeWritten,
      slugs,
      ...(failed !== undefined ? { failedSlug: failed.slug } : {}),
      remaining:
        failedIndex === undefined ? [] : records.slice(failedIndex + 1).map((later) => later.slug),
    })
  }

  return { direction, slugs, paused, intake }
}

/**
 * A phase agent may not quiesce the repository from inside its own build.
 *
 * `refuseOwnSessionControl` blocks a phase from controlling its own build, and a
 * phase session's build is `running` by definition — so it is inside a pause
 * walk, and `--all` without this guard would be a one-flag bypass of a stated
 * product rule. Uniform across directions, like the per-build rule. No caller
 * the repository-wide form exists for (a script, a deploy hook, a cron job, a
 * non-TTY host) carries `AB_SESSION`; only a runner-spawned phase does.
 */
export function refuseOwnSessionBulkControl(
  direction: BulkDirection,
  env: Record<string, string | undefined>,
): void {
  const session = env.AB_SESSION?.trim()
  const build = env.AB_BUILD?.trim()
  if (session === undefined || session === '') return
  if (build === undefined || build === '') return
  throw new BuildControlError(
    'own-session',
    `cannot ${direction} every build from build "${build}"'s own phase session ` +
      '(AB_SESSION/AB_BUILD conflict); run this command outside that build session',
  )
}

export interface AbBulkControlOpts {
  targetRepo: string
  env: Record<string, string | undefined>
  exec: Exec
  direction: BulkDirection
  /** Explicit `--store`; selection remains --store > AB_STORE > repo-local. */
  storeRef?: string
  /** Injectable adapter seam for unit tests. */
  openStore?: StoreOpener
}

/** Sessionless command shell: resolve repository/store, walk, always close.
 * The exact mirror of `abBuildControl`, over the bulk contract. */
export async function abBulkControl(opts: AbBulkControlOpts): Promise<BulkControlSummary> {
  // Before opening a store, as in abBuildControl: the conflict is ambient and
  // no read is needed to know the attempt is forbidden.
  refuseOwnSessionBulkControl(opts.direction, opts.env)

  return withSessionlessStore(opts, ({ store, repo }) =>
    bulkControlRepository({ store, repo, env: opts.env, direction: opts.direction }),
  )
}

/** Operator-facing success report: the shared announcement line the dashboard
 * also prints, then one line per requested build in the exact shape
 * `ab pause <slug>` already prints, so a script parsing per-build output parses
 * this unchanged. */
export function bulkControlLines(summary: BulkControlSummary): string[] {
  return [
    bulkControlReport(summary),
    ...summary.slugs.map((slug) => `build ${slug}: ${summary.direction} requested`),
  ]
}

/** Operator-facing failure report: what the walk wrote, where it stopped, and
 * what it never reached. */
export function bulkFailureLines(error: BulkWalkError): string[] {
  const { direction, paused, pausedWritten, intake, intakeWritten, slugs, failedSlug, remaining } =
    error.progress
  const label = direction === 'pause' ? 'pause all' : 'resume all'
  // Write order again, and the hold clause carries the same words as the
  // success report. It is the clause that tells the operator whether the
  // prefix that survived is the quiesced one: a failure with the hold written
  // still holds every queued build, and a failure before it changed nothing.
  const holdLine = pausedWritten
    ? paused
      ? 'queued builds held'
      : 'queued builds released'
    : 'hold not written'
  const intakeLine = intakeWritten
    ? `intake ${intake ? 'ON' : 'OFF'} written`
    : 'intake not written'

  const lines = [`${label}: failed; ${holdLine}; ${intakeLine}`]
  if (slugs.length > 0) lines.push(`requested: ${slugs.join(', ')}`)
  lines.push(
    failedSlug === undefined
      ? `failed before any build — ${error.message}`
      : `failed at: ${failedSlug} — ${error.message}`,
  )
  if (remaining.length > 0) lines.push(`not attempted: ${remaining.join(', ')}`)
  return lines
}
