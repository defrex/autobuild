import { z } from 'zod'
/** Additive plugin API: recognizable across separately loaded SDK copies. */
export type ForgeFailureDetails =
  | { kind: 'rate-limited'; resetAt: string }
  | { kind: 'transient'; retry: 'retryable' }

export class ForgeFailure extends Error {
  readonly forgeFailure = 'autobuild.forge-failure.v1' as const
  constructor(
    message: string,
    readonly details: ForgeFailureDetails,
  ) {
    super(message)
    this.name = 'ForgeFailure'
    if (!isForgeFailure(this)) throw new TypeError('Invalid forge failure details')
  }
}

export function isForgeFailure(error: unknown): error is ForgeFailure {
  if (!error || typeof error !== 'object') return false
  const value = error as ForgeFailure
  if (
    value.forgeFailure !== 'autobuild.forge-failure.v1' ||
    typeof value.message !== 'string' ||
    value.message.length === 0
  )
    return false
  const details = value.details
  return (
    !!details &&
    ((details.kind === 'rate-limited' && z.iso.datetime().safeParse(details.resetAt).success) ||
      (details.kind === 'transient' && details.retry === 'retryable'))
  )
}

export interface ForgeRequestContext {
  outcome?: 'restPrimary' | 'restNotModified' | 'graphql'
  build?: string
}
/** Called once for each actual provider request, including failed requests. */
export type ForgeRequestObserver = (context: ForgeRequestContext) => void

/** Git's network diagnostics have no structured HTTP response. Keep this
 * deliberately narrow: policy refusals and local validation never qualify. */
export function classifyGitNetworkFailure(error: unknown): unknown {
  if (isForgeFailure(error)) return error
  const message = error instanceof Error ? error.message : String(error)
  if (
    /\b(?:401|403|429)\b|authentication failed|permission denied|\[rejected\]|stale info|non-fast-forward/i.test(
      message,
    )
  )
    return error
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  if (
    ['ECONNRESET', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(
      String(code),
    ) ||
    /\b(?:HTTP(?:\/\S+)?\s+|returned error:\s*|HTTP code[ =]+)5\d\d\b|\bService Unavailable\b|connection reset|ECONNRESET|ETIMEDOUT|connection timed out|operation timed out|request timed out/i.test(
      message,
    )
  )
    return new ForgeFailure(message, { kind: 'transient', retry: 'retryable' })
  return error
}
