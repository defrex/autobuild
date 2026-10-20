import { z } from 'zod'
/** Bounded operational evidence, never lifecycle authority. */
export const forgeRequestCountsSchema = z.strictObject({
  total: z.number().int().nonnegative(),
  unattributed: z.number().int().nonnegative(),
  builds: z
    .array(z.strictObject({ build: z.string().min(1), requests: z.number().int().positive() }))
    .max(10),
  complete: z.boolean(),
})
export type ForgeRequestCounts = z.infer<typeof forgeRequestCountsSchema>
export function forgeHotspot(counts: ForgeRequestCounts | undefined): string | undefined {
  if (!counts) return undefined
  const attributed = counts.total - counts.unattributed
  return counts.builds.find((row) => row.requests >= 2 && row.requests > attributed / 2)?.build
}
