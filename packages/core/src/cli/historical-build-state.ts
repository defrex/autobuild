import type { BuildStore } from '../store/types'
import { buildStreamSeedReducer, type BuildStreamSeed } from '../kernel/read-facts'

/** Only explicit old --since cursors need historical reconstruction. Ordinary
 * registration and the first event batch must use the persisted seed. */
export async function historicalBuildState(
  store: BuildStore,
  slug: string,
  requested: number,
  current: { cursor: number; value: BuildStreamSeed },
) {
  if (requested >= current.cursor) return current.value
  const events = await store.getEvents(slug)
  return buildStreamSeedReducer.reduce(events.filter((event) => event.seq <= requested))
}

import { repositoryAttentionReducer } from '../kernel/repository-attention'
export async function historicalRepositoryAttention(
  store: BuildStore,
  repo: string,
  requested: number,
  current: { cursor: number; value: ReturnType<typeof repositoryAttentionReducer.finish> },
) {
  if (requested >= current.cursor) return current.value
  const events = await store.getRepoEvents(repo)
  return repositoryAttentionReducer.reduce(events.filter((event) => event.seq <= requested))
}
