import { hostname } from 'node:os'
import { nativeSessionHandleSchema } from '../../events/native-session'
export { nativeSessionHandleSchema } from '../../events/native-session'
import type {
  AgentResumeResult,
  AgentRunner,
  AgentStartOpts,
  AgentTurnFailure,
  NativeSessionHandle,
} from '../types'

export function nativeHandle(
  runner: string,
  nativeId: string,
  workspacePath: string,
  host = hostname(),
  statePath?: string,
): NativeSessionHandle {
  return nativeSessionHandleSchema.parse({
    version: 1,
    runner,
    nativeId,
    host,
    workspacePath,
    ...(statePath !== undefined ? { statePath } : {}),
  })
}

export function notResumable(
  reason: Extract<AgentResumeResult, { kind: 'not-resumable' }>['reason'],
  message: string,
): AgentResumeResult {
  return { kind: 'not-resumable', reason, message }
}

export function guardNativeHandle(
  handle: NativeSessionHandle,
  runner: string,
  opts: AgentStartOpts,
  host = hostname(),
): AgentResumeResult | undefined {
  if (!nativeSessionHandleSchema.safeParse(handle).success)
    return notResumable('missing-state', 'Invalid native session handle')
  if (handle.runner !== runner)
    return notResumable('wrong-runner', 'Native session belongs to another adapter')
  if (handle.host !== host)
    return notResumable('wrong-host', 'Native state belongs to another host')
  if (handle.workspacePath !== opts.workspacePath)
    return notResumable('wrong-workspace', 'Native state belongs to another workspace')
  return undefined
}

/** Compatibility boundary for adapters which have not implemented native resume. */
export async function resumeAgent(
  runner: AgentRunner,
  handle: NativeSessionHandle,
  message: string,
  opts: AgentStartOpts,
): Promise<AgentResumeResult> {
  return runner.resume === undefined
    ? notResumable('unsupported', `${runner.name} does not support native resume`)
    : runner.resume(handle, message, opts)
}

export class NativeObservationError extends Error {
  constructor(readonly failure: unknown) {
    super('Native session observation failed', { cause: failure })
  }
}

export class NativeIdentityMismatch extends NativeObservationError {
  constructor() {
    super(new Error('Conflicting native session identity'))
  }
}

/** Recognized native lookup diagnostics only; provider failures keep their taxonomy. */
export function nativeStateUnavailable(failure: AgentTurnFailure): boolean {
  if (
    failure.cause === 'credentials' ||
    failure.cause === 'exhaustion' ||
    failure.cause === 'configuration'
  )
    return false
  return /\bno (?:saved )?(?:conversation|session|rollout) found\b|\b(?:session|thread|conversation)[^\n]* (?:not found|does not exist)\b|\b(?:cannot|could not) find (?:a |the )?(?:session|thread|conversation)\b|\b(?:session|thread|conversation) state (?:is )?(?:missing|unavailable)\b|\bunknown (?:session|thread)(?: id)?\b/i.test(
    failure.message,
  )
}

/** Once per turn, with conflicting identities rejected before prompt consumption. */
export function nativeObserver(
  opts: AgentStartOpts,
  runner: string,
  host: string,
  expected?: string,
): (id: string) => Promise<void> {
  let observed: string | undefined
  return async (id) => {
    if (id.trim() === '') return
    if ((expected !== undefined && expected !== id) || (observed !== undefined && observed !== id))
      throw new NativeIdentityMismatch()
    if (observed === id) return
    observed = id
    try {
      await opts.onNativeSession?.(nativeHandle(runner, id, opts.workspacePath, host))
    } catch (error) {
      throw new NativeObservationError(error)
    }
  }
}
