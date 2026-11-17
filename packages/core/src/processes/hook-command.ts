/**
 * The production invoker for configured command hooks (§16.1 `[hooks]`): one
 * `sh -c` process per record, the record on stdin as one JSON line. Exit 0
 * within the hook's timeout is success; anything else is a failure whose text
 * the hook runtime reports. The command runs in its own process group so a
 * timeout, a stop, or a natural exit reaps every descendant it started.
 */
import type { HookConfig } from '../config/schema'
import { terminateProcessGroup } from './process-group'
import type { HookInvoke, HookInvokeResult } from './hooks'

/** Build- and session-identity variables a hook must never inherit. */
const STRIPPED_ENV = [
  'AB_BUILD',
  'AB_SESSION',
  'AB_PHASE',
  'AB_ROUND',
  'AB_HARVEST',
  'AB_CONTEXT_DIR',
  'AB_DISPATCH_GENERATION',
] as const

const OUTPUT_TAIL_BYTES = 4 * 1024
const ERROR_MAX = 1_000

export function hookCommandEnv(
  env: Record<string, string | undefined>,
  name: string,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env))
    if (value !== undefined && !(STRIPPED_ENV as readonly string[]).includes(key))
      result[key] = value
  result.AB_HOOK = name
  return result
}

function truncate(text: string): string {
  return text.length > ERROR_MAX ? `${text.slice(0, ERROR_MAX - 1)}…` : text
}

/** Keep only the last `OUTPUT_TAIL_BYTES` of a stream, read to its end. */
async function tail(stream: ReadableStream<Uint8Array>, sink: { text: string }): Promise<void> {
  const decoder = new TextDecoder()
  for await (const chunk of stream) {
    sink.text = (sink.text + decoder.decode(chunk, { stream: true })).slice(-OUTPUT_TAIL_BYTES)
  }
}

export function commandHookInvoker(opts: {
  checkout: string
  env: Record<string, string | undefined>
  stopTimeoutMs?: number
}): HookInvoke {
  return async (hook, line, signal) => runCommandHook(hook, line, signal, opts)
}

export async function runCommandHook(
  hook: { name: string; config: HookConfig },
  line: string,
  signal: AbortSignal,
  opts: { checkout: string; env: Record<string, string | undefined>; stopTimeoutMs?: number },
): Promise<HookInvokeResult> {
  const command = hook.config.command
  if (command === undefined) return { ok: false, error: 'could not start: no command' }
  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn(['sh', '-c', command], {
      cwd: opts.checkout,
      env: hookCommandEnv(opts.env, hook.name),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    })
  } catch (error) {
    return {
      ok: false,
      error: truncate(`could not start: ${error instanceof Error ? error.message : String(error)}`),
    }
  }
  const output = { text: '' }
  const drained = Promise.all([
    tail(child.stdout as ReadableStream<Uint8Array>, output),
    tail(child.stderr as ReadableStream<Uint8Array>, output),
  ]).catch(() => {})
  let reaping: Promise<void> | undefined
  const reap = (): Promise<void> =>
    (reaping ??= terminateProcessGroup(child.pid, opts.stopTimeoutMs).catch(() => {}))
  // Timeout and abort are armed before any stdin is written: a command that
  // never reads a record larger than the pipe buffer must not hold delivery
  // past its timeout or a stop.
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    void reap()
  }, hook.config.timeoutSeconds * 1000)
  const onAbort = (): void => void reap()
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  // The write runs inside the protected lifetime and is never awaited: the
  // command's exit decides, and one that closes stdin first only fails it.
  void (async () => {
    const stdin = child.stdin as import('bun').FileSink
    stdin.write(line)
    await stdin.end()
  })().catch(() => {})
  try {
    const exitCode = await child.exited
    // Descendants that outlive a natural exit are reaped with the group.
    await reap()
    await drained
    if (signal.aborted) return { ok: false, error: 'stopped' }
    if (timedOut) return { ok: false, error: `timed out after ${hook.config.timeoutSeconds}s` }
    if (exitCode === 0) return { ok: true }
    const detail = output.text.trim()
    return {
      ok: false,
      error: truncate(`exit status ${exitCode}${detail.length > 0 ? `: ${detail}` : ''}`),
    }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}
