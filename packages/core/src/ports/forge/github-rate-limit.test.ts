import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { GitHubForge } from './github'
import {
  GitHubApiError,
  type GitHubRequest,
  type GitHubRequestOpts,
  type GitHubResponse,
} from './github-transport'
import { type ForgeFailure, isForgeFailure, type ForgeRequestContext } from '../forge-failure'
import { MemoryBuildStore } from '../../store/memory'
import { readForgeHealth } from '../../store/reduced-reads'
import { manualClock } from '../../testing/fixed'
import { guardForge, ForgeCooldown, type ForgeGuardScope } from '../../kernel/guarded-forge'
import { clearForgeDegradation } from '../../operator/control'

const NOW = Date.parse('2026-11-20T12:00:00.000Z')
const RESET = Math.floor(NOW / 1000) + 600
const LIMIT_HEADERS = {
  'x-ratelimit-limit': '5000',
  'x-ratelimit-remaining': '0',
  'x-ratelimit-reset': String(RESET),
  'x-ratelimit-resource': 'core',
}

type Reply = GitHubResponse | GitHubApiError
type Route = (
  method: string,
  path: string,
  opts?: GitHubRequestOpts,
) => Reply | Promise<Reply> | undefined

interface Call {
  method: string
  path: string
  opts?: GitHubRequestOpts
}

/** In-memory transport: each request is answered by the first route that
 * returns a reply; an unanswered request fails the test loudly. A route may
 * answer with a promise the test resolves by hand. `now` is the adapter's
 * clock (default: fixed at `NOW`). */
function makeForgeWith(options: { now?: () => number }, ...routes: Route[]) {
  const calls: Call[] = []
  const observed: ForgeRequestContext[] = []
  const transport: GitHubRequest = async (method, path, opts) => {
    calls.push({ method, path, ...(opts !== undefined ? { opts } : {}) })
    for (const route of routes) {
      const reply = await route(method, path, opts)
      if (reply instanceof GitHubApiError) throw reply
      if (reply !== undefined) return reply
    }
    throw new Error(`unscripted ${method} ${path}`)
  }
  const forge = new GitHubForge({
    repository: 'acme/app',
    transport,
    now: options.now ?? (() => NOW),
  })
  forge.observeRequests((context) => observed.push(context))
  return { forge, calls, observed }
}
const makeForge = (...routes: Route[]) => makeForgeWith({}, ...routes)

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
  (
    suffix: string,
    reply: (opts?: GitHubRequestOpts) => Reply | Promise<Reply> | undefined,
  ): Route =>
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

/** One read-only GraphQL request through the adapter's private seam. */
const graphqlRead = (forge: unknown): Promise<unknown> =>
  (
    forge as {
      graphql(op: string, schema: z.ZodType, query: string, vars: object): Promise<unknown>
    }
  ).graphql('rateLimit', z.unknown(), 'query { rateLimit { cost } }', {})

