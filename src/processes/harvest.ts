/** Deterministic halves of observation harvest: scan, dedup, validation, and
 * proposal rendering. Agent judgment is deliberately absent from this file. */
import type { ArtifactRef } from '../ontology'
import {
  harvestProposalSetSchema,
  harvestScanPacketSchema,
  occurrenceKey,
  type HarvestLedgerTicket,
  type HarvestObservation,
  type HarvestProposal,
  type HarvestProposalSet,
  type HarvestScanPacket,
  type OccurrenceKey,
} from '../harvest/schema'
import {
  claimedOccurrenceKeys,
  reduceHarvest,
  type HarvestState,
} from '../kernel/harvest'
import type { TicketSource } from '../ports/types'
import { specConformance } from '../spec-standard'
import {
  contentHash,
  toBytes,
  type BuildStore,
} from '../store/types'

export const HARVEST_SCAN_ARTIFACT = 'harvest-scan'
export const HARVEST_PROPOSALS_ARTIFACT = 'harvest-proposals'
export const HARVEST_REVIEW_ARTIFACT = 'harvest-review'
export const HARVEST_REPORT_ARTIFACT = 'harvest-report'
export const HARVEST_TRANSCRIPT_ARTIFACT = 'harvest-transcript'

export interface HarvestScanResult {
  observations: HarvestObservation[]
  state: HarvestState
}

/** Raw structured `observation.recorded` envelopes across this repository.
 * The pair `{build, seq}` is the occurrence key; payload ids are not assumed
 * globally unique. */
export async function scanUnclaimedObservations(
  store: BuildStore,
  repo: string,
): Promise<HarvestScanResult> {
  await store.ensureRepo(repo)
  const harvestEvents = await store.getRepoEvents(repo)
  const state = reduceHarvest(harvestEvents)
  const claimed = claimedOccurrenceKeys(state)
  const observations: HarvestObservation[] = []

  for (const record of await store.listBuilds()) {
    if (record.repo !== repo) continue
    const events = await store.getEvents(record.slug)
    for (const event of events) {
      if (event.type !== 'observation.recorded') continue
      const occurrence = { build: record.slug, seq: event.seq }
      if (claimed.has(occurrenceKey(occurrence))) continue
      observations.push({
        occurrence,
        id: event.payload.id,
        kind: event.payload.kind,
        summary: event.payload.summary,
        ...(event.payload.files !== undefined
          ? { files: [...event.payload.files] }
          : {}),
        ...(event.payload.refs !== undefined
          ? { refs: [...event.payload.refs] }
          : {}),
        ts: event.ts,
        ...(record.ticket !== undefined
          ? { ticket: structuredClone(record.ticket) }
          : {}),
      })
    }
  }

  observations.sort(
    (a, b) =>
      a.occurrence.build.localeCompare(b.occurrence.build) ||
      a.occurrence.seq - b.occurrence.seq,
  )
  return { observations, state }
}

/** Distinct previously filed/joined proposal tickets, reconciled through the
 * TicketSource's native lifecycle semantics. Resolved and missing entries stay
 * in the packet as tombstones rather than disappearing and being re-filed. */
export async function reconcileHarvestLedger(
  state: HarvestState,
  tickets: TicketSource,
): Promise<HarvestLedgerTicket[]> {
  const byProposal = new Map<
    string,
    { proposalKey: string; ticket: NonNullable<(typeof state.ledger)[number]['ticket']> }
  >()
  for (const entry of state.ledger) {
    if (entry.proposalKey === undefined || entry.ticket === undefined) continue
    byProposal.set(entry.proposalKey, {
      proposalKey: entry.proposalKey,
      ticket: entry.ticket,
    })
  }
  const entries = [...byProposal.values()].sort((a, b) =>
    a.proposalKey.localeCompare(b.proposalKey),
  )
  if (entries.length === 0) return []

  const ids = entries.map((entry) => entry.ticket.id)
  const states = await tickets.dependencyStates(ids)
  const out: HarvestLedgerTicket[] = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    const dependency = states[index] ?? {
      id: entry.ticket.id,
      exists: false,
      resolved: false,
      blockedBy: [],
    }
    const current = dependency.exists
      ? await tickets.get(entry.ticket.id)
      : null
    out.push({
      proposalKey: entry.proposalKey,
      ticket: structuredClone(entry.ticket),
      exists: dependency.exists,
      resolved: dependency.resolved,
      ...(current?.title !== undefined ? { title: current.title } : {}),
      ...(current?.body !== undefined ? { body: current.body } : {}),
    })
  }
  return out
}

