import { z } from 'zod'

/** Advisory timing only; the anchor identifies the canonical journal measurement. */
export const repoTicketScanCheckpointSchema = z
  .object({
    startedAt: z.string().datetime().max(40),
    anchor: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
export type RepoTicketScanCheckpoint = z.infer<typeof repoTicketScanCheckpointSchema>
export function validateScanCheckpoint(value: unknown) {
  return repoTicketScanCheckpointSchema.nullable().parse(value)
}

export function sameScanCheckpoint(
  a: RepoTicketScanCheckpoint | null,
  b: RepoTicketScanCheckpoint | null,
): boolean {
  return a === null || b === null ? a === b : a.startedAt === b.startedAt && a.anchor === b.anchor
}
