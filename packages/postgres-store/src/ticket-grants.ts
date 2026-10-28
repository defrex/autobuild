import { projectTransaction } from './request-context'
import { hostedProjectContext } from './request-context'
import {
  admitHostedRequest,
  PROJECT_LIFECYCLE_LOCK,
  findProject,
  captureProject,
  admitProject,
} from './project-lifecycle'
import { createHash, randomBytes } from 'node:crypto'
import type { SQL } from 'bun'

export interface TicketGrant {
  id: string
  repo: string
  execution: string
  kind: 'runner' | 'phase'
  parent: string | null
  expiresAt: string
}
export interface TicketGrantStore {
  authenticate(token: string, now: Date): Promise<TicketGrant | null>
  issue(
    repo: string,
    execution: string,
    kind: 'runner' | 'phase',
    parent: TicketGrant | null,
    now: Date,
  ): Promise<{ token: string; grant: TicketGrant }>
  revoke(id: string, repo: string): Promise<void>
  renew(id: string, repo: string, now: Date): Promise<void>
}
const digest = (token: string) => createHash('sha256').update(token).digest('hex')
const ttl = 5 * 60_000
export class PostgresTicketGrantStore implements TicketGrantStore {
  constructor(private readonly sql: SQL) {}
  async authenticate(token: string, now: Date): Promise<TicketGrant | null> {
    const [row] = hostedProjectContext()
      ? await this.sql`SELECT g.* FROM ticket_grants g
      WHERE g.digest = ${digest(token)} AND g.revoked_at IS NULL AND g.expires_at > ${now.toISOString()}
      AND (g.parent IS NULL OR EXISTS (SELECT 1 FROM ticket_grants p WHERE p.id = g.parent
        AND p.revoked_at IS NULL AND p.expires_at > ${now.toISOString()} AND p.registration = g.registration))`
      : await this.sql`SELECT g.* FROM ticket_grants g JOIN LATERAL
      (SELECT seq, action FROM project_journal WHERE repo = g.repo ORDER BY seq DESC LIMIT 1) r
      ON r.seq = g.registration AND r.action = 'added'
      WHERE g.digest = ${digest(token)} AND g.revoked_at IS NULL AND g.expires_at > ${now.toISOString()}
      AND (g.parent IS NULL OR EXISTS (SELECT 1 FROM ticket_grants p WHERE p.id = g.parent
        AND p.revoked_at IS NULL AND p.expires_at > ${now.toISOString()} AND p.registration = g.registration))`
    if (row && hostedProjectContext()) {
      const admission = await findProject(this.sql, row.repo)
      if (!admission || admission.registration !== String(row.registration)) return null
    }
    return row
      ? {
          id: row.id,
          repo: row.repo,
          execution: row.execution,
          kind: row.kind,
          parent: row.parent,
          expiresAt: new Date(row.expires_at).toISOString(),
        }
      : null
  }
  async issue(
    repo: string,
    execution: string,
    kind: 'runner' | 'phase',
    parent: TicketGrant | null,
    now: Date,
  ) {
    if (
      (kind === 'phase' &&
        (parent?.kind !== 'runner' || parent.repo !== repo || parent.execution !== execution)) ||
      (kind === 'runner' && parent)
    )
      throw new Error('invalid ticket grant parent')
    const id = randomBytes(16).toString('hex')
    const token = `abt_${randomBytes(32).toString('hex')}`
    const expiresAt = new Date(
      Math.min(now.getTime() + ttl, parent ? Date.parse(parent.expiresAt) : Infinity),
    ).toISOString()
    const rows = await projectTransaction(this.sql, async (tx) => {
      if (hostedProjectContext()) {
        const admission = await captureProject(tx as SQL, repo)
        await admitHostedRequest(tx as SQL)
        await admitProject(tx as SQL, admission)
        return tx`INSERT INTO ticket_grants (id, digest, repo, registration, execution, kind, parent, expires_at)
          SELECT ${id}, ${digest(token)}, ${repo}, ${admission.registration!}::bigint, ${execution}, ${kind}, ${parent?.id ?? null}, ${expiresAt}
          WHERE (${parent?.id ?? null}::text IS NULL OR EXISTS
            (SELECT 1 FROM ticket_grants p WHERE p.id = ${parent?.id ?? null} AND p.registration = ${admission.registration!}::bigint
              AND p.revoked_at IS NULL AND p.expires_at > ${now.toISOString()})) RETURNING id`
      }
      await tx`SELECT pg_advisory_xact_lock_shared(${PROJECT_LIFECYCLE_LOCK})`
      return tx`INSERT INTO ticket_grants (id, digest, repo, registration, execution, kind, parent, expires_at)
      SELECT ${id}, ${digest(token)}, ${repo}, r.seq, ${execution}, ${kind}, ${parent?.id ?? null}, ${expiresAt}
      FROM (SELECT seq, action FROM project_journal WHERE repo = ${repo} ORDER BY seq DESC LIMIT 1) r
      WHERE r.action = 'added' AND (${parent?.id ?? null}::text IS NULL OR EXISTS
        (SELECT 1 FROM ticket_grants p WHERE p.id = ${parent?.id ?? null} AND p.registration = r.seq
          AND p.revoked_at IS NULL AND p.expires_at > ${now.toISOString()})) RETURNING id`
    })
    if (!rows.length) throw new Error('project or parent grant is no longer active')
    return { token, grant: { id, repo, execution, kind, parent: parent?.id ?? null, expiresAt } }
  }
  async revoke(id: string, repo: string) {
    await projectTransaction(this.sql, async (tx) => {
      await admitHostedRequest(tx as SQL)
      await tx`UPDATE ticket_grants SET revoked_at = COALESCE(revoked_at, ${new Date().toISOString()}) WHERE id = ${id} AND repo = ${repo}`
    })
  }
  async renew(id: string, repo: string, now: Date) {
    await projectTransaction(this.sql, async (tx) => {
      await admitHostedRequest(tx as SQL)
      await tx`WITH renewed AS (
      UPDATE ticket_grants SET expires_at = ${new Date(now.getTime() + ttl).toISOString()}
      WHERE id = ${id} AND repo = ${repo} AND kind = 'runner' AND revoked_at IS NULL AND expires_at > ${now.toISOString()}
      RETURNING id, expires_at)
      UPDATE ticket_grants SET expires_at = renewed.expires_at FROM renewed
      WHERE ticket_grants.parent = renewed.id AND ticket_grants.revoked_at IS NULL`
    })
  }
}
