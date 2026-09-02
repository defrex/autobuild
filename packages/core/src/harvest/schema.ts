/**
 * Frozen structured values shared by the harvest kernel, CLI, skills, and
 * repository journal. Harvest operates on observation occurrences, not on an
 * observation id alone: event sequence numbers are only monotonic within one
 * build, so `{build, seq}` is the canonical identity.
 */
import { z } from 'zod'
import { observationKindSchema, ticketRefSchema } from '../ontology'

export const occurrenceKeySchema = z.strictObject({
  build: z.string().min(1),
  seq: z.number().int().positive(),
})
export type OccurrenceKey = z.infer<typeof occurrenceKeySchema>

export function occurrenceKey(key: OccurrenceKey): string {
  return `${key.build}:${key.seq}`
}

export const harvestObservationSchema = z.strictObject({
  occurrence: occurrenceKeySchema,
  id: z.string().min(1),
  kind: observationKindSchema,
  summary: z.string().min(1),
  files: z.array(z.string()).optional(),
  refs: z.array(z.string()).optional(),
  ts: z.string().min(1),
  ticket: ticketRefSchema.optional(),
})
export type HarvestObservation = z.infer<typeof harvestObservationSchema>

/** The durable reason a Harvest snapshot crossed repository pressure. */
export const harvestTriggerSchema = z.enum(['count', 'drift', 'both'])
export type HarvestTrigger = z.infer<typeof harvestTriggerSchema>

/** Source-aware lifecycle visibility for distinct tickets that originated the
 * observations in a scan. Foreign-source refs remain visible but are never
 * sent to the repository's configured TicketSource. */
export const harvestOriginatingTicketSchema = z.strictObject({
  ticket: ticketRefSchema,
  sourceMatches: z.boolean(),
  exists: z.boolean(),
  resolved: z.boolean(),
})
export type HarvestOriginatingTicket = z.infer<typeof harvestOriginatingTicketSchema>

/** Filing records both meanings even when one id is simultaneously declared
 * by the agent and automatically derived from an originating ticket. */
export const harvestBlockerProvenanceSchema = z.strictObject({
  declared: z.array(z.string().min(1)),
  derived: z.array(z.string().min(1)),
})
export type HarvestBlockerProvenance = z.infer<typeof harvestBlockerProvenanceSchema>

/** Prior proposals are semantic-dedup context for the synthesizer. The source
 * owns lifecycle resolution; harvest only reports the returned facts. */
export const harvestLedgerTicketSchema = z.strictObject({
  proposalKey: z.string().min(1),
  ticket: ticketRefSchema,
  exists: z.boolean(),
  resolved: z.boolean(),
  title: z.string().optional(),
  body: z.string().optional(),
})
export type HarvestLedgerTicket = z.infer<typeof harvestLedgerTicketSchema>

export const harvestScanPacketSchema = z.strictObject({
  repo: z.string().min(1),
  run: z.string().min(1),
  observations: z.array(harvestObservationSchema).min(1),
  originatingTickets: z.array(harvestOriginatingTicketSchema).default([]),
  ledger: z.array(harvestLedgerTicketSchema).default([]),
})
export type HarvestScanPacket = z.infer<typeof harvestScanPacketSchema>

const proposalMembers = z.array(occurrenceKeySchema).min(1)

export const harvestCreateProposalSchema = z.strictObject({
  action: z.literal('create'),
  title: z.string().min(1),
  /** The prose for the rendered `What and why` section. */
  whatWhy: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  /** Explicit even when there is little to exclude. */
  outOfScope: z.array(z.string().min(1)).min(1),
  /** Source-local ticket ids that must complete before this work can start. */
  blockedBy: z
    .array(
      z
        .string()
        .min(1)
        .refine((id) => id.trim().length > 0, 'blocker id must be nonblank'),
    )
    .optional(),
  observations: proposalMembers,
})

export const harvestJoinProposalSchema = z.strictObject({
  action: z.literal('join'),
  ticket: ticketRefSchema,
  observations: proposalMembers,
  reason: z.string().min(1),
})

export const harvestSuppressProposalSchema = z.strictObject({
  action: z.literal('suppress'),
  observations: proposalMembers,
  reason: z.string().min(1),
})

export const harvestProposalSchema = z.discriminatedUnion('action', [
  harvestCreateProposalSchema,
  harvestJoinProposalSchema,
  harvestSuppressProposalSchema,
])
export type HarvestProposal = z.infer<typeof harvestProposalSchema>

export const harvestProposalSetSchema = z.strictObject({
  proposals: z.array(harvestProposalSchema).min(1),
})
export type HarvestProposalSet = z.infer<typeof harvestProposalSetSchema>

export const harvestDispositionSchema = z.strictObject({
  occurrence: occurrenceKeySchema,
  action: z.enum(['filed', 'joined', 'suppressed']),
  proposalKey: z.string().min(1).optional(),
  ticket: ticketRefSchema.optional(),
  reason: z.string().min(1).optional(),
})
export type HarvestDisposition = z.infer<typeof harvestDispositionSchema>

/** Stable, prose-free summary of proposal work still pending when automatic
 * recovery is exhausted. The released occurrence list remains authoritative;
 * these descriptors let status name reviewed proposal clusters without
 * loading an artifact. */
export const harvestPendingProposalSchema = z.strictObject({
  proposalKey: z.string().min(1),
  action: z.enum(['create', 'join', 'suppress']),
  observations: z.array(occurrenceKeySchema).min(1),
})
export type HarvestPendingProposal = z.infer<typeof harvestPendingProposalSchema>

export const harvestStepSchema = z.enum(['scan', 'synthesize', 'review', 'file'])
export type HarvestStep = z.infer<typeof harvestStepSchema>

export const harvestStatusSchema = z.enum(['running', 'completed', 'escalated', 'failed'])
export type HarvestStatus = z.infer<typeof harvestStatusSchema>
