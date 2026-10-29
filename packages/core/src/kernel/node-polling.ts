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
  state: Pick<BuildState, 'pollingActivity'>,
  children: readonly { slug: string; state: Pick<BuildState, 'pollingActivity'> }[],
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

/** Ticket membership needs claims, PR lifecycle and operator demand, not each
 * plan/review/verification event that keeps GitHub observation active. */
export function nodeTicketObservationKey(
  state: Pick<BuildState, 'pollingActivity'>,
  children: readonly { slug: string; state: Pick<BuildState, 'pollingActivity'> }[],
): string {
  const select = (activity: BuildState['pollingActivity'], types: readonly string[]) =>
    Object.fromEntries(
      types.flatMap((type) => (activity?.[type] === undefined ? [] : [[type, activity[type]]])),
    )
  return nodeActivityKey(
    {
      pollingActivity: select(state.pollingActivity, [
        'build.land-requested',
        'build.hold-requested',
        'node.restack-requested',
        'escalation.answered',
        'node.parent-requested',
        'node.parent-accepted',
      ]),
    },
    children.map((child) => ({
      slug: child.slug,
      state: {
        pollingActivity: select(child.state.pollingActivity, [
          'build.created',
          'pr.opened',
          'finalize.completed',
          'pr.merged',
          'pr.closed',
          'build.completed',
          'build.aborted',
          'node.contribution-recorded',
          'integration.landed',
        ]),
      },
    })),
  )
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

/** Valid scheduling evidence may be reused across processes, never across activity epochs. */
export function nodePollingEvidenceValid(
  state: BuildState,
  activityKey: string,
  policy: NodePollingPolicy,
  now: Date,
): boolean {
  const check = state.nodePolling
  const time = now.getTime()
  const checked = Date.parse(check?.checkedAt ?? '')
  const unchanged = Date.parse(check?.unchangedSince ?? '')
  return (
    check?.activityKey === activityKey &&
    check.nodeIdleAfterSeconds === policy.nodeIdleAfterSeconds &&
    check.nodeIdlePollSeconds === policy.nodeIdlePollSeconds &&
    Number.isFinite(time) &&
    Number.isFinite(checked) &&
    Number.isFinite(unchanged) &&
    // The anchor uses the dispatcher clock; checkedAt uses the store clock.
    // Validate each against now without imposing an order across clocks.
    unchanged <= time &&
    checked <= time
  )
}

/** Successful unchanged active observations need no additional durable record. */
export function nodePollingCheckpointRequired(
  state: BuildState,
  activityKey: string,
  policy: NodePollingPolicy,
  now: Date,
): boolean {
  if (!nodePollingEvidenceValid(state, activityKey, policy, now)) return true
  const check = state.nodePolling!
  return (
    now.getTime() - Date.parse(check.unchangedSince) >= policy.nodeIdleAfterSeconds * 1000 &&
    now.getTime() - Date.parse(check.checkedAt) >= policy.nodeIdlePollSeconds * 1000
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
    nodePollingEvidenceValid(state, activityKey, policy, now) &&
    time - unchanged >= policy.nodeIdleAfterSeconds * 1000
  return {
    mode: idle ? ('idle' as const) : ('active' as const),
    due: !idle || time - checked >= policy.nodeIdlePollSeconds * 1000,
    intervalSeconds: policy.nodeIdlePollSeconds,
    lastChecked: check?.checkedAt,
  }
}
