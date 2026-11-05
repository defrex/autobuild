import type { Exec } from './retry'
import { matchStateNames, type HostedTicketPolicy } from '@defrex/autobuild/hosted-tickets'
import type { TicketStateCount } from '@defrex/autobuild/plugin-sdk'

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

/** Bounded state counts: the project's state names plus one primary-key probe
 * per matched name in the trigger-maintained `ab_ticket_state_counts`. It
 * never reads `ab_tickets`, so its cost does not grow with ticket population. */
export async function readTicketStateCounts(
  q: Exec,
  repo: string,
  configured: string[],
  names: readonly string[],
): Promise<TicketStateCount[]> {
  await seedTicketStates(q, repo, configured)
  const existing = (await q`SELECT name FROM ab_ticket_states WHERE repo = ${repo}`).map((row) =>
    String(row.name),
  )
  const matched = matchStateNames(names, existing)
  if (matched.length === 0) return []
  const rows = await q`SELECT state, tickets::integer AS tickets FROM ab_ticket_state_counts
    WHERE repo = ${repo} AND state = ANY(${q.array(matched, 'text')})`
  const counts = new Map(rows.map((row) => [String(row.state), Number(row.tickets)]))
  return matched.map((name) => ({ name, tickets: counts.get(name) ?? 0 }))
}
