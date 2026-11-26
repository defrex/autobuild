/**
 * The adapter-free half of production store composition. A local reference
 * never evaluates the remote HTTP adapter or repository configuration: the
 * remote client loads only when `openProductionStoreAsync` opens an http(s)
 * reference, and repository-state resolution lives in `store-opening.ts` and
 * `sessionless-store.ts`. `store-opening.ts` re-exposes all of this with its
 * eager remote factory, so its exports and behavior are unchanged.
 */
import { AccountRedactor, redactAccountStore } from '../store/account-redaction'
import type { BuildStore } from '../store/types'
import { InvalidAmbientContextError } from './ambient-errors'
import { projectToken } from './project-credentials'
import type { RepoStatePaths } from './repo-state'
import { isRemoteStoreRef, resolveStore, type ResolveStoreOpts } from './store-ref'

/** Shared injection seam used by every command that opens a BuildStore. */
export type StoreOpener = (ref: string, token?: string) => BuildStore

export function optionalToken(value: string | undefined): string | undefined {
  // Bearer credentials are opaque. Only absence and the exact empty value mean
  // "no token"; nonempty values are forwarded byte-for-byte.
  return value !== undefined && value !== '' ? value : undefined
}

/** Production local/remote composition over a supplied remote factory. */
export function composeProductionStore(
  ref: string,
  token: string | undefined,
  remoteFactory?: ResolveStoreOpts['remoteFactory'],
): BuildStore {
  const forwardedToken = optionalToken(token)
  const store = resolveStore(ref, {
    ...(remoteFactory ? { remoteFactory } : {}),
    ...(forwardedToken !== undefined ? { token: forwardedToken } : {}),
  })
  const raw = process.env.AB_ACCOUNT_CREDENTIAL_ENVS
  if (!raw) return store
  const names: unknown = JSON.parse(raw)
  if (!Array.isArray(names) || !names.every((name) => typeof name === 'string'))
    throw new Error('Invalid account credential variable inventory')
  return redactAccountStore(
    store,
    new AccountRedactor(() => names.map((name) => process.env[name])),
  )
}

/** The production remote factory, loaded with the remote adapter. */
export async function loadRemoteFactory(): Promise<NonNullable<ResolveStoreOpts['remoteFactory']>> {
  const { RemoteBuildStore } = await import('../store/remote/client')
  return (url, remoteToken) => new RemoteBuildStore({ url, token: remoteToken })
}

/** The production opener for `ref`: the remote adapter loads only for an
 * http(s) reference. */
export async function productionOpenerFor(ref: string): Promise<StoreOpener> {
  const remoteFactory = isRemoteStoreRef(ref) ? await loadRemoteFactory() : undefined
  return (selected, token) => composeProductionStore(selected, token, remoteFactory)
}

/** `openProductionStore` without loading the remote adapter for a local ref. */
export async function openProductionStoreAsync(ref: string, token?: string): Promise<BuildStore> {
  return (await productionOpenerFor(ref))(ref, token)
}

export interface OpenStoreForRepoStateOpts {
  env: Record<string, string | undefined>
  openStore?: StoreOpener
  useProjectCredential?: boolean
}

export interface OpenedStoreContext extends RepoStatePaths {
  store: BuildStore
  token?: string
  /** The validated ambient phase/Harvest identity this invocation carries, if
   * any — the same value that scoped `store`. Exposed for commands whose
   * repository selection also depends on ambient own-build authority. */
  ambient?: import('./env').AmbientReadSession
}

/** Open from an already canonicalized state selection with `opener`. */
export function openStoreForRepoStateWith(
  state: RepoStatePaths,
  opts: OpenStoreForRepoStateOpts,
  opener: StoreOpener,
): OpenedStoreContext {
  // A judge session's only store authority is its one preference.
  if (opts.env.AB_JUDGE !== undefined)
    throw new InvalidAmbientContextError('a judge session has no read authority')
  const token =
    opts.useProjectCredential !== false && isRemoteStoreRef(state.storeRef)
      ? projectToken(state.storeRef, state.repo, opts.env)
      : optionalToken(opts.env.AB_TOKEN)
  if (!token && isRemoteStoreRef(state.storeRef) && state.configStore === state.storeRef) {
    throw new Error('No project credential for this service; run ab connect')
  }
  const store = opener(state.storeRef, token)
  return {
    ...state,
    store,
    ...(token !== undefined ? { token } : {}),
  }
}
