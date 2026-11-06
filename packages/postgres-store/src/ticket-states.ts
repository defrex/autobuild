import type { Exec } from './retry'
import { matchStateNames, type HostedTicketPolicy } from '@defrex/autobuild/hosted-tickets'
import type { TicketStateCount } from '@defrex/autobuild/plugin-sdk'

export function policyStateNames(policy: HostedTicketPolicy): string[] {
  const t = policy.tickets
  return [t.triageState, t.readyState, t.claimedState, t.doneState, t.createState, t.proposalState]
}

/** The optional backlog and rejected role names a policy maps. */
export function policyRoleStateNames(policy: HostedTicketPolicy): string[] {
  const t = policy.tickets
  return [t.backlogState, t.rejectedState].filter((name) => name !== undefined)
}

/** Serialize state mutations and policy publication within a project. */
export async function lockTicketStates(q: Exec, repo: string): Promise<void> {
  await q`SELECT pg_advisory_xact_lock(hashtextextended(${repo}, 731926))`
}

/** Confirm only configured names; initialized requests never acquire the mutation lock.
 * `roles` match case-insensitively, as role moves resolve them, so a role mapped
 * onto an existing state (`icebox` or `Icebox`) inserts nothing and that state,
 * with its tickets, holds the role. Lifecycle `names` keep their exact match. */
export async function seedTicketStates(
  q: Exec,
  repo: string,
  names: string[],
  roles: string[] = [],
): Promise<void> {
  const requested = [...new Set(names)]
  const roleKeys = [...new Set(roles.map((name) => name.trim().toLowerCase()))]
  if (requested.length === 0 && roleKeys.length === 0) return
  const missing = async () => {
    const rows = (
      await q`SELECT name FROM ab_ticket_states
      WHERE repo = ${repo} AND (name = ANY(${q.array(requested, 'text')})
        OR lower(btrim(name)) = ANY(${q.array(roleKeys, 'text')}))`
    ).map((row) => String(row.name))
    const exact = new Set(rows)
    const folded = new Set(rows.map((name) => name.trim().toLowerCase()))
    const unseededRoles = roles.filter((name, index) => {
      const key = name.trim().toLowerCase()
      return !folded.has(key) && roles.findIndex((n) => n.trim().toLowerCase() === key) === index
    })
    return [...requested.filter((name) => !exact.has(name)), ...unseededRoles]
  }
  if ((await missing()).length === 0) return
  await lockTicketStates(q, repo)
  for (const name of await missing()) {
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
  roles: string[] = [],
): Promise<TicketStateCount[]> {
  await seedTicketStates(q, repo, configured, roles)
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
