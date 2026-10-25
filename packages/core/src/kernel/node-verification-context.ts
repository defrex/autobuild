import { z } from 'zod'
import { commitRangeSchema, ticketRefSchema } from '../ontology'
import type { BuildState } from './reducer'
import { buildTrailers, validateBuildSlug } from './build-identity'
import { originalForeign } from './change-presence'
import { history, nodeInventory, type NodeGit } from './node-restack'
import type { CommitRange, TicketRef } from '../ontology'
import { readBuildFacts } from '../store/reduced-reads'
import type { BuildStore } from '../store/types'

export interface NodeContribution {
  build: string
  ticket: TicketRef
  spec: { kind: 'spec'; rev: number }
  specPath: string
  commits: string[]
}
export interface NodeVerificationIndex {
  range: CommitRange
  handPushedCommits: { sha: string; originalSha: string; message: string }[]
  contributions: NodeContribution[]
  unattributedCommits: string[]
  commits: { sha: string; build?: string }[]
}

/** Reachability, rather than the current child inventory, establishes membership. */
export async function collectNodeVerificationProvenance(
  store: BuildStore,
  repo: string,
  range: CommitRange,
  git: NodeGit,
  ownership: { contributionBase: string; foreignAliases?: Record<string, string> },
): Promise<{ index: NodeVerificationIndex; specs: Map<string, string> }> {
  const index: NodeVerificationIndex = {
    range,
    handPushedCommits: [],
    contributions: [],
    unattributedCommits: [],
    commits: [],
  }
  const owned = new Set((await nodeInventory(git, range.head, ownership.contributionBase)).foreign)
  const aliases = new Map(Object.entries(ownership.foreignAliases ?? {}))
  const specs = new Map<string, string>()
  const byBuild = new Map<string, NodeContribution>()
  for (const commit of await history(
    git,
    [`${range.base}..${range.head}`],
    ['--reverse', '--topo-order'],
  )) {
    if (owned.has(commit.sha))
      index.handPushedCommits.push({
        sha: commit.sha,
        originalSha: originalForeign(commit.sha, aliases),
        message: commit.message,
      })
    const trailers = buildTrailers(commit.message)
    if (trailers.length > 1) throw new Error(`ambiguous build identity on ${commit.sha}`)
    const build = trailers[0]
    if (build === undefined) {
      index.commits.push({ sha: commit.sha })
      index.unattributedCommits.push(commit.sha)
      continue
    }
    try {
      validateBuildSlug(build)
    } catch {
      throw new Error(`invalid build identity on ${commit.sha}: ${JSON.stringify(build)}`)
    }
    let contribution = byBuild.get(build)
    if (contribution === undefined) {
      try {
        const record = await store.getBuild(build)
        if (!record) throw new Error('unknown build')
        if (record.repo !== repo) throw new Error('build belongs to a different repository')
        if (!record.ticket) throw new Error('missing ticket identity')
        const { state } = (await readBuildFacts(store, build)).value
        if (state.specRev === undefined) throw new Error('missing authoritative spec revision')
        const artifact = await store.getArtifact(build, 'spec', state.specRev)
        if (!artifact) throw new Error(`missing spec@${state.specRev}`)
        contribution = {
          build,
          ticket: record.ticket,
          spec: { kind: 'spec', rev: state.specRev },
          specPath: '',
          commits: [],
        }
        byBuild.set(build, contribution)
        index.contributions.push(contribution)
        specs.set(build, new TextDecoder().decode(artifact.content))
      } catch (error) {
        throw new Error(
          `node verification contribution ${build} at ${commit.sha}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    contribution.commits.push(commit.sha)
    index.commits.push({ sha: commit.sha, build })
  }
  return { index, specs }
}

export const NODE_VERIFICATION_CONTEXT = 'node-verification-context'
const sha = z.string().min(1)
const buildIdentity = z.string().refine((value) => {
  try {
    validateBuildSlug(value)
    return true
  } catch {
    return false
  }
}, 'invalid build identity')
const payloadSchema = z.strictObject({
  version: z.literal(1),
  cycle: z.string().min(1),
  range: commitRangeSchema,
  index: z.strictObject({
    range: commitRangeSchema,
    handPushedCommits: z.array(z.strictObject({ sha, originalSha: sha, message: z.string() })),
    contributions: z.array(
      z.strictObject({
        build: buildIdentity,
        ticket: ticketRefSchema,
        spec: z.strictObject({ kind: z.literal('spec'), rev: z.number().int().nonnegative() }),
        specPath: z.literal(''),
        commits: z.array(sha),
      }),
    ),
    unattributedCommits: z.array(sha),
    commits: z.array(z.strictObject({ sha, build: buildIdentity.optional() })),
  }),
  specs: z.record(z.string(), z.string()),
})
export function parseNodeVerificationContext(
  content: string,
  cycle: { id: string; parent: string; head: string },
) {
  const payload = payloadSchema.parse(JSON.parse(content))
  if (
    payload.cycle !== cycle.id ||
    payload.range.base !== cycle.parent ||
    payload.range.head !== cycle.head ||
    payload.index.range.base !== cycle.parent ||
    payload.index.range.head !== cycle.head
  )
    throw new Error('node verification prepared input cycle/range mismatch')
  const builds = payload.index.contributions.map((c) => c.build)
  if (
    new Set(builds).size !== builds.length ||
    Object.keys(payload.specs).length !== builds.length ||
    builds.some((build) => !Object.hasOwn(payload.specs, build))
  )
    throw new Error('node verification prepared input spec membership mismatch')
  const commits = new Map(payload.index.commits.map((c) => [c.sha, c.build]))
  const unattributed = payload.index.commits.filter((c) => c.build === undefined).map((c) => c.sha)
  if (
    new Set(payload.index.unattributedCommits).size !== payload.index.unattributedCommits.length ||
    unattributed.length !== payload.index.unattributedCommits.length ||
    unattributed.some((sha) => !payload.index.unattributedCommits.includes(sha)) ||
    payload.index.contributions.some(
      (c) => c.commits.length === 0 || new Set(c.commits).size !== c.commits.length,
    )
  )
    throw new Error('node verification prepared input commit membership mismatch')

  if (
    commits.size !== payload.index.commits.length ||
    payload.index.contributions.some((c) =>
      c.commits.some((sha) => commits.get(sha) !== c.build),
    ) ||
    payload.index.commits.some(
      (c) =>
        c.build !== undefined &&
        !payload.index.contributions.some(
          (item) => item.build === c.build && item.commits.includes(c.sha),
        ),
    ) ||
    payload.index.unattributedCommits.some(
      (sha) => !commits.has(sha) || commits.get(sha) !== undefined,
    ) ||
    payload.index.handPushedCommits.some((c) => !commits.has(c.sha))
  )
    throw new Error('node verification prepared input commit membership mismatch')
  return { ...payload, index: payload.index as NodeVerificationIndex }
}

/** Called only from repository-authorized preparation, never from a guest. */
export async function prepareNodeVerificationContext(
  store: BuildStore,
  repo: string,
  cycle: { id: string; parent: string; head: string },
  state: Pick<BuildState, 'nodeRestack' | 'nodeOpened'>,
  git: NodeGit,
): Promise<string> {
  const contributionBase =
    state.nodeRestack?.contributionBoundaries?.[cycle.head] ??
    state.nodeRestack?.contributionBase ??
    state.nodeOpened?.sha
  if (!contributionBase)
    throw new Error(
      'node verification is missing its durable contribution boundary; restore node opening evidence',
    )
  const range = { base: cycle.parent, head: cycle.head }
  const { index, specs } = await collectNodeVerificationProvenance(store, repo, range, git, {
    contributionBase,
    foreignAliases: state.nodeRestack?.foreignAliases,
  })
  const content = JSON.stringify({
    version: 1,
    cycle: cycle.id,
    range,
    index,
    specs: Object.fromEntries(specs),
  })
  parseNodeVerificationContext(content, cycle)
  return content
}
