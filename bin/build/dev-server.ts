/**
 * Dev-server lifecycle guard for the e2e step of the validate gate.
 *
 * The standing "don't launch the dev server" rule exists to avoid *duplicate*
 * dev-server processes in one worktree. build relaxes it with a
 * launch-only-if-not-running guard owned by the script: it probes the dev URL,
 * spawns the top-level `bun run dev` only when nothing is already serving, and
 * tears down only the process it started — never a server you launched.
 *
 * See `build/build-flow/design.html` → "e2e & the dev server".
 */

import { type ChildProcess, spawn } from "node:child_process"
import { basename } from "node:path"

/**
 * Derive the dev URL exactly as `CLAUDE.md` / `bin/dev.sh` document: the
 * subdomain is `CONDUCTOR_WORKSPACE_NAME` when set, else the repo dir basename.
 * In sandbox/CI mode (`CI=1` or `PORTLESS_PORT` set) it falls back to plain
 * HTTP on a non-privileged port.
 */
export function deriveDevUrl(env: NodeJS.ProcessEnv, repoRoot: string): string {
  const name = env.CONDUCTOR_WORKSPACE_NAME ?? basename(repoRoot)
  const isSandbox = env.CI === "1" || Boolean(env.PORTLESS_PORT)
  if (isSandbox) {
    const port = env.PORTLESS_PORT ?? "1355"
    return `http://${name}.dispatch.localhost:${port}`
  }
  return `https://${name}.dispatch.localhost`
}

export type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<{ ok: boolean }>

/**
 * Is something already serving at `url`? Any HTTP response (even an error
 * status) counts as reachable. A TLS/certificate error also counts — it means
 * a server is listening and negotiating (the local CA may not be trusted by
 * Node even when the browser trusts it). Connection-refused / DNS failures mean
 * nothing is there.
 */
export async function reachable(
  url: string,
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  try {
    await fetchImpl(url, { method: "HEAD" })
    return true
  } catch (error) {
    const message = String(
      (error as { message?: unknown })?.message ?? error,
    ).toLowerCase()
    const code = String((error as { code?: unknown })?.code ?? "").toLowerCase()
    if (
      message.includes("certificate") ||
      message.includes("self-signed") ||
      message.includes("self signed") ||
      code.includes("cert")
    ) {
      return true
    }
    return false
  }
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

export type WaitOpts = {
  timeoutMs?: number
  intervalMs?: number
  reachableImpl?: (url: string) => Promise<boolean>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/** Poll `url` until it's reachable or the timeout elapses. Returns success. */
export async function waitUntilReachable(
  url: string,
  opts: WaitOpts = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 120_000
  const intervalMs = opts.intervalMs ?? 2_000
  const isReachable = opts.reachableImpl ?? ((u: string) => reachable(u))
  const sleep = opts.sleep ?? defaultSleep
  const now = opts.now ?? (() => Date.now())

  const deadline = now() + timeoutMs
  while (now() < deadline) {
    if (await isReachable(url)) return true
    await sleep(intervalMs)
  }
  return await isReachable(url)
}

export type WithDevServerArgs<T> = {
  devUrl: string
  repoRoot: string
  run: (devUrl: string) => Promise<T>
  /** Override the dev-server spawn (tests). Defaults to top-level `bun run dev`. */
  spawnDev?: (repoRoot: string) => ChildProcess
  /** Override teardown (tests). Defaults to killing the spawned process group. */
  killDev?: (child: ChildProcess) => void
  reachableImpl?: (url: string) => Promise<boolean>
  waitImpl?: (url: string) => Promise<boolean>
}

/**
 * `bun run dev` spawns a tree (next, dev:convex, portless registration).
 * `detached: true` puts them in their own process group so teardown can signal
 * the whole group — killing only the parent `bun` orphans the children and
 * leaves a stale server that the next run's `reachable()` probe would treat as
 * "already serving".
 */
function spawnDevServer(repoRoot: string): ChildProcess {
  return spawn("bun", ["run", "dev"], {
    cwd: repoRoot,
    stdio: "ignore",
    detached: true,
  })
}

/** SIGTERM the spawned process's entire group (negative pid), best-effort. */
function killDevServer(child: ChildProcess): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, "SIGTERM")
  } catch {
    // Group gone or unsupported — fall back to the direct child.
    child.kill("SIGTERM")
  }
}

/**
 * Run `run(devUrl)` with a dev server guaranteed reachable. Spawns the
 * top-level `bun run dev` only if nothing is already serving, and tears down
 * only a server it started.
 */
export async function withDevServer<T>({
  devUrl,
  repoRoot,
  run,
  spawnDev = spawnDevServer,
  killDev = killDevServer,
  reachableImpl = (u: string) => reachable(u),
  waitImpl = (u: string) => waitUntilReachable(u),
}: WithDevServerArgs<T>): Promise<T> {
  let started: ChildProcess | null = null
  if (!(await reachableImpl(devUrl))) {
    started = spawnDev(repoRoot)
    const up = await waitImpl(devUrl)
    if (!up) {
      killDev(started)
      throw new Error(`dev server never became reachable at ${devUrl}`)
    }
  }
  try {
    return await run(devUrl)
  } finally {
    // Tear down ONLY a server we started; never one the user launched.
    if (started) killDev(started)
  }
}
