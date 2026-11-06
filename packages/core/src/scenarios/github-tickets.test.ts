/**
 * The `github` ticket source under real dispatcher ticks (SPEC §13): a ready
 * issue is claimed, built and merged, and the dispatcher's existing done
 * transition closes it as completed; a closed-unmerged PR, an abort and a
 * spec bounce leave it open in triage. Every tick reads through
 * `GitHubTicketSource` over the in-memory GitHub fake, and none of them sends
 * a GraphQL or search request: ticks never count. No network.
 */
import { afterEach, expect, test } from 'bun:test'
import { humanActor } from '../events/envelope'
import { reduceBuild } from '../kernel/reducer'
import { FakeGitHubIssues } from '../ports/tickets/github-fake'
import { GitHubTicketSource } from '../ports/tickets/github'
import { ticketLifecycle } from '../ports/tickets/lifecycle'
import { ticketsSchema } from '../config/schema'
import { emptyTickReport } from '../processes/dispatcher'
import {
  CONFIG_TOML,
  CONFORMING_BODY,
  happyHandlers,
  makeHarness,
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
