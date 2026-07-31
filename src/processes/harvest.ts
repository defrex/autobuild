/** Deterministic halves of observation harvest: scan, dedup, validation, and
 * proposal rendering. Agent judgment is deliberately absent from this file. */
import type { ArtifactRef } from '../ontology'
import {
  harvestProposalSetSchema,
  harvestScanPacketSchema,
  occurrenceKey,
  type HarvestBlockerProvenance,
  type HarvestDisposition,
  type HarvestLedgerTicket,
  type HarvestObservation,
  type HarvestOriginatingTicket,
  type HarvestPendingProposal,
  type HarvestProposal,
  type HarvestProposalSet,
  type HarvestScanPacket,
  type HarvestTrigger,
  type OccurrenceKey,
} from '../harvest/schema'
import {
  claimedOccurrenceKeys,
  proposalArtifactForRound,
  reduceHarvest,
  type HarvestRunState,
  type HarvestState,
} from '../kernel/harvest'
import type { TicketSource } from '../ports/types'
import { specConformance } from '../spec-standard'
import { contentHash, toBytes, type BuildStore } from '../store/types'

export const HARVEST_SCAN_ARTIFACT = 'harvest-scan'
export const HARVEST_PROPOSALS_ARTIFACT = 'harvest-proposals'
export const HARVEST_REVIEW_ARTIFACT = 'harvest-review'
export const HARVEST_REPORT_ARTIFACT = 'harvest-report'
export const HARVEST_TRANSCRIPT_ARTIFACT = 'harvest-transcript'

export interface HarvestMerge {
  build: string
  ts: string
}

export interface HarvestScanResult {
  observations: HarvestObservation[]
  /** One durable merge fact per build, collected during the existing event-stream reads. */
  merges: HarvestMerge[]
  state: HarvestState
}

export interface HarvestPressure {
  observationCount: number
  drift: number
  trigger?: HarvestTrigger
}

/** Pure two-dimensional Harvest gate. Drift is measured from the oldest
 * unclaimed observation and excludes that observation's own build. */
export function evaluateHarvestPressure(
  scan: Pick<HarvestScanResult, 'observations' | 'merges'>,
  policy: { harvestThreshold: number; harvestMaxDrift: number },
): HarvestPressure {
  const observationCount = scan.observations.length
  if (observationCount === 0) return { observationCount, drift: 0 }

  const oldest = scan.observations.reduce((candidate, observation) =>
    observation.ts < candidate.ts ? observation : candidate,
  )
  const mergedBuilds = new Set<string>()
  for (const merge of scan.merges) {
    if (merge.build === oldest.occurrence.build || merge.ts <= oldest.ts) continue
    mergedBuilds.add(merge.build)
  }
  const drift = mergedBuilds.size
  const countTriggered = observationCount >= policy.harvestThreshold
  const driftTriggered = policy.harvestMaxDrift > 0 && drift >= policy.harvestMaxDrift
  const trigger =
    countTriggered && driftTriggered
      ? 'both'
      : countTriggered
        ? 'count'
        : driftTriggered
          ? 'drift'
          : undefined
  return {
    observationCount,
    drift,
    ...(trigger !== undefined ? { trigger } : {}),
  }
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
  const merges: HarvestMerge[] = []

  for (const record of await store.listBuilds()) {
    if (record.repo !== repo) continue
    const events = await store.getEvents(record.slug)
    for (const event of events) {
      if (event.type === 'pr.merged') {
        merges.push({ build: record.slug, ts: event.ts })
        continue
      }
      if (event.type !== 'observation.recorded') continue
      const occurrence = { build: record.slug, seq: event.seq }
      if (claimed.has(occurrenceKey(occurrence))) continue
      observations.push({
        occurrence,
        id: event.payload.id,
        kind: event.payload.kind,
        summary: event.payload.summary,
        ...(event.payload.files !== undefined ? { files: [...event.payload.files] } : {}),
        ...(event.payload.refs !== undefined ? { refs: [...event.payload.refs] } : {}),
        ts: event.ts,
        ...(record.ticket !== undefined ? { ticket: structuredClone(record.ticket) } : {}),
      })
    }
  }

  observations.sort(
    (a, b) =>
      a.occurrence.build.localeCompare(b.occurrence.build) || a.occurrence.seq - b.occurrence.seq,
  )
  return { observations, merges, state }
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
    const current = dependency.exists ? await tickets.get(entry.ticket.id) : null
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

/** Distinct observation-origin tickets in first-seen order. Lifecycle state is
 * informational at scan time; filing refreshes matching refs before create. */
export async function reconcileOriginatingTickets(
  observations: HarvestObservation[],
  tickets: TicketSource,
): Promise<HarvestOriginatingTicket[]> {
  const distinct = new Map<string, NonNullable<HarvestObservation['ticket']>>()
  for (const observation of observations) {
    if (observation.ticket === undefined) continue
    const key = `${observation.ticket.source}:${observation.ticket.id}`
    if (!distinct.has(key)) distinct.set(key, structuredClone(observation.ticket))
  }

  const refs = [...distinct.values()]
  const matchingIds = refs
    .filter((ticket) => ticket.source === tickets.name)
    .map((ticket) => ticket.id)
  const states = matchingIds.length > 0 ? await tickets.dependencyStates(matchingIds) : []
  const byId = new Map(states.map((state) => [state.id, state]))

  return refs.map((ticket) => {
    const sourceMatches = ticket.source === tickets.name
    const state = sourceMatches ? byId.get(ticket.id) : undefined
    return {
      ticket,
      sourceMatches,
      exists: state?.exists ?? false,
      resolved: state?.resolved ?? false,
    }
  })
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
    originatingTickets: await reconcileOriginatingTickets(opts.observations, opts.tickets),
    ledger: await reconcileHarvestLedger(opts.state, opts.tickets),
  })
}

