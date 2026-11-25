import type { RepositoryReadFacts } from '../store/reduced-reads'
import type { BuildStore } from '../store/types'
import { WebAnalyticsSource } from '../web/analytics-source'
import { readOnlyStore } from '../web/read-only'
import { WebModelHub } from '../web/hub'
import { projectRepositoryFrame } from '../web/repository-source'
import { WebPortInUseError, type StartedWebServer, type WebServerStarter } from '../web/server'
import type { DispatchWebArgs } from './dispatch-args'
import { launchContext } from './dispatch-launch-contract'
import { serveRepositoryWeb } from './web'

/** How long a successor generation waits for its predecessor to free the port. */
export const SUCCESSOR_BIND_RETRY_MS = 100
export const SUCCESSOR_BIND_ATTEMPTS = 100

/**
 * The web UI a dispatcher serves in process (`ab dispatch --web`). Its hub is
 * in push mode and shows the repository facts that a refresh the dispatcher
 * already performs read from the store. Frames from the dashboard frontend
 * carry the change position that refresh sampled, so they add no read. A
 * kernel-only dispatcher's journal refresh samples none, so while a browser
 * is connected each of its frames reads one `getRepoChangePosition`, and
 * nothing while nobody watches. Analytics and timeline requests are explicit
 * reads through the attached store.
 */
export interface DispatchWeb {
  hub: WebModelHub
  url: string
  /** Serve the frame for facts a dispatcher refresh just read, stamped with
   * `position` when the refresh sampled one. Without one, and only while a
   * browser is connected and a store is attached, one position read. */
  publishFacts(facts: RepositoryReadFacts, position?: string): void
  /** Serve analytics over `store`, once it is open. Until then the routes
   * answer 503. A later call replaces the store. */
  attachStore(store: BuildStore): void
  /** Stop the server and drop every connection. Idempotent. */
  close(): Promise<void>
}

export interface StartDispatchWebOpts {
  options: DispatchWebArgs
  repo: string
  env: Record<string, string | undefined>
  stdout: (line: string) => void
  stderr: (line: string) => void
  start?: WebServerStarter
  sleep?: (ms: number) => Promise<void>
}

/**
 * Bind the dispatcher's web server. A first generation fails on a taken port,
 * before it takes the repository lease. A successor generation already holds
 * the lease from preflight, so it waits for its predecessor to free the
 * pinned port and, if it never does, keeps dispatching without the web UI.
 * Only a first generation announces the URL, so it is printed once.
 */
export async function startDispatchWeb(
  opts: StartDispatchWebOpts,
): Promise<DispatchWeb | undefined> {
  const context = launchContext(opts.env)
  const successor =
    context?.predecessor !== undefined ||
    context?.recovery !== undefined ||
    context?.rollback !== undefined
  const hub = new WebModelHub({})
  let analytics: WebAnalyticsSource | undefined
  let attached: BuildStore | undefined
  let store: BuildStore | undefined
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms))
  let server: StartedWebServer | undefined
  for (let attempt = 1; server === undefined; attempt++) {
    try {
      server = await serveRepositoryWeb({
        hub,
        repo: opts.repo,
        ...(opts.options.host !== undefined ? { host: opts.options.host } : {}),
        port: opts.options.port,
        json: opts.options.json,
        command: 'ab dispatch',
        announce: !successor,
        stdout: opts.stdout,
        stderr: opts.stderr,
        analytics: () => analytics,
        ...(opts.start !== undefined ? { start: opts.start } : {}),
      })
    } catch (error) {
      if (!successor || !(error instanceof WebPortInUseError)) {
        hub.close()
        throw error
      }
      if (attempt >= SUCCESSOR_BIND_ATTEMPTS) {
        hub.close()
        opts.stderr(`ab dispatch: web UI unavailable after handoff: ${error.message}`)
        return undefined
      }
      await sleep(SUCCESSOR_BIND_RETRY_MS)
    }
  }
  const started = server
  let closing: Promise<void> | undefined
  const publish = (facts: RepositoryReadFacts, position?: string) => {
    const frame = projectRepositoryFrame(opts.repo, facts).frame
    hub.publish(position !== undefined ? { ...frame, position } : frame)
  }
  // The kernel path's position read: single-flight, latest facts win.
  let reading = false
  let pending: RepositoryReadFacts | undefined
  const stampAndPublish = (facts: RepositoryReadFacts) => {
    pending = facts
    if (reading) return
    const reader = store
    if (reader === undefined) return
    reading = true
    void (async () => {
      let position: string | undefined
      try {
        position = await reader.getRepoChangePosition(opts.repo)
      } catch {
        // Presentation only: the frame goes out without its refetch signal.
      }
      reading = false
      const latest = pending!
      pending = undefined
      publish(latest, position)
    })()
  }
  return {
    hub,
    url: started.url,
    publishFacts: (facts, position) => {
      if (position !== undefined || store === undefined || hub.subscribers === 0)
        publish(facts, position)
      else stampAndPublish(facts)
    },
    attachStore: (next) => {
      if (closing !== undefined || next === attached) return
      attached = next
      store = readOnlyStore(next)
      analytics = new WebAnalyticsSource(store, opts.repo)
    },
    close: () => {
      analytics = undefined
      attached = undefined
      store = undefined
      closing ??= (async () => {
        try {
          await started.stop()
        } finally {
          hub.close()
        }
      })()
      return closing
    },
  }
}
