import { createHash } from 'node:crypto'
import type { TicketRef } from '../ontology'
import type { BuildRecord, BuildDigest } from '../store/types'
import type { CurrentBuildFacts } from '../store/reduced-reads'
import type { BuildState } from './reducer'
import type { NodeGit } from './node-restack'
import { history } from './node-restack'
import { buildTrailers } from './build-identity'

export type ChangeIdentity = `build:${string}` | `foreign:${string}`
export const normalizeIdentities = (ids: Iterable<ChangeIdentity>): ChangeIdentity[] =>
  [...new Set(ids)].sort()
export interface PresenceBuild {
  record: BuildRecord
  digest: BuildDigest
}
/** A tied newest generation is an error, never an invitation to fall back. */
export function blockerBuild(
  entries: PresenceBuild[],
  source: string,
  id: string,
  identity: (ref: TicketRef, build?: string) => string = (ref) =>
    JSON.stringify([ref.source, ref.id]),
): PresenceBuild | string | undefined {
  const generations = entries
    .filter(
      ({ record }) =>
        record.ticket && identity(record.ticket, record.slug) === identity({ source, id }),
    )
    .sort(
      (a, b) =>
        b.record.createdAt.localeCompare(a.record.createdAt) ||
        b.record.slug.localeCompare(a.record.slug),
    )
  if (generations[0] && generations[1]?.record.createdAt === generations[0].record.createdAt)
    return `blocker ${id} has ambiguous build generations at ${generations[0].record.createdAt}`
  return generations[0]
}
export function missingChanges(
  required: readonly ChangeIdentity[],
  present: readonly string[],
): ChangeIdentity[] {
  const available = new Set(present)
  return required.filter((id) => !available.has(id))
}

export function originalForeign(sha: string, aliases: Map<string, string>): string {
  const seen = new Set<string>()
  while (aliases.has(sha) && aliases.get(sha) !== sha) {
    if (seen.has(sha)) throw new Error('cyclic foreign identity evidence')
    seen.add(sha)
    sha = aliases.get(sha)!
  }
  return sha
}

export interface LandingEvidence {
  slug: string
  sha: string
  /** A node landing transports its completed owned contribution. */
  contribution?: ChangeIdentity[]
}
/** Stable identities and confirmed foreign replay aliases survive node rewrites.
 * Expand transported contributions transitively, including older manifests
 * that retained a nested node identity rather than its leaf identities. */
function expandLandings(
  identities: ChangeIdentity[],
  proofs: ChangeIdentity[],
  landings: LandingEvidence[],
): ChangeIdentity[] {
  const byIdentity = new Map<ChangeIdentity, LandingEvidence[]>()
  for (const landing of landings) {
    for (const key of [`build:${landing.slug}`, `foreign:${landing.sha}`] as ChangeIdentity[]) {
      const proofs = byIdentity.get(key) ?? []
      proofs.push(landing)
      byIdentity.set(key, proofs)
    }
  }
  const result = new Set(identities)
  const visited = new Set<ChangeIdentity>()
  const pending = [...identities, ...proofs]
  while (pending.length) {
    const identity = pending.pop()!
    if (visited.has(identity)) continue
    visited.add(identity)
    for (const landing of byIdentity.get(identity) ?? []) {
      const transported = landing.contribution ?? [`build:${landing.slug}` as const]
      for (const item of transported) {
        result.add(item)
        pending.push(item)
      }
    }
  }
  return normalizeIdentities(result)
}

/** Exact Git ancestry plus confirmed landing facts handles trailerless squash
 * commits. No optimistic writer intent or source lifecycle is consulted. */
export async function observePresence(
  git: NodeGit,
  head: string,
  landings: LandingEvidence[],
  aliases = new Map<string, string>(),
  includeForeign = false,
): Promise<ChangeIdentity[]> {
  return projectPresence(await presenceWitness(git, head), landings, aliases, includeForeign)
}

/** Full reachable history of a sampled head. In-memory only: it is the
 * compaction source for a {@link PresenceProbe} and is never persisted. Older
 * observations may still carry one as historical evidence. */
export interface PresenceWitness {
  version: 1
  commits: string[]
  identities: `build:${string}`[]
}

export async function presenceWitness(git: NodeGit, head: string): Promise<PresenceWitness> {
  const commits = await history(git, [head])
  return {
    version: 1,
    commits: [...new Set(commits.map((commit) => commit.sha))].sort(),
    identities: [
      ...new Set(
        commits.flatMap((commit) =>
          buildTrailers(commit.message).map((slug) => `build:${slug}` as const),
        ),
      ),
    ].sort(),
  }
}

