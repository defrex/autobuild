/**
 * Forge CI on finished leaves (SPEC §15.7). Pure classification of a
 * provider's check runs and commit statuses, the durable failure record's
 * dedupe identity, and the one selector every surface reads to decide
 * whether a recorded failure still describes the PR.
 */
import { createHash } from 'node:crypto'
import type { HeadCheck, HeadChecks } from '../ports/types'
import type { BuildState, CiFailureRecord } from './reducer'
import { epilogueLeaf } from './dispatch-capacity'

/** Failing checks carried in a `pr.checks-failed` for display. */
export const CI_FAILURE_PREVIEW = 20
const NAME_LIMIT = 200

export interface CheckRunObservation {
  name: string
  status: string
  conclusion: string | null
  url?: string
}

export interface CommitStatusObservation {
  context: string
  state: string
  url?: string
}

const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out'])
const FAILING_STATES = new Set(['failure', 'error'])

/** Classify one commit's latest check runs and statuses. `truncated` says
 * either listing was incomplete: a visible failure still proves red, but no
 * visible failure proves nothing. Cancelled, neutral, skipped and
 * action-required runs are not failures. */
export function classifyHeadChecks(
  checkRuns: readonly CheckRunObservation[],
  statuses: readonly CommitStatusObservation[],
  truncated = false,
): HeadChecks {
  const failing: HeadCheck[] = []
  let pending = false
  for (const run of checkRuns) {
    if (run.status !== 'completed') pending = true
    else if (run.conclusion !== null && FAILING_CONCLUSIONS.has(run.conclusion))
      failing.push({
        name: run.name,
        source: 'check-run',
        conclusion: run.conclusion,
        ...(run.url ? { url: run.url } : {}),
      })
  }
  for (const status of statuses) {
    if (status.state === 'pending') pending = true
    else if (FAILING_STATES.has(status.state))
      failing.push({
        name: status.context,
        source: 'status',
        conclusion: status.state,
        ...(status.url ? { url: status.url } : {}),
      })
  }
  const normalized = normalizeFailing(failing)
  if (truncated && normalized.length === 0) return { kind: 'unknown', reason: 'truncated' }
  return { kind: 'known', failing: normalized, pending }
}

/** Sorted by `(source, name)`, deduped by name within a source, names
 * truncated to the payload limit. */
function normalizeFailing(failing: readonly HeadCheck[]): HeadCheck[] {
  const seen = new Set<string>()
  const out: HeadCheck[] = []
  for (const check of failing) {
    const name = check.name.slice(0, NAME_LIMIT) || '(unnamed)'
    const key = JSON.stringify([check.source, name])
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ ...check, name })
  }
  return out.sort((a, b) =>
    a.source === b.source ? compare(a.name, b.name) : compare(a.source, b.source),
  )
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Identity of the complete failing set, independent of order and of the
 * display preview: a change to any failing check changes it. */
export function failingSetDigest(failing: readonly HeadCheck[]): string {
  const pairs = normalizeFailing(failing).map((check) => [check.source, check.name])
  return createHash('sha256').update(JSON.stringify(pairs)).digest('hex')
}

/** One attention event per `(head, buildHead, failing set)`. */
export function ciFailureKey(failure: { head: string; buildHead: string; digest: string }): string {
  return JSON.stringify([failure.head, failure.buildHead, failure.digest])
}

/** A finished, open, unmerged leaf with no phase or session running: the
 * builds whose forge CI the dispatcher observes. Paused, held and
 * consent-awaiting leaves count; conflicted or reconciling ones do not. */
export function ciChecksObservable(state: BuildState): boolean {
  return (
    state.kind !== 'node' &&
    state.pr !== undefined &&
    state.prState === 'open' &&
    epilogueLeaf(state) &&
    state.currentPhase === undefined &&
    state.sessions.open.length === 0
  )
}

/** The recorded failure, only while it still describes the build's open PR
 * at its recorded head. A reconcile, restack, merge or close hides it at
 * once; the dispatcher records the durable clear on its next poll. */
export function currentCiFailure(state: BuildState): CiFailureRecord | undefined {
  const failure = state.ciFailure
  if (!failure || state.prState !== 'open') return undefined
  if (state.pr?.number !== failure.pr || state.pr.headSha !== failure.buildHead) return undefined
  return failure
}

/** The shared vocabulary for a forge CI failure on every surface. */
export function ciFailureText(failure: {
  head: string
  buildHead: string
  checks: readonly { name: string }[]
  total: number
}): string {
  const names = failure.checks.map((check) => check.name).join(', ')
  const more =
    failure.total > failure.checks.length ? ` (+${failure.total - failure.checks.length} more)` : ''
  const differs =
    failure.head !== failure.buildHead
      ? ` (live PR head differs from build head ${failure.buildHead.slice(0, 12)})`
      : ''
  return `forge CI failing at ${failure.head.slice(0, 12)}: ${names}${more}${differs}`
}
