import { describe, expect, test } from 'bun:test'
import { isForgeFailure } from '../forge-failure'
import {
  GitHubApiError,
  classifyGitHubFailure,
  classifyGitHubGraphQLRefusal,
  githubQuotaExhaustedFailure,
  githubRateLimitSnapshot,
  githubRequestResource,
  GitHubQuotaExhaustion,
  isGitHubGraphQLUnavailable,
} from './github-transport'

const NOW = Date.parse('2026-11-17T00:00:00Z')
const PROXY = 'GitHub GraphQL is not available from Claude Code sessions. Use the REST API instead.'

/** The forge applies the refusal classifier to GraphQL requests only, after
 * the shared failure classifier. */
const classify = (error: unknown) => classifyGitHubGraphQLRefusal(classifyGitHubFailure(error, NOW))

test("the proxy's GraphQL refusal is GraphQL-unavailable, as JSON or plain text", () => {
  // The transport takes the message from a JSON body or the trimmed text.
  for (const error of [
    new GitHubApiError(403, PROXY, { message: PROXY }),
    new GitHubApiError(403, PROXY),
    new GitHubApiError(403, 'GraphQL API unavailable for this session'),
  ]) {
    const classified = classify(error)
    expect(isGitHubGraphQLUnavailable(classified)).toBe(true)
    expect(isForgeFailure(classified)).toBe(false)
    expect((classified as { forgeMessage: string }).forgeMessage).toBe(error.message)
  }
})

test('ordinary permission refusals stay plain GitHub errors', () => {
  for (const message of [
    'Resource not accessible by integration',
    'Resource protected by organization SAML enforcement.',
    'GitHub access to example/repo is not enabled for this session',
  ]) {
    const error = new GitHubApiError(403, message, { message })
    expect(classify(error)).toBe(error)
  }
  // Only a 403 qualifies, whatever the wording.
  const notFound = new GitHubApiError(404, PROXY)
  expect(classify(notFound)).toBe(notFound)
})

test('rate limits and transient failures stay ForgeFailures', () => {
  const secondary = new GitHubApiError(
    403,
    'You have exceeded a secondary rate limit. GraphQL is unavailable for now.',
  )
  const primary = new GitHubApiError(403, PROXY, undefined, {
    'x-ratelimit-remaining': '0',
    'x-ratelimit-reset': String(NOW / 1000 + 600),
  })
  const transient = new GitHubApiError(502, PROXY)
  for (const error of [secondary, primary, transient]) {
    const classified = classify(error)
    expect(isForgeFailure(classified)).toBe(true)
    expect(isGitHubGraphQLUnavailable(classified)).toBe(false)
  }
})

test('non-GitHub errors pass through unchanged', () => {
  const error = new Error(PROXY)
  expect(classifyGitHubGraphQLRefusal(error)).toBe(error)
})

test('rate-limit snapshots parse primary headers in epoch seconds and default to core', () => {
  const headers = {
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': '4210',
    'x-ratelimit-reset': '1795176000',
    'x-ratelimit-used': '790',
  }
  expect(githubRateLimitSnapshot({ ...headers, 'x-ratelimit-resource': 'graphql' })).toEqual({
    resource: 'graphql',
    limit: 5000,
    remaining: 4210,
    resetAt: new Date(1795176000 * 1000).toISOString(),
  })
  expect(githubRateLimitSnapshot(headers)?.resource).toBe('core')
  expect(githubRateLimitSnapshot({})).toBeUndefined()
  for (const garbage of ['', 'soon', '-1', '1.5', '1e3'])
    expect(githubRateLimitSnapshot({ ...headers, 'x-ratelimit-reset': garbage })).toBeUndefined()
  const { 'x-ratelimit-remaining': _remaining, ...partial } = headers
  expect(githubRateLimitSnapshot(partial)).toBeUndefined()
})

