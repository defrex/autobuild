import type { AgentTurnFailure } from '../types'

/** Optional structured signals exposed by a runtime in addition to its error
 * text. Unknown hints are deliberately ignored: under-classification keeps the
 * existing bounded retry policy, while over-classification would suppress a
 * potentially useful retry. */
export interface ProviderErrorHints {
  status?: number | null
  codes?: readonly (string | number | null | undefined)[]
}

const PERMANENT_STATUSES = new Set([401, 402, 403])

const PERMANENT_CODE_PATTERNS = [
  /^(?:auth|authentication|authorization)(?:_|-)/,
  /^(?:unauthorized|forbidden)$/,
  /^(?:invalid|expired|missing|revoked)_(?:api_)?(?:key|token|credential)s?$/,
  /^(?:permission|access)(?:_|-)(?:denied|error|required)$/,
  /^oauth_org_not_allowed$/,
  /(?:^|[_-])(?:billing|payment|quota|credit|balance|budget)(?:[_-]|$)/,
  /^(?:insufficient|out_of)_(?:quota|credits?|balance|funds)$/,
  /^usage_(?:limit|quota)(?:_|$)/,
] as const

const PERMANENT_TEXT_PATTERNS = [
  /\b(?:authentication|authorization)[_ -](?:failed|required|error|invalid)\b/i,
  /\bunauthori[sz]ed\b/i,
  /\bforbidden\b/i,
  /\b(?:invalid|expired|missing|revoked)[_ -](?:api[_ -]?)?(?:key|token|credentials?)\b/i,
  /\b(?:api[- ]?key|token|credentials?)\s+(?:is\s+|are\s+)?(?:invalid|expired|missing|revoked)\b/i,
  /\bpermission(?:_error|\s+(?:denied|required|error))\b/i,
  /\b(?:do not|does not|don't|doesn't)\s+have\s+permission\b/i,
  /\b(?:access|request)\s+(?:is\s+)?(?:denied|not permitted)\b/i,
  /(?:^|[^a-z0-9])(?:quota(?:[_ -](?:exceeded|exhausted|depleted))?|(?:insufficient|exhausted|depleted)[_ -]quota)(?:$|[^a-z0-9])/i,
  /\busage[_ -]?(?:limit|quota)\b/i,
  /\b(?:billing|spending|monthly)\s+(?:limit|cap|cycle)\b/i,
  /\bbilling(?:_error|\s+(?:error|issue|required|disabled))\b/i,
  /\bpayment\s+(?:is\s+)?required\b/i,
  /\bsubscription\s+(?:is\s+)?(?:expired|inactive|required|disabled)\b/i,
  /\b(?:insufficient|no|out of|exhausted|depleted)\s+(?:credits?|balance|funds)\b/i,
  /\bcredits?\s+(?:are\s+|is\s+)?(?:required|exhausted|depleted)\b/i,
  /\bbudget\s+(?:is\s+)?(?:exceeded|exhausted|depleted)\b/i,
] as const

/** Classify a provider/SDK-declared turn error without rewriting its message.
 * Only positive authentication, permission, quota, or billing evidence is
 * permanent. In particular, 429/rate-limit, overload, 5xx, timeout, transport,
 * and unknown errors remain eligible for the existing bounded retry policy. */
export function classifyProviderError(
  message: string,
  hints: ProviderErrorHints = {},
): AgentTurnFailure {
  const permanent =
    (hints.status !== null && hints.status !== undefined && PERMANENT_STATUSES.has(hints.status)) ||
    (hints.codes ?? []).some(isPermanentCode) ||
    hasPermanentHttpStatus(message) ||
    PERMANENT_TEXT_PATTERNS.some((pattern) => pattern.test(message))

  return { message, permanent }
}

function isPermanentCode(code: string | number | null | undefined): boolean {
  if (code === null || code === undefined) return false
  if (typeof code === 'number') return PERMANENT_STATUSES.has(code)
  const normalized = code.trim().toLowerCase()
  return PERMANENT_CODE_PATTERNS.some((pattern) => pattern.test(normalized))
}

function hasPermanentHttpStatus(message: string): boolean {
  return (
    /^\s*(?:(?:http(?:\/\d(?:\.\d)?)?|status(?:\s+code)?)\s*[:=]?\s*)?(?:401|402|403)\b/i.test(
      message,
    ) ||
    /\bhttp(?:\s+status)?\s*[:=]?\s*(?:401|402|403)\b/i.test(message) ||
    /["']?(?:status|status_code|statusCode)["']?\s*[:=]\s*["']?(?:401|402|403)\b/.test(message)
  )
}
