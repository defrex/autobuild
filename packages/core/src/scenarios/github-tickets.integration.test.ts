/**
 * The `github` ticket source under real dispatcher ticks (SPEC §13): a ready
 * issue is claimed, built and merged, and the dispatcher's existing done
 * transition closes it as completed; a closed-unmerged PR, an abort and a
 * spec bounce leave it open in triage. Every tick reads through
 * `GitHubTicketSource` over the in-memory GitHub fake, and none of them sends
 * a GraphQL, search or comment-history request: ticks never count. No network.
 */
import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordTicketMigration } from '../kernel/ticket-migrations'
import { exportTickets, importTickets } from '../ports/tickets/migration'
import { Dispatcher, type DispatcherDeps } from '../processes/dispatcher'
import { humanActor } from '../events/envelope'
import { reduceBuild } from '../kernel/reducer'
import { FakeGitHubIssues } from '../ports/tickets/github-fake'
import { GitHubTicketSource } from '../ports/tickets/github'
import { ticketLifecycle } from '../ports/tickets/lifecycle'
import { parseConfig } from '../config/load'
import { ticketsSchema } from '../config/schema'
import { emptyTickReport, readyCriteria } from '../processes/dispatcher'
import {
  CONFIG_TOML,
  CONFORMING_BODY,
  happyHandlers,
  makeHarness,
  readyTicket,
  type E2eHarness,
} from './harness'

const SLUG = 'add-rate-limiting'
const GITHUB_TOML = CONFIG_TOML.replace(
  '[tickets]\nsource = "file"\nreadyLabels = ["autobuild"]\nreadyState = "Ready"\n',
  '[tickets]\nsource = "github"\n',
)

const harnesses: E2eHarness[] = []
afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.cleanup()
})

async function githubHarness(
  body = CONFORMING_BODY,
): Promise<{ h: E2eHarness; github: FakeGitHubIssues; issue: number }> {
  expect(GITHUB_TOML).toContain('source = "github"')
  const github = new FakeGitHubIssues()
  const source = new GitHubTicketSource({
    transport: github.transport,
    repository: github.repository,
    lifecycle: ticketLifecycle(ticketsSchema.parse({ source: 'github' })),
    readyLabels: ['autobuild'],
  })
  const issue = github.fileIssue({
    title: 'Add rate limiting',
    body,
    labels: ['autobuild', 'autobuild:ready'],
  })
  const h = await makeHarness({
    handlers: happyHandlers(),
    ticketSource: source,
    configToml: GITHUB_TOML,
  })
  harnesses.push(h)
  return { h, github, issue }
}

/** Claim and run every phase to the open PR. */
async function openPr(h: E2eHarness, github: FakeGitHubIssues, issue: number): Promise<void> {
  expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), dispatched: 1 })
  expect(github.issue(issue)?.labels).toEqual(['autobuild', 'autobuild:doing'])
  expect((await h.runLatest()).prState).toBe('open')
  expect(h.cliErrors).toEqual([])
}

function expectNoCounts(github: FakeGitHubIssues): void {
  expect(github.graphqlRequests()).toEqual([])
  expect(github.requests.filter((r) => r.path.includes('search'))).toEqual([])
  // Comment history is an explicit export/import read, never a tick's.
  expect(github.count('comments-list')).toBe(0)
}

test('a merged build closes its issue as completed, with no state label', async () => {
  const { h, github, issue } = await githubHarness()
  await openPr(h, github, issue)
  h.forge.setPrState(1, { state: 'merged', sha: 'squash-1' })
  const ticks = [await h.dispatcher.tick(), await h.dispatcher.tick()]
  expect(ticks.some((tick) => tick.merged === 1)).toBe(true)
  expect(reduceBuild(await h.events(SLUG)).outcome).toBe('merged')
  expect(github.issue(issue)).toMatchObject({
    state: 'closed',
    state_reason: 'completed',
    labels: ['autobuild'],
  })
  expect(github.comments.get(issue)?.at(-1)).toBe(`build ${SLUG} merged: https://fake.forge/pr/1`)
  expect(github.comments.get(issue)!.length).toBeGreaterThanOrEqual(1)
  expectNoCounts(github)
}, 30_000)

test('a PR closed without merging leaves the issue open in triage', async () => {
  const { h, github, issue } = await githubHarness()
  await openPr(h, github, issue)
  h.forge.setPrState(1, { state: 'closed' })
  expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), closed: 1 })
  expect(github.issue(issue)).toMatchObject({ state: 'open', labels: ['autobuild'] })
  expectNoCounts(github)
}, 30_000)

