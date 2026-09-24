/** Deterministic halves of observation harvest: scan, dedup, validation, and
 * proposal rendering. Agent judgment is deliberately absent from this file. */
import type { AbEvent } from '../events/catalog'
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
import type { RepositoryEvent } from '../events/repository'
import {
  contentHash,
  toBytes,
  type BuildDigest,
  type BuildRecord,
  type BuildStore,
} from '../store/types'

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

/** The build- and occurrence-shaped facts both pressure evaluations project
 * onto: the unclaimed occurrences with their event timestamps, and the merge
 * facts. Keeping the oldest-observation selection and drift arithmetic in one
 * place makes the scan-based and digest-based evaluations equal by
 * construction rather than by parallel maintenance (AUT-521). */
interface HarvestPressureFacts {
  unclaimed: { build: string; seq: number; ts: string }[]
  merges: { build: string; ts: string }[]
}

function evaluateHarvestPressureFacts(
  facts: HarvestPressureFacts,
  policy: { harvestThreshold: number; harvestMaxDrift: number },
): HarvestPressure {
  const observationCount = facts.unclaimed.length
  if (observationCount === 0) return { observationCount, drift: 0 }

  // The oldest unclaimed occurrence: min ts, then build ascending, then seq
  // ascending — exactly what the scan projection's sort-by-(build,seq) then
  // strict-`<`-reduce produced, now stated as one comparator.
  const oldest = [...facts.unclaimed].sort(
    (a, b) =>
      (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0) || a.build.localeCompare(b.build) || a.seq - b.seq,
  )[0]!
  const mergedBuilds = new Set<string>()
  for (const merge of facts.merges) {
    if (merge.build === oldest.build || merge.ts <= oldest.ts) continue
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

/** Pure two-dimensional Harvest gate. Drift is measured from the oldest
 * unclaimed observation and excludes that observation's own build. */
export function evaluateHarvestPressure(
  scan: Pick<HarvestScanResult, 'observations' | 'merges'>,
  policy: { harvestThreshold: number; harvestMaxDrift: number },
): HarvestPressure {
  return evaluateHarvestPressureFacts(
    {
      unclaimed: scan.observations.map((observation) => ({
        build: observation.occurrence.build,
        seq: observation.occurrence.seq,
        ts: observation.ts,
      })),
      merges: scan.merges,
    },
    policy,
  )
}

/** The same gate from build digests and the repository journal alone
 * (AUT-521): claimedness comes from the journal, unclaimed occurrences and
 * merge facts from the digests — no per-build history reads. The merge facts
 * use each digest's latest `pr.merged` ts; drift counts a build when any of
 * its merges is strictly after the oldest unclaimed observation, and
 * `max(merge.ts) > oldest.ts` is equivalent to `any(merge.ts) > oldest.ts`,
 * so latest-wins carries exactly the drift fact the scan collects. */
export function evaluateHarvestPressureFromDigests(input: {
  digests: Map<string, BuildDigest>
  harvestEvents: RepositoryEvent[]
  policy: { harvestThreshold: number; harvestMaxDrift: number }
}): HarvestPressure {
  const claimed = claimedOccurrenceKeys(reduceHarvest(input.harvestEvents))
  const unclaimed: HarvestPressureFacts['unclaimed'] = []
  const merges: HarvestPressureFacts['merges'] = []
  for (const digest of input.digests.values()) {
    for (const observation of digest.observations) {
      if (claimed.has(occurrenceKey({ build: digest.slug, seq: observation.seq }))) continue
      unclaimed.push({ build: digest.slug, seq: observation.seq, ts: observation.ts })
    }
    if (digest.merged !== undefined) merges.push({ build: digest.slug, ts: digest.merged })
  }
  return evaluateHarvestPressureFacts({ unclaimed, merges }, input.policy)
}

/** The dispatcher harvest-launch gate's read sequence as one named seam
 * (AUT-521): `ensureRepo`, one repo-scoped digest batch read, and the pure
 * digest evaluation with the caller's policy. Per-evaluation cost is one
 * journal read (passed in by the caller, which already holds it) plus one
 * bounded digest read — flat in the number of accumulated finished builds,
 * where the previous scan read every build's full history per evaluation. */
export async function evaluateHarvestPressureFromStore(input: {
  store: BuildStore
  repo: string
  harvestEvents: RepositoryEvent[]
  policy: { harvestThreshold: number; harvestMaxDrift: number }
}): Promise<HarvestPressure> {
  await input.store.ensureRepo(input.repo)
  const digests = await input.store.getRepoBuildDigests(input.repo)
  return evaluateHarvestPressureFromDigests({
    digests,
    harvestEvents: input.harvestEvents,
    policy: input.policy,
  })
}

/** The deterministic core of the unclaimed-observation scan, over
 * already-loaded streams: exactly the reduce/claim/collect/sort the
 * store-reading scan performs, with no store calls. The dashboard consumes
 * this directly with the journal and per-build event arrays it has already
 * fetched (AUT-486), while `scanUnclaimedObservations` keeps the
 * ensure/read/delegate shape its other callers depend on. */
export function collectUnclaimedObservations(input: {
  repo: string
  records: BuildRecord[]
  eventsByBuild: Map<string, AbEvent[]>
  harvestEvents: RepositoryEvent[]
}): HarvestScanResult {
  const state = reduceHarvest(input.harvestEvents)
  const claimed = claimedOccurrenceKeys(state)
  const observations: HarvestObservation[] = []
  const merges: HarvestMerge[] = []

  for (const record of input.records) {
    if (record.repo !== input.repo) continue
    const events = input.eventsByBuild.get(record.slug)
    if (events === undefined) {
      throw new Error(`eventsByBuild is missing an entry for build "${record.slug}"`)
    }
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

/** The unclaimed-observation count from build digests and the repository
 * journal alone (AUT-487): the same reduce/claim/count the store-reading scan
 * performs, with no per-build history reads. The operator query consumes this
 * directly, and the terminal dashboards consume it through
 * `sampleUnclaimedObservationCount` (AUT-524), while `scanUnclaimedObservations`
 * keeps the full-scan shape its remaining callers depend on (the harvest
 * runner's packet scan — the only source of observation payloads — and its
 * gate re-confirmation; the dispatcher's harvest-launch gate itself evaluates
 * from digests, AUT-521). Occurrences are keyed `{build, seq}`; payload ids
 * are not assumed globally unique. */
export function unclaimedObservationCount(input: {
  digests: Map<string, BuildDigest>
  harvestEvents: RepositoryEvent[]
}): number {
  const claimed = claimedOccurrenceKeys(reduceHarvest(input.harvestEvents))
  let count = 0
  for (const digest of input.digests.values()) {
    for (const observation of digest.observations) {
      if (!claimed.has(occurrenceKey({ build: digest.slug, seq: observation.seq }))) count += 1
    }
  }
  return count
}

/** The terminal dashboards' observation-pressure sample (AUT-487): build
 * digests plus the repository journal, reduced to the unclaimed-observation
 * count. Store traffic is flat in the finished-build count — one journal read
 * plus one repo-scoped digest read, plus the journal-record probe below.
 *
 * Missing-record treatment (AUT-524): a repository whose journal record does
 * not yet exist has an empty journal by definition, so the probe answers
 * `[]` instead of letting `getRepoEvents` reject and silently retain a stale
 * count. The sample writes nothing — a display path must not `ensureRepo` —
 * mirroring the operator query's missing-record treatment
 * (operator/query.ts). `scanUnclaimedObservations` keeps its materializing
 * `ensureRepo` for its remaining callers. */
export async function sampleUnclaimedObservationCount(
  store: BuildStore,
  repo: string,
): Promise<number> {
  const [digests, harvestEvents] = await Promise.all([
    store.getRepoBuildDigests(repo),
    // Bounded read (AUT-489): unclaimedObservationCount reduces durable
    // harvest types only, so the subset is replay-equivalent.
    (async () => ((await store.getRepo(repo)) === null ? [] : store.getRepoStateEvents(repo)))(),
  ])
  return unclaimedObservationCount({ digests, harvestEvents })
}

/** Raw structured `observation.recorded` envelopes across this repository.
 * The pair `{build, seq}` is the occurrence key; payload ids are not assumed
 * globally unique. */
export async function scanUnclaimedObservations(
  store: BuildStore,
  repo: string,
): Promise<HarvestScanResult> {
  await store.ensureRepo(repo)
  // Bounded read (AUT-489): only harvest facts are consumed here; the
  // per-build history reads stay as AUT-487 left them.
  const harvestEvents = await store.getRepoStateEvents(repo)
  const records = await store.listBuilds()
  const eventsByBuild = new Map<string, AbEvent[]>()
  for (const record of records) {
    if (record.repo !== repo) continue
    eventsByBuild.set(record.slug, await store.getEvents(record.slug))
  }
  return collectUnclaimedObservations({ repo, records, eventsByBuild, harvestEvents })
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