describe('quota exhaustion evidence', () => {
  const T = NOW
  const at = (ms: number) => new Date(ms).toISOString()
  const snap = (remaining: number, resetMs: number, resource = 'core') => ({
    resource,
    limit: 5000,
    remaining,
    resetAt: at(resetMs),
  })
  const ANON = 'no GitHub credential was available'

  test('remaining 0 with a valid reset is remembered until the reset passes', () => {
    const tracker = new GitHubQuotaExhaustion()
    tracker.observe(snap(0, T + 600_000), undefined, T)
    expect(tracker.admit('core', T)).toEqual({ resetAt: at(T + 600_000), seq: 1 })
    expect(tracker.admit('core', T + 599_999)?.resetAt).toBe(at(T + 600_000))
    expect(tracker.admit('core', T + 600_000)).toBeUndefined()
    expect(tracker.admit('core', T + 700_000)).toBeUndefined()
  })

  test('absent, past and implausible resets record nothing', () => {
    const tracker = new GitHubQuotaExhaustion()
    tracker.observe(undefined, undefined, T)
    tracker.observe(snap(0, T), undefined, T)
    tracker.observe(snap(0, T - 1000), undefined, T)
    tracker.observe(snap(0, T + 65 * 60_000 + 1000), undefined, T)
    expect(tracker.admit('core', T)).toBeUndefined()
    // A complete snapshot exactly at the plausibility bound still counts.
    tracker.observe(snap(0, T + 65 * 60_000), undefined, T)
    expect(tracker.admit('core', T)).toBeDefined()
    // Missing or malformed headers never produce a snapshot to observe.
    expect(
      githubRateLimitSnapshot({ 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '0' }),
    ).toBeUndefined()
    expect(
      githubRateLimitSnapshot({
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': 'soon',
      }),
    ).toBeUndefined()
  })

  test('no positive response clears or shortens an unexpired entry', () => {
    for (const reset of [T + 600_000, T + 300_000, T + 900_000])
      for (const unauthenticated of [undefined, ANON]) {
        const tracker = new GitHubQuotaExhaustion()
        tracker.observe(snap(0, T + 600_000), undefined, T)
        tracker.observe(snap(4999, reset), unauthenticated, T + 1000)
        expect(tracker.admit('core', T + 1000)?.resetAt).toBe(at(T + 600_000))
        expect(tracker.admit('core', T + 600_000)).toBeUndefined()
      }
  })

  test('an exhausted response keeps the later reset and always gets new evidence', () => {
    const tracker = new GitHubQuotaExhaustion()
    tracker.observe(snap(0, T + 600_000), undefined, T)
    tracker.observe(snap(0, T + 300_000), undefined, T)
    expect(tracker.admit('core', T)).toEqual({ resetAt: at(T + 600_000), seq: 2 })
    tracker.observe(snap(0, T + 600_000), undefined, T)
    expect(tracker.admit('core', T)?.seq).toBe(3)
    tracker.observe(snap(0, T + 900_000), undefined, T)
    expect(tracker.admit('core', T)).toEqual({ resetAt: at(T + 900_000), seq: 4 })
  })

  test('release forgets only the authorized evidence', () => {
    const tracker = new GitHubQuotaExhaustion()
    tracker.observe(snap(0, T + 600_000), undefined, T)
    const old = tracker.admit('core', T)!.seq
    tracker.observe(snap(0, T + 600_000), undefined, T)
    tracker.release('core', old)
    expect(tracker.admit('core', T)?.seq).toBe(old + 1)
    tracker.release('core', old + 1)
    expect(tracker.admit('core', T)).toBeUndefined()
    // A repository override never releases unauthenticated evidence.
    tracker.observe(snap(0, T + 600_000), ANON, T)
    const anonymous = tracker.admit('core', T)!
    tracker.release('core', anonymous.seq)
    expect(tracker.admit('core', T)?.unauthenticated).toBe(ANON)
  })

  test('credential classes are separate entries and authenticated evidence wins', () => {
    for (const order of [0, 1]) {
      const tracker = new GitHubQuotaExhaustion()
      const steps = [
        () => tracker.observe(snap(0, T + 300_000), ANON, T),
        () => tracker.observe(snap(4999, T + 3_000_000), undefined, T),
      ]
      for (const step of order ? steps.reverse() : steps) step()
      expect(tracker.admit('core', T)).toMatchObject({
        resetAt: at(T + 300_000),
        unauthenticated: ANON,
      })
    }
    const tracker = new GitHubQuotaExhaustion()
    tracker.observe(snap(0, T + 600_000), ANON, T)
    tracker.observe(snap(0, T + 300_000), undefined, T)
    const preferred = tracker.admit('core', T)
    expect(preferred?.resetAt).toBe(at(T + 300_000))
    expect(preferred?.unauthenticated).toBeUndefined()
    // The authenticated entry expires first; the unauthenticated one governs on.
    expect(tracker.admit('core', T + 300_000)).toMatchObject({
      resetAt: at(T + 600_000),
      unauthenticated: ANON,
    })
    expect(tracker.admit('core', T + 600_000)).toBeUndefined()
  })

  test('the final answer does not depend on arrival order', () => {
    const observations = [snap(0, T + 600_000), snap(3, T + 601_000), snap(0, T + 300_000)] as const
    const permutations = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ]
    for (const order of permutations) {
      const tracker = new GitHubQuotaExhaustion()
      for (const index of order) tracker.observe(observations[index], undefined, T)
      expect(tracker.admit('core', T)?.resetAt).toBe(at(T + 600_000))
      expect(tracker.admit('core', T + 600_000)).toBeUndefined()
    }
  })

  test('resources are independent and an unpredictable request is never held', () => {
    const tracker = new GitHubQuotaExhaustion()
    tracker.observe(snap(0, T + 600_000, 'graphql'), undefined, T)
    expect(tracker.admit('graphql', T)).toBeDefined()
    expect(tracker.admit('core', T)).toBeUndefined()
    expect(tracker.admit('search', T)).toBeUndefined()
    expect(tracker.admit(undefined, T)).toBeUndefined()
    tracker.observe(snap(0, T + 600_000, 'core'), undefined, T)
    tracker.release('core', tracker.admit('core', T)!.seq)
    expect(tracker.admit('graphql', T)).toBeDefined()
  })

  test('request resources are predicted conservatively', () => {
    expect(githubRequestResource('POST', 'graphql')).toBe('graphql')
    expect(githubRequestResource('GET', 'search/issues')).toBe('search')
    expect(githubRequestResource('GET', 'repos/acme/app/pulls/42')).toBe('core')
    expect(githubRequestResource('GET', '/repos/acme/app')).toBe('core')
    expect(
      githubRequestResource('POST', 'https://uploads.github.com/repos/acme/app/releases/1/assets'),
    ).toBeUndefined()
  })

  test('the synthesized failure is the rate limit a refusal would produce', () => {
    const failure = githubQuotaExhaustedFailure('core', { resetAt: at(T + 600_000) })
    expect(failure.details).toEqual({ kind: 'rate-limited', resetAt: at(T + 600_000) })
    expect(failure.message).toContain('so this request was not sent')
    const anonymous = githubQuotaExhaustedFailure('core', {
      resetAt: at(T + 600_000),
      unauthenticated: ANON,
    })
    expect(anonymous.details).toEqual({
      kind: 'rate-limited',
      resetAt: at(T + 600_000),
      unauthenticated: ANON,
    })
    expect(anonymous.message).toContain(`(request was unauthenticated: ${ANON})`)
  })
})
