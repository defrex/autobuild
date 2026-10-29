import { forgeHealthEventPayloadSchemas } from './repository'

/** Hosted admission horizon; never applied to historical event decoding. */
export const MAX_FORGE_DEGRADATION_MS = 24 * 60 * 60 * 1000

export function validateForgeDegradation(payload: unknown, now: Date): void {
  const parsed = forgeHealthEventPayloadSchemas['dispatcher.forge-degraded'].parse(payload)
  const deadline = Date.parse(parsed.resetAt)
  if (!Number.isFinite(deadline) || deadline > now.getTime() + MAX_FORGE_DEGRADATION_MS)
    throw new Error('forge resetAt must be a finite ISO deadline within 24 hours of server time')
}
