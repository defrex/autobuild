import type { BuildState } from '../../kernel/reducer'

export function landingPolicyDisplay(landing: BuildState['landing']): string {
  if (landing?.command?.kind === 'hold') return 'held'
  return landing?.decision?.mode ?? 'policy pending'
}
