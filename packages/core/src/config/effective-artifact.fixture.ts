import { parseConfig } from './load'
import { effectiveBuildConfigContent } from '../processes/build-execution-state'

/** Pre-removal normalized snapshot, including defaults written while disabled. */
export function historicalEffectiveConfig(enabled = false): Record<string, unknown> {
  const config = JSON.parse(
    effectiveBuildConfigContent(
      parseConfig(`
[tickets]
source = "file"
readyState = "ready"
[orchestrator]
enabled = ${enabled}
[orchestrator.sandbox]
idleMinutes = 7
environmentVariables = ["CUSTOM_TOOL"]
`),
    ),
  )
  config.orchestrator = {
    ...config.orchestrator,
    invocationBudgetSeconds: 240,
    approvals: ['sandbox.publish'],
    ...(enabled ? { model: 'test/historical', wake: ['escalation.*'] } : {}),
  }
  return config
}
