import { describe, expect, test } from 'bun:test'
import type { GitHubRequest } from '../forge/github-transport'
import { TicketClaimBlockedError } from '../types'
import { FakeGitHubIssues } from './github-fake'
import { GitHubTicketSource } from './github'
import type { TicketLifecycle } from './lifecycle'

// This repository's shape: the create state is the ready state.
const LIFECYCLE: TicketLifecycle = {
  triage: 'triage',
  ready: 'ready',
  doing: 'doing',
  done: 'done',
  create: 'ready',
  proposal: 'triage',
}
const CLOCK = Date.parse('2026-11-23T22:48:00Z')
const now = () => CLOCK

function source(github: FakeGitHubIssues, transport: GitHubRequest = github.transport) {
  return new GitHubTicketSource({
    transport,
    repository: github.repository,
    lifecycle: LIFECYCLE,
    readyLabels: [],
    now,
  })
}

function setup() {
  const github = new FakeGitHubIssues({ now })
  return { github, tickets: source(github) }
}

const ready = (github: FakeGitHubIssues) => github.fileIssue({ labels: ['autobuild:ready'] })

describe('github blockers behind a lagging dependency summary', () => {
  test('reads, the ready listing and dependency states report a just-recorded blocker', async () => {
    const { github, tickets } = setup()
    const issue = ready(github)
    const blocker = github.fileIssue()
    github.staleDependencySummary = true
    github.uiAddDependency(issue, blocker)
    expect((await tickets.get(String(issue)))?.blockedBy).toEqual([String(blocker)])
    const listing = await tickets.listReady({ state: 'ready' })
    expect(listing.tickets).toHaveLength(1)
    expect(listing.tickets[0]).toMatchObject({
      blockedBy: [String(blocker)],
      blockersResolved: false,
    })
    const [state] = await tickets.dependencyStates([String(issue)])
    expect(state?.blockedBy).toEqual([String(blocker)])
  })

  test('a warm ready scan answers its dependency reads with 304s; no ready issues, no reads', async () => {
    const { github, tickets } = setup()
    expect((await tickets.listReady({ state: 'ready' })).tickets).toEqual([])
    expect(github.count('blocked-by-list')).toBe(0)
    for (let n = 0; n < 3; n++) ready(github)
    await tickets.listReady({ state: 'ready' })
    github.resetRequests()
    await tickets.listReady({ state: 'ready' })
    expect(github.primary).toBe(0)
    expect(github.count('blocked-by-list')).toBe(3)
  })

  test('claim refuses an unresolved blocker the dependency check did not evaluate', async () => {
    const { github, tickets } = setup()
    const issue = ready(github)
    const blocker = github.fileIssue()
    github.staleDependencySummary = true
    github.uiAddDependency(issue, blocker)
    github.resetRequests()
    const refused = await tickets
      .claim(String(issue), { blockedBy: [] })
      .catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(TicketClaimBlockedError)
    expect((refused as TicketClaimBlockedError).blockers).toEqual([String(blocker)])
    expect(github.writes()).toEqual([])
    expect(github.issue(issue)?.labels).toContain('autobuild:ready')
    // A blocker the dispatcher evaluated is its call (a landed node sibling).
    expect(await tickets.claim(String(issue), { blockedBy: [String(blocker)] })).toBe(true)

    const other = ready(github)
    const done = github.fileIssue({ state: 'closed', state_reason: 'completed' })
    github.uiAddDependency(other, done)
    expect(await tickets.claim(String(other), { blockedBy: [] })).toBe(true)
  })
})

