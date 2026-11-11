import type { RepositoryEvent, RepositoryEventPayload } from '../events/repository'
import { defineReducer } from './incremental'
export type ForgeDegradation = RepositoryEventPayload<'dispatcher.forge-degraded'>
export const forgeHealthReducer = defineReducer<
  { active?: ForgeDegradation },
  RepositoryEvent,
  ForgeDegradation | undefined
>({
  version: 1,
  initial: () => ({}),
  fold(acc, events) {
    for (const event of events) {
      if (event.type === 'dispatcher.forge-degraded') acc.active = event.payload
      if (event.type === 'dispatcher.forge-recovered' && acc.active?.forge === event.payload.forge)
        delete acc.active
    }
  },
  finish: (acc) => acc.active,
})

/** One process's latest rate limit outside the dispatcher's credential. */
export type ForgeCredentialLimit = RepositoryEventPayload<'forge.credential-limited'> & {
  at: string
}

/** Retained credential-limit entries; the newest resets win. */
export const FORGE_CREDENTIAL_LIMIT_CAP = 16

/** Latest `forge.credential-limited` per (forge, process), bounded. Expiry
 * is a read-time projection: callers keep only entries whose reset is ahead. */
export const forgeCredentialLimitsReducer = defineReducer<
  { limits: Record<string, ForgeCredentialLimit> },
  RepositoryEvent,
  ForgeCredentialLimit[]
>({
  version: 1,
  initial: () => ({ limits: {} }),
  fold(acc, events) {
    for (const event of events) {
      if (event.type !== 'forge.credential-limited') continue
      acc.limits[`${event.payload.forge}\u0000${event.payload.process}`] = {
        ...event.payload,
        at: event.ts,
      }
    }
    const entries = Object.entries(acc.limits)
    if (entries.length > FORGE_CREDENTIAL_LIMIT_CAP)
      acc.limits = Object.fromEntries(
        entries
          .sort(([, a], [, b]) => Date.parse(b.resetAt) - Date.parse(a.resetAt))
          .slice(0, FORGE_CREDENTIAL_LIMIT_CAP),
      )
  },
  finish: (acc) =>
    Object.values(acc.limits)
      .map((limit) => ({ ...limit }))
      .sort((a, b) => a.resetAt.localeCompare(b.resetAt)),
})

/** Entries whose reset is still ahead of `now`. */
export function activeForgeCredentialLimits(
  limits: readonly ForgeCredentialLimit[],
  now: Date,
): ForgeCredentialLimit[] {
  return limits.filter((limit) => Date.parse(limit.resetAt) > now.getTime())
}
