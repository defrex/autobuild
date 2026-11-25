import { describe, expect, test } from 'bun:test'
import { ticketSearchRequestBudget } from '../../testing/dispatch-read-budget'
import { ForgeFailure } from '../forge-failure'
import { GitHubApiError } from '../forge/github-transport'
import { TicketSourceRateLimitError } from '../types'
import { FakeGitHubIssues } from './github-fake'
import { GitHubTicketSource, githubSearchQuotaExhausted, searchWindow } from './github'
import { MemoryGitHubValidatorStore } from './github-validators'
import type { TicketLifecycle } from './lifecycle'
import { TicketSearchCursorInvalid } from './search'

const LIFECYCLE: TicketLifecycle = {
  triage: 'triage',
  ready: 'ready',
  doing: 'doing',
  done: 'done',
  create: 'triage',
  proposal: 'triage',
}
const START = Date.parse('2026-11-24T12:00:00Z')

function setup() {
  let clock = START
  const now = () => clock
  const github = new FakeGitHubIssues({ now })
  const validators = new MemoryGitHubValidatorStore()
  const tickets = new GitHubTicketSource({
    transport: github.transport,
    repository: github.repository,
    lifecycle: LIFECYCLE,
    readyLabels: [],
    validators,
    now,
  })
  const advance = (ms: number) => {
    clock += ms
  }
  return { github, tickets, validators, advance }
}

const queryOf = (github: FakeGitHubIssues, i = -1) =>
  github.requests.filter((r) => r.kind === 'search-issues').at(i)!.params!

const ids = (page: { tickets: Array<{ id: string }> }) => page.tickets.map((hit) => hit.id)

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a rejection')
}