export function artifactRef(meta: { kind: string; revision: number }): ArtifactRef {
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

/** Resolve the authoritative blocker union immediately before create. Agent
 * declarations retain strict validation; observation origins are best-effort
 * prerequisites and contribute only while they still exist and are unresolved. */
export interface HarvestCreateBlockers {
  blockedBy: string[]
  provenance: HarvestBlockerProvenance
}

export async function resolveHarvestCreateBlockers(
  proposal: Extract<HarvestProposal, { action: 'create' }>,
  observations: HarvestObservation[],
  tickets: TicketSource,
): Promise<HarvestCreateBlockers> {
  const declared = [...new Set(proposal.blockedBy ?? [])]
  const byOccurrence = new Map(
    observations.map((observation) => [occurrenceKey(observation.occurrence), observation]),
  )
  const originIds: string[] = []
  const seenOrigins = new Set<string>()
  for (const occurrence of proposal.observations) {
    const observation = byOccurrence.get(occurrenceKey(occurrence))
    if (observation === undefined) {
      throw new Error(
        `cannot resolve blockers for harvest proposal "${proposal.title}": ` +
          `missing scan observation ${occurrenceKey(occurrence)}`,
      )
    }
    const origin = observation.ticket
    if (origin === undefined || origin.source !== tickets.name || seenOrigins.has(origin.id)) {
      continue
    }
    seenOrigins.add(origin.id)
    originIds.push(origin.id)
  }

  const candidates = [...new Set([...declared, ...originIds])]
  if (candidates.length === 0) {
    return { blockedBy: [], provenance: { declared, derived: [] } }
  }

  let states: Awaited<ReturnType<TicketSource['dependencyStates']>>
  try {
    states = await tickets.dependencyStates(candidates)
  } catch (error) {
    throw new Error(
      `cannot file harvest proposal "${proposal.title}" through ticket source ` +
        `"${tickets.name}": blocker validation failed for ${candidates.map((id) => `"${id}"`).join(', ')}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }

  const byId = new Map(states.map((state) => [state.id, state]))
  const invalid = declared.filter((id) => byId.get(id)?.exists !== true)
  if (invalid.length > 0) {
    throw new Error(
      `cannot file harvest proposal "${proposal.title}" through ticket source ` +
        `"${tickets.name}": unknown or invalid blocker ${invalid.map((id) => `"${id}"`).join(', ')}`,
    )
  }

  const derived = originIds.filter((id) => {
    const state = byId.get(id)
    return state?.exists === true && !state.resolved
  })
  return {
    blockedBy: [...new Set([...declared, ...derived])],
    provenance: { declared, derived },
  }
}

export interface HarvestExhaustionPartition {
  releasedObservations: OccurrenceKey[]
  committedDispositions: HarvestDisposition[]
  pendingProposals: HarvestPendingProposal[]
}

/** Determine the only safe give-up partition from frozen repository facts.
 * No provider is queried and no external side effect occurs here: filed facts,
 * the approved proposal artifact, and its original scan packet are the entire
 * authority.
 *
 * Store read failures propagate so a transient outage can be retried. Once a
 * read succeeds, malformed/missing artifacts and unclassifiable proposal
 * members fail safe as pending work instead of making exhaustion itself a hot
 * loop. */
export async function partitionHarvestExhaustion(opts: {
  store: BuildStore
  repo: string
  run: HarvestRunState
}): Promise<HarvestExhaustionPartition> {
  const { store, repo, run } = opts
  const releaseWholeSnapshot = (): HarvestExhaustionPartition => ({
    releasedObservations: structuredClone(run.observations),
    committedDispositions: [],
    pendingProposals: [],
  })
  const approval = [...run.reviews].reverse().find((review) => review.verdict === 'approve')
  if (approval === undefined) return releaseWholeSnapshot()

  const approved = proposalArtifactForRound(run, approval.round)
  if (approved === undefined) return releaseWholeSnapshot()
  // A rejected read is transient and must remain retryable. A successful
  // missing result is durable corruption, so release rather than relaunching
  // this same rejecting exhaustion settlement forever.
  const artifact = await store.getRepoArtifact(repo, approved.kind, approved.rev)
  if (artifact === null) return releaseWholeSnapshot()

  let set: HarvestProposalSet
  try {
    set = parseApprovedProposalSet(new TextDecoder().decode(artifact.content), run.observations)
  } catch {
    return releaseWholeSnapshot()
  }

  // The scan packet is needed only to prove a join is still a valid frozen
  // disposition. As above, transport/read errors propagate; missing,
  // malformed, or mismatched content simply makes joins pending. Creates with
  // durable filing facts and suppressions remain independently classifiable.
  const scanArtifact = await store.getRepoArtifact(repo, run.scan.kind, run.scan.rev)
  let packet: HarvestScanPacket | undefined
  if (scanArtifact !== null) {
    let raw: unknown
    try {
      raw = JSON.parse(new TextDecoder().decode(scanArtifact.content))
    } catch {
      raw = undefined
    }
    const parsed = harvestScanPacketSchema.safeParse(raw)
    if (parsed.success && parsed.data.run === run.run) {
      const packetOccurrences = new Set(
        parsed.data.observations.map((item) => occurrenceKey(item.occurrence)),
      )
      if (
        packetOccurrences.size === run.observations.length &&
        run.observations.every((item) => packetOccurrences.has(occurrenceKey(item)))
      ) {
        packet = parsed.data
      }
    }
  }

  const knownLedger = new Map(
    (packet?.ledger ?? []).map((entry) => [`${entry.ticket.source}:${entry.ticket.id}`, entry]),
  )
  const filed = new Map(run.filed.map((entry) => [entry.proposalKey, entry.ticket]))
  const proposalKeys = new Set<string>()
  for (const proposal of set.proposals) {
    const proposalKey = harvestProposalKey(proposal)
    if (proposalKeys.has(proposalKey)) return releaseWholeSnapshot()
    proposalKeys.add(proposalKey)
  }

  const releasedObservations: OccurrenceKey[] = []
  const committedDispositions: HarvestDisposition[] = []
  const pendingProposals: HarvestPendingProposal[] = []
  const releaseProposal = (proposal: HarvestProposal): void => {
    const proposalKey = harvestProposalKey(proposal)
    releasedObservations.push(...structuredClone(proposal.observations))
    pendingProposals.push({
      proposalKey,
      action: proposal.action,
      observations: structuredClone(proposal.observations),
    })
  }

  for (const proposal of set.proposals) {
    if (proposal.action === 'create') {
      const proposalKey = harvestProposalKey(proposal)
      const ticket = filed.get(proposalKey)
      if (ticket === undefined) {
        releaseProposal(proposal)
      } else {
        for (const occurrence of proposal.observations) {
          committedDispositions.push({
            occurrence: { ...occurrence },
            action: 'filed',
            proposalKey,
            ticket: structuredClone(ticket),
          })
        }
      }
      continue
    }

    if (proposal.action === 'join') {
      const known = knownLedger.get(`${proposal.ticket.source}:${proposal.ticket.id}`)
      if (known === undefined || !known.exists || known.resolved) {
        releaseProposal(proposal)
        continue
      }
      for (const occurrence of proposal.observations) {
        committedDispositions.push({
          occurrence: { ...occurrence },
          action: 'joined',
          proposalKey: known.proposalKey,
          ticket: structuredClone(known.ticket),
          reason: proposal.reason,
        })
      }
      continue
    }

    const proposalKey = harvestProposalKey(proposal)
    for (const occurrence of proposal.observations) {
      committedDispositions.push({
        occurrence: { ...occurrence },
        action: 'suppressed',
        proposalKey,
        reason: proposal.reason,
      })
    }
  }

  // Coverage was revalidated above, so this is a defensive fail-safe against a
  // future classifier bug rather than a reachable content error.
  const expected = new Set(run.observations.map(occurrenceKey))
  const seen = new Set<string>()
  for (const occurrence of [
    ...committedDispositions.map((item) => item.occurrence),
    ...releasedObservations,
  ]) {
    const key = occurrenceKey(occurrence)
    if (!expected.has(key) || seen.has(key)) return releaseWholeSnapshot()
    seen.add(key)
  }
  if (seen.size !== expected.size) return releaseWholeSnapshot()

  return {
    releasedObservations,
    committedDispositions,
    pendingProposals,
  }
}

export function renderHarvestProposal(
  proposal: Extract<HarvestProposal, { action: 'create' }>,
  observations: HarvestObservation[],
): string {
  const byKey = new Map(
    observations.map((observation) => [occurrenceKey(observation.occurrence), observation]),
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
  return harvestScanPacketSchema.parse(JSON.parse(new TextDecoder().decode(artifact.content)))
}
