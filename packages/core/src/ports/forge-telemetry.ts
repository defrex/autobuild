import { z } from 'zod'
/** One response's primary rate-limit headers, as an adapter reports them.
 * Secondary limits carry no status headers and never appear here. */
export const forgeRateLimitObservationSchema = z.strictObject({
  resource: z.string().min(1).max(64),
  limit: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  resetAt: z.iso.datetime(),
})
export type ForgeRateLimitObservation = z.infer<typeof forgeRateLimitObservationSchema>
/** The latest observation for one resource, stamped when the dispatcher saw it. */
export const forgeRateLimitSnapshotSchema = forgeRateLimitObservationSchema.extend({
  observedAt: z.iso.datetime(),
})
export type ForgeRateLimitSnapshot = z.infer<typeof forgeRateLimitSnapshotSchema>
/** Bounded operational evidence, never lifecycle authority. */
export const forgeRequestCountsSchema = z.strictObject({
  restPrimary: z.number().int().nonnegative().optional(),
  restNotModified: z.number().int().nonnegative().optional(),
  graphql: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative(),
  unattributed: z.number().int().nonnegative(),
  builds: z
    .array(z.strictObject({ build: z.string().min(1), requests: z.number().int().positive() }))
    .max(10),
  complete: z.boolean(),
  /** Latest primary rate-limit reading per resource, carried across ticks. */
  rateLimits: z.array(forgeRateLimitSnapshotSchema).max(8).optional(),
})
export type ForgeRequestCounts = z.infer<typeof forgeRequestCountsSchema>
export function forgeHotspot(counts: ForgeRequestCounts | undefined): string | undefined {
  if (!counts) return undefined
  const attributed = counts.total - counts.unattributed
  return counts.builds.find((row) => row.requests >= 2 && row.requests > attributed / 2)?.build
}
