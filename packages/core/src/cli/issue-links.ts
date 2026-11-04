/**
 * `ab issue downgrade <N> --reason <text>` (SPEC "Forge issue links"): an
 * agent found the build only partly resolves a linked `closes` issue. The
 * downgrade is one-way and must land before the kernel seals the links for
 * the PR; a downgrade the reducer would treat as inert is refused, or, when
 * a seal overtakes it, reported as a failure rather than a success.
 *
 * NOT a terminal: usable in any phase until the seal.
 */
import type { EventEnvelope } from '../events/catalog'
import { agentActor } from '../events/envelope'
import { formatIssueLinks } from '../ports/tickets/issue-links'
import { readBuildFacts } from '../store/reduced-reads'
import type { BuildStore } from '../store/types'
import type { CliEnv } from './env'

export interface IssueDowngradeDeps {
  store: BuildStore
  env: CliEnv
}

export interface IssueDowngradeOpts {
  issue: string
  reason: string
}

export async function downgradeIssueLink(
  deps: IssueDowngradeDeps,
  opts: IssueDowngradeOpts,
): Promise<EventEnvelope<'issue-link.downgraded'>> {
  const match = /^#?(\d+)$/.exec(opts.issue.trim())
  const issue = match === null ? Number.NaN : Number(match[1])
  if (!Number.isSafeInteger(issue) || issue <= 0)
    throw new Error(`'ab issue downgrade' expects an issue number such as 824, not "${opts.issue}"`)
  const reason = opts.reason.trim()
  if (reason === '') throw new Error("'ab issue downgrade' requires a non-empty --reason")

  const { env, store } = deps
  const before = (await readBuildFacts(store, env.build)).value.state
  if (before.issueLinksSealedSeq !== undefined)
    throw new Error(
      `issue links were sealed when the PR was prepared at seq ${before.issueLinksSealedSeq}; ` +
        "use 'ab escalate' instead",
    )
  const link = before.issueLinks.find((entry) => entry.issue === issue)
  if (link === undefined)
    throw new Error(
      before.issueLinks.length === 0
        ? `issue #${issue} is not linked: this build has no issue links`
        : `issue #${issue} is not linked; linked: ${formatIssueLinks(before.issueLinks)}`,
    )
  if (link.intent === 'refs')
    throw new Error(`issue #${issue} is already refs; nothing to downgrade`)

  const appended = await store.append(env.build, {
    actor: agentActor(env.phase, env.session),
    type: 'issue-link.downgraded',
    payload: { issue, reason },
  })
  const after = (await readBuildFacts(store, env.build)).value.state
  if (after.issueLinks.find((entry) => entry.issue === issue)?.downgrade?.seq !== appended.seq)
    throw new Error(
      `downgrade recorded at seq ${appended.seq} but inert: links were sealed at seq ` +
        `${after.issueLinksSealedSeq ?? '?'}; use 'ab escalate' instead`,
    )
  return appended
}
