import { humanActor, type Via } from '../events/envelope'
import {
  unmeasuredSettlementPolicySchema,
  type EventPayload,
  type UnmeasuredSettlementPolicy,
} from '../events/payloads'
import { settleAttempt } from '../kernel/attempt-settlement'
import { mergedAttemptMeasurement } from '../kernel/landing-measurement'
import type { BuildState } from '../kernel/reducer'
import {
  optimizationCompletionBlocker,
  optimizationElapsedHours,
  optimizationPendingCleanups,
  optimizationStopEligibility,
  optimizationUnmeasuredMerges,
  type PendingCleanupView,
  type UnmeasuredMergeView,
  type OptimizationState,
  type OptimizationStopEligibility,
} from '../kernel/optimization'
import {
  applyObjectiveRevisions,
  objectiveSchema,
  revisableChangesSchema,
  type Objective,
  type ObjectiveChanges,
  type RevisableField,
} from '../objective'
import { readBuildFacts } from '../store/reduced-reads'
import type { BuildStore } from '../store/types'
import { requireRouteBuild, RouteRefusalError } from './requests'

export interface ObjectiveProgress {
  starting?: number
  spread?: number
  current?: number
  best?: number
  attempts: OptimizationState['attempts'] & { running: number }
  plateau: number
  elapsedHours: number
  eligibility: OptimizationStopEligibility
  stopped?: OptimizationState['stopped']
  /** Once stopped: what still keeps the node from completing, if anything. */
  completionBlocker?: string
  /** In-flight attempts that merged without a landing measurement of their
   * merged head. Each holds its concurrency slot until an operator settles it. */
  unmeasuredMerges: UnmeasuredMergeView[]
  /** Settled attempts whose published build branch still awaits deletion. */
  pendingCleanups: PendingCleanupView[]
}

export interface ObjectiveView {
  slug: string
  revision: number
  objective: Objective
  revisedFields: RevisableField[]
  progress: ObjectiveProgress
}

/** An optimization node's effective objective and progress, all from its
 * reduced digest. */
export function objectiveView(slug: string, state: OptimizationState, now: Date): ObjectiveView {
  return {
    slug,
    revision: state.revision,
    objective: state.objective,
    revisedFields: state.revisedFields,
    progress: {
      ...(state.starting !== undefined
        ? { starting: state.starting.value, spread: state.starting.spread }
        : {}),
      ...(state.current !== undefined ? { current: state.current } : {}),
      ...(state.best !== undefined ? { best: state.best } : {}),
      attempts: { ...state.attempts, running: state.inFlight.length },
      plateau: state.plateau,
      elapsedHours: optimizationElapsedHours(state, now),
      eligibility: optimizationStopEligibility(state, now),
      ...(state.stopped !== undefined ? { stopped: state.stopped } : {}),
      ...(() => {
        const blocker = optimizationCompletionBlocker({ optimization: state })
        return state.stopped !== undefined && blocker !== undefined
          ? { completionBlocker: blocker }
          : {}
      })(),
      unmeasuredMerges: optimizationUnmeasuredMerges(state),
      pendingCleanups: optimizationPendingCleanups(state),
    },
  }
}

function requireOptimization(slug: string, state: BuildState): OptimizationState {
  const refuse = (error: string): never => {
    throw new RouteRefusalError({ kind: 'conflict', error })
  }
  if (state.kind !== 'node') refuse(`build "${slug}" is not a node`)
  if (state.optimization === undefined)
    refuse(`node "${slug}" is not an optimization node: no objective was accepted`)
  return state.optimization!
}

function requireRunning(slug: string, state: BuildState, refusal: string): void {
  if (
    state.status === 'done' ||
    state.status === 'aborted' ||
    state.prState === 'merged' ||
    state.prState === 'closed'
  )
    throw new RouteRefusalError({
      kind: 'conflict',
      error: `node "${slug}" is terminal; ${refusal}`,
    })
}

/** One `readBuildFacts`: the node's effective objective and progress. */
export async function showObjective(input: {
  store: BuildStore
  repo: string
  slug: string
  now?: Date
}): Promise<ObjectiveView> {
  await requireRouteBuild(input.store, input.repo, input.slug)
  const state = (await readBuildFacts(input.store, input.slug)).value.state
  return objectiveView(input.slug, requireOptimization(input.slug, state), input.now ?? new Date())
}

/**
 * Record `optimization.objective-revised` (RFC 0005 §4.3): the knobs that
 * change when to stop, how much to spend or how large a gain must be.
 * Running attempts are unaffected and nothing is replanned; the dispatcher
 * evaluates the revised stop rules on its next tick. A revision after a stop
 * is recorded but never resumes proposing: a stop is final.
 */
