import { describe, expect, test } from 'bun:test'
import { GitHubForge } from './github'
import {
  GitHubApiError,
  type GitHubRequest,
  type GitHubRequestOpts,
  type GitHubResponse,
} from './github-transport'
import { isForgeFailure, type ForgeRequestContext } from '../forge-failure'

const NOW = Date.parse('2026-11-20T12:00:00.000Z')
const RESET = Math.floor(NOW / 1000) + 600
const LIMIT_HEADERS = {
  'x-ratelimit-limit': '5000',
  'x-ratelimit-remaining': '0',
  'x-ratelimit-reset': String(RESET),
  'x-ratelimit-resource': 'core',
}

type Reply = GitHubResponse | GitHubApiError
type Route = (method: string, path: string, opts?: GitHubRequestOpts) => Reply | undefined

interface Call {
  method: string
  path: string
  opts?: GitHubRequestOpts
}

/** In-memory transport: each request is answered by the first route that
 * returns a reply; an unanswered request fails the test loudly. */
function makeForge(...routes: Route[]) {
  const calls: Call[] = []
  const observed: ForgeRequestContext[] = []
  const transport: GitHubRequest = async (method, path, opts) => {
    calls.push({ method, path, ...(opts !== undefined ? { opts } : {}) })
    for (const route of routes) {
      const reply = route(method, path, opts)
      if (reply instanceof GitHubApiError) throw reply
      if (reply !== undefined) return reply
    }
    throw new Error(`unscripted ${method} ${path}`)
  }
  const forge = new GitHubForge({ repository: 'acme/app', transport, now: () => NOW })
  forge.observeRequests((context) => observed.push(context))
  return { forge, calls, observed }
}

const ok = (json: unknown, headers: Record<string, string> = {}): GitHubResponse => ({
  status: 200,
  headers,
  json,
})
const notModified = (headers: Record<string, string> = {}): GitHubResponse => ({
  status: 304,
  headers,
})
const rateLimited = () =>
  new GitHubApiError(403, 'API rate limit exceeded for installation', undefined, LIMIT_HEADERS)
const on =
  (suffix: string, reply: (opts?: GitHubRequestOpts) => Reply | undefined): Route =>
  (method, path, opts) =>
    method === 'GET' && path === `repos/acme/app/${suffix}` ? reply(opts) : undefined
const conditional = (opts?: GitHubRequestOpts) => opts?.headers?.['If-None-Match']
async function expectForgeFailure(work: Promise<unknown>): Promise<void> {
  const error = await work.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  expect(isForgeFailure(error)).toBe(true)
}

const protectedBranch = {
  protected: true,
  commit: { sha: 'sha-main' },
  protection: {
    required_status_checks: { checks: [{ context: 'ci' }], contexts: [] },
    required_pull_request_reviews: null,
    restrictions: null,
  },
}
const unprotectedBranch = {
  protected: false,
  commit: { sha: 'sha-main' },
  protection: { enabled: false, required_status_checks: { enforcement_level: 'off' } },
}

describe('rate-limit snapshot capture', () => {
  test('observers receive the primary limit on 200, 304 and a limited failure', async () => {
    let served = 0
    const { forge, observed } = makeForge(
      on('branches/main', () =>
        ++served === 1
          ? ok(unprotectedBranch, {
              etag: '"b1"',
              'x-ratelimit-limit': '5000',
              'x-ratelimit-remaining': '4210',
              'x-ratelimit-reset': String(RESET),
            })
          : served === 2
            ? notModified({
                'x-ratelimit-limit': '5000',
                'x-ratelimit-remaining': '4210',
                'x-ratelimit-reset': String(RESET),
                'x-ratelimit-resource': 'core',
              })
            : rateLimited(),
      ),
    )
    await forge.remoteBranchSha('main')
    await forge.remoteBranchSha('main')
    await expectForgeFailure(forge.remoteBranchSha('main'))
    const resetAt = new Date(RESET * 1000).toISOString()
    expect(observed.map((context) => [context.outcome, context.rateLimit])).toEqual([
      ['restPrimary', { resource: 'core', limit: 5000, remaining: 4210, resetAt }],
      ['restNotModified', { resource: 'core', limit: 5000, remaining: 4210, resetAt }],
      ['restPrimary', { resource: 'core', limit: 5000, remaining: 0, resetAt }],
    ])
  })

  test('a response without complete headers carries no snapshot', async () => {
    const { forge, observed } = makeForge(
      on('branches/main', () => ok(unprotectedBranch, { 'x-ratelimit-remaining': '12' })),
    )
    await forge.remoteBranchSha('main')
    expect(observed).toHaveLength(1)
    expect(observed[0]?.rateLimit).toBeUndefined()
  })
})

