import type { PolicyConfig } from '../config/schema'
import type { RepositoryEventPayload } from '../events/repository'
import type { CapacityBuild } from './dispatch-capacity'

// Pure and client-safe: both dashboards import this through `dispatch-capacity`.
// The engagement reducer lives in `open-pr-backpressure-state.ts`.

/** The resolved `[policy]` open-PR backpressure watermarks. */
export interface OpenPrBackpressurePolicy {
  maxOpenPrs: number
  resumeOpenPrs: number
  excludeHeld: boolean
}

/** Open-PR backpressure as the dispatcher will decide it next tick: whether
 * normal-priority intake is paused, and the count and watermarks behind it. */
export interface OpenPrBackpressure extends OpenPrBackpressurePolicy {
  active: boolean
  openPrs: number
}

/** The configured watermarks, or `undefined` when `maxOpenPrs` is unset and
 * backpressure is disabled. `resumeOpenPrs` defaults to `maxOpenPrs - 1`. */
export function openPrBackpressurePolicy(
  policy:
    | Partial<Pick<PolicyConfig, 'maxOpenPrs' | 'resumeOpenPrs' | 'excludeHeldOpenPrs'>>
    | undefined,
): OpenPrBackpressurePolicy | undefined {
  if (policy?.maxOpenPrs === undefined) return undefined
  return {
    maxOpenPrs: policy.maxOpenPrs,
    resumeOpenPrs: policy.resumeOpenPrs ?? policy.maxOpenPrs - 1,
    excludeHeld: policy.excludeHeldOpenPrs ?? false,
  }
}

/** A nonterminal root build (leaf or integration node) with an open or
 * conflicted PR. Children targeting an integration node do not count; with
 * `excludeHeld`, neither does a PR whose active landing command is `hold`. */
export function openRootPr(build: CapacityBuild, excludeHeld: boolean): boolean {
  const { state } = build
  return (
    state.status !== 'done' &&
    state.status !== 'aborted' &&
    state.target === undefined &&
    state.pr !== undefined &&
    (state.prState === 'open' || state.prState === 'conflicted') &&
    !(excludeHeld && state.landing?.command?.kind === 'hold')
  )
}

/** Open root PRs among the builds, each slug counted once. */
export function openPrCount(builds: readonly CapacityBuild[], excludeHeld: boolean): number {
  const unique = new Map(builds.map((build) => [build.record.slug, build]))
  let count = 0
  for (const build of unique.values()) if (openRootPr(build, excludeHeld)) count++
  return count
}

/** Backpressure engages at the high watermark and, once engaged, holds until
 * the count drains to the resume watermark. With `resumeOpenPrs ==
 * maxOpenPrs` this is exactly `openPrs >= maxOpenPrs` and cannot flap. */
export function openPrBackpressure(
  builds: readonly CapacityBuild[],
  policy: OpenPrBackpressurePolicy | undefined,
  engaged: boolean,
): OpenPrBackpressure | undefined {
  if (!policy) return undefined
  const openPrs = openPrCount(builds, policy.excludeHeld)
  return {
    active: openPrs >= policy.maxOpenPrs || (engaged && openPrs > policy.resumeOpenPrs),
    openPrs,
    ...policy,
  }
}

export type OpenPrBackpressureTransition =
  | {
      type: 'dispatcher.open-pr-backpressure-engaged'
      payload: RepositoryEventPayload<'dispatcher.open-pr-backpressure-engaged'>
    }
  | {
      type: 'dispatcher.open-pr-backpressure-cleared'
      payload: RepositoryEventPayload<'dispatcher.open-pr-backpressure-cleared'>
    }

/** The repository event that records a change in engagement, or `undefined`
 * on a steady state. `current` is `undefined` when backpressure is disabled;
 * `openPrs` is the count a disabled policy clears with. */
export function backpressureTransition(
  current: OpenPrBackpressure | undefined,
  engaged: boolean,
  openPrs = current?.openPrs ?? 0,
): OpenPrBackpressureTransition | undefined {
  if (!current)
    return engaged
      ? {
          type: 'dispatcher.open-pr-backpressure-cleared',
          payload: { openPrs, reason: 'disabled' },
        }
      : undefined
  if (current.active && !engaged)
    return {
      type: 'dispatcher.open-pr-backpressure-engaged',
      payload: {
        openPrs: current.openPrs,
        maxOpenPrs: current.maxOpenPrs,
        resumeOpenPrs: current.resumeOpenPrs,
        excludeHeld: current.excludeHeld,
      },
    }
  if (!current.active && engaged)
    return {
      type: 'dispatcher.open-pr-backpressure-cleared',
      payload: { openPrs: current.openPrs, reason: 'drained' },
    }
  return undefined
}

/** Shared wording for active backpressure, used by both dashboards' control
 * lines and the dispatcher's ticket diagnostics; `''` when inactive. */
export function backpressureExplanation(backpressure?: OpenPrBackpressure): string {
  if (!backpressure?.active) return ''
  return `open-PR backpressure: ${backpressure.openPrs} open root PR${backpressure.openPrs === 1 ? '' : 's'} ≥ maxOpenPrs ${backpressure.maxOpenPrs}; normal claims paused until ≤ ${backpressure.resumeOpenPrs} (urgent still claimed)${backpressure.excludeHeld ? '; held PRs excluded' : ''}`
}

/** The `ab repository status` line for configured backpressure, active or not. */
export function backpressureStatusLine(backpressure: OpenPrBackpressure): string {
  const counts = `${backpressure.openPrs} open root PR${backpressure.openPrs === 1 ? '' : 's'} (max ${backpressure.maxOpenPrs}, resume ${backpressure.resumeOpenPrs}${backpressure.excludeHeld ? ', held excluded' : ''})`
  return backpressure.active
    ? `open-PR backpressure: active — ${counts}; normal-priority claims paused, urgent still claimed`
    : `open-PR backpressure: inactive — ${counts}`
}
