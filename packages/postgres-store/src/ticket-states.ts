import type { Exec } from './retry'
import type { HostedTicketPolicy } from '@defrex/autobuild/hosted-tickets'

export function policyStateNames(policy: HostedTicketPolicy): string[] {
  const t = policy.tickets
  return [t.triageState, t.readyState, t.claimedState, t.doneState, t.createState, t.proposalState]
}

/** Serialize state mutations and policy publication within a project. */
export async function lockTicketStates(q: Exec, repo: string): Promise<void> {
  await q`SELECT pg_advisory_xact_lock(hashtextextended(${repo}, 731926))`
}

/** Confirm only configured names; initialized requests never acquire the mutation lock. */
export async function seedTicketStates(q: Exec, repo: string, names: string[]): Promise<void> {
  const requested = [...new Set(names)]
  if (requested.length === 0) return
  const present = () => q`SELECT name FROM ab_ticket_states
    WHERE repo = ${repo} AND name = ANY(${q.array(requested, 'text')})`
  if ((await present()).length === requested.length) return
  await lockTicketStates(q, repo)
  const existing = new Set((await present()).map((row) => String(row.name)))
  for (const name of requested) {
    if (!existing.has(name))
      await q`INSERT INTO ab_ticket_states (repo, name) VALUES (${repo}, ${name}) ON CONFLICT DO NOTHING`
  }
}
