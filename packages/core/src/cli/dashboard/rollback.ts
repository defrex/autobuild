import type { RuntimeIdentity } from '../../events/runtime'
import type { DispatchUpgradeState } from '../../kernel/dispatch-upgrade'
import { displayText } from './cells'
import { handoffRuntime } from './handoff'

export interface DashboardRollback {
  correlation: string
  lineage: string
  failed: RuntimeIdentity
  restored: RuntimeIdentity
  ts: string
}

/** Historical holds remain queryable, but only the authoritative lineage is visible. */
export function projectRollback(state: DispatchUpgradeState): DashboardRollback | undefined {
  const lineage = state.authoritativeRun && state.lineages[state.authoritativeRun]
  const hold = lineage ? state.holds[lineage] : undefined
  if (!hold) return undefined
  return {
    correlation: hold.payload.correlation,
    lineage: hold.payload.lineage,
    failed: hold.payload.failed,
    restored: hold.payload.restored,
    ts: hold.ts,
  }
}

export function formatRollback(rollback: DashboardRollback): string {
  return `rollback: failed ${handoffRuntime(rollback.failed)}; restored ${handoffRuntime(rollback.restored)}; held ${handoffRuntime(rollback.failed)}; at ${displayText(rollback.ts)}`
}
