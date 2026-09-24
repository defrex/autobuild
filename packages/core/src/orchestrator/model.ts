/**
 * Model resolution and typed failure classification (AUT-342): the
 * orchestrator's model comes from `[orchestrator].model`, a provider-
 * qualified string in the same vocabulary as `[roles]`, resolved through the
 * deployment's gateway credential. Model failures are typed on
 * `turn.failed` — provider availability, exhaustion, credentials, and
 * configuration are distinguished so nothing is ever retried unboundedly and
 * the class is visible in the session's reduced state.
 */
import { LoadAPIKeyError, createGateway } from 'ai'
import {
  GatewayAuthenticationError,
  GatewayInternalServerError,
  GatewayModelNotFoundError,
  GatewayRateLimitError,
} from '@ai-sdk/gateway'

/** Strip the optional `vercel-ai-gateway/` prefix so the value is written
 * exactly as `[roles]` spells it while the gateway provider receives the
 * bare model id. */
export function resolveGatewayModelId(model: string): string {
  const prefix = 'vercel-ai-gateway/'
  return model.startsWith(prefix) ? model.slice(prefix.length) : model
}

/** Resolve the configured model string through the deployment's gateway
 * credential (`AI_GATEWAY_API_KEY`, read by `createGateway`). Missing or
 * rejected credentials surface at call time and classify as `credentials`. */
export function resolveGatewayModel(model: string): ReturnType<ReturnType<typeof createGateway>> {
  return createGateway()(resolveGatewayModelId(model))
}

/** The typed model-failure vocabulary, mirroring `turn.failed`'s `kind`. */
export type TurnFailureKind =
  | 'provider-unavailable'
  | 'exhausted'
  | 'credentials'
  | 'configuration'
  | 'internal'

/**
 * Classify one model error. The gateway's own error classes are the primary
 * vocabulary: `GatewayModelNotFoundError` (`type: 'model_not_found'`, thrown
 * at call time — the gateway constructs a model for any id, so unknown-model
 * is never `NoSuchModelError`) is `configuration`;
 * `GatewayAuthenticationError` or `LoadAPIKeyError` (which the gateway does
 * not export; `ai` re-exports it from `@ai-sdk/provider`) is `credentials`;
 * `GatewayRateLimitError` or any 429 is `exhausted`;
 * `GatewayInternalServerError` and other 5xx/network/timeout errors are
 * `provider-unavailable`. Remaining errors classify by their `statusCode`
 * when present, else `internal`.
 */
export function classifyModelError(error: unknown): TurnFailureKind {
  // `ai` rewrites gateway authentication errors flowing through a stream
  // into a plain Error (or AISDKError in production) that keeps only the
  // class NAME — classify those by name before the instanceof checks.
  const name =
    typeof (error as { name?: unknown })?.name === 'string'
      ? ((error as { name?: string }).name ?? '')
      : ''
  if (name === 'GatewayAuthenticationError' || name === 'GatewayError') return 'credentials'
  if (error instanceof GatewayModelNotFoundError) return 'configuration'
  if (error instanceof GatewayAuthenticationError || error instanceof LoadAPIKeyError) {
    return 'credentials'
  }
  if (error instanceof GatewayRateLimitError) return 'exhausted'
  if (error instanceof GatewayInternalServerError) return 'provider-unavailable'

  // Non-gateway shapes: classify by what they carry.
  const candidate = error as { statusCode?: unknown; name?: unknown; message?: unknown }
  if (typeof candidate?.statusCode === 'number') {
    if (candidate.statusCode === 401 || candidate.statusCode === 403) return 'credentials'
    if (candidate.statusCode === 404) return 'configuration'
    if (candidate.statusCode === 429) return 'exhausted'
    if (candidate.statusCode >= 500) return 'provider-unavailable'
  }
  const text = `${candidate?.name ?? ''} ${candidate?.message ?? ''}`.toLowerCase()
  if (text.includes('api key') || text.includes('apikey') || text.includes('unauthorized')) {
    return 'credentials'
  }
  if (text.includes('rate limit') || text.includes('too many requests')) return 'exhausted'
  if (text.includes('timeout') || text.includes('econnrefused') || text.includes('enotfound')) {
    return 'provider-unavailable'
  }
  return 'internal'
}