describe('successful exhaustion enters cooldown', () => {
  const resetAt = new Date(RESET * 1000).toISOString()
  const branch = (headers: Record<string, string>) => ok(unprotectedBranch, headers)
  const healthy = {
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': '4999',
    'x-ratelimit-reset': String(RESET),
  }
  const ANON = 'no GitHub credential was available'
  async function rejection(work: Promise<unknown>): Promise<unknown> {
    return work.then(
      () => {
        throw new Error('expected a rejection')
      },
      (caught: unknown) => caught,
    )
  }
  async function expectPreempted(work: Promise<unknown>, at = resetAt): Promise<ForgeFailure> {
    const error = await rejection(work)
    expect(isForgeFailure(error)).toBe(true)
    const failure = error as ForgeFailure
    expect(failure.details).toMatchObject({ kind: 'rate-limited', resetAt: at })
    expect(failure.message).toContain('this request was not sent')
    return failure
  }
  /** Let in-flight operations reach the transport, with no timer. */
  async function settle(done: () => boolean): Promise<void> {
    for (let turn = 0; turn < 10_000 && !done(); turn++) await Promise.resolve()
    expect(done()).toBe(true)
  }
  function deferred() {
    let resolve!: (reply: Reply) => void
    const promise = new Promise<Reply>((done) => {
      resolve = done
    })
    return { promise, resolve }
  }

  test('a 200 reporting 0 remaining keeps its result and holds the next request for that quota', async () => {
    const { forge, calls, observed } = makeForge(on('branches/main', () => branch(LIMIT_HEADERS)))
    expect(await forge.remoteBranchSha('main')).toBe('sha-main')
    expect([calls.length, observed.length]).toEqual([1, 1])
    await expectPreempted(forge.remoteBranchSha('main'))
    await expectPreempted(forge.getPrState('/ws', 42))
    // Nothing was sent, and a skipped call is not a provider request.
    expect([calls.length, observed.length]).toEqual([1, 1])
  })

  test('a 304 reporting 0 remaining does the same', async () => {
    const { forge, calls } = makeForge(
      on('branches/main', (opts) =>
        conditional(opts) === '"b"' ? notModified(LIMIT_HEADERS) : branch({ etag: '"b"' }),
      ),
    )
    expect(await forge.remoteBranchSha('main')).toBe('sha-main')
    expect(await forge.remoteBranchSha('main')).toBe('sha-main')
    expect(calls).toHaveLength(2)
    await expectPreempted(forge.remoteBranchSha('main'))
    expect(calls).toHaveLength(2)
  })

  test('the next request is sent once the reset passes', async () => {
    let now = NOW
    let headers: Record<string, string> = LIMIT_HEADERS
    const { forge, calls } = makeForgeWith(
      { now: () => now },
      on('branches/main', () => branch(headers)),
    )
    await forge.remoteBranchSha('main')
    now = RESET * 1000 - 1
    await expectPreempted(forge.remoteBranchSha('main'))
    now = RESET * 1000
    headers = healthy
    expect(await forge.remoteBranchSha('main')).toBe('sha-main')
    expect(calls).toHaveLength(2)
  })

  test('a nonexhausted success, or one without a valid plausible reset, holds nothing', async () => {
    const replies: Record<string, string>[] = [
      healthy,
      { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '0' },
      { ...LIMIT_HEADERS, 'x-ratelimit-reset': 'soon' },
      { ...LIMIT_HEADERS, 'x-ratelimit-reset': String(Math.floor(NOW / 1000) - 5) },
      { ...LIMIT_HEADERS, 'x-ratelimit-reset': String(Math.floor(NOW / 1000) + 7200) },
    ]
    for (const headers of replies) {
      const { forge, calls } = makeForge(on('branches/main', () => branch(headers)))
      await forge.remoteBranchSha('main')
      expect(await forge.remoteBranchSha('main')).toBe('sha-main')
      expect(calls).toHaveLength(2)
    }
  })

  test('core and graphql exhaustion hold only their own quota', async () => {
    const graphql =
      (headers: Record<string, string>): Route =>
      (method, path) =>
        method === 'POST' && path === 'graphql'
          ? ok({ data: { rateLimit: { cost: 1 } } }, headers)
          : undefined
    const exhaustedGraphql = { ...LIMIT_HEADERS, 'x-ratelimit-resource': 'graphql' }
    const first = makeForge(
      graphql(exhaustedGraphql),
      on('branches/main', () => branch({})),
    )
    await graphqlRead(first.forge)
    expect(await first.forge.remoteBranchSha('main')).toBe('sha-main')
    expect(first.calls.map((call) => call.path)).toEqual([
      'graphql',
      'repos/acme/app/branches/main',
    ])
    const second = makeForge(
      graphql({}),
      on('branches/main', () => branch(LIMIT_HEADERS)),
    )
    await second.forge.remoteBranchSha('main')
    await graphqlRead(second.forge)
    await expectPreempted(second.forge.remoteBranchSha('main'))
    expect(second.calls.map((call) => call.path)).toEqual([
      'repos/acme/app/branches/main',
      'graphql',
    ])
  })

  test('concurrent replies in either order never clear the exhaustion early', async () => {
    const exhausted = LIMIT_HEADERS
    for (const positiveReset of [RESET + 1, RESET])
      for (const exhaustedFirst of [true, false]) {
        let now = NOW
        const pending = [deferred(), deferred()]
        let served = 0
        const { forge, calls } = makeForgeWith(
          { now: () => now },
          on('branches/main', () => pending[served++]?.promise ?? branch(healthy)),
        )
        const reads = [forge.remoteBranchSha('main'), forge.remoteBranchSha('main')]
        await settle(() => calls.length === 2)
        const replies = [
          branch(exhausted),
          branch({
            ...healthy,
            'x-ratelimit-remaining': '3',
            'x-ratelimit-reset': String(positiveReset),
          }),
        ]
        const order = exhaustedFirst ? [0, 1] : [1, 0]
        for (const index of order) {
          pending[index]!.resolve(replies[index]!)
          await reads[index]
        }
        expect(await Promise.all(reads)).toEqual(['sha-main', 'sha-main'])
        await expectPreempted(forge.remoteBranchSha('main'))
        expect(calls).toHaveLength(2)
        now = RESET * 1000
        expect(await forge.remoteBranchSha('main')).toBe('sha-main')
        expect(calls).toHaveLength(3)
      }
  })

  test('an anonymous exhausted success holds the next request as an unauthenticated limit', async () => {
    const { forge } = makeForge(
      on('branches/main', () => ({ ...branch(LIMIT_HEADERS), unauthenticated: ANON })),
    )
    await forge.remoteBranchSha('main')
    const failure = await expectPreempted(forge.remoteBranchSha('main'))
    expect(failure.details).toEqual({ kind: 'rate-limited', resetAt, unauthenticated: ANON })
  })

  test('a refusal keeps its existing handling and is never remembered', async () => {
    const { forge, calls } = makeForge(on('branches/main', () => rateLimited()))
    for (const attempt of [1, 2]) {
      const error = await rejection(forge.remoteBranchSha('main'))
      expect(isForgeFailure(error) && error.details).toEqual({ kind: 'rate-limited', resetAt })
      expect((error as Error).message).not.toContain('not sent')
      expect(calls).toHaveLength(attempt)
    }
    const floor = makeForge(
      on('branches/main', () => new GitHubApiError(429, 'secondary rate limit exceeded')),
    )
    const error = await rejection(floor.forge.remoteBranchSha('main'))
    expect(isForgeFailure(error) && error.details).toEqual({
      kind: 'rate-limited',
      resetAt: new Date(NOW + 60_000).toISOString(),
    })
  })

  /** The adapter composed with the kernel guard over an in-memory store. */
  function guarded(
    route: (method: string, path: string) => Reply | Promise<Reply> | undefined,
    scope?: ForgeGuardScope,
  ) {
    const clock = manualClock(new Date(NOW).toISOString())
    const store = new MemoryBuildStore({ clock })
    const harness = makeForgeWith({ now: () => clock().getTime() }, route)
    const wrap = (now: () => Date = clock) =>
      guardForge(harness.forge, {
        store,
        repo: 'r',
        name: 'github',
        now,
        ...(scope !== undefined ? { scope } : {}),
      })
    const types = async () => (await store.getRepoEvents('r')).map((event) => event.type)
    const degradations = async () =>
      (await store.getRepoEvents('r')).flatMap((event) =>
        event.type === 'dispatcher.forge-degraded' ? [event.payload] : [],
      )
    const clear = () =>
      clearForgeDegradation({ store, repo: 'r', user: 'Ada', forge: 'github', reason: 'override' })
    return { ...harness, clock, store, guard: wrap(), wrap, types, degradations, clear }
  }
  const core =
    (reply: () => Reply | Promise<Reply>) =>
    (method: string, path: string): Reply | Promise<Reply> | undefined =>
      method === 'GET' && path === 'repos/acme/app/branches/main' ? reply() : undefined
  const sha = (forge: { remoteBranchSha?: (branch: string) => Promise<string> }) =>
    forge.remoteBranchSha!('main')

  test('composed with the dispatcher guard: one degradation, cooldown, then recovery', async () => {
    let headers: Record<string, string> = LIMIT_HEADERS
    const h = guarded(core(() => branch(headers)))
    expect(await sha(h.guard)).toBe('sha-main')
    await expectPreempted(sha(h.guard))
    expect(h.calls).toHaveLength(1)
    expect((await readForgeHealth(h.store, 'r'))?.resetAt).toBe(resetAt)
    expect(await h.degradations()).toHaveLength(1)
    expect(await rejection(sha(h.guard))).toBeInstanceOf(ForgeCooldown)
    expect(h.calls).toHaveLength(1)
    h.clock.set(resetAt)
    headers = healthy
    expect(await sha(h.guard)).toBe('sha-main')
    expect(h.calls).toHaveLength(2)
    expect(await h.types()).toEqual(['dispatcher.forge-degraded', 'dispatcher.forge-recovered'])
  })

  test('composed with a process guard: the cooldown stays local and is reported as attention', async () => {
    const h = guarded(
      core(() => branch(LIMIT_HEADERS)),
      { process: 'runner' },
    )
    await h.store.ensureRepo('r')
    await sha(h.guard)
    await expectPreempted(sha(h.guard))
    expect(await rejection(sha(h.guard))).toBeInstanceOf(ForgeCooldown)
    expect(h.calls).toHaveLength(1)
    const events = await h.store.getRepoEvents('r')
    expect(events.map((event) => event.type)).toEqual(['forge.credential-limited'])
    expect(events[0]?.payload).toMatchObject({ credential: 'process', resetAt })
  })

  describe('explicit recovery past remembered exhaustion', () => {
    /** Exhaustion observed, the next request pre-empted and recorded. */
    async function degraded(replies: Array<() => Reply | Promise<Reply>>) {
      let served = 0
      const h = guarded(core(() => (replies[served++] ?? (() => branch(healthy)))()))
      await sha(h.guard)
      await expectPreempted(sha(h.guard))
      expect(h.calls).toHaveLength(1)
      return h
    }

    test('a real successful probe goes out after a clear and releases the entry', async () => {
      const h = await degraded([() => branch(LIMIT_HEADERS)])
      await h.clear()
      expect(await sha(h.guard)).toBe('sha-main')
      expect(await sha(h.guard)).toBe('sha-main')
      expect(h.calls).toHaveLength(3)
      expect(await readForgeHealth(h.store, 'r')).toBeUndefined()
      expect(await h.degradations()).toHaveLength(1)
    })

    test('a real refused probe restores the cooldown', async () => {
      const h = await degraded([() => branch(LIMIT_HEADERS), () => rateLimited()])
      await h.clear()
      const error = await rejection(sha(h.guard))
      expect(isForgeFailure(error) && error.details).toEqual({ kind: 'rate-limited', resetAt })
      expect(h.calls).toHaveLength(2)
      expect((await readForgeHealth(h.store, 'r'))?.resetAt).toBe(resetAt)
      expect(await rejection(sha(h.guard))).toBeInstanceOf(ForgeCooldown)
      expect(h.calls).toHaveLength(2)
    })

    test('a re-wrapped guard still honors the clear', async () => {
      const h = await degraded([() => branch(LIMIT_HEADERS)])
      await h.clear()
      expect(await sha(h.wrap(() => h.clock()))).toBe('sha-main')
      expect(h.calls).toHaveLength(2)
    })

    test('no repository clear releases process-scoped or unauthenticated evidence', async () => {
      const anonymous = guarded(core(() => ({ ...branch(LIMIT_HEADERS), unauthenticated: ANON })))
      await anonymous.store.ensureRepo('r')
      await sha(anonymous.guard)
      await expectPreempted(sha(anonymous.guard))
      await anonymous.clear()
      // A fresh wrap has no local cooldown; the gate still defers.
      const failure = await expectPreempted(sha(anonymous.wrap(() => anonymous.clock())))
      expect(failure.details).toMatchObject({ unauthenticated: ANON })
      expect(anonymous.calls).toHaveLength(1)
      expect(await anonymous.degradations()).toHaveLength(0)

      const runner = guarded(
        core(() => branch(LIMIT_HEADERS)),
        { process: 'runner' },
      )
      await runner.store.ensureRepo('r')
      await sha(runner.guard)
      await expectPreempted(sha(runner.guard))
      await runner.clear()
      await expectPreempted(sha(runner.wrap(() => runner.clock())))
      expect(runner.calls).toHaveLength(1)
    })

    test('a core probe never releases graphql evidence', async () => {
      const h = guarded((method, path) =>
        method === 'POST' && path === 'graphql'
          ? ok(
              { data: { rateLimit: { cost: 1 } } },
              { ...LIMIT_HEADERS, 'x-ratelimit-resource': 'graphql' },
            )
          : core(() => branch(h.calls.length <= 2 ? LIMIT_HEADERS : healthy))(method, path),
      )
      await graphqlRead(h.forge)
      await sha(h.guard)
      await expectPreempted(sha(h.guard))
      await h.clear()
      expect(await sha(h.guard)).toBe('sha-main')
      expect(h.calls).toHaveLength(3)
      // The graphql evidence was never recorded, so the clear does not cover it.
      await expectPreempted(graphqlRead(h.guard))
      expect(h.calls).toHaveLength(3)
      expect(await h.degradations()).toHaveLength(2)
    })

    for (const [label, probeReset] of [
      ['the same reset', RESET],
      ['an earlier valid reset', RESET - 120],
    ] as const)
      test(`an exhausted probe success with ${label} is pre-empted next and recorded afresh`, async () => {
        const probeHeaders = { ...LIMIT_HEADERS, 'x-ratelimit-reset': String(probeReset) }
        const h = await degraded([() => branch(LIMIT_HEADERS), () => branch(probeHeaders)])
        await h.clear()
        expect(await sha(h.guard)).toBe('sha-main')
        expect(h.calls).toHaveLength(2)
        const fresh = new Date(probeReset * 1000).toISOString()
        await expectPreempted(sha(h.guard), fresh)
        expect(h.calls).toHaveLength(2)
        const degradations = await h.degradations()
        expect(degradations).toHaveLength(2)
        expect(degradations[1]).not.toHaveProperty('continued')
        expect((await readForgeHealth(h.store, 'r'))?.resetAt).toBe(fresh)
        expect(await rejection(sha(h.guard))).toBeInstanceOf(ForgeCooldown)
        expect(h.calls).toHaveLength(2)
      })

    test('concurrent probes after one clear cannot cover newer evidence', async () => {
      for (const exhaustedFirst of [true, false]) {
        const pending = [deferred(), deferred()]
        let probe = 0
        const h = await degraded([
          () => branch(LIMIT_HEADERS),
          () => pending[probe++]!.promise,
          () => pending[probe++]!.promise,
        ])
        await h.clear()
        const probes = [sha(h.guard), sha(h.guard)]
        await settle(() => h.calls.length === 3)
        const replies = [branch(LIMIT_HEADERS), branch(healthy)]
        const order = exhaustedFirst ? [0, 1] : [1, 0]
        for (const index of order) {
          pending[index]!.resolve(replies[index]!)
          await probes[index]
        }
        expect(await Promise.all(probes)).toEqual(['sha-main', 'sha-main'])
        await expectPreempted(sha(h.guard))
        expect(h.calls).toHaveLength(3)
        expect(await h.degradations()).toHaveLength(2)
      }
    })
  })
})
