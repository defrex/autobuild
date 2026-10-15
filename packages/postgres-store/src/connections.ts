import { insertPreparedCredential } from './credentials'
import { SQL } from 'bun'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { ConnectionProposal, ConnectionOutcome } from '@defrex/autobuild/connection'
import { normalizeProjectRepository, PostgresProjectRegistry } from './projects'
import { resolvePostgresUrl, type PostgresEnv } from './env'
import { assertSchema } from './schema'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export class ConnectionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}
export interface ConnectionRecord extends ConnectionOutcome {
  id: string
  code: string
  expiresAt: string
}
export interface ConnectionStore {
  start(proposal: ConnectionProposal): Promise<ConnectionRecord & { capability: string }>
  poll(id: string, capability: string, cancel?: boolean): Promise<ConnectionOutcome>
  lookup(code: string, actor: string): Promise<ConnectionRecord | null>
  decide(code: string, actor: string, approve: boolean): Promise<ConnectionRecord>
}
function record(row: Record<string, unknown>): ConnectionRecord {
  return {
    id: String(row.id),
    repo: String(row.repo),
    credentialId: String(row.credential_id),
    code: String(row.code),
    status: row.status as ConnectionOutcome['status'],
    expiresAt: new Date(row.expires_at as string).toISOString(),
  }
}
export class PostgresConnectionStore implements ConnectionStore {
  constructor(
    private readonly sql: SQL,
    private readonly now = () => new Date(),
  ) {}
  async start(input: ConnectionProposal) {
    if (
      typeof input.repo !== 'string' ||
      input.repo.length > 2048 ||
      !/^[a-f0-9]{32}$/.test(input.credentialId) ||
      !/^[a-f0-9]{64}$/.test(input.digest)
    )
      throw new ConnectionError(400, 'invalid connection proposal')
    let repo: string
    try {
      repo = normalizeProjectRepository(input.repo)
    } catch {
      throw new ConnectionError(400, 'invalid repository identity')
    }
    const now = this.now()
    // Bounded expiry retention; never deletes an active capability.
    await this
      .sql`DELETE FROM project_connections WHERE id IN (SELECT id FROM project_connections WHERE expires_at < ${new Date(now.getTime() - 86400000).toISOString()} LIMIT 100)`
    const capability = randomBytes(32).toString('hex')
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = randomBytes(16).toString('hex')
      const code = randomBytes(5).toString('hex').toUpperCase()
      const [row] = await this
        .sql`INSERT INTO project_connections (id, repo, credential_id, digest, capability_hash, code, created_at, expires_at, status)
        VALUES (${id}, ${repo}, ${input.credentialId}, ${input.digest}, ${hash(capability)}, ${code}, ${now.toISOString()}, ${new Date(now.getTime() + 600000).toISOString()}, 'pending') ON CONFLICT DO NOTHING RETURNING *`
      if (row) return { ...record(row), capability }
    }
    throw new ConnectionError(503, 'connection creation unavailable; retry')
  }
  async poll(id: string, capability: string, cancel = false): Promise<ConnectionOutcome> {
    if (!/^[a-f0-9]{32}$/.test(id) || !/^[a-f0-9]{64}$/.test(capability))
      throw new ConnectionError(404, 'unknown connection')
    return this.sql.begin(async (tx) => {
      const [row] = await tx`SELECT * FROM project_connections WHERE id = ${id} FOR UPDATE`
      if (
        !row ||
        !timingSafeEqual(
          Buffer.from(row.capability_hash, 'hex'),
          Buffer.from(hash(capability), 'hex'),
        )
      )
        throw new ConnectionError(404, 'unknown connection')
      const now = this.now()
      if (!cancel && row.polled_at && now.getTime() - new Date(row.polled_at).getTime() < 4500)
        throw new ConnectionError(429, 'poll again in five seconds')
      if (!cancel && row.poll_attempts >= 130)
        throw new ConnectionError(429, 'connection polling limit reached')
      let status = row.status
      if (cancel) {
        if (status === 'approved')
          await tx`UPDATE project_credentials SET revoked_at = COALESCE(revoked_at, ${now.toISOString()}) WHERE id = ${row.credential_id} AND repo = ${row.repo}`
        status = 'denied'
      } else if (status === 'pending' && new Date(row.expires_at) <= now) status = 'expired'
      await tx`UPDATE project_connections SET status = ${status}, polled_at = ${now.toISOString()}, poll_attempts = poll_attempts + 1 WHERE id = ${id}`
      return { ...record(row), status }
    }) as Promise<ConnectionOutcome>
  }
  async lookup(code: string, actor: string): Promise<ConnectionRecord | null> {
    if (!actor || actor.length > 320 || !/^[A-F0-9]{10}$/.test(code))
      throw new ConnectionError(400, 'enter the ten-character connection code')
    const now = this.now()
    const [limit] = await this
      .sql`INSERT INTO connection_lookup_limits (actor, started_at, attempts) VALUES (${actor}, ${now.toISOString()}, 1)
      ON CONFLICT (actor) DO UPDATE SET
        attempts = CASE WHEN connection_lookup_limits.started_at < ${new Date(now.getTime() - 60000).toISOString()} THEN 1 ELSE connection_lookup_limits.attempts + 1 END,
        started_at = CASE WHEN connection_lookup_limits.started_at < ${new Date(now.getTime() - 60000).toISOString()} THEN ${now.toISOString()} ELSE connection_lookup_limits.started_at END RETURNING attempts`
    if (limit.attempts > 20)
      throw new ConnectionError(429, 'too many code lookups; retry in a minute')
    const [row] = await this.sql`SELECT * FROM project_connections WHERE code = ${code}`
    if (!row) return null
    const result = record(row)
    if (result.status === 'pending' && new Date(result.expiresAt) <= now) result.status = 'expired'
    return result
  }
  async decide(code: string, actor: string, approve: boolean): Promise<ConnectionRecord> {
    if (!(await this.lookup(code, actor))) throw new ConnectionError(404, 'unknown connection')
    return this.sql.begin(async (tx) => {
      const [row] = await tx`SELECT * FROM project_connections WHERE code = ${code} FOR UPDATE`
      const now = this.now()
      if (row.status !== 'pending') return record(row)
      const status = new Date(row.expires_at) <= now ? 'expired' : approve ? 'approved' : 'denied'
      if (status === 'approved') {
        // Same lock order as registry mutations, with the request locked first.
        await tx`INSERT INTO project_registry_state (singleton, legacy_imported) VALUES (true, false) ON CONFLICT DO NOTHING`
        await tx`SELECT singleton FROM project_registry_state WHERE singleton = true FOR UPDATE`
        const [previous] =
          await tx`SELECT action FROM project_journal WHERE repo = ${row.repo} ORDER BY seq DESC LIMIT 1`
        if (previous?.action !== 'added')
          await tx`INSERT INTO project_journal (seq, repo, action, actor, ts) VALUES (nextval('project_journal_seq'), ${row.repo}, 'added', ${actor}, ${now.toISOString()})`
        // A collision aborts the whole transaction, including project registration.
        await insertPreparedCredential(tx as SQL, {
          id: row.credential_id,
          digest: row.digest,
          repo: row.repo,
          now,
          user: actor,
        })
      }
      const [updated] =
        await tx`UPDATE project_connections SET status = ${status}, approved_by = ${status === 'approved' ? actor : null} WHERE id = ${row.id} RETURNING *`
      return record(updated)
    }) as Promise<ConnectionRecord>
  }
}
export async function openPostgresConnectionStoreFromEnv(
  env: PostgresEnv,
): Promise<PostgresConnectionStore> {
  const sql = new SQL(resolvePostgresUrl(env))
  try {
    await assertSchema(sql)
    await new PostgresProjectRegistry(sql).initializeFromEnv(env)
    return new PostgresConnectionStore(sql)
  } catch (error) {
    await sql.close()
    throw error
  }
}
