import { AccountRedactor, redactAccountStore } from '../store/account-redaction'
import { untilDeadline } from './watch-lifetime'
/**
 * Production BuildStore composition for CLI commands.
 *
 * `repo-state.ts` owns repository identity and reference precedence, while
 * `store-ref.ts` remains the adapter-free local-vs-remote parser. This module
 * joins those seams to the production remote adapter and owns finite-command
 * store lifecycle.
 */
import { projectToken } from './project-credentials'
import { isRemoteStoreRef } from './repo-state'
import type { Exec } from '../ports/workspace/git-worktree'
import { RemoteBuildStore } from '../store/remote/client'
import { scopeLocalStoreToPhaseSession } from '../store/phase-session'
import type { BuildStore } from '../store/types'
import {
  resolveAmbientReadSession,
  type AmbientReadSession,
  type CliEnv,
  type HarvestCliEnv,
} from './env'
import { resolveRepoState, type RepoStatePaths } from './repo-state'
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
  const store = resolveStore(ref, {
    remoteFactory: (url, remoteToken) => new RemoteBuildStore({ url, token: remoteToken }),
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

/** Apply validated ambient authority to a selected Store handle. Remote
 * handles retain server-side project authorization; every handle receives
 * the same in-process build/session scope. Keeping this primitive shared prevents
 * phase commands and ambient-aware query commands from drifting. */
function scopeSelectedStoreToPhaseSession(
  store: BuildStore,
  _ref: string,
  env: AmbientReadSession,
): BuildStore {
  return scopeLocalStoreToPhaseSession(
    store,
    'build' in env
      ? { kind: 'build', id: env.build, session: env.session }
      : { kind: 'repo', id: env.repo, session: env.session },
  )
}

/** Open the Store for a validated phase/Harvest ambient identity. */
export function openProductionSessionStore(env: CliEnv | HarvestCliEnv): BuildStore {
  return scopeSelectedStoreToPhaseSession(openProductionStore(env.store, env.token), env.store, env)
}

export interface OpenedStoreContext extends RepoStatePaths {
  store: BuildStore
  token?: string
  /** The validated ambient phase/Harvest identity this invocation carries, if
   * any — the same value that scoped `store`. Exposed for commands whose
   * repository selection also depends on ambient own-build authority. */
  ambient?: AmbientReadSession
}

export interface OpenStoreForRepoStateOpts {
  env: Record<string, string | undefined>
  openStore?: StoreOpener
  useProjectCredential?: boolean
}

/** Open from an already canonicalized state selection. Dispatch uses this form
 * so repository topology and relative overrides are decided exactly once. */
export function openStoreForRepoState(
  state: RepoStatePaths,
  opts: OpenStoreForRepoStateOpts,
): OpenedStoreContext {
  const token =
    opts.useProjectCredential !== false && isRemoteStoreRef(state.storeRef)
      ? projectToken(state.storeRef, state.repo, opts.env)
      : optionalToken(opts.env.AB_TOKEN)
  if (!token && isRemoteStoreRef(state.storeRef) && state.configStore === state.storeRef) {
    throw new Error('No project credential for this service; run ab connect')
  }
  const store = (opts.openStore ?? openProductionStore)(state.storeRef, token)
  return {
    ...state,
    store,
    ...(token !== undefined ? { token } : {}),
  }
}

export interface SessionlessStoreOpts extends OpenStoreForRepoStateOpts {
  /** Optional command-owned shutdown budget for handle closure. */
  closeDeadline?: AbortSignal
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
    ...(opts.env.AB_STORE !== undefined ? { envStore: opts.env.AB_STORE } : {}),
  })
  return openStoreForRepoState(state, opts)
}

/** Finite command ownership boundary. Opening failures occur before the
 * try/finally, so only a successfully returned handle is ever closed.
 *
 * Ambient query openers apply in-process build/session scope to both local
 * and remote handles; the server additionally enforces project authority. */
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

/** Dedicated opener for the finite query commands whose operator-sessionless
 * syntax is also useful inside a phase. Invalid ambient identity fails before
 * repository canonicalization or Store opening; absent identity preserves the
 * ordinary unscoped operator path. */
export async function openAmbientReadStore(
  opts: SessionlessStoreOpts,
): Promise<OpenedStoreContext> {
  const ambient = resolveAmbientReadSession(opts.env)
  const state = await resolveRepoState({
    targetRepo: opts.targetRepo,
    exec: opts.exec,
    ...(opts.storeRef !== undefined ? { storeRef: opts.storeRef } : {}),
    ...(opts.env.AB_STORE !== undefined ? { envStore: opts.env.AB_STORE } : {}),
  })
  const context = openStoreForRepoState(state, {
    ...opts,
    useProjectCredential: ambient === undefined,
  })
  if (ambient === undefined) return context
  return {
    ...context,
    ambient,
    store: scopeSelectedStoreToPhaseSession(context.store, state.storeRef, ambient),
  }
}

export async function withAmbientReadStore<T>(
  opts: SessionlessStoreOpts,
  use: (context: OpenedStoreContext) => Promise<T> | T,
): Promise<T> {
  const context = await openAmbientReadStore(opts)
  try {
    return await use(context)
  } finally {
    const closing = context.store.close()
    if (opts.closeDeadline) await untilDeadline(closing, opts.closeDeadline)
    else await closing
  }
}
