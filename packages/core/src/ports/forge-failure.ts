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
  build?: string
}
/** Called once for each actual provider request, including failed requests. */
export type ForgeRequestObserver = (context: ForgeRequestContext) => void
