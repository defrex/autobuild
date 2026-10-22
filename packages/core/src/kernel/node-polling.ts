import { createHash } from 'node:crypto'
import type { AbEvent } from '../events/catalog'
import type { BuildState } from './reducer'

export interface NodePollingPolicy {
  nodeIdleAfterSeconds: number
  nodeIdlePollSeconds: number
}

/** Canonical serialization also survives JSONB key reordering. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

const observations = new Set([
  'node.compared',
  'node.parent-distance',
  'integration.observed',
  'target.moved',
  'node.inventory',
  'landing.decided',
  'node.parent-rejected',
])

/** Commands retain identity, even repeated holds. Observations retain meaning.
 * The bounded map has at most one entry per event type, never per log entry. */
export function advancePollingActivity(activity: Record<string, string>, event: AbEvent): void {
  if (
    event.type === 'node.poll-checked' ||
    event.type === 'observation.recorded' ||
    event.type.startsWith('session.') ||
    event.type.startsWith('runner.') ||
    event.type.startsWith('workspace.') ||
    event.type.startsWith('build.janitor-')
  )
    return
  activity[event.type] = observations.has(event.type) ? canonical(event.payload) : String(event.seq)
}

export function nodeActivityKey(
  state: BuildState,
  children: readonly { slug: string; state: BuildState }[],
): string {
  return createHash('sha256')
    .update(
      canonical({
        own: state.pollingActivity,
        children: children
          .map(({ slug, state: child }) => ({ slug, activity: child.pollingActivity }))
          .sort((a, b) => a.slug.localeCompare(b.slug)),
      }),
    )
    .digest('hex')
}

/** Pending operations always bypass cadence; hold and absent consent do not. */
export function nodePollingUnsettled(state: BuildState): boolean {
  return (
    !state.nodeOpened ||
    !state.nodeComparison ||
    state.nodeRestack?.distance?.count === null ||
    !!state.currentPhase ||
    state.status === 'done' ||
    state.status === 'aborted' ||
    state.prState === 'closed' ||
    state.prState === 'merged' ||
    state.pendingCommands.length > 0 ||
    state.sessions.open.length > 0 ||
    !!state.landing?.native?.operation ||
    !!state.landing?.native?.enabled ||
    !!state.landing?.nativeEnablePending ||
    !!state.landing?.applicationFailure ||
    !!(
      state.pr &&
      state.landing?.command &&
      state.landing.command.seq !== state.landing.acknowledgedSeq
    ) ||
    !!state.nodeRestack?.active ||
    !!state.nodeRestack?.parentRequest ||
    !!state.nodeRestack?.parentChange ||
    Object.keys(state.nodeRestack?.requests ?? {}).length > 0 ||
    !!state.integration?.intent
  )
}

export function nodePollingSchedule(
  state: BuildState,
  activityKey: string,
  policy: NodePollingPolicy,
  now: Date,
  unsettled = nodePollingUnsettled(state),
) {
  const check = state.nodePolling
  const time = now.getTime()
  const checked = Date.parse(check?.checkedAt ?? '')
  const unchanged = Date.parse(check?.unchangedSince ?? '')
  const idle =
    !unsettled &&
    check?.activityKey === activityKey &&
    check.nodeIdleAfterSeconds === policy.nodeIdleAfterSeconds &&
    check.nodeIdlePollSeconds === policy.nodeIdlePollSeconds &&
    Number.isFinite(time) &&
    Number.isFinite(checked) &&
    Number.isFinite(unchanged) &&
    unchanged <= checked &&
    checked <= time &&
    time - unchanged >= policy.nodeIdleAfterSeconds * 1000
  return {
    mode: idle ? ('idle' as const) : ('active' as const),
    due: !idle || time - checked >= policy.nodeIdlePollSeconds * 1000,
    intervalSeconds: policy.nodeIdlePollSeconds,
    lastChecked: check?.checkedAt,
  }
}
