import type { Exec } from './retry'
import type { HostedTicketPolicy } from '@defrex/autobuild/hosted-tickets'

export function policyStateNames(policy: HostedTicketPolicy): string[] {
  const t = policy.tickets
  return [t.triageState, t.readyState, t.claimedState, t.doneState, t.createState, t.proposalState]
}

/** All writers share this project lock, including policy publication. */
export async function seedTicketStates(q: Exec, repo: string, names: string[]): Promise<void> {
  await q`SELECT pg_advisory_xact_lock(hashtextextended(${repo}, 731926))`
  for (const name of new Set(names)) {
    await q`INSERT INTO ab_ticket_states (repo, name) VALUES (${repo}, ${name}) ON CONFLICT DO NOTHING`
  }
}
