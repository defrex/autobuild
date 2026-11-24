/** The dispatcher's github ticket source resolves a real checkout's origin. */
import { afterEach, describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TicketsConfig } from '../config/schema'
import { createPluginRegistry } from '../plugins/registry'
import { FakeGitHubIssues } from '../ports/tickets/github-fake'
import { spawnExec } from '../ports/workspace/git-worktree'
import { temporaryDirectories } from '../testing/temp-directories'
import { dispatcherTicketSource } from './dispatch-tickets'

const mkdtemp = temporaryDirectories(afterEach)
const CONFIG = { source: 'github', readyState: 'ready' } as TicketsConfig
const ENV = { GITHUB_TOKEN: 't' }

async function checkout(origin?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ab-dispatch-tickets-'))
  expect((await spawnExec(['git', 'init', '-q'], { cwd: dir })).exitCode).toBe(0)
  if (origin !== undefined)
    expect(
      (
        await spawnExec(['git', 'remote', 'add', 'origin', origin], {
          cwd: dir,
        })
      ).exitCode,
    ).toBe(0)
  return dir
}

describe('dispatcherTicketSource — github over a real checkout', () => {
  // URL-form parsing is unit-tested in dispatch-tickets.test.ts; one form
  // proves real `git remote get-url origin` output reaches the source.
  test('lists ready tickets for an ssh origin read from real git', async () => {
    const origin = 'git@github.com:acme/widgets.git'
    const dir = await checkout(origin)
    const stateRoot = await mkdtemp(join(tmpdir(), 'ab-dispatch-tickets-state-'))
    const github = new FakeGitHubIssues()
    const source = await dispatcherTicketSource(
      CONFIG,
      { env: ENV, exec: spawnExec },
      { checkout: dir },
      stateRoot,
      createPluginRegistry(),
      { transport: github.transport },
    )
    const ready = github.fileIssue({
      labels: ['autobuild', 'autobuild:ready'],
    })
    const listing = await source.listReady({
      labels: ['autobuild'],
      state: 'ready',
    })
    expect(listing.tickets.map((ticket) => ticket.ref.id)).toEqual([String(ready)])
  })

  test('a checkout with no origin keeps the typed startup error', async () => {
    const dir = await checkout()
    await expect(
      dispatcherTicketSource(
        CONFIG,
        { env: ENV, exec: spawnExec },
        { checkout: dir },
        undefined,
        createPluginRegistry(),
      ),
    ).rejects.toThrow(
      '[tickets].source = "github" needs the repository\'s origin remote on github.com; set the checkout\'s origin or export AB_REPOSITORY',
    )
  })
})
