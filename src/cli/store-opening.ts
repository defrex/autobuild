/**
 * Production BuildStore composition for CLI commands.
 *
 * `repo-state.ts` owns repository identity and reference precedence, while
 * `store-ref.ts` remains the adapter-free local-vs-remote parser. This module
 * joins those seams to the production remote adapter and owns finite-command
 * store lifecycle.
 */
import type { Exec } from '../ports/workspace/git-worktree'
import { RemoteBuildStore } from '../store/remote/client'
import type { BuildStore } from '../store/types'
import {
  resolveRepoState,
  type RepoStatePaths,
} from './repo-state'
import { resolveStore } from './store-ref'

/** Shared injection seam used by every command that opens a BuildStore. */
export type StoreOpener = (ref: string, token?: string) => BuildStore

function optionalToken(value: string | undefined): string | undefined {
  // Bearer credentials are opaque. Only absence and the exact empty value mean
  // "no token"; nonempty values are forwarded byte-for-byte.
  return value !== undefined && value !== '' ? value : undefined
}

/** Production local/remote composition. The low-level parser stays injectable
 * and does not import the HTTP adapter. */
export const openProductionStore: StoreOpener = (ref, token) => {
  const forwardedToken = optionalToken(token)
  return resolveStore(ref, {
    remoteFactory: (url, remoteToken) =>
      new RemoteBuildStore({ url, token: remoteToken }),
    ...(forwardedToken !== undefined ? { token: forwardedToken } : {}),
  })
}

export interface OpenedStoreContext extends RepoStatePaths {
  store: BuildStore
  token?: string
}

export interface OpenStoreForRepoStateOpts {
  env: Record<string, string | undefined>
  openStore?: StoreOpener
}

/** Open from an already canonicalized state selection. Dispatch uses this form
 * so repository topology and relative overrides are decided exactly once. */
export function openStoreForRepoState(
  state: RepoStatePaths,
  opts: OpenStoreForRepoStateOpts,
): OpenedStoreContext {
  const token = optionalToken(opts.env['AB_TOKEN'])
  const store = (opts.openStore ?? openProductionStore)(state.storeRef, token)
  return {
    ...state,
    store,
    ...(token !== undefined ? { token } : {}),
  }
}

export interface SessionlessStoreOpts extends OpenStoreForRepoStateOpts {
  targetRepo: string
  exec: Exec
  /** Explicit --store; precedence is applied by repo-state.ts. */
  storeRef?: string
}

/** Resolve the main checkout and sessionless reference precedence, then open
 * the selected production or injected store. The caller owns the handle. */
export async function openSessionlessStore(
  opts: SessionlessStoreOpts,
): Promise<OpenedStoreContext> {
  const state = await resolveRepoState({
    targetRepo: opts.targetRepo,
    exec: opts.exec,
    ...(opts.storeRef !== undefined ? { storeRef: opts.storeRef } : {}),
    ...(opts.env['AB_STORE'] !== undefined
      ? { envStore: opts.env['AB_STORE'] }
      : {}),
  })
  return openStoreForRepoState(state, opts)
}

/** Finite command ownership boundary. Opening failures occur before the
 * try/finally, so only a successfully returned handle is ever closed. */
export async function withSessionlessStore<T>(
  opts: SessionlessStoreOpts,
  use: (context: OpenedStoreContext) => Promise<T> | T,
): Promise<T> {
  const context = await openSessionlessStore(opts)
  try {
    return await use(context)
  } finally {
    await context.store.close()
  }
}