describe('rate-limited and unreadable reads fail closed', () => {
  test('getPrState rejects a limited poll, never reporting closed or merged', async () => {
    const { forge } = makeForge(on('pulls/42', () => rateLimited()))
    await expectForgeFailure(forge.getPrState('/ws', 42))
  })

  test('inspectLandingGate rejects a limited branch or rules read', async () => {
    const branch = makeForge(
      on('branches/main', () => rateLimited()),
      on('rules/branches/main', () => ok([])),
    )
    await expectForgeFailure(branch.forge.inspectLandingGate('main'))
    const rules = makeForge(
      on('branches/main', () => ok(unprotectedBranch)),
      on('rules/branches/main', () => rateLimited()),
    )
    await expectForgeFailure(rules.forge.inspectLandingGate('main'))
  })

  test('an unparseable branch read is unproven, never proved-ungated', async () => {
    const { forge } = makeForge(
      on('branches/main', () => ok('<html>unavailable</html>')),
      on('rules/branches/main', () => ok([])),
    )
    expect((await forge.inspectLandingGate('main')).kind).toBe('unproven')
  })

  test('inspectMergeFreshness rethrows limits but keeps best-effort evidence for ordinary failures', async () => {
    const limited = makeForge(on('branches/main/protection', () => rateLimited()))
    await expectForgeFailure(limited.forge.inspectMergeFreshness('main'))
    const rulesLimited = makeForge(
      on('branches/main/protection', () => new GitHubApiError(404, 'Branch not protected')),
      on('rules/branches/main', () => rateLimited()),
    )
    await expectForgeFailure(rulesLimited.forge.inspectMergeFreshness('main'))
    const ordinary = makeForge(
      on('branches/main/protection', () => new GitHubApiError(403, 'Resource not accessible')),
      on('rules/branches/main', () => ok('garbage')),
    )
    const result = await ordinary.forge.inspectMergeFreshness('main')
    expect(result.fenced).toBe(false)
    expect(result.evidence).toHaveLength(2)
  })

  test('remoteBranchExists rethrows a limit; only a 404 proves absence', async () => {
    const limited = makeForge(on('git/ref/heads/topic', () => rateLimited()))
    await expectForgeFailure(limited.forge.remoteBranchExists('topic'))
    const absent = makeForge(on('git/ref/heads/topic', () => new GitHubApiError(404, 'Not Found')))
    expect(await absent.forge.remoteBranchExists('topic')).toBe(false)
  })

  test('a limited merge PUT is a forge failure, never a merge refusal', async () => {
    const { forge } = makeForge((method) => (method === 'PUT' ? rateLimited() : undefined))
    await expectForgeFailure(forge.squashMerge('/ws', 42, 'head-42'))
  })
})

