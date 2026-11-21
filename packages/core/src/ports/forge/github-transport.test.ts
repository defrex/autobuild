import { expect, test } from 'bun:test'
import { isForgeFailure } from '../forge-failure'
import {
  GitHubApiError,
  classifyGitHubFailure,
  classifyGitHubGraphQLRefusal,
  githubRateLimitSnapshot,
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
