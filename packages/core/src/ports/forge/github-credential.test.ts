/** The credential safeguard: processes that must hold a GitHub credential
 * refuse to send anonymous requests, and an anonymous rate limit says so. */
import { afterEach, describe, expect, test } from 'bun:test'
import { ForgeCredentialMissing, isForgeFailure } from '../forge-failure'
import { GitHubForge } from './github'
import {
  classifyGitHubFailure,
  createGitHubFetchTransport,
  GITHUB_REQUIRE_CREDENTIAL_ENV,
  githubCredentialRequirement,
} from './github-transport'

const original = globalThis.fetch
const calls: { url: string; init: RequestInit }[] = []
function answer(respond: () => Response): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return respond()
  }) as typeof fetch
}
afterEach(() => {
  globalThis.fetch = original
  calls.length = 0
})

const limited = () =>
  Response.json(
    { message: 'API rate limit exceeded for 3.86.63.34.' },
    {
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' },
    },
  )

describe('githubCredentialRequirement', () => {
  test('the marker requires a credential; an explicit label wins; anything else allows anonymous', () => {
    expect(githubCredentialRequirement({ [GITHUB_REQUIRE_CREDENTIAL_ENV]: '1' })).toBe(
      'remote guest process',
    )
    expect(githubCredentialRequirement({ [GITHUB_REQUIRE_CREDENTIAL_ENV]: '1' }, 'backend')).toBe(
      'backend',
    )
    expect(githubCredentialRequirement({}, 'backend')).toBe('backend')
    expect(githubCredentialRequirement({})).toBeUndefined()
    expect(githubCredentialRequirement({ [GITHUB_REQUIRE_CREDENTIAL_ENV]: '0' })).toBeUndefined()
  })
})

describe('createGitHubFetchTransport credential requirement', () => {
  test('a required credential miss throws ForgeCredentialMissing and never sends', async () => {
    answer(() => Response.json({}))
    const transport = createGitHubFetchTransport({
      token: async () => ({ token: undefined, reason: 'GITHUB_TOKEN and GH_TOKEN are unset' }),
      requireCredential: 'build-runner b',
    })
    const error = await transport('GET', 'repos/acme/app').catch((caught) => caught)
    expect(error).toBeInstanceOf(ForgeCredentialMissing)
    expect(error).toMatchObject({
      process: 'build-runner b',
      credential: 'GITHUB_TOKEN or GH_TOKEN',
      reason: 'GITHUB_TOKEN and GH_TOKEN are unset',
    })
    expect(isForgeFailure(error)).toBe(false)
    expect(calls).toEqual([])
  })

  test('an anonymous rate limit classifies with its miss reason; an authenticated one without', async () => {
    answer(limited)
    const anonymous = createGitHubFetchTransport({
      token: async () => ({ token: undefined, reason: 'no login' }),
    })
    const failure = classifyGitHubFailure(
      await anonymous('GET', 'repos/acme/app').catch((caught) => caught),
    )
    expect(isForgeFailure(failure)).toBe(true)
    expect((failure as { details: unknown }).details).toMatchObject({
      kind: 'rate-limited',
      unauthenticated: 'no login',
    })
    const authenticated = createGitHubFetchTransport({ token: 't' })
    const owned = classifyGitHubFailure(
      await authenticated('GET', 'repos/acme/app').catch((caught) => caught),
    )
    expect(isForgeFailure(owned)).toBe(true)
    expect((owned as { details: object }).details).not.toHaveProperty('unauthenticated')
    expect(calls).toHaveLength(2)
  })
})

describe('GitHubForge credential requirement', () => {
  test('the guest marker makes a tokenless forge refuse before any request', async () => {
    answer(() => Response.json({ commit: { sha: 'head' } }))
    const forge = new GitHubForge({
      repository: 'acme/app',
      env: { [GITHUB_REQUIRE_CREDENTIAL_ENV]: '1' },
      token: async () => ({ token: undefined, reason: 'GITHUB_TOKEN and GH_TOKEN are unset' }),
    })
    await expect(forge.remoteBranchSha('main')).rejects.toBeInstanceOf(ForgeCredentialMissing)
    expect(calls).toEqual([])
  })

  test('without the marker a tokenless forge keeps sending anonymously', async () => {
    answer(() => Response.json({ commit: { sha: 'head' } }))
    const forge = new GitHubForge({
      repository: 'acme/app',
      env: {},
      token: async () => ({ token: undefined, reason: 'unset' }),
    })
    expect(await forge.remoteBranchSha('main')).toBe('head')
    expect(calls).toHaveLength(1)
    expect(new Headers(calls[0]!.init.headers).get('Authorization')).toBeNull()
  })
})