test('an aborted build leaves the issue open in triage, marked aborted', async () => {
  const { h, github, issue } = await githubHarness()
  expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), dispatched: 1 })
  expect(github.issue(issue)?.labels).toEqual(['autobuild', 'autobuild:doing'])
  await h.store.append(SLUG, {
    actor: humanActor('operator'),
    type: 'build.abort-requested',
    payload: { reason: 'not now' },
  })
  for (let i = 0; i < 3 && reduceBuild(await h.events(SLUG)).status !== 'done'; i++)
    await h.dispatcher.tick()
  expect(reduceBuild(await h.events(SLUG)).outcome).toBe('abandoned')
  expect(github.issue(issue)?.state).toBe('open')
  expect([...github.issue(issue)!.labels].sort()).toEqual(['autobuild', 'autobuild:aborted'])
  expect(github.comments.get(issue)?.at(-1)).toBe(`build ${SLUG} aborted — returned to triage`)
  expectNoCounts(github)
}, 30_000)

test('a spec bounce leaves the issue open in triage', async () => {
  const { h, github, issue } = await githubHarness('Make login better somehow.\n')
  expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), bounced: 1 })
  expect(github.issue(issue)).toMatchObject({ state: 'open', labels: ['autobuild'] })
  expect(github.comments.get(issue)).toHaveLength(1)
  expectNoCounts(github)
}, 30_000)

