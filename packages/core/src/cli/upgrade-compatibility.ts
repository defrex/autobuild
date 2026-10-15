import { spawnExec } from '../ports/workspace/git-worktree'
import { readDistributionIdentity } from './installation'
import { isRemoteStoreRef, resolveRepoState } from './repo-state'
import {
  classifyClient,
  compatibilityAdvice,
  stableVersion,
  supportedClientRangeSchema,
} from '../store/remote/compatibility'

export type CompatibilityFetch = (url: string, init: RequestInit) => Promise<Response>

/** Read-only, advisory, and deliberately credential-free. Never expose a store URL. */
export async function checkUpgradeCompatibility(options: {
  targetRepo: string
  version?: string
  distRoot?: string
  env?: Record<string, string | undefined>
  stderr: (line: string) => void
  fetch?: CompatibilityFetch
  timeoutMs?: number
}): Promise<void> {
  const paths = await resolveRepoState({
    targetRepo: options.targetRepo,
    exec: spawnExec,
    envStore: (options.env ?? process.env).AB_STORE,
  })
  if (!isRemoteStoreRef(paths.storeRef)) return
  const unknown = () =>
    options.stderr(
      'warning: hosted service compatibility could not be verified; the upgraded project may fail to connect',
    )
  try {
    const targetVersion =
      options.version ?? (await readDistributionIdentity(options.distRoot)).version
    const url = new URL(paths.storeRef)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    url.pathname = `${url.pathname.replace(/\/$/, '')}/health`
    const controller = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort()
        reject(new Error('timeout'))
      }, options.timeoutMs ?? 3000)
    })
    const response = await Promise.race([
      (async () => {
        const response = await (options.fetch ?? fetch)(url.toString(), {
          signal: controller.signal,
          redirect: 'error',
        })
        if (response.status !== 200) throw new Error('health failed')
        return (await response.json()) as Record<string, unknown>
      })(),
      expired,
    ]).finally(() => clearTimeout(timeout))
    if (!response || !stableVersion(response.autobuildVersion)) return unknown()
    const serviceVersion = response.autobuildVersion as string
    if (!Object.hasOwn(response, 'supportedClientRange')) {
      if (targetVersion !== serviceVersion)
        options.stderr(
          `warning: service Autobuild ${serviceVersion} requires an exact client version; target ${targetVersion} differs. Upgrade the service to the compatibility-window release first to publish a supported client range; the upgraded project may fail to connect`,
        )
      return
    }
    const range = supportedClientRangeSchema.safeParse(response.supportedClientRange)
    if (!range.success || classifyClient(targetVersion, range.data) === 'invalid') return unknown()
    const advice = compatibilityAdvice(targetVersion, serviceVersion, range.data)
    if (advice)
      options.stderr(
        `warning: target Autobuild ${targetVersion}: ${advice}; the upgraded project may fail to connect`,
      )
  } catch {
    unknown()
  }
}
