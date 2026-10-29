import { z } from 'zod'

/** Disposable scheduling metadata, never authoritative scan outcomes or a reducer checkpoint. */
export const scanCadenceSchema = z.object({
  scanSeq: z.number().int().positive(),
  startedAt: z.iso.datetime().transform((value) => new Date(value).toISOString()),
  mode: z.enum(['admission', 'observation']),
  readinessFingerprint: z.string(),
  criteriaFingerprint: z.string(),
})
export type ScanCadence = z.infer<typeof scanCadenceSchema>
export const scanCadenceWriteSchema = z.object({
  cadence: scanCadenceSchema,
  allowClockRollback: z.boolean().default(false),
})
