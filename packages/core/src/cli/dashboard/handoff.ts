import type { RuntimeIdentity } from '../../events/runtime'
import type { DispatchUpgradeState } from '../../kernel/dispatch-upgrade'
import type { DashboardBuild } from './model'
import { displayText } from './cells'

export interface DashboardHandoff {
  run: string
  successor?: string
  correlation: string
  from: RuntimeIdentity
  to: RuntimeIdentity
  mode: 'drain' | 'cutover'
  deadline?: string
}

/** Only accepted durable facts determine visibility; takeover and time do not retire a run. */
export function projectHandoffs(state: DispatchUpgradeState): {
  handoffs: DashboardHandoff[]
  draining: ReadonlySet<string>
} {
  const runs = Object.values(state.runs)
    .filter((run) => run.handoff && !run.completed)
    .sort(
      (a, b) =>
        a.handoff!.seq - b.handoff!.seq ||
        a.handoff!.payload.run.localeCompare(b.handoff!.payload.run),
    )
  const draining = new Set<string>()
  const handoffs = runs.map((run): DashboardHandoff => {
    const fact = run.handoff!.payload
    const mode = fact.mode ?? 'cutover'
    if (mode === 'drain') for (const slug of Object.keys(run.outstanding)) draining.add(slug)
    return {
      run: fact.run,
      correlation: fact.correlation,
      from: fact.from,
      to: fact.to,
      mode,
      ...(fact.successor !== undefined ? { successor: fact.successor } : {}),
      ...(run.deadline !== undefined ? { deadline: run.deadline } : {}),
    }
  })
  return { handoffs, draining }
}

export function enrichDrainingRow(
  row: DashboardBuild,
  draining: ReadonlySet<string>,
): DashboardBuild {
  if (row.draining === undefined && !draining.has(row.slug)) return row
  const { draining: _previous, ...fresh } = row
  return { ...fresh, ...(draining.has(row.slug) ? { draining: true } : {}) }
}

export function handoffRuntime(runtime: RuntimeIdentity): string {
  const version = runtime.version && runtime.version !== 'unknown' ? runtime.version : undefined
  const commit =
    runtime.commit && runtime.commit !== 'unknown' ? runtime.commit.slice(0, 12) : undefined
  return displayText([version, commit].filter(Boolean).join(' ') || 'unknown')
}

export function formatHandoff(handoff: DashboardHandoff): string {
  return `handoff ${handoffRuntime(handoff.from)} to ${handoffRuntime(handoff.to)}; mode ${handoff.mode}; drain deadline ${handoff.deadline ?? 'unknown'}`
}