export async function makeHarvestScanPacket(opts: {
  store: BuildStore
  tickets: TicketSource
  repo: string
  run: string
  observations: HarvestObservation[]
  state: HarvestState
}): Promise<HarvestScanPacket> {
  return harvestScanPacketSchema.parse({
    repo: opts.repo,
    run: opts.run,
    observations: opts.observations,
    ledger: await reconcileHarvestLedger(opts.state, opts.tickets),
  })
}

export function artifactRef(meta: {
  kind: string
  revision: number
}): ArtifactRef {
  return { kind: meta.kind, rev: meta.revision }
}

export interface CoverageResult {
  ok: boolean
  errors: string[]
}

/** Every claimed observation must occur exactly once across create/join/
 * suppress outcomes; no unclaimed key may be smuggled into an artifact. */
export function validateProposalCoverage(
  set: HarvestProposalSet,
  claimed: OccurrenceKey[],
): CoverageResult {
  const expected = new Set(claimed.map(occurrenceKey))
  const counts = new Map<string, number>()
  for (const proposal of set.proposals) {
    for (const occurrence of proposal.observations) {
      const key = occurrenceKey(occurrence)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  const errors: string[] = []
  for (const key of expected) {
    const count = counts.get(key) ?? 0
    if (count === 0) errors.push(`claimed observation ${key} is not covered`)
    else if (count > 1) errors.push(`claimed observation ${key} is covered ${count} times`)
  }
  for (const key of counts.keys()) {
    if (!expected.has(key)) errors.push(`proposal covers unclaimed observation ${key}`)
  }
  return { ok: errors.length === 0, errors }
}

/** Parse an approved proposal artifact and re-assert its partition at the
 * deterministic filing boundary. */
export function parseApprovedProposalSet(
  raw: string,
  claimed: OccurrenceKey[],
): HarvestProposalSet {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `approved harvest proposal artifact is not JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  const parsed = harvestProposalSetSchema.safeParse(json)
  if (!parsed.success) {
    throw new Error(
      `approved harvest proposal artifact does not match the schema: ${parsed.error.message}`,
    )
  }
  const coverage = validateProposalCoverage(parsed.data, claimed)
  if (!coverage.ok) {
    throw new Error(`approved harvest proposals are not a partition: ${coverage.errors.join('; ')}`)
  }
  return parsed.data
}

/** Stable proposal identity: semantic cluster membership, independent of prose
 * edits, review rounds, and the separately reserved external-create UUID. */
export function harvestProposalKey(proposal: HarvestProposal): string {
  const members = proposal.observations.map(occurrenceKey).sort().join('\n')
  return `harvest-${contentHash(toBytes(members)).slice(0, 24)}`
}

export function renderHarvestProposal(
  proposal: Extract<HarvestProposal, { action: 'create' }>,
  observations: HarvestObservation[],
): string {
  const byKey = new Map(
    observations.map((observation) => [
      occurrenceKey(observation.occurrence),
      observation,
    ]),
  )
  const evidence = proposal.observations.map((key) => {
    const observation = byKey.get(occurrenceKey(key))
    if (!observation) {
      throw new Error(
        `cannot render proposal "${proposal.title}": missing claimed observation ${occurrenceKey(key)}`,
      )
    }
    return (
      `- build \`${key.build}\`, event seq ${key.seq}, observation ` +
      `\`${observation.id}\`: ${observation.summary}`
    )
  })
  const body = [
    `# ${proposal.title}`,
    '',
    '## What and why',
    '',
    proposal.whatWhy,
    '',
    '## Acceptance criteria',
    '',
    ...proposal.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    '',
    '## Out of scope',
    '',
    ...proposal.outOfScope.map((item) => `- ${item}`),
    '',
    '## Evidence',
    '',
    ...evidence,
    '',
  ].join('\n')
  const conformance = specConformance(body)
  if (!conformance.conforms) {
    throw new Error(
      `rendered harvest proposal "${proposal.title}" does not conform to the spec standard: ${conformance.missing.join('; ')}`,
    )
  }
  return body
}

export async function loadScanPacket(
  store: BuildStore,
  repo: string,
  ref: ArtifactRef,
): Promise<HarvestScanPacket> {
  const artifact = await store.getRepoArtifact(repo, ref.kind, ref.rev)
  if (!artifact) {
    throw new Error(`missing harvest scan artifact ${ref.kind}@${ref.rev}`)
  }
  return harvestScanPacketSchema.parse(
    JSON.parse(new TextDecoder().decode(artifact.content)),
  )
}