describe('conditional revalidation of repeatable reads', () => {
  const pr = {
    state: 'open',
    merged: false,
    draft: false,
    base: { ref: 'main' },
    head: { ref: 'ab/topic', sha: 'head-42' },
  }

  test('inspectLandingPr, readCommitMessage and remoteBranchExists revalidate with If-None-Match', async () => {
    const { forge, calls } = makeForge(
      on('pulls/42', (opts) =>
        conditional(opts) === '"pr"' ? notModified() : ok(pr, { etag: '"pr"' }),
      ),
      on('commits/abc', (opts) =>
        conditional(opts) === '"c"'
          ? notModified()
          : ok({ commit: { message: 'subject' } }, { etag: '"c"' }),
      ),
      on('git/ref/heads/topic', (opts) =>
        conditional(opts) === '"r"' ? notModified() : ok({ object: { sha: 'x' } }, { etag: '"r"' }),
      ),
    )
    for (let round = 0; round < 2; round++) {
      expect((await forge.inspectLandingPr('/ws', 42)).headSha).toBe('head-42')
      expect(await forge.readCommitMessage('/ws', 'abc')).toBe('subject')
      expect(await forge.remoteBranchExists('topic')).toBe(true)
    }
    expect(calls.map((call) => conditional(call.opts) ?? null)).toEqual([
      null,
      null,
      null,
      '"pr"',
      '"c"',
      '"r"',
    ])
  })

  test('ruleset pagination replays the cached link across 304s', async () => {
    const page = (n: string) =>
      Array.from({ length: n === '1' ? 100 : 3 }, () => ({ type: 'deletion' }))
    const { forge, calls } = makeForge(
      on('branches/main', (opts) =>
        conditional(opts) === '"b"' ? notModified() : ok(unprotectedBranch, { etag: '"b"' }),
      ),
      on('rules/branches/main', (opts) => {
        const n = opts?.query?.page ?? '1'
        if (conditional(opts) === `"p${n}"`) return notModified()
        return ok(page(n), {
          etag: `"p${n}"`,
          ...(n === '1' ? { link: '<https://api.github.com/x?page=2>; rel="next"' } : {}),
        })
      }),
    )
    expect((await forge.inspectLandingGate('main')).kind).toBe('proved-ungated')
    expect((await forge.inspectLandingGate('main')).kind).toBe('proved-ungated')
    const rules = calls.filter((call) => call.path.endsWith('rules/branches/main'))
    expect(rules.map((call) => [call.opts?.query?.page, conditional(call.opts) ?? null])).toEqual([
      ['1', null],
      ['2', null],
      ['1', '"p1"'],
      ['2', '"p2"'],
    ])
  })

  test('branch consumers in one scope share one wire read and each get their own view', async () => {
    for (const fixture of [protectedBranch, unprotectedBranch]) {
      for (const gateFirst of [false, true]) {
        const { forge, calls } = makeForge(
          on('branches/main', () => ok(fixture, { etag: '"b"' })),
          on('rules/branches/main', () => ok([])),
        )
        await forge.withReadScope(async () => {
          const reads = gateFirst
            ? [forge.inspectLandingGate('main'), forge.remoteBranchSha('main')]
            : [forge.remoteBranchSha('main'), forge.inspectLandingGate('main')]
          const [first, second] = await Promise.all(reads)
          const gate = gateFirst ? first : second
          const sha = gateFirst ? second : first
          expect(sha).toBe('sha-main')
          expect((gate as { kind: string }).kind).toBe(
            fixture === protectedBranch ? 'gated' : 'proved-ungated',
          )
        })
        expect(calls.filter((call) => call.path === 'repos/acme/app/branches/main')).toHaveLength(1)
      }
    }
  })

  test('across scopes a 304 serves both branch consumers their own view', async () => {
    const { forge, calls } = makeForge(
      on('branches/main', (opts) =>
        conditional(opts) === '"b"' ? notModified() : ok(protectedBranch, { etag: '"b"' }),
      ),
      on('rules/branches/main', () => ok([])),
    )
    await forge.withReadScope(() => forge.remoteBranchSha('main'))
    await forge.withReadScope(async () => {
      expect((await forge.inspectLandingGate('main')).kind).toBe('gated')
      expect(await forge.remoteBranchSha('main')).toBe('sha-main')
    })
    const branch = calls.filter((call) => call.path === 'repos/acme/app/branches/main')
    expect(branch.map((call) => conditional(call.opts) ?? null)).toEqual([null, '"b"'])
  })

  test('a representation a caller cannot validate loses its validator', async () => {
    const { forge, calls } = makeForge(
      on('commits/abc', () => ok({ unexpected: true }, { etag: '"c"' })),
    )
    await expect(forge.readCommitMessage('/ws', 'abc')).rejects.toThrow(
      'unexpected GitHub response',
    )
    await expect(forge.readCommitMessage('/ws', 'abc')).rejects.toThrow(
      'unexpected GitHub response',
    )
    expect(calls.map((call) => conditional(call.opts) ?? null)).toEqual([null, null])
  })

  test('a mutation clears validators so the next read is unconditional', async () => {
    const { forge, calls } = makeForge(
      on('commits/abc', () => ok({ commit: { message: 'subject' } }, { etag: '"c"' })),
      (method) => (method === 'POST' ? ok({}) : undefined),
    )
    await forge.readCommitMessage('/ws', 'abc')
    await forge.commentOnPr('/ws', 42, 'plain comment')
    await forge.readCommitMessage('/ws', 'abc')
    expect(
      calls.filter((call) => call.method === 'GET').map((call) => conditional(call.opts) ?? null),
    ).toEqual([null, null])
  })
})
