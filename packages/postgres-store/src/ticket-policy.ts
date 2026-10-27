import { admitHostedRequest } from './project-lifecycle'
import { seedTicketStates, policyStateNames } from './ticket-states'
import type { Exec } from './retry'
import type { SQL } from 'bun'
import { hostedTicketPolicySchema, type HostedTicketPolicy } from '@defrex/autobuild/hosted-tickets'

export interface TicketPolicyStore {
  get(repo: string): Promise<HostedTicketPolicy | null>
  put(repo: string, policy: HostedTicketPolicy, writer: string): Promise<void>
}

/** Registration sequence scopes policy to the current project incarnation. */
export class PostgresTicketPolicyStore implements TicketPolicyStore {
  constructor(private readonly sql: SQL) {}
  async get(repo: string): Promise<HostedTicketPolicy | null> {
    const [row] = await this.sql`SELECT p.policy FROM project_ticket_policy p JOIN LATERAL
      (SELECT seq, action FROM project_journal WHERE repo = ${repo} ORDER BY seq DESC LIMIT 1) r
      ON r.seq = p.registration AND r.action = 'added' WHERE p.repo = ${repo}`
    return row
      ? hostedTicketPolicySchema.parse(
          typeof row.policy === 'string' ? JSON.parse(row.policy) : row.policy,
        )
      : null
  }
  async put(repo: string, policy: HostedTicketPolicy, writer: string): Promise<void> {
    const parsed = hostedTicketPolicySchema.parse(policy)
    await this.sql.begin(async (tx) => {
      await admitHostedRequest(tx as SQL)
      await tx`SELECT singleton FROM project_registry_state WHERE singleton = true FOR UPDATE`
      const [registration] =
        await tx`SELECT seq, action FROM project_journal WHERE repo = ${repo} ORDER BY seq DESC LIMIT 1`
      if (registration?.action !== 'added') throw new Error('project not registered')
      const [previous] =
        await tx`SELECT policy FROM project_ticket_policy WHERE repo = ${repo} AND registration = ${registration.seq}`
      const old = previous
        ? hostedTicketPolicySchema.parse(
            typeof previous.policy === 'string' ? JSON.parse(previous.policy) : previous.policy,
          )
        : undefined
      await seedTicketStates(tx as unknown as Exec, repo, [
        ...(old ? policyStateNames(old) : []),
        ...policyStateNames(parsed),
      ])
      await tx`INSERT INTO project_ticket_policy (repo, registration, policy, writer, updated_at)
        VALUES (${repo}, ${registration.seq}, ${parsed}, ${writer}, ${new Date().toISOString()})
        ON CONFLICT (repo) DO UPDATE SET registration = EXCLUDED.registration, policy = EXCLUDED.policy,
          writer = EXCLUDED.writer, updated_at = EXCLUDED.updated_at
        WHERE project_ticket_policy.registration <> EXCLUDED.registration OR project_ticket_policy.policy <> EXCLUDED.policy`
    })
  }
}

/** Explicit test seam; production always composes the PostgreSQL adapter. */
export class MemoryTicketPolicyStore implements TicketPolicyStore {
  private readonly policies = new Map<string, HostedTicketPolicy>()
  async get(repo: string) {
    return structuredClone(this.policies.get(repo) ?? null)
  }
  async put(repo: string, policy: HostedTicketPolicy, _writer: string) {
    this.policies.set(repo, hostedTicketPolicySchema.parse(policy))
  }
}
