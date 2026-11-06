import { projectTransaction, hostedProjectContext } from './request-context'
import { admitHostedRequest, findProject, captureProject, admitProject } from './project-lifecycle'
import {
  seedTicketStates,
  policyStateNames,
  policyRoleStateNames,
  lockTicketStates,
} from './ticket-states'
import type { Exec } from './retry'
import type { SQL } from 'bun'
import {
  hostedTicketPolicySchema,
  publishedTicketPolicy,
  type HostedTicketPolicy,
} from '@defrex/autobuild/hosted-tickets'

export interface TicketPolicyPutOptions {
  /** `replace` (default) stores the publish as the complete policy;
   * `retain-roles` keeps saved roles a publisher predating them omits. */
  mode?: 'replace' | 'retain-roles'
}

/** `kept` names the collisions when a `retain-roles` publish left the saved
 * policy unchanged rather than erase a role mapping. */
export interface TicketPolicyPutResult {
  kept?: string[]
}

export interface TicketPolicyStore {
  get(repo: string): Promise<HostedTicketPolicy | null>
  put(
    repo: string,
    policy: HostedTicketPolicy,
    writer: string,
    options?: TicketPolicyPutOptions,
  ): Promise<TicketPolicyPutResult>
}

/** Registration sequence scopes policy to the current project incarnation. */
export class PostgresTicketPolicyStore implements TicketPolicyStore {
  constructor(private readonly sql: SQL) {}
  async get(repo: string): Promise<HostedTicketPolicy | null> {
    const admission = hostedProjectContext() ? await findProject(this.sql, repo) : undefined
    if (admission === null) return null
    const [row] = admission
      ? await this.sql`SELECT policy FROM project_ticket_policy
      WHERE repo = ${repo} AND registration = ${admission.registration!}::bigint`
      : await this.sql`SELECT p.policy FROM project_ticket_policy p JOIN LATERAL
      (SELECT seq, action FROM project_journal WHERE repo = ${repo} ORDER BY seq DESC LIMIT 1) r
      ON r.seq = p.registration AND r.action = 'added' WHERE p.repo = ${repo}`
    return row
      ? hostedTicketPolicySchema.parse(
          typeof row.policy === 'string' ? JSON.parse(row.policy) : row.policy,
        )
      : null
  }
  async put(
    repo: string,
    policy: HostedTicketPolicy,
    writer: string,
    options: TicketPolicyPutOptions = {},
  ): Promise<TicketPolicyPutResult> {
    const incoming = hostedTicketPolicySchema.parse(policy)
    return await projectTransaction(this.sql, async (tx) => {
      const admission = hostedProjectContext() ? await captureProject(tx, repo) : undefined
      await admitHostedRequest(tx as SQL)
      if (admission) await admitProject(tx, admission)
      if (!admission)
        await tx`SELECT singleton FROM project_registry_state WHERE singleton = true FOR UPDATE`
      const registration = admission
        ? { seq: admission.registration!, action: 'added' }
        : (
            await tx`SELECT seq, action FROM project_journal WHERE repo = ${repo} ORDER BY seq DESC LIMIT 1`
          )[0]
      if (registration?.action !== 'added') throw new Error('project not registered')
      await lockTicketStates(tx as unknown as Exec, repo)
      const [previous] =
        await tx`SELECT policy FROM project_ticket_policy WHERE repo = ${repo} AND registration = ${registration.seq}`
      const old = previous
        ? hostedTicketPolicySchema.parse(
            typeof previous.policy === 'string' ? JSON.parse(previous.policy) : previous.policy,
          )
        : undefined
      // Merged under the lock, so concurrent publishes never lose a role.
      const published = publishedTicketPolicy(old, incoming, options.mode ?? 'replace')
      if (published.kept) return { kept: published.kept }
      const parsed = hostedTicketPolicySchema.parse(published.policy)
      await seedTicketStates(
        tx as unknown as Exec,
        repo,
        [...(old ? policyStateNames(old) : []), ...policyStateNames(parsed)],
        [...(old ? policyRoleStateNames(old) : []), ...policyRoleStateNames(parsed)],
      )
      await tx`INSERT INTO project_ticket_policy (repo, registration, policy, writer, updated_at)
        VALUES (${repo}, ${registration.seq}, ${parsed}, ${writer}, ${new Date().toISOString()})
        ON CONFLICT (repo) DO UPDATE SET registration = EXCLUDED.registration, policy = EXCLUDED.policy,
          writer = EXCLUDED.writer, updated_at = EXCLUDED.updated_at
        WHERE project_ticket_policy.registration <> EXCLUDED.registration OR project_ticket_policy.policy <> EXCLUDED.policy`
      return {}
    })
  }
}

/** Explicit test seam; production always composes the PostgreSQL adapter. */
export class MemoryTicketPolicyStore implements TicketPolicyStore {
  private readonly policies = new Map<string, HostedTicketPolicy>()
  async get(repo: string) {
    return structuredClone(this.policies.get(repo) ?? null)
  }
  async put(
    repo: string,
    policy: HostedTicketPolicy,
    _writer: string,
    options: TicketPolicyPutOptions = {},
  ): Promise<TicketPolicyPutResult> {
    const published = publishedTicketPolicy(
      this.policies.get(repo),
      hostedTicketPolicySchema.parse(policy),
      options.mode ?? 'replace',
    )
    if (published.kept) return { kept: published.kept }
    this.policies.set(repo, hostedTicketPolicySchema.parse(published.policy))
    return {}
  }
}
