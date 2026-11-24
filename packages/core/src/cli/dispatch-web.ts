import type { RepositoryReadFacts } from '../store/reduced-reads'
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
 * in push mode: it reads nothing, and shows the repository facts that a
 * refresh the dispatcher already performs read from the store.
 */
export interface DispatchWeb {
  hub: WebModelHub
  url: string
  /** Serve the frame for facts a dispatcher refresh just read. No store call. */
  publishFacts(facts: RepositoryReadFacts): void
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
  return {
    hub,
    url: started.url,
    publishFacts: (facts) => hub.publish(projectRepositoryFrame(opts.repo, facts).frame),
    close: () => {
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
