/**
 * GitHub REST transport seam, shared by the forge adapter and its PR
 * attachment hosting. Kept dependency-free so both can import it without a
 * cycle, and so tests inject a fake transport instead of shelling `gh`.
 */
import { z } from 'zod'
import { spawnExec } from '../workspace/git-worktree'

export interface GitHubRequestOpts {
  query?: Record<string, string>
  /** JSON-serializable request body. Ignored when `raw` is set. */
  body?: unknown
  /** Extra headers (e.g. `Accept: application/vnd.github.raw`). */
  headers?: Record<string, string>
  /** Raw request bytes (release-asset upload); sets the body verbatim. */
  raw?: Uint8Array
  signal?: AbortSignal
}

export interface GitHubResponse {
  status: number
  /** Lowercased response headers of interest. */
  headers: Record<string, string>
  /** Parsed JSON body when the response declared one. */
  json?: unknown
  /** Raw response bytes when the body was not JSON. */
  bytes?: Uint8Array
}

/**
 * One authenticated GitHub REST call. `path` is API-relative
 * (`repos/{owner}/{repo}/pulls/42`) or an absolute URL (release-asset
 * `upload_url`). Non-2xx responses throw {@link GitHubApiError} — except
 * `304 Not Modified`, which is returned (never thrown) because it is a
 * documented *success* for a conditional request: callers that send
 * revalidation headers such as `If-None-Match` read the 304 as "the cached
 * representation is still current". A 304 carries no body, so the response
 * has no `json` and no `bytes`.
 */
export type GitHubRequest = (
  method: string,
  path: string,
  opts?: GitHubRequestOpts,
) => Promise<GitHubResponse>

/** Typed non-2xx response. `body` carries the parsed JSON (when any) so
 * fail-closed callers can classify documented error shapes. */
export class GitHubApiError extends Error {
  readonly status: number
  readonly body?: unknown

  constructor(status: number, message: string, body?: unknown) {
    super(message)
    this.name = 'GitHubApiError'
    this.status = status
    this.body = body
  }
}

const GITHUB_API_BASE = 'https://api.github.com'
const GITHUB_API_VERSION = '2022-11-28'

function githubErrorMessage(status: number, body: unknown, text: string): string {
  if (body !== null && typeof body === 'object' && 'message' in body) {
    const message = (body as { message?: unknown }).message
    if (typeof message === 'string' && message !== '') return message
  }
  return text.trim() !== '' ? text.trim() : `GitHub API responded ${status}`
}

/** The documented plan-limitation error shape for the rulesets endpoint.
 * Shared by the forge's fail-closed gate probe and its tests. */
export const restPlanLimitation = z
  .object({
    message: z.literal(
      'Upgrade to GitHub Pro or make this repository public to enable this feature.',
    ),
    documentation_url: z.literal('https://docs.github.com/rest/repos/rules#get-rules-for-a-branch'),
  })
  .passthrough()

/** Where a transport's bearer token comes from: a literal, nothing (anonymous
 * requests), or a resolver the transport invokes lazily. A resolved token is
 * memoized until a request answers `401 Unauthorized` (a rotated or revoked
 * `gh auth login`), after which the next request resolves again. A miss is
 * memoized for {@link CREDENTIAL_MISS_TTL_MS} so a transient failure (a
 * momentarily locked keyring) is neither frozen into anonymous access for the
 * process lifetime nor re-probed on every single request. */
export type GitHubTokenSource = string | undefined | (() => Promise<string | undefined>)

/** How long a credential miss stays memoized before the resolver is asked
 * again. Bounds the gh probe rate for a transport that never finds a token. */
export const CREDENTIAL_MISS_TTL_MS = 60_000

/** Production transport: token-authenticated fetch against api.github.com.
 * Callers pass a literal token or a resolver over {@link resolveGitHubToken}
 * (env token, then gh CLI login); no `Authorization` header is sent when
 * neither yields one. */
export function createGitHubFetchTransport(opts: {
  token?: GitHubTokenSource
  apiBase?: string
  now?: () => number
}): GitHubRequest {
  const source = opts.token
  const now = opts.now ?? Date.now
  let resolved: Promise<string | undefined> | undefined
  let missedAt: number | undefined
  const resolveToken = (): Promise<string | undefined> => {
    if (
      resolved !== undefined &&
      missedAt !== undefined &&
      now() - missedAt >= CREDENTIAL_MISS_TTL_MS
    ) {
      resolved = undefined
    }
    if (resolved === undefined) {
      missedAt = undefined
      const attempt = typeof source === 'function' ? source() : Promise.resolve(source)
      resolved = attempt
      attempt.then(
        (token) => {
          if (resolved === attempt && token === undefined) missedAt = now()
        },
        () => {
          // A rejected probe is not an answer at all — ask again next time.
          if (resolved === attempt) resolved = undefined
        },
      )
    }
    return resolved
  }
  const forgetToken = (): void => {
    if (typeof source === 'function') {
      resolved = undefined
      missedAt = undefined
    }
  }
  const base = opts.apiBase ?? GITHUB_API_BASE
  return async (method, path, request = {}) => {
    const token = await resolveToken()
    let url = /^https:\/\//i.test(path) ? path : `${base}/${path.replace(/^\/+/, '')}`
    if (request.query !== undefined) {
      const params = new URLSearchParams(request.query)
      url += (url.includes('?') ? '&' : '?') + params.toString()
    }
    const headers: Record<string, string> = {
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      Accept: 'application/vnd.github+json',
      ...request.headers,
    }
    if (token !== undefined && token !== '') headers.Authorization = `Bearer ${token}`
    let body: BodyInit | undefined
    if (request.raw !== undefined) body = request.raw as unknown as BodyInit
    else if (request.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(request.body)
    }
    const response = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    })
    const headerMap: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      headerMap[key.toLowerCase()] = value
    })
    // A 304 Not Modified answers a conditional request (If-None-Match) and
    // always carries an empty body — return it before the non-2xx throw so
    // callers can treat revalidation success as success, not an error.
    if (response.status === 304) {
      return { status: 304, headers: headerMap }
    }
    const contentType = headerMap['content-type'] ?? ''
    let text = ''
    let json: unknown
    let bytes: Uint8Array | undefined
    if (contentType.includes('application/json')) {
      text = await response.text()
      try {
        json = JSON.parse(text)
      } catch {
        // A non-JSON body behind a JSON content type is ordinary garbage.
      }
    } else {
      // Binary bodies (release assets, raw file contents) are read as bytes —
      // never round-tripped through text, which would corrupt arbitrary data.
      const buffer = await response.arrayBuffer()
      if (buffer.byteLength > 0) bytes = new Uint8Array(buffer)
    }
    if (!response.ok) {
      if (response.status === 401) forgetToken()
      if (bytes !== undefined) text = new TextDecoder().decode(bytes)
      throw new GitHubApiError(
        response.status,
        githubErrorMessage(response.status, json, text),
        json,
      )
    }
    return {
      status: response.status,
      headers: headerMap,
      ...(json !== undefined ? { json } : {}),
      ...(bytes !== undefined ? { bytes } : {}),
    }
  }
}

