/**
 * Web server options shared by `ab web` and `ab dispatch --web`. No store,
 * React or server imports, so the dispatcher launcher can use it without
 * widening its filesystem/process-only import graph.
 */

export const DEFAULT_WEB_HOST = '127.0.0.1'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

/** True when `host` keeps the server on this machine. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host.toLowerCase())
}

/** Parse `--port`: an integer from 0 to 65535; 0 lets the OS choose. */
export function parseWebPort(value: string | undefined, usage: string): number {
  if (value === undefined) return 0
  const port = Number(value)
  if (!/^\d+$/u.test(value) || !Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error(`--port requires an integer from 0 to 65535, got "${value}" — ${usage}`)
  return port
}

/** Ask the OS for a free port on `hostname`, then release it. A dispatcher
 * launcher pins it into every generation's argv, so the URL it announces
 * survives runtime upgrades. One local bind; no store. */
export async function reserveWebPort(hostname: string): Promise<number> {
  const server = Bun.serve({
    hostname,
    port: 0,
    reusePort: false,
    fetch: () => new Response(null, { status: 503 }),
  })
  const port = server.port
  await server.stop(true)
  if (port === undefined) throw new Error(`could not reserve a web port on ${hostname}`)
  return port
}
