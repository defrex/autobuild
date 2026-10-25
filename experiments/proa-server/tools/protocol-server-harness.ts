import { observeProtocolResponse } from './protocol-route-coverage'
import { mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

const project = resolve(import.meta.dir, '..')
const root = resolve(project, '../..')
type Environment = Record<string, string | undefined>
const builds = new Map<string, Promise<{ server: string; blob: string; reader: string }>>()

async function externalTarget(environment: Environment) {
  const requested = environment.CARGO_TARGET_DIR
  if (!requested || !isAbsolute(requested))
    throw new Error(
      'Protocol build requires an absolute external CARGO_TARGET_DIR; use the verify cache',
    )
  await mkdir(requested, { recursive: true })
  const target = await realpath(requested)
  const listed = Bun.spawnSync(['git', 'worktree', 'list', '--porcelain'], { cwd: root })
  if (listed.exitCode) throw new Error('Cannot verify protocol Cargo cache location')
  for (const match of listed.stdout.toString().matchAll(/^worktree (.+)$/gm)) {
    const tree = await realpath(match[1]!)
    if (target === tree || target.startsWith(`${tree}/`))
      throw new Error('Protocol Cargo cache must be outside every worktree')
  }
  return target
}

async function compile(environment: Environment, locked: boolean) {
  const target = await externalTarget(environment)
  let pending = builds.get(target)
  if (!pending) {
    pending = (async () => {
      const cargo = [
        'cargo',
        'build',
        '--locked',
        '--example',
        'protocol-test-server',
        '--example',
        'protocol-blob-proof',
        '--example',
        'data-proof',
        '--message-format=json',
      ]
      const child = Bun.spawn(locked ? ['flock', `${target}/.verify.lock`, ...cargo] : cargo, {
        cwd: project,
        env: { ...environment, CARGO_TARGET_DIR: target },
        stdout: 'pipe',
        stderr: 'inherit',
      })
      const output = await new Response(child.stdout).text()
      if ((await child.exited) !== 0) throw new Error('Protocol test server compilation failed')
      let server: string | undefined
      let blob: string | undefined
      let reader: string | undefined
      for (const line of output.split('\n').filter(Boolean)) {
        const artifact = JSON.parse(line) as {
          reason?: string
          executable?: string
          target?: { name: string }
        }
        if (
          artifact.reason === 'compiler-artifact' &&
          artifact.target?.name === 'protocol-test-server' &&
          artifact.executable
        )
          server = artifact.executable
        if (
          artifact.reason === 'compiler-artifact' &&
          artifact.target?.name === 'protocol-blob-proof' &&
          artifact.executable
        )
          blob = artifact.executable
        if (
          artifact.reason === 'compiler-artifact' &&
          artifact.target?.name === 'data-proof' &&
          artifact.executable
        )
          reader = artifact.executable
      }
      if (!server) throw new Error('Cargo did not report the protocol test server executable')
      if (!blob) throw new Error('Cargo did not report the protocol blob proof executable')
      if (!reader) throw new Error('Cargo did not report the production reader proof executable')
      return { server, blob, reader }
    })()
    builds.set(target, pending)
    pending.catch(() => {
      if (builds.get(target) === pending) builds.delete(target)
    })
  }
  return pending
}

/** Compile once per harness run. Caller MUST already hold the shared .verify.lock;
 * use the explicit locked wrapper outside the maintained verify gate. */
export function buildProtocolExecutables(environment: Environment) {
  return compile(environment, false)
}
export function buildProtocolExecutablesLocked(environment: Environment) {
  return compile(environment, true)
}

export interface ProtocolServerOptions {
  executable: string
  /** Already scrubbed by withDataServices/withProtocolDatabase; never merge process.env. */
  env: Environment
  clock?: () => Date
  retention?: { maxRevisions: number }
  startupTimeoutMs?: number
  controlTimeoutMs?: number
  teardownTimeoutMs?: number
}

/** Spawn the test-only executable. Its private newline JSON control channel is
 * not an HTTP endpoint and must never be mounted in the normal server binary. */
export async function startProtocolServer(options: ProtocolServerOptions) {
  const child = Bun.spawn([options.executable], {
    cwd: project,
    env: {
      ...options.env,
      PROA_TEST_RETENTION: options.retention ? JSON.stringify(options.retention) : undefined,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let diagnostic = ''
  const stderr = (async () => {
    for await (const bytes of child.stderr) {
      // Keep diagnostics bounded without printing environment or control payloads.
      diagnostic = (diagnostic + new TextDecoder().decode(bytes)).slice(-8192)
    }
  })()
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  let stopping: Promise<void> | undefined
  const shutdown = new AbortController()
  async function nextLine(): Promise<unknown> {
    while (!buffered.includes('\n')) {
      const result = await reader.read()
      if (result.done) {
        await child.exited
        await stderr
        throw new Error(`Protocol test server exited (${child.exitCode}): ${diagnostic}`)
      }
      buffered += decoder.decode(result.value, { stream: true })
      if (buffered.length > 8192) throw new Error('Protocol server control message is too large')
    }
    const boundary = buffered.indexOf('\n')
    const line = buffered.slice(0, boundary)
    buffered = buffered.slice(boundary + 1)
    return JSON.parse(line)
  }
  async function bounded<T>(operation: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), ms)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  const close = () => {
    stopping ??= (async () => {
      shutdown.abort()
      try {
        child.stdin.end()
        await bounded(
          child.exited,
          options.teardownTimeoutMs ?? 10000,
          'Protocol server teardown timed out',
        )
      } catch (error) {
        child.kill('SIGKILL')
        await child.exited
        throw error
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
        await stderr
        process.removeListener('SIGINT', stopOnSignal)
        process.removeListener('SIGTERM', stopOnSignal)
      }
    })()
    return stopping
  }
  const stopOnSignal = () => {
    void close().catch((error) => console.error('Protocol server signal cleanup failed', error))
  }
  process.once('SIGINT', stopOnSignal)
  process.once('SIGTERM', stopOnSignal)
  try {
    const ready = (await bounded(
      nextLine(),
      options.startupTimeoutMs ?? 15000,
      'Protocol server startup timed out',
    )) as { ready?: boolean; port?: number }
    if (
      ready?.ready !== true ||
      !Number.isInteger(ready.port) ||
      ready.port! < 1 ||
      ready.port! > 65535
    )
      throw new Error('Invalid protocol server readiness identity')
    const url = `http://127.0.0.1:${ready.port}`
    let queue = Promise.resolve()
    const fetchFn = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        let response: Promise<Response> | undefined
        const launch = queue.then(async () => {
          if (shutdown.signal.aborted || child.exitCode !== null)
            throw new Error('Protocol test server is closed')
          if (options.clock) {
            const now = options.clock().toISOString()
            child.stdin.write(`${JSON.stringify({ now })}\n`)
            await child.stdin.flush()
            const reply = (await bounded(
              nextLine(),
              options.controlTimeoutMs ?? 5000,
              'Protocol clock synchronization timed out',
            )) as { ok?: boolean }
            if (reply?.ok !== true) throw new Error('Protocol clock synchronization refused')
          }
          const original = init?.signal ?? (input instanceof Request ? input.signal : undefined)
          response = fetch(input, {
            ...init,
            signal: original ? AbortSignal.any([original, shutdown.signal]) : shutdown.signal,
          })
          // Only synchronization and request START are serialized. Holding this
          // queue through headers would deadlock a held read waiting for a write.
          void response.catch(() => {})
        })
        queue = launch.catch(() => {})
        try {
          await launch
        } catch (error) {
          // A lost/malformed control reply makes channel framing untrustworthy.
          await close().catch(() => {})
          throw error
        }
        const completed = await response!
        const requested = input instanceof Request ? input.url : String(input)
        if (new URL(requested).origin === url)
          await observeProtocolResponse(
            init?.method ?? (input instanceof Request ? input.method : 'GET'),
            requested,
            completed,
          )
        return completed
      },
      { preconnect: fetch.preconnect },
    ) as typeof fetch
    return { url, fetch: fetchFn, close }
  } catch (error) {
    await close().catch(() => {})
    throw error
  }
}
