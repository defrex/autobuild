/**
 * GitHub REST transport seam, shared by the forge adapter and its PR
 * attachment hosting. Kept dependency-free so both can import it without a
 * cycle, and so tests inject a fake transport instead of shelling `gh`.
 */
import { z } from 'zod'

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
 * `upload_url`). Non-2xx responses throw {@link GitHubApiError}.
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

/** Production transport: token-authenticated fetch against api.github.com.
 * The token comes from `GITHUB_TOKEN ?? GH_TOKEN` unless overridden. */
export function createGitHubFetchTransport(opts: {
  token?: string
  apiBase?: string
}): GitHubRequest {
  const token = opts.token
  const base = opts.apiBase ?? GITHUB_API_BASE
  return async (method, path, request = {}) => {
    const url = /^https:\/\//i.test(path) ? path : `${base}/${path.replace(/^\/+/, '')}`
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
    const contentType = headerMap['content-type'] ?? ''
    const text = await response.text()
    let json: unknown
    let bytes: Uint8Array | undefined
    if (contentType.includes('application/json')) {
      try {
        json = JSON.parse(text)
      } catch {
        // A non-JSON body behind a JSON content type is ordinary garbage.
      }
    } else if (text.length > 0) {
      bytes = new TextEncoder().encode(text)
    }
    if (!response.ok) {
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
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN
  return token !== undefined && token !== '' ? token : undefined
}
