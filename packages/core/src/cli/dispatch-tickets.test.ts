/** The dispatcher's ticket source resolves a github origin from the checkout. */
import { describe, expect, test } from 'bun:test'
import type { TicketsConfig } from '../config/schema'
import { createPluginRegistry } from '../plugins/registry'
import { FakeGitHubIssues } from '../ports/tickets/github-fake'
import type { Exec } from '../ports/workspace/git-worktree'
import { dispatcherTicketSource } from './dispatch-tickets'

const CONFIG = { source: 'github', readyState: 'ready' } as TicketsConfig
const CHECKOUT = '/work/widgets'
const ENV = { GITHUB_TOKEN: 't' }

function recordingExec(result: { exitCode: number; stdout: string }) {
  const calls: Array<{ argv: string[]; cwd: string | undefined }> = []
  const exec: Exec = async (argv, opts) => {
    calls.push({ argv: [...argv], cwd: opts?.cwd })
    return { ...result, stderr: '' }
  }
  return { exec, calls }
}

async function listsReady(
  github: FakeGitHubIssues,
  source: Awaited<ReturnType<typeof dispatcherTicketSource>>,
) {
  const ready = github.fileIssue({ labels: ['autobuild', 'autobuild:ready'] })
  const listing = await source.listReady({
    labels: ['autobuild'],
    state: 'ready',
  })
  expect(listing.tickets.map((ticket) => ticket.ref.id)).toEqual([String(ready)])
  const rest = github.requests.filter((request) => request.path !== 'graphql')
  expect(rest.length).toBeGreaterThan(0)
  for (const request of rest) expect(request.path).toContain('repos/acme/widgets')
}

describe('dispatcherTicketSource — github', () => {
  for (const origin of ['git@github.com:acme/widgets.git', 'https://github.com/acme/widgets.git'])
    test(`checkout mode resolves ${origin} from the checkout, not the identity`, async () => {
      const github = new FakeGitHubIssues()
      const { exec, calls } = recordingExec({
        exitCode: 0,
        stdout: `${origin}\n`,
      })
      const source = await dispatcherTicketSource(
        CONFIG,
        { env: ENV, exec },
        { checkout: CHECKOUT },
        undefined,
        createPluginRegistry(),
        { transport: github.transport },
      )
      expect(calls).toEqual([{ argv: ['git', 'remote', 'get-url', 'origin'], cwd: CHECKOUT }])
      expect(source.name).toBe('github')
      await listsReady(github, source)
    })

  test('origin mode takes the repository and spawns nothing', async () => {
    const github = new FakeGitHubIssues()
    const { exec, calls } = recordingExec({ exitCode: 128, stdout: '' })
    const source = await dispatcherTicketSource(
      CONFIG,
      { env: ENV, exec, repository: 'git@github.com:acme/widgets.git' },
      { checkout: '/scratch/origin-root' },
      undefined,
      createPluginRegistry(),
      { transport: github.transport },
    )
    expect(calls).toEqual([])
    await listsReady(github, source)
  })

  test('origin mode with AB_REPOSITORY resolves the same coordinates', async () => {
    const github = new FakeGitHubIssues()
    const { exec, calls } = recordingExec({ exitCode: 128, stdout: '' })
    const repository = 'https://github.com/acme/widgets'
    const source = await dispatcherTicketSource(
      CONFIG,
      { env: { ...ENV, AB_REPOSITORY: repository }, exec, repository },
      { checkout: '/scratch/origin-root' },
      undefined,
      createPluginRegistry(),
      { transport: github.transport },
    )
    expect(calls).toEqual([])
    await listsReady(github, source)
  })

  test('a checkout with no origin keeps the typed startup error', async () => {
    const { exec } = recordingExec({ exitCode: 2, stdout: '' })
    await expect(
      dispatcherTicketSource(
        CONFIG,
        { env: ENV, exec },
        { checkout: CHECKOUT },
        undefined,
        createPluginRegistry(),
      ),
    ).rejects.toThrow(
      '[tickets].source = "github" needs the repository\'s origin remote on github.com; set the checkout\'s origin or export AB_REPOSITORY',
    )
  })

  test('a checkout whose origin is off github.com keeps the typed startup error', async () => {
    const { exec } = recordingExec({
      exitCode: 0,
      stdout: 'https://gitlab.com/acme/widgets\n',
    })
    await expect(
      dispatcherTicketSource(
        CONFIG,
        { env: ENV, exec },
        { checkout: CHECKOUT },
        undefined,
        createPluginRegistry(),
      ),
    ).rejects.toThrow(
      '[tickets].source = "github" needs an origin on github.com; origin is https://gitlab.com/acme/widgets',
    )
  })
})
