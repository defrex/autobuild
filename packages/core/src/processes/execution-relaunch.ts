import type { RuntimeIdentity } from '../events/runtime'
import type { BuildState } from '../kernel/reducer'

export function sameRuntime(a: RuntimeIdentity, b: RuntimeIdentity): boolean {
  return (
    a.version === b.version &&
    a.commit === b.commit &&
    a.source.kind === b.source.kind &&
    a.source.location === b.source.location
  )
}

/** Pure boundary decision over facts already read by the runner. */
export function relaunchTarget(state: BuildState, instance: string, runtime: RuntimeIdentity) {
  const execution = state.drainingExecutions?.[instance]
  const authorization = execution?.authorization
  if (
    execution?.ended ||
    !authorization?.targetRuntime ||
    !sameRuntime(authorization.runtime, runtime) ||
    sameRuntime(authorization.targetRuntime, runtime)
  )
    return undefined
  return {
    instance,
    correlation: authorization.correlation,
    from: runtime,
    to: authorization.targetRuntime,
  }
}
