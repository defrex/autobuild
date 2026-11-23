/**
 * GitHub REST transport seam, shared by the forge adapter and its PR
 * attachment hosting, plus the credential resolution every GitHub caller
 * shares. Imports nothing from the forge module so both can import it
 * without a cycle (the workspace module's `spawnExec` is the only production
 * dependency), and tests inject a fake transport or exec seam instead of
 * shelling `gh`.
 */
import { z } from 'zod'
import { ForgeCredentialMissing, ForgeFailure, isForgeFailure } from '../forge-failure'
import type { ForgeRateLimitObservation } from '../forge-telemetry'
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
  /** Why a successful request went out without a credential, when it did. */
  unauthenticated?: string
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

  constructor(
    status: number,
    message: string,
    body?: unknown,
    readonly headers: Record<string, string> = {},
    /** Why the request went out without a credential, when it did. */
    readonly unauthenticated?: string,
  ) {
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
 * requests), or a resolver the transport invokes lazily — a bare token or a
 * {@link GitHubCredential}, whose miss reason the transport then attaches to
 * the error of any request that had to go out anonymously. The transport asks
 * a resolver again at most once per {@link CREDENTIAL_MISS_TTL_MS}: after a
 * miss (a momentarily locked keyring is neither frozen into anonymous access
 * for the process lifetime nor re-probed on every request), and after a
 * request answers `401 Unauthorized` (a rotated or revoked `gh auth login` is
 * picked up without a restart, while a revoked-but-still-stored login cannot
 * drive a gh spawn per request). */
export type GitHubTokenSource =
  | string
  | undefined
  | (() => Promise<string | undefined | GitHubCredential>)

/** Minimum interval between two invocations of a token resolver. */
export const CREDENTIAL_MISS_TTL_MS = 60_000

/** Marks a process environment whose GitHub API requests must carry a
 * credential. Remote workspace providers set it for every guest process. */
export const GITHUB_REQUIRE_CREDENTIAL_ENV = 'AB_GITHUB_REQUIRE_CREDENTIAL'

/** The process label a transport names when it refuses an anonymous request:
 * an explicit label, else a generic one when the environment carries
 * {@link GITHUB_REQUIRE_CREDENTIAL_ENV}, else none (anonymous allowed). */
export function githubCredentialRequirement(
  env: Readonly<Record<string, string | undefined>>,
  label?: string,
): string | undefined {
  if (label !== undefined) return label
  return env[GITHUB_REQUIRE_CREDENTIAL_ENV] === '1' ? 'remote guest process' : undefined
}

/** Production transport: token-authenticated fetch against api.github.com.
 * Callers pass a literal token or a resolver such as
 * {@link githubTokenSource}; no `Authorization` header is sent when neither
 * yields one — unless `requireCredential` names the process, in which case a
 * request that would go out anonymously throws {@link ForgeCredentialMissing}
 * before anything is sent. */
