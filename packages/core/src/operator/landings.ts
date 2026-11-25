import {
  BUILD_EFFECTIVE_CONFIG_ARTIFACT,
  parseEffectiveBuildConfig,
} from '../processes/build-execution-state'
import type { RepoViewStore } from '../processes/repo-view'
import type { CurrentBuildFacts } from '../store/reduced-reads'
import type { BuildRecord, BuildStore } from '../store/types'
import { withOperatorView } from './read-view'
import { projectTree, type ConsentQueueEntry } from '../cli/dashboard/tree'

/** One open build's consent-queue entry, or null when it awaits no consent.
 * Reads the pinned effective-config artifact only for a build with a landing
 * decision. */
export async function consentEntryFromView(
  view: RepoViewStore,
  record: BuildRecord,
  facts: CurrentBuildFacts,
): Promise<ConsentQueueEntry | null> {
  const artifact = facts.state.landing?.decision
    ? await view.getArtifact(
        record.slug,
        facts.state.verify.configPin?.artifact.kind ?? BUILD_EFFECTIVE_CONFIG_ARTIFACT,
        facts.state.verify.configPin?.artifact.rev,
      )
    : null
  const expected = artifact ? parseEffectiveBuildConfig(artifact).verify.steps : undefined
  const tree = projectTree(record, facts.state, facts.log.restack, expected)
  return tree.consent ? { slug: record.slug, ...tree } : null
}

/** Stored readiness only; land reobserves live completeness at its mutation boundary. */
export async function listOperatorLandings(opts: {
  store: BuildStore
  repo: string
}): Promise<ConsentQueueEntry[]> {
  return withOperatorView(opts.store, opts.repo, 'builds', async (view) => {
    const entries: ConsentQueueEntry[] = []
    // Only nonterminal builds can await consent; the open listing never
    // reads a settled build.
    for (const { record, digest } of await view.listOpenBuilds(opts.repo)) {
      if (record.repo !== opts.repo) continue
      if (digest.terminal !== undefined) continue
      const entry = await consentEntryFromView(view, record, await view.buildFacts(record.slug))
      if (entry) entries.push(entry)
    }
    return entries.sort((a, b) => a.slug.localeCompare(b.slug))
  })
}
