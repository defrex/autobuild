import type { AgentTurnFailure } from '../types'

/** Optional structured signals exposed by a runtime in addition to its error
 * text. Unknown hints are deliberately treated as availability failures: that
 * preserves the existing bounded retry policy and permits an explicitly
 * configured alternate without hiding credential evidence. */
export interface ProviderErrorHints {
  status?: number | null
  codes?: readonly (string | number | null | undefined)[]
}

const EXHAUSTION_CODE_PATTERNS = [
  /(?:^|[_-])(?:billing|payment|quota|credit|balance|budget)(?:[_-]|$)/,
  /^(?:insufficient|out_of)_(?:quota|credits?|balance|funds)$/,
  /^usage_(?:limit|quota)(?:_|$)/,
] as const

const CREDENTIAL_CODE_PATTERNS = [
  /^(?:auth|authentication|authorization)(?:_|-)/,
  /^(?:unauthorized|forbidden)$/,
  /^(?:invalid|expired|missing|revoked)_(?:api_)?(?:key|token|credential)s?$/,
  /^(?:permission|access)(?:_|-)(?:denied|error|required)$/,
  /^oauth_org_not_allowed$/,
] as const

const EXHAUSTION_TEXT_PATTERNS = [
  /(?:^|[^a-z0-9])(?:quota(?:[_ -](?:exceeded|exhausted|depleted|refreshes?))?|(?:insufficient|exhausted|depleted)[_ -]quota)(?:$|[^a-z0-9])/i,
  /\busage[_ -]?(?:limit|quota)\b/i,
  /\b(?:billing|spending|monthly)\s+(?:limit|cap|cycle)\b/i,
  /\bbilling(?:_error|\s+(?:error|issue|required|disabled))\b/i,
  /\bpayment\s+(?:is\s+)?required\b/i,
  /\bsubscription\s+(?:is\s+)?(?:expired|inactive|required|disabled)\b/i,
  /\b(?:insufficient|no|out of|exhausted|depleted)\s+(?:credits?|balance|funds)\b/i,
  /\bcredits?\s+(?:are\s+|is\s+)?(?:required|exhausted|depleted)\b/i,
  /\bbudget\s+(?:is\s+)?(?:exceeded|exhausted|depleted)\b/i,
] as const

const CREDENTIAL_TEXT_PATTERNS = [
  /\b(?:authentication|authorization)[_ -](?:failed|required|error|invalid)\b/i,
  /\bunauthori[sz]ed\b/i,
  /\bforbidden\b/i,
  /\b(?:invalid|expired|missing|revoked)[_ -](?:api[_ -]?)?(?:key|token|credentials?)\b/i,
  /\b(?:api[- ]?key|token|credentials?)\s+(?:is\s+|are\s+)?(?:invalid|expired|missing|revoked)\b/i,
  /\bpermission(?:_error|\s+(?:denied|required|error))\b/i,
  /\b(?:do not|does not|don't|doesn't)\s+have\s+permission\b/i,
  /\b(?:access|request)\s+(?:is\s+)?(?:denied|not permitted)\b/i,
] as const

/** Classify a provider/SDK-declared turn error without rewriting its message.
 * Exhaustion evidence intentionally wins over generic 402/403 and permission
 * evidence: providers commonly wrap usage-limit responses in those shapes. */
export function classifyProviderError(
  message: string,
  hints: ProviderErrorHints = {},
): AgentTurnFailure {
  const codes = hints.codes ?? []
  const exhaustion =
    hints.status === 402 ||
    codes.some((code) => code === 402 || matchesCode(code, EXHAUSTION_CODE_PATTERNS)) ||
    hasHttpStatus(message, [402]) ||
    EXHAUSTION_TEXT_PATTERNS.some((pattern) => pattern.test(message))
  if (exhaustion) return { message, permanent: true, cause: 'exhaustion' }

  const credentials =
    hints.status === 401 ||
    hints.status === 403 ||
    codes.some(
      (code) => code === 401 || code === 403 || matchesCode(code, CREDENTIAL_CODE_PATTERNS),
    ) ||
    hasHttpStatus(message, [401, 403]) ||
    CREDENTIAL_TEXT_PATTERNS.some((pattern) => pattern.test(message))
  if (credentials) return { message, permanent: true, cause: 'credentials' }

  return { message, permanent: false, cause: 'availability' }
}

/** Whether another declared target may be tried inside this phase attempt.
 * Legacy plugins have no cause: preserve their old safe split. */
export function isAlternateEligible(failure: AgentTurnFailure): boolean {
  return failure.cause === undefined
    ? !failure.permanent
    : failure.cause === 'availability' || failure.cause === 'exhaustion'
}

/** Final-failure retry behavior remains governed by the compatibility bit. */
export function mayRetryPhase(failure: AgentTurnFailure): boolean {
  return !failure.permanent
}

/** Explicit local configuration failures bypass both alternates and phase retries. */
export function configurationFailure(message: string): AgentTurnFailure {
  return { message, permanent: true, cause: 'configuration' }
}

/** Explicit credential failures bypass both alternates and phase retries. */
export function credentialFailure(message: string): AgentTurnFailure {
  return { message, permanent: true, cause: 'credentials' }
}

function matchesCode(
  code: string | number | null | undefined,
  patterns: readonly RegExp[],
): boolean {
  if (code === null || code === undefined || typeof code === 'number') return false
  const normalized = code.trim().toLowerCase()
  return patterns.some((pattern) => pattern.test(normalized))
}

function hasHttpStatus(message: string, statuses: readonly number[]): boolean {
  const alternatives = statuses.join('|')
  return (
    new RegExp(
      `^\\s*(?:(?:http(?:\\/\\d(?:\\.\\d)?)?|status(?:\\s+code)?)\\s*[:=]?\\s*)?(?:${alternatives})\\b`,
      'i',
    ).test(message) ||
    new RegExp(`\\bhttp(?:\\s+status)?\\s*[:=]?\\s*(?:${alternatives})\\b`, 'i').test(message) ||
    new RegExp(
      `["']?(?:status|status_code|statusCode)["']?\\s*[:=]\\s*["']?(?:${alternatives})\\b`,
    ).test(message)
  )
}
