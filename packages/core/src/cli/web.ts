import type { RefreshScheduler } from './dashboard/refresh'
import type { Exec } from '../ports/workspace/git-worktree'
import { withSessionlessStore, type StoreOpener } from './store-opening'
import { WebModelHub } from '../web/hub'
import { loopbackHosts } from '../web/http'
import { repositoryLabel } from '../web/page'
import { readOnlyStore } from '../web/read-only'
import { RepositoryFrameSource } from '../web/repository-source'
import { startWebServer } from '../web/server'

export const WEB_USAGE = 'usage: ab web [--port <n>] [--host <addr>] [--json] [--store <ref>]'

export const DEFAULT_WEB_HOST = '127.0.0.1'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

/** Parse `--port`: an integer from 0 to 65535; 0 lets the OS choose. */
export function parseWebPort(value: string | undefined): number {
  if (value === undefined) return 0
  const port = Number(value)
  if (!/^\d+$/u.test(value) || !Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error(`--port requires an integer from 0 to 65535, got "${value}" — ${WEB_USAGE}`)
  return port
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
  const hostname = opts.host ?? DEFAULT_WEB_HOST
  const widened = opts.host !== undefined && !LOOPBACK.has(opts.host.toLowerCase())
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
      const label = repositoryLabel(repo)
      const server = await startWebServer({
        hub,
        repositoryLabel: label,
        allowedHosts: widened ? 'any' : loopbackHosts(hostname),
        hostname,
        port: opts.port ?? 0,
      })
      try {
        if (widened)
          opts.stderr(
            `ab web: --host ${hostname} serves beyond loopback with no access control; anyone who can reach port ${server.port} can read this repository's builds, tickets and escalations.`,
          )
        opts.stdout(
          opts.json
            ? JSON.stringify({ url: server.url })
            : `ab web: serving ${label} at ${server.url}`,
        )
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
