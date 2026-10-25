import {
  BUILD_EFFECTIVE_CONFIG_ARTIFACT,
  parseEffectiveBuildConfig,
} from '../processes/build-execution-state'
import type { BuildStore } from '../store/types'
import { readBuildDigests } from '../store/reduced-reads'
import { withOperatorView } from './read-view'
import { projectTree, type ConsentQueueEntry } from '../cli/dashboard/tree'

/** Stored readiness only; land reobserves live completeness at its mutation boundary. */
export async function listOperatorLandings(opts: {
  store: BuildStore
  repo: string
}): Promise<ConsentQueueEntry[]> {
  return withOperatorView(opts.store, opts.repo, 'builds', async (view) => {
    const records = await view.listBuilds()
    const digests = await readBuildDigests(view, opts.repo)
    const entries: ConsentQueueEntry[] = []
    for (const record of records) {
      if (record.repo !== opts.repo) continue
      const digest = digests.get(record.slug)
      if (!digest)
        throw new Error(`getRepoBuildDigests is missing an entry for build "${record.slug}"`)
      if (digest.terminal !== undefined) continue
      const facts = await view.buildFacts(record.slug)
      const artifact = facts.state.landing?.decision
        ? await view.getArtifact(
            record.slug,
            facts.state.verify.configPin?.artifact.kind ?? BUILD_EFFECTIVE_CONFIG_ARTIFACT,
            facts.state.verify.configPin?.artifact.rev,
          )
        : null
      const expected = artifact ? parseEffectiveBuildConfig(artifact).verify.steps : undefined
      const tree = projectTree(record, facts.state, facts.log.restack, expected)
      if (tree.consent) entries.push({ slug: record.slug, ...tree })
    }
    return entries.sort((a, b) => a.slug.localeCompare(b.slug))
  })
}
