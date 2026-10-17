import { decodeLog } from '../kernel/log-index-value'
/** The consumer boundary for current reductions. Raw event reads are for event output. */
import type { BuildStore } from './types'
import { validateReducerValue } from './reducer-value-validation'
import type {
  buildReadFactsReducer,
  buildStreamSeedReducer,
  repositoryReadFactsReducer,
} from '../kernel/read-facts'
import { publicationStateReducer } from '../processes/publication-state'
import type { SnapshotScope } from './snapshots'

type Reader = Pick<BuildStore, 'getReducerValue'>
export async function readBuildStreamSeed(store: Reader, slug: string) {
  return readValue<ReturnType<typeof buildStreamSeedReducer.finish>>(
    store,
    { kind: 'build', slug },
    'buildStreamSeed',
  )
}
export async function readBuildFacts(store: Reader, slug: string) {
  const result = await readValue<ReturnType<typeof buildReadFactsReducer.finish>>(
    store,
    { kind: 'build', slug },
    'buildReadFacts',
  )
  const value = result.value
  return {
    cursor: result.cursor,
    value: {
      ...value,
      log: decodeLog(value.log),
      publication: publicationStateReducer.finish(value.publication),
    },
  }
}
async function readValue<T>(
  store: Reader,
  scope: SnapshotScope,
  reducer: string,
): Promise<{ cursor: number; value: T }> {
  const result = await store.getReducerValue(scope, { reducer })
  if (!validateReducerValue(reducer, result.value))
    throw new Error(`invalid persisted value for ${reducer}`)
  // The generated validator checks the complete finished contract before decoding.
  return { cursor: result.cursor, value: result.value as T }
}

export type RepositoryReadFacts = ReturnType<typeof repositoryReadFactsReducer.finish>
export async function readRepositoryFacts(
  store: Reader & Pick<BuildStore, 'getRepo'>,
  repo: string,
) {
  let absent = false
  try {
    absent = (await store.getRepo(repo)) === null
  } catch {
    // Lease/record metadata can be unavailable while durable values remain readable.
    return readValue<RepositoryReadFacts>(store, { kind: 'repo', repo }, 'repositoryReadFacts')
  }
  if (!absent)
    return readValue<RepositoryReadFacts>(store, { kind: 'repo', repo }, 'repositoryReadFacts')
  const { repositoryReadFactsReducer } = await import('../kernel/read-facts')
  return {
    cursor: 0,
    value: repositoryReadFactsReducer.finish(repositoryReadFactsReducer.initial()),
  }
}

type Selectors = {
  setupStreak: ReturnType<typeof import('../processes/build-runner').setupStreakReducer.finish>
  baseBranch: ReturnType<
    typeof import('../processes/dispatcher-selectors').baseBranchReducer.finish
  >
  publishedBranchHead: ReturnType<
    typeof import('../processes/build-runner').publishedBranchHeadReducer.finish
  >
  verifyDiffBase: ReturnType<
    typeof import('../processes/build-runner').verifyDiffBaseReducer.finish
  >
  recordedBaseSha: ReturnType<
    typeof import('../config/pipeline-source').recordedBaseShaReducer.finish
  >
}
export async function readBuildSelector<N extends keyof Selectors>(
  store: Reader,
  slug: string,
  name: N,
): Promise<Selectors[N]> {
  if (name === 'setupStreak')
    return (await readValue<Selectors[N]>(store, { kind: 'build', slug }, name)).value
  return (await readValue<{ value?: Selectors[N] }>(store, { kind: 'build', slug }, `${name}Value`))
    .value.value as Selectors[N]
}

export async function readPhaseFailures(
  store: Reader,
  slug: string,
  phase: import('../ontology').Phase,
  round: number,
) {
  const result = await store.getReducerValue(
    { kind: 'build', slug },
    { reducer: 'phaseFailures', args: { phase, round } },
  )
  if (!validateReducerValue('phaseFailures', result.value))
    throw new Error('invalid phaseFailures value')
  return result.value as unknown as ReturnType<
    ReturnType<typeof import('../processes/build-runner').phaseFailuresReducer>['finish']
  >
}

export async function readDispatchBudget(
  store: Reader,
  slug: string,
  infrastructureOwnsWorkspace: boolean,
) {
  const result = await store.getReducerValue(
    { kind: 'build', slug },
    { reducer: 'dispatchFailureBudget', args: { infrastructureOwnsWorkspace } },
  )
  if (!validateReducerValue('dispatchFailureBudget', result.value))
    throw new Error('invalid dispatchFailureBudget value')
  return {
    cursor: result.cursor,
    value: result.value as unknown as ReturnType<
      ReturnType<
        typeof import('../processes/dispatch-failure-budget').dispatchFailureBudgetReducer
      >['finish']
    >,
  }
}

export async function readDeferralLedger(store: Reader, slug: string) {
  return readValue<import('../kernel/auto-merge').DeferralLedger>(
    store,
    { kind: 'build', slug },
    'currentDeferralObservation',
  )
}

export async function readRepositoryAttention(store: Reader, repo: string) {
  return readValue<import('../kernel/repository-attention').RepositoryAttentionState>(
    store,
    { kind: 'repo', repo },
    'repositoryAttention',
  )
}

export type CurrentBuildFacts = Awaited<ReturnType<typeof readBuildFacts>>['value']

export async function readTerminalGuard(
  store: Reader,
  slug: string,
  phase: import('../ontology').Phase,
  round: number,
  session: string,
) {
  const result = await store.getReducerValue(
    { kind: 'build', slug },
    { reducer: 'terminalGuard', args: { phase, round, session } },
  )
  if (!validateReducerValue('terminalGuard', result.value))
    throw new Error('invalid terminalGuard value')
  return result.value as { diagnostic?: string }
}

export async function readOpenTick(store: Reader, repo: string, run: string) {
  const result = await store.getReducerValue(
    { kind: 'repo', repo },
    { reducer: 'openTick', args: { run } },
  )
  if (typeof result.value !== 'boolean') throw new Error('invalid openTick value')
  return result.value
}
export async function readPinnedAssets(store: Reader, slug: string) {
  return readValue<ReturnType<typeof import('./ticket-assets').pinnedAssetsReducer.finish>>(
    store,
    { kind: 'build', slug },
    'pinnedAssets',
  )
}

/** Digests are reductions too. Read persisted per-build digests so repeated
 * discovery never transfers all historical digest-relevant event rows. */
export async function readPersistedBuildDigests(
  store: Reader & Pick<BuildStore, 'listBuilds'>,
  repo: string,
  records?: import('./types').BuildRecord[],
) {
  const output = new Map<string, import('./types').BuildDigest>()
  for (const record of records ?? (await store.listBuilds())) {
    if (record.repo !== repo) continue
    const result = await readValue<ReturnType<typeof import('./digest').buildDigestReducer.finish>>(
      store,
      { kind: 'build', slug: record.slug },
      'buildDigest',
    )
    output.set(record.slug, { slug: record.slug, ...result.value })
  }
  return output
}

/** Keep the batch boundary for hosted callers; adapter implementations use
 * readPersistedBuildDigests so each digest still comes from a persisted value. */
export function readBuildDigests(store: Pick<BuildStore, 'getRepoBuildDigests'>, repo: string) {
  return store.getRepoBuildDigests(repo)
}
