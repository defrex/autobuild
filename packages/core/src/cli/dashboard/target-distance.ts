import type { BuildState } from '../../kernel/reducer'
import type { LeafRestackState } from '../../kernel/leaf-restack-state'

export function distanceSuffix(count: number | null | undefined, terminal?: string): string {
  if (terminal === 'merged' || terminal === 'closed') return ''
  if (count == null || !Number.isSafeInteger(count) || count < 0) return '+?'
  return count === 0 ? '' : `+${count}`
}

export function workTargetDistance(state: BuildState, restack: LeafRestackState): string {
  const sample = restack.distance
  const valid = sample && sample.branch === state.baseBranch && sample.sha === restack.target?.sha
  return distanceSuffix(valid ? sample.count : null, state.prState)
}
