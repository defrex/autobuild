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
): PresenceBuild | string | undefined {
  const generations = entries
    .filter(({ record }) => record.ticket?.source === source && record.ticket.id === id)
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

function originalForeign(sha: string, aliases: Map<string, string>): string {
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
/** Exact Git ancestry plus confirmed landing facts handles trailerless squash
 * commits. No optimistic writer intent or source lifecycle is consulted. */
export async function observePresence(
  git: NodeGit,
  head: string,
  landings: LandingEvidence[],
  aliases = new Map<string, string>(),
): Promise<ChangeIdentity[]> {
  const commits = await history(git, [head])
  const reachable = new Set(commits.map((commit) => commit.sha))
  const result: ChangeIdentity[] = []
  const relevantForeign = new Set(
    landings
      .flatMap((landing) => landing.contribution ?? [])
      .filter((id) => id.startsWith('foreign:')),
  )
  for (const commit of commits) {
    for (const build of buildTrailers(commit.message)) result.push(`build:${build}`)
    const foreign: ChangeIdentity = `foreign:${originalForeign(commit.sha, aliases)}`
    if (aliases.has(commit.sha) || relevantForeign.has(foreign)) result.push(foreign)
  }
  for (const landing of landings) {
    if (!reachable.has(landing.sha)) continue
    result.push(...(landing.contribution ?? [`build:${landing.slug}` as const]))
  }
  return normalizeIdentities(result)
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
  const owned = new Set(commits.map((commit) => commit.sha))
  const result: ChangeIdentity[] = []
  for (const commit of commits) {
    const trailers = buildTrailers(commit.message)
    if (trailers.length > 1) throw new Error('ambiguous node contribution identity')
    if (trailers.length === 1) result.push(`build:${trailers[0]!}`)
    else result.push(`foreign:${originalForeign(commit.sha, aliases)}`)
  }
  for (const landing of landings) {
    if (!owned.has(landing.sha)) continue
    result.push(...(landing.contribution ?? [`build:${landing.slug}` as const]))
  }
  return normalizeIdentities(result)
}

export interface PresenceInputs {
  entries: PresenceBuild[]
  states: Map<string, BuildState>
  aliases: Map<string, string>
  landings: LandingEvidence[]
}
/** One repository batch, never a full-log read per dependent. */
export async function presenceInputs(
  store: { buildFacts(slug: string): Promise<CurrentBuildFacts> },
  entries: PresenceBuild[],
): Promise<PresenceInputs> {
  const states = new Map<string, BuildState>()
  const aliases = new Map<string, string>()
  for (const entry of entries) {
    if (entry.digest.kind !== 'node' && !entry.digest.merged) continue
    const state = (await store.buildFacts(entry.record.slug)).state
    states.set(entry.record.slug, state)
    if (entry.digest.kind === 'node')
      for (const [sha, original] of Object.entries(state.nodeRestack?.foreignAliases ?? {}))
        aliases.set(sha, original)
  }
  const landings: LandingEvidence[] = []
  for (const [slug, state] of states) {
    if (state.mergedSha && state.prState === 'merged' && state.status !== 'aborted') {
      if (state.kind === 'node') {
        const contribution = state.nodeRestack?.contribution
        if (contribution?.landing === state.mergedSha)
          landings.push({
            slug,
            sha: state.mergedSha,
            contribution: contribution.identities as ChangeIdentity[],
          })
      } else landings.push({ slug, sha: state.mergedSha })
    }
  }
  return { entries, states, aliases, landings }
}
