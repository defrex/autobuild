/**
 * Store decorators that inject deterministic failures. Nothing here involves
 * timing: a decorator fails one named operation and delegates the rest, so a
 * test can pin exactly what a surviving PREFIX of a multi-write action leaves
 * behind — which is the whole reason write ORDER is load-bearing in actions
 * the store cannot make atomic.
 *
 * Production code never imports from `src/testing/`.
 */
import type {
  RepositoryEventEnvelope,
  RepositoryEventType,
  RepositoryEventWrite,
} from '../events/repository'
import type { BuildStore } from '../store/types'

/**
 * Fail every `appendRepo` of one repository event type; delegate everything
 * else to `store`. The `Object.create` idiom keeps the decorator a real
 * `BuildStore` without restating the port.
 */
export function withFailingRepoAppend(store: BuildStore, failOn: RepositoryEventType): BuildStore {
  const proxy = Object.create(store) as BuildStore
  proxy.appendRepo = async <T extends RepositoryEventType>(
    repo: string,
    event: RepositoryEventWrite<T>,
  ): Promise<RepositoryEventEnvelope<T>> => {
    if (event.type === failOn) throw new Error(`store failure writing ${failOn}`)
    return store.appendRepo(repo, event)
  }
  return proxy
}
