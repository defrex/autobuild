import type { Exec } from '../ports/workspace/git-worktree'
import type { DispatchPlacement } from '../kernel/dispatch-placement'
import { RemoteBuildStore } from '../store/remote/client'
import { resolveRepoState, isRemoteStoreRef } from './repo-state'
import { projectToken } from './project-credentials'

export const TAKEOVER_WARNING =
  'Warning: --takeover dispatches locally and can displace the hosted dispatcher.'

export class DispatchPlacementStartupError extends Error {
  readonly code = 'DISPATCH_PLACEMENT_UNREADABLE'
  constructor(cause: unknown, secrets: string[] = []) {
    let detail = cause instanceof Error ? cause.message : String(cause)
    for (const secret of secrets) if (secret) detail = detail.split(secret).join('[redacted]')
    detail = detail.replace(/https?:\/\/[^\s]+/g, (url) => {
      try {
        const parsed = new URL(url)
        return `${parsed.origin}${parsed.pathname}`
      } catch {
        return '[redacted URL]'
      }
    })
    super(
      `Cannot read dispatch placement: ${detail}. Use --viewer to watch, or --takeover to dispatch locally and potentially displace hosted dispatch.`,
      { cause },
    )
    this.name = 'DispatchPlacementStartupError'
  }
}

export interface DispatchModeOptions {
  viewer?: boolean
  takeover?: boolean
  dispatchedBy?: string
  repository?: string
  intake?: boolean
  targetRepo: string
  repo?: string
  storeRef?: string
  env: Record<string, string | undefined>
  exec: Exec
  stderr: (message: string) => void
}
export interface PlacementReader {
  getDispatchPlacement(repo: string): Promise<DispatchPlacement>
  close(): Promise<void>
}
export async function selectDispatchMode(
  opts: DispatchModeOptions,
  deps: {
    resolve?: typeof resolveRepoState
    open?: (url: string, token: string | undefined) => PlacementReader
  } = {},
): Promise<{ viewer: boolean; dispatchedBy?: string }> {
  if (opts.viewer && opts.takeover) throw new Error('--viewer and --takeover cannot be combined')
  if (opts.viewer)
    return {
      viewer: true,
      ...(opts.dispatchedBy !== undefined ? { dispatchedBy: opts.dispatchedBy } : {}),
    }
  if (opts.repository || opts.env.AB_REPOSITORY?.trim()) return { viewer: false }
  if (opts.takeover) {
    opts.stderr(TAKEOVER_WARNING)
    return { viewer: false }
  }
  let token: string | undefined
  let placement: DispatchPlacement
  try {
    const state = await (deps.resolve ?? resolveRepoState)({
      targetRepo: opts.targetRepo,
      exec: opts.exec,
      ...(opts.storeRef !== undefined ? { storeRef: opts.storeRef } : {}),
      ...(opts.env.AB_STORE !== undefined ? { envStore: opts.env.AB_STORE } : {}),
    })
    if (!isRemoteStoreRef(state.storeRef)) return { viewer: false }
    const repo = opts.repo ?? state.repo
    token = projectToken(state.storeRef, repo, opts.env)
    const reader = (deps.open ?? ((url, token) => new RemoteBuildStore({ url, token })))(
      state.storeRef,
      token,
    )
    try {
      placement = await reader.getDispatchPlacement(repo)
    } finally {
      await reader.close()
    }
  } catch (cause) {
    throw new DispatchPlacementStartupError(cause, [token ?? '', opts.env.AB_TOKEN ?? ''])
  }
  if (placement.status !== 'known' || !placement.placement.hosted) return { viewer: false }
  if (opts.intake !== undefined)
    throw new Error('--viewer cannot set startup intake; use --takeover to dispatch locally')
  return { viewer: true, dispatchedBy: new URL(placement.placement.origin).host }
}
