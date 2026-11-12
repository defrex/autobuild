import { forgeHealthEventPayloadSchemas } from './repository'

/** Hosted admission horizon; never applied to historical event decoding. */
export const MAX_FORGE_DEGRADATION_MS = 24 * 60 * 60 * 1000

/** Forge-health facts whose `resetAt` hosted admission bounds. */
export const FORGE_RESET_EVENT_TYPES = [
  'dispatcher.forge-degraded',
  'forge.credential-limited',
] as const

export function validateForgeResetHorizon(
  type: (typeof FORGE_RESET_EVENT_TYPES)[number],
  payload: unknown,
  now: Date,
): void {
  const parsed = forgeHealthEventPayloadSchemas[type].parse(payload)
  const deadline = Date.parse(parsed.resetAt)
  if (!Number.isFinite(deadline) || deadline > now.getTime() + MAX_FORGE_DEGRADATION_MS)
    throw new Error('forge resetAt must be a finite ISO deadline within 24 hours of server time')
}

export function validateForgeDegradation(payload: unknown, now: Date): void {
  validateForgeResetHorizon('dispatcher.forge-degraded', payload, now)
}