export function githubTokenFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  // `||`, not `??`: an exported-but-empty GITHUB_TOKEN (a templated .env or
  // unit file) must not mask a valid GH_TOKEN.
  const token = env.GITHUB_TOKEN || env.GH_TOKEN
  return token !== undefined && token !== '' ? token : undefined
}

/** Subprocess seam for the gh CLI credential probe: argv and an abort signal
 * in; exit code, stdout, and stderr out. The workspace module's `spawnExec`
 * satisfies it and is the default; callers that own a richer exec seam adapt
 * it so tests never reach a real `gh`. The signal is the probe's deadline. */
export type GitHubCliExec = (
  cmd: string[],
  opts: { signal: AbortSignal },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

/** How long the gh probe may take before it is treated as "no credential".
 * `gh auth token` never prompts, so anything this slow is a wedged keyring. */
export const GH_CLI_TOKEN_TIMEOUT_MS = 10_000

/** The argv of the gh CLI credential probe. Exported so exec seams in tests
 * can recognize it. `--hostname` pins github.com even when the operator's
 * default gh host is an enterprise instance, because the transport only ever
 * speaks to api.github.com. */
export const GH_CLI_TOKEN_COMMAND: readonly string[] = [
  'gh',
  'auth',
  'token',
  '--hostname',
  'github.com',
]

/** Outcome of one credential lookup. A miss carries the reason so a
 * fail-fast caller can say *why* (gh not installed, not logged in to
 * github.com, timed out) instead of a generic "no token". */
export type GitHubCredential = { token: string } | { token: undefined; reason: string }

/** The credential the operator stored with `gh auth login`, read through
 * `gh auth token`. Never throws: gh missing, unauthenticated, silent, or
 * slower than the deadline all resolve to a miss with its reason. The
 * deadline is enforced here — not in the spawner — so it holds for every
 * injected exec seam: the probe is aborted through the signal and its result
 * abandoned, so a wrapper script that forked the real gh and left the pipes
 * open cannot hold the caller. The probe inherits this process's environment
 * (gh reads its own keyring), so pass the process environment as `env`. */
export async function githubTokenFromGhCli(
  exec: GitHubCliExec = spawnExec,
  timeoutMs: number = GH_CLI_TOKEN_TIMEOUT_MS,
): Promise<GitHubCredential> {
  const command = GH_CLI_TOKEN_COMMAND.join(' ')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const deadline = new Promise<GitHubCredential>((resolve) => {
    controller.signal.addEventListener(
      'abort',
      () =>
        resolve({
          token: undefined,
          reason: `\`${command}\` did not answer within ${timeoutMs} ms`,
        }),
      { once: true },
    )
  })
  const probe = (async (): Promise<GitHubCredential> => {
    try {
      const result = await exec([...GH_CLI_TOKEN_COMMAND], { signal: controller.signal })
      if (result.exitCode !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim()
        return {
          token: undefined,
          reason: `\`${command}\` exited ${result.exitCode}${detail === '' ? '' : `: ${detail}`}`,
        }
      }
      const token = result.stdout.trim()
      if (token === '') return { token: undefined, reason: `\`${command}\` printed no token` }
      return { token }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return { token: undefined, reason: `\`${command}\` could not run: ${detail}` }
    }
  })()
  try {
    return await Promise.race([probe, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/** GitHub credential resolution for kernel-side forge access: `GITHUB_TOKEN`,
 * then `GH_TOKEN` ({@link githubTokenFromEnv}), then the gh CLI's stored
 * login. The environment variables serve hosted and sandboxed dispatchers,
 * which have no gh and no keyring; the gh fallback keeps a local
 * checkout-mode dispatcher working with nothing more than `gh auth login`, as
 * it did before the adapter moved off gh subprocesses. A miss names what was
 * tried. */
export async function resolveGitHubToken(
  env: Readonly<Record<string, string | undefined>>,
  exec?: GitHubCliExec,
): Promise<GitHubCredential> {
  const fromEnv = githubTokenFromEnv(env)
  if (fromEnv !== undefined) return { token: fromEnv }
  const probe = await githubTokenFromGhCli(exec)
  if (probe.token !== undefined) return probe
  return {
    token: undefined,
    reason: `GITHUB_TOKEN and GH_TOKEN are unset and ${probe.reason}`,
  }
}
