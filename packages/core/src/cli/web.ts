import type { RefreshScheduler } from './dashboard/refresh'
import type { Exec } from '../ports/workspace/git-worktree'
import { withSessionlessStore, type StoreOpener } from './store-opening'
import { WebModelHub } from '../web/hub'
import { loopbackHosts } from '../web/http'
import { repositoryLabel } from '../web/page'
import { readOnlyStore } from '../web/read-only'
import { RepositoryFrameSource } from '../web/repository-source'
import { parseWebPort as parseOptionPort, DEFAULT_WEB_HOST, isLoopbackHost } from '../web/options'
import { startWebServer, type StartedWebServer, type WebServerStarter } from '../web/server'

export const WEB_USAGE = 'usage: ab web [--port <n>] [--host <addr>] [--json] [--store <ref>]'

export { DEFAULT_WEB_HOST, isLoopbackHost } from '../web/options'

/** Parse `--port` for `ab web`: an integer from 0 to 65535; 0 lets the OS choose. */
export function parseWebPort(value: string | undefined, usage: string = WEB_USAGE): number {
  return parseOptionPort(value, usage)
}

export interface ServeRepositoryWebOpts {
  hub: WebModelHub
  repo: string
  host?: string
  port: number
  json: boolean
  /** The command naming the server in its announcement, warnings and errors. */
  command: string
  /** Print the URL line: the JSON `{"url":…}` with `json`, prose otherwise. */
  announce: boolean
  stdout: (line: string) => void
  stderr: (line: string) => void
  /** Test seam; defaults to binding a real socket. */
  start?: WebServerStarter
}

/** Bind the web server over `hub`, warn when `--host` widened it beyond
 * loopback, and announce its URL. Shared by `ab web` and `ab dispatch --web`. */
export async function serveRepositoryWeb(opts: ServeRepositoryWebOpts): Promise<StartedWebServer> {
  const hostname = opts.host ?? DEFAULT_WEB_HOST
  const widened = opts.host !== undefined && !isLoopbackHost(opts.host)
  const label = repositoryLabel(opts.repo)
  const server = await (opts.start ?? startWebServer)({
    hub: opts.hub,
    repositoryLabel: label,
    allowedHosts: widened ? 'any' : loopbackHosts(hostname),
    hostname,
    port: opts.port,
    command: opts.command,
  })
  if (widened)
    opts.stderr(
      `${opts.command}: --host ${hostname} serves beyond loopback with no access control; anyone who can reach port ${server.port} can read this repository's builds, tickets and escalations.`,
    )
  if (opts.announce)
    opts.stdout(
      opts.json
        ? JSON.stringify({ url: server.url })
        : `${opts.command}: serving ${label} at ${server.url}`,
    )
  return server
}

export interface AbWebOpts {
  targetRepo: string
  env: Record<string, string | undefined>
  exec: Exec
  stdout: (line: string) => void
  stderr: (line: string) => void
  port?: number
  host?: string
  json: boolean
  storeRef?: string
  openStore?: StoreOpener
  /** Stops the server; without one it serves until the process ends. */
  signal?: AbortSignal
  scheduler?: RefreshScheduler
  /** Observes the running hub, for tests. */
  onListening?: (server: { url: string; hub: WebModelHub }) => void
}

/**
 * `ab web`: serve the read-only web UI for this repository's builds. It
 * appends nothing, takes no dispatcher lease and registers no operator
 * presence; the store it holds refuses every write.
 */
export async function abWeb(opts: AbWebOpts): Promise<void> {
  await withSessionlessStore(
    {
      targetRepo: opts.targetRepo,
      env: opts.env,
      exec: opts.exec,
      ...(opts.storeRef !== undefined ? { storeRef: opts.storeRef } : {}),
      ...(opts.openStore !== undefined ? { openStore: opts.openStore } : {}),
    },
    async ({ store, repo }) => {
      const reader = readOnlyStore(store)
      const hub = new WebModelHub({
        source: new RepositoryFrameSource(reader, repo),
        networkReads: store.networkReads === true,
        ...(opts.scheduler !== undefined ? { scheduler: opts.scheduler } : {}),
        onError: (error) =>
          opts.stderr(
            `ab web: store read failed: ${error instanceof Error ? error.message : error}`,
          ),
      })
      const server = await serveRepositoryWeb({
        hub,
        repo,
        ...(opts.host !== undefined ? { host: opts.host } : {}),
        port: opts.port ?? 0,
        json: opts.json,
        command: 'ab web',
        announce: true,
        stdout: opts.stdout,
        stderr: opts.stderr,
      })
      try {
        opts.onListening?.({ url: server.url, hub })
        await untilAborted(opts.signal)
      } finally {
        await server.stop()
        hub.close()
      }
    },
  )
}

function untilAborted(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return new Promise(() => {})
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
}