export function createGitHubFetchTransport(opts: {
  token?: GitHubTokenSource
  apiBase?: string
  now?: () => number
  requireCredential?: string
}): GitHubRequest {
  const source = opts.token
  const now = opts.now ?? Date.now
  let resolved: Promise<GitHubCredential> | undefined
  /** When the current answer arrived; `undefined` while one is in flight. */
  let resolvedAt: number | undefined
  let missed = false
  const stale = (): boolean =>
    resolvedAt !== undefined && now() - resolvedAt >= CREDENTIAL_MISS_TTL_MS
  const normalize = (answer: string | undefined | GitHubCredential): GitHubCredential => {
    if (typeof answer === 'object') return answer
    return answer === undefined || answer === ''
      ? { token: undefined, reason: 'no GitHub credential was available' }
      : { token: answer }
  }
  const resolveToken = (): Promise<GitHubCredential> => {
    if (missed && stale()) resolved = undefined
    if (resolved === undefined) {
      resolvedAt = undefined
      missed = false
      const attempt = (typeof source === 'function' ? source() : Promise.resolve(source)).then(
        normalize,
      )
      resolved = attempt
      attempt.then(
        (credential) => {
          if (resolved !== attempt) return
          resolvedAt = now()
          missed = credential.token === undefined
        },
        () => {
          // A rejected probe is not an answer at all — ask again next time.
          if (resolved === attempt) resolved = undefined
        },
      )
    }
    return resolved
  }
  /** 401: the memoized token is no longer accepted. Drop it once the interval
   * has passed so the next request resolves again; inside the interval the
   * stale token keeps failing without spawning anything. */
  const forgetToken = (): void => {
    if (typeof source === 'function' && stale()) resolved = undefined
  }
  const base = opts.apiBase ?? GITHUB_API_BASE
  return async (method, path, request = {}) => {
    const credential = await resolveToken()
    const token = credential.token
    // `in` for the same strictNullChecks reason as the anonymous error below.
    const missReason =
      token === undefined || token === ''
        ? 'reason' in credential
          ? credential.reason
          : 'no GitHub credential was available'
        : undefined
    if (missReason !== undefined && opts.requireCredential !== undefined)
      throw new ForgeCredentialMissing(opts.requireCredential, missReason)
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
      return {
        status: 304,
        headers: headerMap,
        ...(missReason !== undefined ? { unauthenticated: missReason } : {}),
      }
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
      // An anonymous request that failed names why it was anonymous: a 404 on
      // a private repository is otherwise indistinguishable from a bad path,
      // and the operator's fix (export a token, or `gh auth login`) is the
      // point of the message.
      // `in` rather than relying on the `token === undefined` discriminant:
      // the plugin-sdk typecheck fixture compiles this chain without
      // strictNullChecks, where `undefined` is assignable to `string` and
      // the union stops discriminating (AUT-517).
      const anonymous =
        credential.token === undefined && 'reason' in credential
          ? ` (request was unauthenticated: ${credential.reason})`
          : ''
      throw new GitHubApiError(
        response.status,
        `${githubErrorMessage(response.status, json, text)}${anonymous}`,
        json,
        headerMap,
        missReason,
      )
    }
    return {
      status: response.status,
      headers: headerMap,
      ...(json !== undefined ? { json } : {}),
      ...(bytes !== undefined ? { bytes } : {}),
      ...(missReason !== undefined ? { unauthenticated: missReason } : {}),
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
 * (gh reads its own keyring) and needs no working directory. */
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
  // `in` rather than relying on the `token !== undefined` discriminant: the
  // plugin-sdk typecheck fixture compiles this chain without
  // strictNullChecks, where `undefined` is assignable to `string` and the
  // union stops discriminating (AUT-517). A miss always carries its reason.
  const missReason = 'reason' in probe ? probe.reason : 'no credential source succeeded'
  return {
    token: undefined,
    reason: `GITHUB_TOKEN and GH_TOKEN are unset and ${missReason}`,
  }
}

/** A transport token source over {@link resolveGitHubToken}: the builtin
 * forge's default. Resolves whenever the transport asks (first request, then
 * after a miss interval or a 401). */
export function githubTokenSource(
  env: Readonly<Record<string, string | undefined>>,
  exec?: GitHubCliExec,
): () => Promise<GitHubCredential> {
  return () => resolveGitHubToken(env, exec)
}

/** The primary rate-limit reading a response's headers carry, when they
 * carry a complete one. GitHub reports `x-ratelimit-reset` in UTC epoch
 * seconds; a missing `x-ratelimit-resource` means the `core` REST quota. */
export function githubRateLimitSnapshot(
  headers: Record<string, string>,
): ForgeRateLimitObservation | undefined {
  const integer = (value: string | undefined): number | undefined => {
    if (value === undefined || !/^\d+$/.test(value.trim())) return undefined
    const parsed = Number(value.trim())
    return Number.isSafeInteger(parsed) ? parsed : undefined
  }
  const limit = integer(headers['x-ratelimit-limit'])
  const remaining = integer(headers['x-ratelimit-remaining'])
  const reset = integer(headers['x-ratelimit-reset'])
  if (limit === undefined || remaining === undefined || reset === undefined) return undefined
  const resetAt = new Date(reset * 1000)
  if (!Number.isFinite(resetAt.getTime())) return undefined
  const named = headers['x-ratelimit-resource']?.trim()
  const resource = named !== undefined && named !== '' && named.length <= 64 ? named : 'core'
  return { resource, limit, remaining, resetAt: resetAt.toISOString() }
}

/** How far ahead an exhausted response's reset may lie and still count as
 * evidence: GitHub's primary window is one hour, plus five minutes of skew.
 * A later reset is treated as malformed. */
export const GITHUB_QUOTA_EXHAUSTION_MAX_AHEAD_MS = 65 * 60_000

/** The quota a request will consume, predicted before it is sent:
 * `graphql`, `search`, or `core` for any other API-relative path. An
 * absolute URL (release-asset upload host) is unpredictable: `undefined`. */
export function githubRequestResource(_method: string, path: string): string | undefined {
  if (path === 'graphql') return 'graphql'
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return undefined
  const relative = path.replace(/^\/+/, '')
  if (relative === 'search' || relative.startsWith('search/')) return 'search'
  return 'core'
}

/** One remembered exhausted quota, as {@link GitHubQuotaExhaustion.admit}
 * answers it. `seq` identifies the evidence: every valid exhausted
 * observation gets a new one. */
export interface GitHubQuotaExhausted {
  resetAt: string
  unauthenticated?: string
  seq: number
}

type ExhaustionEntry = { resetMs: number; unauthenticated?: string; seq: number }
type CredentialClass = 'authenticated' | 'unauthenticated'

/**
 * Quotas that a successful response reported exhausted (`remaining: 0` with
 * a plausible future reset), keyed by resource and credential class. Pure
 * and in memory; one per adapter instance.
 *
 * Evidence rules: an absent or malformed snapshot, a reset already past, or
 * one beyond {@link GITHUB_QUOTA_EXHAUSTION_MAX_AHEAD_MS} records nothing.
 * An exhausted response keeps the later of the two resets, so a stale or
 * reordered one can only keep or lengthen a cooldown. No response ever
 * clears or shortens an entry: only the reset passing ends it, or a
 * guard-authorized {@link release}. The resulting state does not depend on
 * the order responses arrive in.
 */
export class GitHubQuotaExhaustion {
  private readonly entries = new Map<string, Map<CredentialClass, ExhaustionEntry>>()
  private evidence = 0

  observe(
    snapshot: ForgeRateLimitObservation | undefined,
    unauthenticated: string | undefined,
    nowMs: number,
  ): void {
    if (snapshot === undefined || snapshot.remaining !== 0) return
    const resetMs = Date.parse(snapshot.resetAt)
    if (!Number.isFinite(resetMs) || resetMs <= nowMs) return
    if (resetMs > nowMs + GITHUB_QUOTA_EXHAUSTION_MAX_AHEAD_MS) return
    const credential: CredentialClass =
      unauthenticated !== undefined ? 'unauthenticated' : 'authenticated'
    let byClass = this.entries.get(snapshot.resource)
    if (byClass === undefined) {
      byClass = new Map()
      this.entries.set(snapshot.resource, byClass)
    }
    const previous = byClass.get(credential)
    const seq = ++this.evidence
    const latest =
      previous === undefined || previous.resetMs <= nowMs
        ? resetMs
        : Math.max(previous.resetMs, resetMs)
    byClass.set(credential, {
      resetMs: latest,
      seq,
      ...(unauthenticated !== undefined ? { unauthenticated } : {}),
    })
  }

  /** The unexpired exhaustion that governs a request for `resource`, if any.
   * Expired entries are dropped here, so expiry needs no timer. The request's
   * credential class is not known yet, so either class blocks; authenticated
   * evidence wins, because it speaks for the credential's own quota. */
  admit(resource: string | undefined, nowMs: number): GitHubQuotaExhausted | undefined {
    if (resource === undefined) return undefined
    const byClass = this.entries.get(resource)
    if (byClass === undefined) return undefined
    for (const [credential, entry] of byClass)
      if (entry.resetMs <= nowMs) byClass.delete(credential)
    if (byClass.size === 0) this.entries.delete(resource)
    const entry = byClass.get('authenticated') ?? byClass.get('unauthenticated')
    if (entry === undefined) return undefined
    return {
      resetAt: new Date(entry.resetMs).toISOString(),
      seq: entry.seq,
      ...(entry.unauthenticated !== undefined ? { unauthenticated: entry.unauthenticated } : {}),
    }
  }

  /** Forget the authenticated entry for `resource`, only while it still
   * carries the evidence `seq` an explicit override authorized. Newer
   * evidence that arrived meanwhile stays. No response path calls this. */
  release(resource: string, seq: number): void {
    const byClass = this.entries.get(resource)
    if (byClass?.get('authenticated')?.seq !== seq) return
    byClass.delete('authenticated')
    if (byClass.size === 0) this.entries.delete(resource)
  }
}

/** The failure a request for an exhausted quota fails with instead of being
 * sent: the rate limit a refusal would have produced. */
export function githubQuotaExhaustedFailure(
  resource: string,
  entry: Pick<GitHubQuotaExhausted, 'resetAt' | 'unauthenticated'>,
): ForgeFailure {
  const anonymous =
    entry.unauthenticated !== undefined
      ? ` (request was unauthenticated: ${entry.unauthenticated})`
      : ''
  return new ForgeFailure(
    `GitHub ${resource} rate limit exhausted until ${entry.resetAt}; a previous response reported 0 remaining, so this request was not sent${anonymous}`,
    {
      kind: 'rate-limited',
      resetAt: entry.resetAt,
      ...(entry.unauthenticated !== undefined ? { unauthenticated: entry.unauthenticated } : {}),
    },
  )
}

/** Documented primary and secondary limits; permission failures are ordinary errors. */
export function githubRateLimitUntil(error: unknown, now: number): string | undefined {
  if (isForgeFailure(error) && error.details.kind === 'rate-limited') return error.details.resetAt
  if (!(error instanceof GitHubApiError)) return undefined
  const limitedEnvelope = z
    .object({
      errors: z.array(
        z
          .object({
            type: z.string().optional(),
            extensions: z.object({ code: z.string().optional() }).passthrough().optional(),
          })
          .passthrough(),
      ),
    })
    .safeParse(error.body)
  const rateLimited =
    limitedEnvelope.success &&
    limitedEnvelope.data.errors.some(
      (e) => e.type === 'RATE_LIMITED' || e.extensions?.code === 'RATE_LIMITED',
    )
  if (
    error.status !== 429 &&
    !(
      (error.status === 403 || error.status === 200) &&
      (rateLimited ||
        error.headers['x-ratelimit-remaining'] === '0' ||
        /rate limit|secondary.*limit|content.creation.*limit/i.test(error.message))
    )
  )
    return undefined
  const retry = error.headers['retry-after']
  const seconds = retry === undefined ? NaN : Number(retry)
  const retryAt = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(retry ?? '')
  // The reset describes the primary quota window, even on secondary-limit responses.
  const reset =
    error.headers['x-ratelimit-remaining'] === '0'
      ? Number(error.headers['x-ratelimit-reset']) * 1000
      : NaN
  return new Date(
    Math.max(
      now + 60_000,
      Number.isFinite(retryAt) ? retryAt : 0,
      Number.isFinite(reset) ? reset : 0,
    ),
  ).toISOString()
}

/** Preserve ordinary errors; only documented limits and retryable transport failures opt in. */
export function classifyGitHubFailure(error: unknown, now = Date.now()): unknown {
  if (isForgeFailure(error)) return error
  const resetAt = githubRateLimitUntil(error, now)
  const message = error instanceof Error ? error.message : String(error)
  if (resetAt) {
    const unauthenticated = error instanceof GitHubApiError ? error.unauthenticated : undefined
    return new ForgeFailure(message, {
      kind: 'rate-limited',
      resetAt,
      ...(unauthenticated ? { unauthenticated } : {}),
    })
  }
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  if (
    (error instanceof GitHubApiError && error.status >= 500) ||
    (error instanceof TypeError && /fetch|network|socket|connection/i.test(message)) ||
    [
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'EAI_AGAIN',
      'UND_ERR_CONNECT_TIMEOUT',
    ].includes(String(code))
  )
    return new ForgeFailure(message, { kind: 'transient', retry: 'retryable' })
  return error
}

/** GitHub GraphQL refused by the environment rather than by GitHub's own
 * limits or permissions: an HTTP 403 on the GraphQL endpoint whose message
 * says GraphQL is unavailable. Claude Code's GitHub proxy answers this way
 * for every GraphQL request, whatever credential is supplied. Deliberately
 * not a `ForgeFailure`: it never drives forge cooldown or landing backoff. */
export class GitHubGraphQLUnavailable extends Error {
  readonly status = 403
  constructor(readonly forgeMessage: string) {
    super(`GitHub GraphQL is unavailable: ${forgeMessage}`)
    this.name = 'GitHubGraphQLUnavailable'
  }
}

export function isGitHubGraphQLUnavailable(error: unknown): error is GitHubGraphQLUnavailable {
  return error instanceof GitHubGraphQLUnavailable
}

const GRAPHQL_UNAVAILABLE = /\bgraphql\b[^\n]*\b(?:not available|unavailable)\b/i

/** Classify a refusal of a GraphQL request. Apply only to errors from the
 * GraphQL endpoint and only after {@link classifyGitHubFailure}, so rate
 * limits and transient failures stay `ForgeFailure`s; ordinary permission
 * 403s are returned unchanged. */
export function classifyGitHubGraphQLRefusal(error: unknown): unknown {
  if (isForgeFailure(error)) return error
  if (!(error instanceof GitHubApiError) || error.status !== 403) return error
  if (!GRAPHQL_UNAVAILABLE.test(error.message)) return error
  return new GitHubGraphQLUnavailable(error.message)
}