test('a build in flight across an import into github closes the remapped issue', async () => {
  const h = await makeHarness({ handlers: happyHandlers(), tickets: [readyTicket('AUT-9')] })
  harnesses.push(h)
  expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), dispatched: 1 })
  expect((await h.runLatest()).prState).toBe('open')
  const [build] = await h.store.listBuilds()
  const dir = await mkdtemp(join(tmpdir(), 'github-import-'))
  try {
    await exportTickets({ source: h.tickets, dir: join(dir, 'export'), repo: h.origin })
    const github = new FakeGitHubIssues()
    const source = new GitHubTicketSource({
      transport: github.transport,
      repository: github.repository,
      lifecycle: ticketLifecycle(ticketsSchema.parse({ source: 'github' })),
      readyLabels: ['autobuild'],
    })
    const result = await importTickets({
      source,
      dir: join(dir, 'export'),
      repo: h.origin,
      assets: h.store,
    })
    const issue = Number(result.mapping['AUT-9'])
    expect(issue).toBe(1001)
    await h.store.ensureRepo(h.origin)
    await recordTicketMigration(h.store, h.origin, { kind: 'human', user: 'operator' }, result)
    h.dispatcher = new Dispatcher({
      ...(h.dispatcher as unknown as { deps: DispatcherDeps }).deps,
      tickets: source,
    })
    github.resetRequests()
    h.forge.setPrState(1, { state: 'merged', sha: 'squash-1' })
    const ticks = [await h.dispatcher.tick(), await h.dispatcher.tick()]
    expect(ticks.some((tick) => tick.merged === 1)).toBe(true)
    expect(github.issue(issue)).toMatchObject({ state: 'closed', state_reason: 'completed' })
    expect(github.comments.get(issue)?.at(-1)).toBe(
      `build ${build!.slug} merged: https://fake.forge/pr/1`,
    )
    expect(github.count('comments-list')).toBe(0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 30_000)

// ── readyAssignee: each dispatcher claims only its credential owner's issues ──

const ME_TOML = GITHUB_TOML.replace(
  'source = "github"\n',
  'source = "github"\nreadyAssignee = "me"\n',
)

function sourceAs(github: FakeGitHubIssues, login: string | null): GitHubTicketSource {
  return new GitHubTicketSource({
    transport: github.transportAs(login),
    repository: github.repository,
    lifecycle: ticketLifecycle(ticketsSchema.parse({ source: 'github' })),
    readyLabels: ['autobuild'],
  })
}

function fileReady(github: FakeGitHubIssues, title: string, ...assignees: string[]): number {
  return github.fileIssue({
    title,
    body: CONFORMING_BODY,
    labels: ['autobuild', 'autobuild:ready'],
    assignees,
  })
}

test('two dispatchers with readyAssignee = "me" list disjoint ready sets', async () => {
  const github = new FakeGitHubIssues()
  const alice = fileReady(github, 'For alice', 'alice')
  const bob = fileReady(github, 'For bob', 'bob')
  fileReady(github, 'For nobody')
  const shared = fileReady(github, 'For alice and carol', 'alice', 'carol')
  const criteria = readyCriteria(parseConfig(ME_TOML))
  expect(criteria.assignee).toBe('me')
  const ready = async (login: string) =>
    (await sourceAs(github, login).listReady(criteria)).tickets.map((t) => Number(t.ref.id))
  expect(await ready('alice')).toEqual([alice, shared])
  expect(await ready('bob')).toEqual([bob])
})

test('an assignee gate adds one conditional GitHub request to each dispatcher tick', async () => {
  const userRequests = (github: FakeGitHubIssues) => github.count('user')
  // X: no gate. Y: "me" from the start. Z: "me" enabled by a reload. Y and Z
  // also hold issues their user must never claim (Z's arrives with the
  // reload); the gate narrows the ready read, so those cost nothing, and the
  // unassigned-ready report adds one conditional read.
  const x = new FakeGitHubIssues()
  fileReady(x, 'Add rate limiting', 'alice')
  const y = new FakeGitHubIssues()
  fileReady(y, 'Add rate limiting', 'alice')
  fileReady(y, 'For bob', 'bob')
  fileReady(y, 'For nobody')
  const z = new FakeGitHubIssues()
  fileReady(z, 'Add rate limiting', 'alice')

  const xSource = sourceAs(x, 'alice')
  const ySource = sourceAs(y, 'alice')
  const zSource = sourceAs(z, 'alice')
  // Dispatch startup prepares every source before its first tick.
  for (const source of [xSource, ySource, zSource]) await source.prepareReadyAssignee()
  for (const github of [x, y, z]) github.resetRequests()

  const xConfig = { current: parseConfig(GITHUB_TOML) }
  const zConfig = { current: parseConfig(GITHUB_TOML) }
  const hx = await makeHarness({
    handlers: happyHandlers(),
    ticketSource: xSource,
    configToml: GITHUB_TOML,
    getConfig: () => xConfig.current,
  })
  const hy = await makeHarness({
    handlers: happyHandlers(),
    ticketSource: ySource,
    configToml: ME_TOML,
  })
  const hz = await makeHarness({
    handlers: happyHandlers(),
    ticketSource: zSource,
    configToml: GITHUB_TOML,
    getConfig: () => zConfig.current,
  })
  harnesses.push(hx, hy, hz)

  const tick = async (h: E2eHarness, github: FakeGitHubIssues) => {
    const before = github.requests.length
    const report = await h.dispatcher.tick()
    return { report, requests: github.requests.length - before }
  }
  const unassigned = (n: number) =>
    `github #${n}: ready but unassigned — [tickets].readyAssignee claims only issues assigned to alice; assign it to make it claimable`

  // First tick: Y's gate costs X's ungated tick plus the unassigned-ready
  // read, reports the unassigned issue, and Y claims only alice's issue.
  const [x1, y1] = [await tick(hx, x), await tick(hy, y)]
  expect(x1.report).toEqual({ ...emptyTickReport(), dispatched: 1 })
  expect(y1.report).toEqual({
    ...emptyTickReport(),
    dispatched: 1,
    invalidTickets: 1,
    ticketDiagnostics: [unassigned(1003)],
  })
  expect(y1.requests).toBe(x1.requests + 1)
  expect(y.issue(1002)?.labels).toEqual(['autobuild', 'autobuild:ready'])
  expect(y.issue(1003)?.labels).toEqual(['autobuild', 'autobuild:ready'])

  // Z's first tick dispatches like X's (no gate yet). Then a reload enables
  // "me" on Z while X reloads another ready-query change: each changed
  // ready query costs the same one fresh read, and "me" adds the one
  // unassigned-ready read.
  const z1 = await tick(hz, z)
  expect(z1.requests).toBe(x1.requests)
  zConfig.current = parseConfig(ME_TOML)
  xConfig.current = parseConfig(
    GITHUB_TOML.replace('source = "github"\n', 'source = "github"\nreadyLabels = []\n'),
  )
  fileReady(z, 'For bob', 'bob')
  const [x2, z2] = [await tick(hx, x), await tick(hz, z)]
  expect(z2.requests).toBe(x2.requests + 1)
  expect(
    z.requests.findLast((r) => r.kind === 'list-issues' && r.params?.assignee !== 'none')?.params
      ?.assignee,
  ).toBe('alice')
  expect(z.issue(1002)?.labels).toEqual(['autobuild', 'autobuild:ready'])

  // Warm ticks keep matching.
  const [x3, y3, z3] = [await tick(hx, x), await tick(hy, y), await tick(hz, z)]
  expect(y3.requests).toBe(x3.requests)
  expect(z3.requests).toBe(x3.requests)
  for (const github of [x, y, z]) expect(userRequests(github)).toBe(0)
  expectNoCounts(y)
}, 30_000)

test('a ready sub-issue of a non-node grouping issue dispatches as an ordinary root leaf', async () => {
  const { h, github, issue } = await githubHarness()
  const group = github.fileIssue({ title: 'Grouping epic', labels: ['autobuild'] })
  github.uiAddSubIssue(group, issue)
  await openPr(h, github, issue)
  const state = reduceBuild(await h.events(SLUG))
  expect(state.target).toBeUndefined()
  expect(github.issue(issue)?.parent).toBe(`${github.owner}/${github.name}#${group}`)
  expect(github.issue(group)?.labels).toEqual(['autobuild'])
  expectNoCounts(github)
}, 30_000)
