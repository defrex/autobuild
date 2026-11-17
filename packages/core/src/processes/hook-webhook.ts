/**
 * The production invoker for URL hooks (§16.1 `[hooks]`), and the router that
 * picks a hook's transport. Each record is one HTTP POST whose body is the
 * exact JSON line a command hook reads on stdin, without its newline, signed
 * with HMAC-SHA256 over `<timestamp>.<body>` using the secret named by
 * `secretEnv` in the dispatcher's environment. A 2xx response within the
 * hook's timeout is success; any other status, a redirect (never followed), a
 * timeout or a connection error is a failure the hook runtime reports.
 *
 * Failure text never carries the secret, the URL, the request headers or the
 * response body.
 */
import { createHmac } from 'node:crypto'
import type { HookConfig } from '../config/schema'
import { runCommandHook } from './hook-command'
import type { HookInvoke, HookInvokeResult } from './hooks'

const ERROR_MAX = 1_000

type Fetch = (url: string, init: RequestInit) => Promise<Response>

export interface WebhookOpts {
  env: Record<string, string | undefined>
  clock: () => Date
  /** Test seam; defaults to the global `fetch`. */
  fetch?: Fetch
}

/** `v1=<lowercase hex HMAC-SHA256(secret, "<timestamp>.<body>")>`. */
export function signHookBody(secret: string, timestamp: number, body: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`
}

/** The request for one record, without transport options. Pure. */
export function webhookRequest(
  hook: { name: string; config: HookConfig },
  record: { id: string },
  line: string,
  secret: string,
  now: Date,
): { url: string; init: { method: 'POST'; headers: Record<string, string>; body: string } } {
  const body = line.endsWith('\n') ? line.slice(0, -1) : line
  const timestamp = Math.floor(now.getTime() / 1000)
  return {
    url: hook.config.url ?? '',
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'autobuild-hook',
        'Autobuild-Hook': hook.name,
        'Autobuild-Delivery': record.id,
        'Autobuild-Timestamp': String(timestamp),
        'Autobuild-Signature': signHookBody(secret, timestamp, body),
      },
      body,
    },
  }
}

function truncate(text: string): string {
  return text.length > ERROR_MAX ? `${text.slice(0, ERROR_MAX - 1)}…` : text
}

function recordId(line: string): string {
  try {
    const id = (JSON.parse(line) as { id?: unknown }).id
    return typeof id === 'string' ? id : ''
  } catch {
    return ''
  }
}

export async function runWebhookHook(
  hook: { name: string; config: HookConfig },
  line: string,
  signal: AbortSignal,
  record: { id: string } | undefined,
  opts: WebhookOpts,
): Promise<HookInvokeResult> {
  const { url, secretEnv, timeoutSeconds } = hook.config
  if (url === undefined) return { ok: false, error: 'could not start: no url' }
  const secret = secretEnv === undefined ? undefined : opts.env[secretEnv]
  if (secret === undefined || secret.trim() === '')
    return {
      ok: false,
      error: `signing secret variable ${secretEnv ?? '(none)'} is unset or empty`,
    }
  if (signal.aborted) return { ok: false, error: 'stopped' }
  const request = webhookRequest(hook, record ?? { id: recordId(line) }, line, secret, opts.clock())
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutSeconds * 1000)
  const onAbort = (): void => controller.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    let response: Response
    try {
      response = await (opts.fetch ?? fetch)(request.url, {
        ...request.init,
        redirect: 'manual',
        signal: controller.signal,
      })
    } catch (error) {
      if (signal.aborted) return { ok: false, error: 'stopped' }
      if (timedOut) return { ok: false, error: `timed out after ${timeoutSeconds}s` }
      const detail =
        error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? 'error')
      return {
        ok: false,
        error: truncate(
          `request failed: ${detail.replaceAll(url, '<url>').replaceAll(secret, '<secret>')}`,
        ),
      }
    }
    await response.body?.cancel().catch(() => {})
    if (signal.aborted) return { ok: false, error: 'stopped' }
    const status = response.status
    if (status >= 200 && status < 300) return { ok: true }
    if ((status >= 300 && status < 400) || status === 0 || response.type === 'opaqueredirect')
      return { ok: false, error: `redirect (HTTP ${status}) not followed` }
    return { ok: false, error: `HTTP ${status}` }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

export function webhookHookInvoker(opts: WebhookOpts): HookInvoke {
  return async (hook, line, signal, record) => runWebhookHook(hook, line, signal, record, opts)
}

/** The dispatcher's invoker: url hooks POST, every other hook runs its command. */
export function hookInvoker(
  opts: WebhookOpts & { checkout: string; stopTimeoutMs?: number },
): HookInvoke {
  return async (hook, line, signal, record) =>
    hook.config.url !== undefined
      ? runWebhookHook(hook, line, signal, record, opts)
      : runCommandHook(hook, line, signal, opts)
}
