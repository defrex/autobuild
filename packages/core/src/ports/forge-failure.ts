import { z } from 'zod'
/** Additive plugin API: recognizable across separately loaded SDK copies. */
export type ForgeFailureDetails =
  | {
      kind: 'rate-limited'
      resetAt: string
      /** Set when the limited request carried no credential: why it went out
       * anonymously. Such a limit belongs to the caller's network address, not
       * to the dispatcher's credential, so it never pauses the repository. */
      unauthenticated?: string
    }
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
    ((details.kind === 'rate-limited' &&
      z.iso.datetime().safeParse(details.resetAt).success &&
      (details.unauthenticated === undefined ||
        (typeof details.unauthenticated === 'string' && details.unauthenticated.length > 0))) ||
      (details.kind === 'transient' && details.retry === 'retryable'))
  )
}

/** A GitHub API request refused before sending because the process has no
 * credential where one is required (a remote guest, or a hosted backend). It
 * is deliberately not a `ForgeFailure`: it is neither a rate limit nor
 * transient, and retrying cannot succeed without a credential. */
export class ForgeCredentialMissing extends Error {
  readonly credential = 'GITHUB_TOKEN or GH_TOKEN' as const
  constructor(
    readonly process: string,
    readonly reason: string,
  ) {
    super(
      `${process}: GitHub API request refused — no GitHub credential (${reason}). ` +
        'Provide GITHUB_TOKEN or GH_TOKEN to this process; remote guests receive no forge ' +
        'credential, so their GitHub API work must run kernel-side.',
    )
    this.name = 'ForgeCredentialMissing'
  }
}

export interface ForgeRejectionDetails {
  /** Human-readable forge name, e.g. `GitHub`. */
  forge: string
  /** The forge's 4xx HTTP status. */
  status: number
  /** The forge's own answer, verbatim. */
  forgeMessage: string
}

/** A non-transient, non-rate-limit client-error answer from the forge. Unlike a
 * `ForgeFailure`, retrying the same request cannot succeed without a change. */
export class ForgeRejection extends Error {
  readonly forgeRejection = 'autobuild.forge-rejection.v1' as const
  readonly forge: string
  readonly status: number
  readonly forgeMessage: string
  constructor(message: string, details: ForgeRejectionDetails) {
    super(message)
    this.name = 'ForgeRejection'
    this.forge = details.forge
    this.status = details.status
    this.forgeMessage = details.forgeMessage
    if (!isForgeRejection(this)) throw new TypeError('Invalid forge rejection details')
  }
}

export function isForgeRejection(error: unknown): error is ForgeRejection {
  if (!error || typeof error !== 'object') return false
  const value = error as ForgeRejection
  return (
    value.forgeRejection === 'autobuild.forge-rejection.v1' &&
    typeof value.message === 'string' &&
    value.message.length > 0 &&
    typeof value.forge === 'string' &&
    value.forge.length > 0 &&
    Number.isInteger(value.status) &&
    value.status >= 400 &&
    value.status <= 499 &&
    typeof value.forgeMessage === 'string' &&
    value.forgeMessage.length > 0
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