/** Durable, query-scoped presence evidence for one sampled head. It records
 * only the SHAs and direct trailers in the reverse proof closure of
 * `questions`, so its size never depends on the destination's reachable
 * commit count, unrelated landings, or repository history. */
export interface PresenceProbe {
  version: 1
  /** Sorted unique identities this observation answers. */
  questions: ChangeIdentity[]
  /** Sorted unique SHAs whose reachability from head was tested. */
  commits: string[]
  /** Sorted subset of `commits` reachable from head. */
  reachable: string[]
  /** Sorted build identities whose direct trailer was tested. */
  builds: `build:${string}`[]
  /** Sorted subset of `builds` found as trailers in head's history. */
  trailers: `build:${string}`[]
}
export interface PresenceNeeds {
  commits: string[]
  builds: `build:${string}`[]
}

const transportedBy = (landing: LandingEvidence): ChangeIdentity[] =>
  landing.contribution ?? [`build:${landing.slug}`]

/** The reverse proof closure of `query`: every SHA and direct trailer whose
 * reachability could derive a queried identity. A landing enters only when it
 * transports a closure identity, and contributes only its own two keys. */
export function presenceNeeds(
  query: Iterable<ChangeIdentity>,
  landings: LandingEvidence[],
  aliases: Map<string, string>,
): PresenceNeeds {
  const transporters = new Map<ChangeIdentity, LandingEvidence[]>()
  for (const landing of landings)
    for (const item of new Set(transportedBy(landing))) {
      const entries = transporters.get(item) ?? []
      entries.push(landing)
      transporters.set(item, entries)
    }
  const keysOf = new Map<string, string[]>()
  for (const key of aliases.keys()) {
    const original = originalForeign(key, aliases)
    const keys = keysOf.get(original) ?? []
    keys.push(key)
    keysOf.set(original, keys)
  }
  const commits = new Set<string>()
  const builds = new Set<`build:${string}`>()
  const visited = new Set<ChangeIdentity>()
  const pending = [...query]
  while (pending.length) {
    const identity = pending.pop()!
    if (visited.has(identity)) continue
    visited.add(identity)
    if (identity.startsWith('build:')) builds.add(identity as `build:${string}`)
    else {
      const sha = identity.slice('foreign:'.length)
      commits.add(sha)
      for (const key of keysOf.get(sha) ?? []) commits.add(key)
    }
    for (const landing of transporters.get(identity) ?? [])
      pending.push(`build:${landing.slug}`, `foreign:${landing.sha}`)
  }
  return { commits: [...commits].sort(), builds: [...builds].sort() }
}

export function covers(probe: PresenceProbe, needs: PresenceNeeds): boolean {
  const commits = new Set(probe.commits)
  const builds = new Set(probe.builds)
  return (
    needs.commits.every((sha) => commits.has(sha)) && needs.builds.every((id) => builds.has(id))
  )
}

/** Whether a stored probe can answer `query` under the current landings. The
 * needs of every stored question must be covered, because the persisted
 * answers are recomputed for all of them. */
export function answers(
  probe: PresenceProbe,
  query: Iterable<ChangeIdentity>,
  landings: LandingEvidence[],
  aliases: Map<string, string>,
): boolean {
  const questions = new Set(probe.questions)
  for (const id of query) if (!questions.has(id)) return false
  return covers(probe, presenceNeeds(probe.questions, landings, aliases))
}

export function compactProbe(
  witness: PresenceWitness,
  questions: Iterable<ChangeIdentity>,
  landings: LandingEvidence[],
  aliases: Map<string, string>,
): PresenceProbe {
  const normalized = normalizeIdentities(questions)
  const needs = presenceNeeds(normalized, landings, aliases)
  const reachable = new Set(witness.commits)
  const trailers = new Set(witness.identities)
  return {
    version: 1,
    questions: normalized,
    commits: needs.commits,
    reachable: needs.commits.filter((sha) => reachable.has(sha)),
    builds: needs.builds,
    trailers: needs.builds.filter((id) => trailers.has(id)),
  }
}

/** Presence answers for only the probe's questions. The unrestricted
 * expansion is local: it is never returned, persisted, or hashed. */
export function projectProbe(
  probe: PresenceProbe,
  landings: LandingEvidence[],
  aliases = new Map<string, string>(),
): ChangeIdentity[] {
  const present = new Set(
    projectPresence(
      { version: 1, commits: probe.reachable, identities: probe.trailers },
      landings,
      aliases,
    ),
  )
  return normalizeIdentities(probe.questions.filter((id) => present.has(id)))
}