describe('github create with blockers into the ready state', () => {
  test('opens staged, records every blocker, then publishes to ready', async () => {
    const github = new FakeGitHubIssues({ now })
    const probe = source(github)
    const probes: Array<{ listed: string[]; claimed: boolean }> = []
    let created: string | undefined
    const transport: GitHubRequest = async (method, path, opts) => {
      if (method === 'POST' && /\/dependencies\/blocked_by$/.test(path)) {
        created = /\/issues\/(\d+)\//.exec(path)![1]!
        const listed = (await probe.listReady({ state: 'ready' })).tickets.map((t) => t.ref.id)
        probes.push({ listed, claimed: await probe.claim(created, { blockedBy: [] }) })
      }
      return github.transport(method, path, opts)
    }
    const tickets = source(github, transport)
    const a = String(github.fileIssue())
    const b = String(github.fileIssue())
    github.staleDependencySummary = true
    github.resetRequests()
    const ticket = await tickets.create({ title: 'Dependent', body: 'Body.', blockedBy: [a, b] })
    expect(probes).toEqual([
      { listed: [], claimed: false },
      { listed: [], claimed: false },
    ])
    expect(ticket).toMatchObject({ ref: { id: created }, state: 'ready', blockedBy: [a, b] })
    expect(github.issue(Number(created))?.labels).toContain('autobuild:ready')
    const writes = github
      .writes()
      .map((r) => r.kind)
      .filter((kind) => kind !== 'label-create')
    expect(writes).toEqual(['create-issue', 'blocked-by-add', 'blocked-by-add', 'patch-issue'])
  })

  test('without blockers it opens ready in one request', async () => {
    const { github, tickets } = setup()
    const ticket = await tickets.create({ title: 'Plain', body: 'Body.' })
    expect(ticket.state).toBe('ready')
    expect(github.count('patch-issue')).toBe(0)
    expect(github.issue(Number(ticket.ref.id))?.labels).toContain('autobuild:ready')
  })

  test('a partial failure says the issue exists and leaves it in triage', async () => {
    const { github, tickets } = setup()
    const a = String(github.fileIssue())
    const b = String(github.fileIssue())
    let posts = 0
    github.failNext(500, {}, { message: 'boom' }, (method, path) => {
      if (method !== 'POST' || !path.endsWith('/dependencies/blocked_by')) return false
      return ++posts === 2
    })
    const failure = await tickets
      .create({ title: 'Dependent', body: 'Body.', blockedBy: [a, b] })
      .catch((error: unknown) => error as Error)
    expect(failure.message).toContain('was created at')
    expect(failure.message).toContain(`Blockers recorded: "${a}"`)
    expect(failure.message).toContain(`Blockers not recorded: "${b}"`)
    expect(failure.message).toContain('left in triage instead of ready')
    expect(failure.message).toContain('ab ticket move')
    const number = Number(/ticket "(\d+)"/.exec(failure.message)![1])
    expect(github.issue(number)?.labels.filter((l) => l.startsWith('autobuild:'))).toEqual([])
  })

  test('a rate limit on the first blocker still says the issue exists', async () => {
    const { github, tickets } = setup()
    const a = String(github.fileIssue())
    github.failNext(
      403,
      { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(CLOCK / 1000 + 600) },
      { message: 'API rate limit exceeded' },
      (method, path) => method === 'POST' && path.endsWith('/dependencies/blocked_by'),
    )
    const failure = await tickets
      .create({ title: 'Dependent', body: 'Body.', blockedBy: [a] })
      .catch((error: unknown) => error as Error)
    expect(failure.message).toContain('was created at')
    expect(failure.message).toContain('left in triage instead of ready')
  })

  test('a keyed retry adopts the staged issue, records the rest and publishes it', async () => {
    const { github, tickets } = setup()
    const a = String(github.fileIssue())
    const b = String(github.fileIssue())
    const key = { idempotencyKey: 'k-1', idempotencyKeyReservedAt: new Date(CLOCK).toISOString() }
    const draft = { title: 'Dependent', body: 'Body.', blockedBy: [a, b] }
    let posts = 0
    github.failNext(500, {}, { message: 'boom' }, (method, path) => {
      if (method !== 'POST' || !path.endsWith('/dependencies/blocked_by')) return false
      return ++posts === 2
    })
    const failure = await tickets.create(draft, key).catch((error: unknown) => error as Error)
    expect(failure.message).toContain('already exists')
    const ticket = await tickets.create(draft, key)
    expect(ticket).toMatchObject({ state: 'ready', blockedBy: [a, b] })
    expect(github.count('create-issue')).toBe(1)
  })
})