export async function reviseObjective(input: {
  store: BuildStore
  repo: string
  slug: string
  user: string
  via?: Via
  changes: ObjectiveChanges
}): Promise<{ slug: string; revision: number; changes: ObjectiveChanges }> {
  const { store, repo, slug } = input
  const parsed = revisableChangesSchema.safeParse(input.changes)
  if (!parsed.success)
    throw new RouteRefusalError({
      kind: 'validation',
      error: `invalid objective revision: ${parsed.error.issues
        .map((issue) =>
          issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
        )
        .join('; ')}`,
    })
  const changes = parsed.data
  await requireRouteBuild(store, repo, slug)
  for (;;) {
    const state = (await readBuildFacts(store, slug)).value.state
    const optimization = requireOptimization(slug, state)
    requireRunning(slug, state, 'its objective can no longer be revised')
    const effective = objectiveSchema.safeParse(
      applyObjectiveRevisions(optimization.objective, [changes]),
    )
    if (!effective.success)
      throw new RouteRefusalError({
        kind: 'validation',
        error: `revised objective is invalid: ${effective.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
      })
    const payload: EventPayload<'optimization.objective-revised'> = {
      changes,
      revision: optimization.revision + 1,
    }
    const event = await store.appendIfCurrent(slug, state.lastSeq, {
      actor: humanActor(input.user, input.via),
      type: 'optimization.objective-revised',
      payload,
    })
    if (event) return { slug, revision: payload.revision, changes }
  }
}

/**
 * Record an operator's `optimization.stopped` (RFC 0005 §9). Without `mode`
 * the objective's stop mode applies. A stop is recorded once and is final;
 * it is not merge consent.
 */
export async function stopObjective(input: {
  store: BuildStore
  repo: string
  slug: string
  user: string
  via?: Via
  mode?: 'abort' | 'drain'
}): Promise<{ slug: string; cause: 'operator'; mode: 'abort' | 'drain' }> {
  const { store, repo, slug } = input
  await requireRouteBuild(store, repo, slug)
  for (;;) {
    const state = (await readBuildFacts(store, slug)).value.state
    const optimization = requireOptimization(slug, state)
    requireRunning(slug, state, 'it can no longer be stopped')
    const stopped = optimization.stopped
    if (stopped !== undefined)
      throw new RouteRefusalError({
        kind: 'conflict',
        error: `node "${slug}" already stopped (${stopped.cause}, ${stopped.mode}) at ${stopped.at}`,
      })
    const mode = input.mode ?? optimization.objective.stop.mode
    const event = await store.appendIfCurrent(slug, state.lastSeq, {
      actor: humanActor(input.user, input.via),
      type: 'optimization.stopped',
      payload: { cause: 'operator', mode },
    })
    if (event) return { slug, cause: 'operator', mode }
  }
}

/**
 * Settle an in-flight attempt that merged without a landing measurement of
 * its merged head (SPEC §15.7), under an explicit policy. `attempt` names its
 * proposal id or its build. `release-unmeasured` records
 * `attempt.settled {merged-unmeasured}`: the slot is released exactly once,
 * the measurement stays absent, and no value, baseline or plateau moves.
 * Works on a stopped node; refused on a terminal one. Reads the node's and
 * the attempt build's reduced facts, never an event log.
 */
export async function settleUnmeasuredAttempt(input: {
  store: BuildStore
  repo: string
  slug: string
  attempt: string
  policy: string
  note?: string
  user: string
  via?: Via
}): Promise<{
  slug: string
  proposal: string
  build: string
  outcome: 'merged-unmeasured'
  policy: UnmeasuredSettlementPolicy
}> {
  const { store, repo, slug } = input
  const parsed = unmeasuredSettlementPolicySchema.safeParse(input.policy)
  if (!parsed.success)
    throw new RouteRefusalError({
      kind: 'validation',
      error: `unknown settlement policy "${input.policy}"; expected one of: ${unmeasuredSettlementPolicySchema.options.join(', ')}`,
    })
  const policy = parsed.data
  const refuse = (error: string): never => {
    throw new RouteRefusalError({ kind: 'conflict', error })
  }
  await requireRouteBuild(store, repo, slug)
  const state = (await readBuildFacts(store, slug)).value.state
  const optimization = requireOptimization(slug, state)
  requireRunning(slug, state, 'its attempts can no longer be settled')
  const entry = optimization.inFlight.find(
    (attempt) =>
      attempt.proposal === input.attempt || attempt.unmeasuredMerge?.build === input.attempt,
  )
  if (entry === undefined)
    return refuse(
      `"${input.attempt}" is not an in-flight attempt of node "${slug}": it already settled, was never proposed, or is unknown; see \`ab objective ${slug}\``,
    )
  const merge = entry.unmeasuredMerge
  if (merge === undefined)
    return refuse(
      `attempt ${entry.proposal} of node "${slug}" has not merged without a landing measurement; only an attempt \`ab objective\` lists as an unmeasured merge can be settled this way`,
    )
  // Revalidate against the attempt build's current facts before writing.
  const child = (await readBuildFacts(store, merge.build)).value.state
  if (child.target?.build !== slug || child.prState !== 'merged')
    refuse(`build ${merge.build} is not a merged attempt of node "${slug}"`)
  if (merge.sha !== undefined && child.mergedSha !== merge.sha)
    refuse(
      `build ${merge.build} merged as ${child.mergedSha ?? 'an unrecorded head'}, not ${merge.sha}`,
    )
  if (
    child.mergedSha !== undefined &&
    mergedAttemptMeasurement(child.landingMeasurement, slug, child.mergedSha).kind === 'measured'
  )
    refuse(
      `build ${merge.build}'s merged head has a valid landing measurement; the dispatcher settles it accepted`,
    )
  const settled = await settleAttempt(
    store,
    slug,
    { proposal: entry.proposal, ticket: entry.ticket, build: merge.build },
    'merged-unmeasured',
    {
      policy,
      ...(merge.sha !== undefined ? { mergedSha: merge.sha } : {}),
      ...(input.note !== undefined && input.note.trim() !== '' ? { note: input.note } : {}),
      actor: humanActor(input.user, input.via),
    },
  )
  if (!settled)
    refuse(
      `attempt ${entry.proposal} of node "${slug}" settled concurrently; see \`ab objective ${slug}\``,
    )
  return {
    slug,
    proposal: entry.proposal,
    build: merge.build,
    outcome: 'merged-unmeasured',
    policy,
  }
}