export function probeEvidence(probe: PresenceProbe, identities: ChangeIdentity[]): string {
  const sorted = <T extends string>(items: Iterable<T>) => [...new Set(items)].sort()
  return `presence-v4:${createHash('sha256')
    .update(
      JSON.stringify([
        probe.version,
        sorted(probe.questions),
        sorted(probe.commits),
        sorted(probe.reachable),
        sorted(probe.builds),
        sorted(probe.trailers),
        sorted(identities),
      ]),
    )
    .digest('hex')}`
}

export function projectPresence(
  witness: PresenceWitness,
  landings: LandingEvidence[],
  aliases = new Map<string, string>(),
  includeForeign = false,
): ChangeIdentity[] {
  const proofs: ChangeIdentity[] = []
  const result: ChangeIdentity[] = [...witness.identities]
  const relevantForeign = new Set(
    landings
      .flatMap((landing) => landing.contribution ?? [])
      .filter((id) => id.startsWith('foreign:')),
  )
  for (const sha of witness.commits) {
    const foreign: ChangeIdentity = `foreign:${originalForeign(sha, aliases)}`
    proofs.push(foreign, `foreign:${sha}`)
    if (includeForeign || aliases.has(sha) || relevantForeign.has(foreign)) result.push(foreign)
  }
  return expandLandings(result, proofs, landings)
}

/** Only aliases belonging to this destination's accepted ancestry are relevant. */
export function destinationAliases(
  inputs: PresenceInputs,
  destination?: string,
): Map<string, string> {
  const aliases = new Map<string, string>()
  const seen = new Set<string>()
  while (destination) {
    if (seen.has(destination)) throw new Error('cyclic destination ancestry')
    seen.add(destination)
    const state = inputs.states.get(destination)
    if (!state) throw new Error('missing destination ancestry')
    for (const [sha, original] of Object.entries(state.nodeRestack?.foreignAliases ?? {}))
      aliases.set(sha, original)
    destination = state.target?.build
  }
  return aliases
}

/** Reconstruct a historical node contribution only from its retained source
 * range. The caller must establish the source head and confirmed landing. */
export async function ownedContribution(
  git: NodeGit,
  base: string,
  head: string,
  landings: LandingEvidence[],
  aliases: Map<string, string>,
): Promise<ChangeIdentity[]> {
  const check = await git.exec(['git', 'merge-base', '--is-ancestor', base, head], {
    cwd: git.workspacePath,
  })
  if (check.exitCode !== 0) throw new Error('cannot establish node contribution boundary')
  const commits = await history(git, [`${base}..${head}`], ['--first-parent'])
  const proofs: ChangeIdentity[] = []
  const result: ChangeIdentity[] = []
  for (const commit of commits) {
    const trailers = buildTrailers(commit.message)
    if (trailers.length > 1) throw new Error('ambiguous node contribution identity')
    if (trailers.length === 1) result.push(`build:${trailers[0]!}`)
    else result.push(`foreign:${originalForeign(commit.sha, aliases)}`)
    proofs.push(`foreign:${commit.sha}`, `foreign:${originalForeign(commit.sha, aliases)}`)
  }
  return expandLandings(result, proofs, landings)
}

export interface PresenceInputs {
  entries: PresenceBuild[]
  states: Map<string, BuildState>
  aliases: Map<string, string>
  landings: LandingEvidence[]
}
/** Read full state only for the destinations whose histories are inspected.
 * Confirmed landing/contribution evidence comes from the batched digest read. */
export async function presenceInputs(
  store: { buildFacts(slug: string): Promise<CurrentBuildFacts> },
  entries: PresenceBuild[],
  destinations: Iterable<string> = [],
  landings = confirmedLandings(entries),
): Promise<PresenceInputs> {
  const states = new Map<string, BuildState>()
  const aliases = new Map<string, string>()
  const pending = [...destinations]
  while (pending.length) {
    const slug = pending.pop()!
    if (states.has(slug)) continue
    const state = (await store.buildFacts(slug)).state
    states.set(slug, state)
    for (const [sha, original] of Object.entries(state.nodeRestack?.foreignAliases ?? {}))
      aliases.set(sha, original)
    if (state.target) pending.push(state.target.build)
  }
  return { entries, states, aliases, landings }
}

/** Shared once per dispatcher tick from the existing batched digest read. */
export function confirmedLandings(entries: PresenceBuild[]): LandingEvidence[] {
  const landings: LandingEvidence[] = []
  for (const { record, digest } of entries) {
    if (!digest.mergedSha || digest.terminal === 'aborted' || digest.prClosed) continue
    if (digest.kind === 'node') {
      if (digest.nodeContribution?.landing === digest.mergedSha)
        landings.push({
          slug: record.slug,
          sha: digest.mergedSha,
          contribution: digest.nodeContribution.identities as ChangeIdentity[],
        })
    } else landings.push({ slug: record.slug, sha: digest.mergedSha })
  }
  return landings
}
