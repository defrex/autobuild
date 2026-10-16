// Frozen ticket reference decoder from v0.12.0 ontology.ts.
import { z } from 'zod'

export const ticketRefSchema = z.strictObject({
  source: z.string().min(1),
  id: z.string().min(1),
  url: z.string().optional(),
  title: z.string().optional(),
})
