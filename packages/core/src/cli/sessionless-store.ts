/**
 * `openSessionlessStore` for callers that must not evaluate the remote adapter
 * for a local reference. This is the only light-path module that resolves
 * repository state (and with it configuration), so readers that already know
 * their journal never load it.
 */
import { resolveRepoState } from './repo-state'
import {
  openStoreForRepoStateWith,
  productionOpenerFor,
  type OpenedStoreContext,
} from './production-store'
import type { SessionlessStoreOpts } from './store-opening'

export async function openSessionlessStoreLazily(
  opts: SessionlessStoreOpts,
): Promise<OpenedStoreContext> {
  const state = await resolveRepoState({
    targetRepo: opts.targetRepo,
    exec: opts.exec,
    ...(opts.storeRef !== undefined ? { storeRef: opts.storeRef } : {}),
    ...(opts.env.AB_STORE !== undefined ? { envStore: opts.env.AB_STORE } : {}),
  })
  const opener = opts.openStore ?? (await productionOpenerFor(state.storeRef))
  return openStoreForRepoStateWith(state, opts, opener)
}
