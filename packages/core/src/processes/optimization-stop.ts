/**
 * The dispatcher's optimization-node stop duty (SPEC §13.1.1, RFC 0005 §9):
 * record an automatic `optimization.stopped` when the digest makes a cause
 * eligible, and act on any recorded stop by cancelling, aborting or waiting
 * on the node's in-flight attempts until each settles.
 *
 * Every decision is read from reduced state. An unstopped node costs no
 * added read; a stopped node with attempts in flight costs at most one
 * reduced `buildFacts` per unmerged attempt build not mid-abort, and none
 * once they settle.
 */
import { DISPATCHER } from '../events/envelope'
import type { TicketMigrations } from '../kernel/ticket-migrations'
import { resolveTicketRef } from '../kernel/ticket-migrations'
import {
  optimizationStopActions,
  optimizationStopCause,
  type InFlightAttempt,
  type OptimizationAttemptBuild,
} from '../kernel/optimization'
import type { BuildState } from '../kernel/reducer'
import type { TicketRef } from '../ontology'
import { digestNodeTargets } from '../store/digest'
import type { BuildDigest, BuildRecord, Clock } from '../store/types'
import type { RepoViewStore } from './repo-view'

export interface OptimizationStopDeps {
  store: RepoViewStore
  clock: Clock
  migrations: TicketMigrations
  /** The configured ticket source, which ticket identities resolve into. */
  ticketSource: string
}

/** Whether the node is one whose stop duty applies at all. */
function stopDutyApplies(state: BuildState): boolean {
  return (
    state.kind === 'node' &&
    state.nodeOpened !== undefined &&
    state.optimization !== undefined &&
    state.status !== 'done' &&
    state.status !== 'aborted' &&
    state.status !== 'paused' &&
    state.prState !== 'merged' &&
    state.prState !== 'closed'
  )
}

/**
 * The newest build of one in-flight attempt in `builds`: a build targeting
 * `nodeSlug` whose ticket resolves, under the repository's ticket-migration
 * identity, to the attempt's ticket. A pure scan of the listing the tick
 * already holds; undefined when no such build exists.
 */
export function newestAttemptBuild(
  deps: Pick<OptimizationStopDeps, 'migrations' | 'ticketSource'>,
  nodeSlug: string,
  attempt: Pick<InFlightAttempt, 'ticket'>,
  builds: readonly { record: BuildRecord; digest: BuildDigest }[],
): { record: BuildRecord; digest: BuildDigest } | undefined {
  const key = (ref: TicketRef, build?: string): string | undefined => {
    try {
      const resolved = resolveTicketRef(deps.migrations, ref, deps.ticketSource, build)
      return `${resolved.source}\u0000${resolved.id}`
    } catch {
      return undefined
    }
  }
  const wanted = key(attempt.ticket)
  if (wanted === undefined) return undefined
  return builds
    .filter(
      ({ record: candidate, digest }) =>
        candidate.ticket !== undefined &&
        key(candidate.ticket, candidate.slug) === wanted &&
        digestNodeTargets(digest).includes(nodeSlug),
    )
    .sort(
      (a, b) =>
        b.record.createdAt.localeCompare(a.record.createdAt) ||
        b.record.slug.localeCompare(a.record.slug),
    )[0]
}

/**
 * One tick of the stop duty for a node. `builds` is the repository's
 * unfiltered build listing, so terminal attempt builds are visible. Returns
 * whether the node's log was written; the caller rereads its facts.
 */
export async function enforceOptimizationStop(
  deps: OptimizationStopDeps,
  record: BuildRecord,
  state: BuildState,
  builds: readonly { record: BuildRecord; digest: BuildDigest }[],
): Promise<boolean> {
  if (!stopDutyApplies(state)) return false
  const optimization = state.optimization!
  if (optimization.stopped === undefined) {
    const cause = optimizationStopCause(optimization, deps.clock())
    if (cause === undefined) return false
    const written = await deps.store.appendIfCurrent(record.slug, state.lastSeq, {
      actor: DISPATCHER,
      type: 'optimization.stopped',
      payload: { cause, mode: optimization.objective.stop.mode },
    })
    return written !== null
  }
  if (optimization.inFlight.length === 0) return false

  const children = new Map<string, BuildState>()
  const attempts: { attempt: InFlightAttempt; build?: OptimizationAttemptBuild }[] = []
  for (const attempt of optimization.inFlight) {
    const entry = newestAttemptBuild(deps, record.slug, attempt, builds)
    if (entry === undefined) {
      attempts.push({ attempt })
      continue
    }
    const { digest } = entry
    const build: OptimizationAttemptBuild = {
      slug: entry.record.slug,
      ...(digest.terminal !== undefined ? { terminal: digest.terminal } : {}),
      ...(digest.merged !== undefined ? { merged: true } : {}),
    }
    // An aborted attempt is decided from its digest until its cleanup's
    // `build.completed`, which reports `done`; only the outcome tells an
    // abandoned build from a finished one.
    if (digest.terminal !== 'aborted' && digest.merged === undefined) {
      const child = (await deps.store.buildFacts(entry.record.slug)).state
      children.set(entry.record.slug, child)
      build.state = child
    }
    attempts.push({ attempt, build })
  }
  const actions = optimizationStopActions(
    { slug: record.slug, stopped: optimization.stopped },
    attempts,
  )
  for (const abort of actions.abort) {
    const child = children.get(abort.slug)!
    await deps.store.appendIfCurrent(abort.slug, child.lastSeq, {
      actor: DISPATCHER,
      type: 'build.abort-requested',
      payload: { reason: abort.reason, origin: { kind: 'optimization-stop', node: record.slug } },
    })
  }
  let wrote = false
  for (const { attempt, build } of actions.settle) {
    for (;;) {
      const current = (await deps.store.buildFacts(record.slug)).state
      if (!current.optimization?.inFlight.some((entry) => entry.proposal === attempt.proposal))
        break
      const written = await deps.store.appendIfCurrent(record.slug, current.lastSeq, {
        actor: DISPATCHER,
        type: 'attempt.settled',
        payload: {
          attempt: {
            proposal: attempt.proposal,
            ticket: attempt.ticket,
            ...(build !== undefined ? { build } : {}),
          },
          outcome: 'stopped',
        },
      })
      if (written) {
        wrote = true
        break
      }
    }
  }
  return wrote
}