describe('github ticket search', () => {
  test('one search request per page at 100 and 100,000 issues', async () => {
    let last: ReturnType<typeof setup> | undefined
    await ticketSearchRequestBudget(async (_population, rows) => {
      const env = setup()
      last = env
      const numbers = new Map<number, number>()
      for (const row of rows)
        numbers.set(
          row.number,
          env.github.fileIssue({
            title: row.title,
            body: row.body,
            labels: [...(row.state === 'Ready' ? ['autobuild:ready'] : []), ...row.labels],
          }),
        )
      return {
        source: env.tickets,
        reset: () => env.github.resetRequests(),
        requests: () =>
          env.github.requests.map((r) => ({
            operation: r.kind === 'search-issues' ? 'search' : r.kind,
          })),
        idOf: (row) => String(numbers.get(row.number)),
      }
    })
    // Nothing was remembered: search stores nothing.
    expect(await last!.validators.get('anything')).toBeUndefined()
  }, 60_000)

  test('scopes the query to the repository with documented syntax and quoted terms', async () => {
    const { github, tickets } = setup()
    await tickets.search({ text: 'Rate limit', limit: 20 })
    expect(queryOf(github)).toEqual({
      q: 'repo:acme/widgets is:issue in:title,body "rate" "limit"',
      sort: 'created',
      order: 'desc',
      per_page: '20',
      page: '1',
    })
    // Text that looks like search syntax stays literal words; the fake
    // answers 422 for any unquoted word or unknown qualifier.
    const hit = github.fileIssue({ title: 'repo:other/x is:pr label:x OR NOT -foo bar' })
    const page = await tickets.search({
      text: 'repo:other/x is:pr label:x OR NOT -foo "bar"',
      limit: 20,
    })
    expect(queryOf(github).q).toBe(
      'repo:acme/widgets is:issue in:title,body "repo:other/x" "is:pr" "label:x" "or" "not" "-foo" "bar"',
    )
    expect(ids(page)).toEqual([String(hit)])
  })

  test('state filters resolve as listReady does, with an exact local filter', async () => {
    const { github, tickets } = setup()
    const file = (title: string, opts: Parameters<FakeGitHubIssues['fileIssue']>[0] = {}) =>
      github.fileIssue({ title: `needle ${title}`, ...opts })
    const triage = file('triage')
    const ready = file('ready', { labels: ['autobuild:ready'] })
    const icebox = file('icebox', { labels: ['autobuild:icebox'] })
    const done = file('done', { state: 'closed' })
    const legacy = file('legacy', { state: 'closed', state_reason: null })
    const notPlanned = file('not planned', { state: 'closed', state_reason: 'not_planned' })
    github.openPullRequest('needle pr')
    const search = async (state?: string) => {
      const page = await tickets.search({ text: 'needle', limit: 50, ...(state ? { state } : {}) })
      return { ids: ids(page).sort(), q: queryOf(github).q, page }
    }
    const all = await search()
    expect(all.ids).toEqual([triage, ready, icebox, done, legacy, notPlanned].map(String).sort())
    expect(Object.fromEntries(all.page.tickets.map((hit) => [hit.id, hit.state]))).toEqual({
      [triage]: 'triage',
      [ready]: 'ready',
      [icebox]: 'icebox',
      [done]: 'done',
      [legacy]: 'done',
      [notPlanned]: 'not-planned',
    })
    const s = (n: number) => [String(n)]
    let r = await search('Ready')
    expect(r.q).toContain('is:open label:"autobuild:ready"')
    expect(r.ids).toEqual(s(ready))
    r = await search('triage')
    expect(r.q).toContain('is:open -label:"autobuild:ready" -label:"autobuild:doing"')
    expect(r.ids).toEqual(s(triage))
    r = await search('icebox')
    expect(r.q).toContain('is:open label:"autobuild:icebox"')
    expect(r.ids).toEqual(s(icebox))
    r = await search('done')
    expect(r.q).toContain('is:closed')
    expect(r.q).not.toContain('reason:')
    expect(r.ids).toEqual([done, legacy].map(String).sort())
    const listed = await tickets.listReady({ state: 'done' })
    expect(listed.tickets.map((t) => t.ref.id).sort()).toEqual(r.ids)
    r = await search('not-planned')
    expect(r.q).toContain('is:closed -reason:completed')
    expect(r.ids).toEqual(s(notPlanned))
  })

  test('hits come from the search response alone', async () => {
    const { github, tickets } = setup()
    const node = github.fileIssue({ title: 'needle node', labels: ['node', 'autobuild:ready'] })
    const child = github.fileIssue({
      title: 'needle child',
      body: 'secret body',
      labels: ['autobuild:ready', 'autobuild:proposal', 'autobuild-link:closes #7', 'area'],
    })
    github.uiAddSubIssue(node, child)
    const bad = github.fileIssue({
      title: 'needle bad',
      labels: ['autobuild:ready', 'autobuild:doing'],
    })
    github.resetRequests()
    const page = await tickets.search({ text: 'needle', limit: 20 })
    expect(github.requests.map((r) => r.kind)).toEqual(['search-issues'])
    expect(page.tickets).toEqual([
      {
        id: String(child),
        title: 'needle child',
        state: 'ready',
        labels: ['autobuild:proposal', 'area'],
        kind: 'work',
      },
      { id: String(node), title: 'needle node', state: 'ready', labels: ['node'], kind: 'node' },
    ])
    expect(page.diagnostics).toEqual([
      `github #${bad}: has 2 state labels (autobuild:ready, autobuild:doing); a ticket holds one state — remove all but one`,
    ])
  })

  test('refuses bad input before any request', async () => {
    const { github, tickets } = setup()
    const refusals: Array<
      [Parameters<GitHubTicketSource['search']>[0], RegExp | typeof TicketSearchCursorInvalid]
    > = [
      [{ text: '" ""', limit: 5 }, /no searchable words/],
      [{ text: 'x'.repeat(260), limit: 5 }, /at most 256/],
      [{ text: 'needle', labels: ['a"b'], limit: 5 }, /double quote/],
      [{ text: 'needle', cursor: '5', limit: 5 }, TicketSearchCursorInvalid],
      [{ text: 'needle', cursor: 'garbage', limit: 5 }, TicketSearchCursorInvalid],
    ]
    for (const [query, expected] of refusals) {
      const error = await rejection(tickets.search(query))
      if (expected instanceof RegExp) expect(error.message).toMatch(expected)
      else expect(error).toBeInstanceOf(expected)
    }
    for (let i = 0; i < 7; i++) github.fileIssue({ title: 'needle' })
    const page = await tickets.search({ text: 'needle', limit: 5 })
    github.resetRequests()
    for (const query of [
      { text: 'other', cursor: page.cursor! },
      { text: 'needle', state: 'ready', cursor: page.cursor! },
      { text: 'needle', cursor: `1000.${page.cursor!.split('.')[1]}` },
    ])
      expect(await rejection(tickets.search({ ...query, limit: 5 }))).toBeInstanceOf(
        TicketSearchCursorInvalid,
      )
    expect(github.requests).toEqual([])
  })

  test('cursor walk pages newest first and survives a limit change', async () => {
    const { github, tickets } = setup()
    const filed = Array.from({ length: 12 }, (_, i) => github.fileIssue({ title: `needle ${i}` }))
    const newest = filed.map(String).reverse()
    const sizes: number[] = []
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = await tickets.search({ text: 'needle', limit: 5, ...(cursor ? { cursor } : {}) })
      sizes.push(page.tickets.length)
      seen.push(...ids(page))
      cursor = page.cursor
    } while (cursor !== undefined)
    expect(sizes).toEqual([5, 5, 2])
    expect(seen).toEqual(newest)

    const first = await tickets.search({ text: 'needle', limit: 5 })
    github.resetRequests()
    const second = await tickets.search({ text: 'needle', limit: 3, cursor: first.cursor! })
    expect(github.requests).toHaveLength(1)
    expect(ids(second)[0]).toBe(newest[5])
  })

  test('never reads past the first 1,000 matches', async () => {
    const { github, tickets } = setup()
    github.seedIssues(1003)
    let cursor: string | undefined
    let last: Awaited<ReturnType<GitHubTicketSource['search']>>
    do {
      last = await tickets.search({ text: 'seeded', limit: 100, ...(cursor ? { cursor } : {}) })
      cursor = last.cursor
    } while (cursor !== undefined)
    expect(last.diagnostics).toEqual([
      'GitHub search returns only the first 1000 of 1003 matches; narrow the query',
    ])
    github.searchIncomplete = true
    expect((await tickets.search({ text: 'seeded', limit: 5 })).diagnostics).toEqual([
      'GitHub search timed out and returned partial results for this page',
    ])
  })

  test('primary search-quota exhaustion refuses only searches until the reset', async () => {
    const { github, tickets, advance } = setup()
    const ready = github.fileIssue({ title: 'needle', labels: ['autobuild:ready'] })
    github.searchRateLimit = 30
    for (let i = 0; i < 30; i++) await tickets.search({ text: 'needle', limit: 5 })
    const error = await rejection(tickets.search({ text: 'needle', limit: 5 }))
    expect(error).toBeInstanceOf(TicketSourceRateLimitError)
    expect((error as TicketSourceRateLimitError).resetAt).toBeGreaterThanOrEqual(START + 60_000)
    github.resetRequests()
    expect(await rejection(tickets.search({ text: 'needle', limit: 5 }))).toBeInstanceOf(
      TicketSourceRateLimitError,
    )
    expect(github.requests).toEqual([])
    expect((await tickets.listReady({ state: 'ready' })).tickets).toHaveLength(1)
    expect(await tickets.get(String(ready))).not.toBeNull()
    advance(61_000)
    expect(ids(await tickets.search({ text: 'needle', limit: 5 }))).toEqual([String(ready)])
  })

  const primary = {
    'x-ratelimit-resource': 'search',
    'x-ratelimit-remaining': '0',
    'x-ratelimit-reset': String(Math.ceil((START + 120_000) / 1000)),
    'x-ratelimit-limit': '30',
  }
  const secondary = 'You have exceeded a secondary rate limit. Please wait a few minutes.'
  const cases: Array<[string, number, Record<string, string>, string]> = [
    ['retry-after with a secondary message', 403, { 'retry-after': '120' }, secondary],
    ['a bare 429 retry-after', 429, { 'retry-after': '60' }, 'Too many requests'],
    [
      'exhaustion without a resource (core)',
      403,
      { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': primary['x-ratelimit-reset'] },
      'API rate limit exceeded',
    ],
    ['primary headers with a secondary message', 403, primary, secondary],
    [
      'primary headers with retry-after',
      403,
      { ...primary, 'retry-after': '90' },
      'API rate limit exceeded',
    ],
  ]
  for (const [name, status, headers, message] of cases)
    test(`a search rate limit from ${name} pauses the whole source`, async () => {
      const { github, tickets, advance } = setup()
      const ready = github.fileIssue({ title: 'needle', labels: ['autobuild:ready'] })
      github.failNext(status, headers, { message }, (_m, path) => path === 'search/issues')
      const error = (await rejection(
        tickets.search({ text: 'needle', limit: 5 }),
      )) as TicketSourceRateLimitError
      expect(error).toBeInstanceOf(TicketSourceRateLimitError)
      github.resetRequests()
      for (const read of [
        tickets.listReady({ state: 'ready' }),
        tickets.get(String(ready)),
        tickets.search({ text: 'needle', limit: 5 }),
      ])
        expect(((await rejection(read)) as TicketSourceRateLimitError).resetAt).toBe(error.resetAt)
      expect(github.requests).toEqual([])
      advance(error.resetAt - START + 1)
      expect((await tickets.listReady({ state: 'ready' })).tickets).toHaveLength(1)
      expect(ids(await tickets.search({ text: 'needle', limit: 5 }))).toEqual([String(ready)])
    })

  test('an armed source cooldown refuses search without arming the search cooldown', async () => {
    const { github, tickets, advance } = setup()
    github.fileIssue({ title: 'needle' })
    github.failNext(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' })
    const error = await rejection(tickets.listReady({ state: 'ready' }))
    github.resetRequests()
    expect(await rejection(tickets.search({ text: 'needle', limit: 5 }))).toBe(error)
    expect(github.requests).toEqual([])
    advance(61_000)
    expect((await tickets.search({ text: 'needle', limit: 5 })).tickets).toHaveLength(1)
  })

  test('classifies only confirmed primary search exhaustion as search-local', () => {
    const reset = {
      'x-ratelimit-resource': 'search',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': '1',
    }
    const api = (
      status: number,
      headers: Record<string, string>,
      message = 'API rate limit exceeded',
      body: unknown = { message },
    ) => new GitHubApiError(status, message, body, headers)
    expect(githubSearchQuotaExhausted(api(403, reset))).toBe(true)
    expect(githubSearchQuotaExhausted(api(429, reset))).toBe(true)
    const local = [
      api(403, { 'retry-after': '60' }),
      api(403, {}, secondary),
      api(403, reset, secondary),
      api(403, reset, 'Forbidden', { message: secondary }),
      api(403, { ...reset, 'retry-after': '60' }),
      api(403, reset, 'Forbidden', {
        message: 'Forbidden',
        documentation_url:
          'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api#about-secondary-rate-limits',
      }),
      api(403, { ...reset, 'x-ratelimit-resource': 'core' }),
      api(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1' }),
      api(403, { ...reset, 'x-ratelimit-remaining': '1' }),
      api(422, reset),
      new ForgeFailure('rate limited', {
        kind: 'rate-limited',
        resetAt: new Date(0).toISOString(),
      }),
    ]
    for (const error of local) expect(githubSearchQuotaExhausted(error)).toBe(false)
  })

  test('search windows start exactly at the offset and stay inside the cap', () => {
    const cases: Array<[number, number, { perPage: number; page: number }]> = [
      [0, 20, { perPage: 20, page: 1 }],
      [20, 20, { perPage: 20, page: 2 }],
      [5, 3, { perPage: 1, page: 6 }],
      [990, 20, { perPage: 10, page: 100 }],
    ]
    for (const [offset, limit, window] of cases) {
      expect(searchWindow(offset, limit)).toEqual(window)
      expect((window.page - 1) * window.perPage).toBe(offset)
      expect(offset + window.perPage).toBeLessThanOrEqual(1000)
    }
  })
})
