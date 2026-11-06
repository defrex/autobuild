import { describe, expect, test } from 'bun:test'
import { describeTicketSourceContract } from './contract'
import { FakeGitHubIssues } from './github-fake'
import { GitHubTicketSource } from './github'
import type { TicketLifecycle } from './lifecycle'

const LIFECYCLE: TicketLifecycle = {
  triage: 'triage',
  ready: 'ready',
  doing: 'doing',
  done: 'done',
  create: 'triage',
  proposal: 'triage',
}

function setup(
  opts: { lifecycle?: Partial<TicketLifecycle>; readyLabels?: string[]; now?: () => number } = {},
) {
  const github = new FakeGitHubIssues(opts.now ? { now: opts.now } : {})
  const source = new GitHubTicketSource({
    transport: github.transport,
    repository: github.repository,
    lifecycle: { ...LIFECYCLE, ...opts.lifecycle },
    readyLabels: opts.readyLabels ?? [],
    ...(opts.now ? { now: opts.now } : {}),
  })
  return { github, source }
}

describeTicketSourceContract('github', async () => {
  const { source } = setup()
  return {
    source,
    states: { ready: 'ready', claimed: 'doing', completed: 'done' },
    editableLabel: 'contract-editable',
    intrinsicIssueLinks: (ticket) => [{ issue: Number(ticket.ref.id), intent: 'closes' }],
  }
})
