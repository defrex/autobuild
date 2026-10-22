import { buildTrailers, validateBuildSlug } from '../kernel/build-identity'
import { history, type NodeGit } from '../kernel/node-restack'
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
): Promise<{ index: NodeVerificationIndex; specs: Map<string, string> }> {
  const index: NodeVerificationIndex = {
    range,
    contributions: [],
    unattributedCommits: [],
    commits: [],
  }
  const specs = new Map<string, string>()
  const byBuild = new Map<string, NodeContribution>()
  for (const commit of await history(
    git,
    [`${range.base}..${range.head}`],
    ['--reverse', '--topo-order'],
  )) {
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
