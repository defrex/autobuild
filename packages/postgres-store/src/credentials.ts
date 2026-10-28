import { AccessError } from './organizations'
import { projectTransaction } from './request-context'
import {
  PROJECT_LIFECYCLE_LOCK,
  captureProject,
  admitHostedRequest,
  admitProject,
} from './project-lifecycle'
import { hostedProjectContext } from './request-context'
import { SQL } from 'bun'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  normalizeProjectRepository,
  PostgresProjectRegistry,
  type ProjectRegistryReader,
} from './projects'
import { resolvePostgresUrl, type PostgresEnv } from './env'
import { assertSchema } from './schema'

export interface CredentialMetadata {
  id: string
  repo: string
  createdAt: string
  createdBy: string
  lastUsedAt: string | null
  revokedAt: string | null
  expiresAt: string | null
  purpose: 'project-owner' | 'dispatcher'
}
export interface CredentialReader {
  /** Success includes fresh project registration validation. */
  authenticate(token: string, now: Date): Promise<CredentialMetadata | null>
}
export interface CredentialStore extends CredentialReader {
  issue(
    repo: string,
    user: string,
    options?: { expiresAt?: Date; purpose?: CredentialMetadata['purpose'] },
  ): Promise<{ token: string; credential: CredentialMetadata }>
  list(repo: string): Promise<CredentialMetadata[]>
  revoke(repo: string, id: string, user: string): Promise<void>
  close(): Promise<void>
}
export class ProjectNotRegisteredError extends Error {
  constructor() {
    super('project not registered')
  }
}
export const LAST_USE_INTERVAL_MS = 60_000
const hash = (secret: string) => createHash('sha256').update(secret).digest()
const stamp = (value: unknown): string | null =>
  value == null ? null : new Date(value as string).toISOString()
function metadata(row: Record<string, unknown>): CredentialMetadata {
  return {
    id: String(row.id),
    repo: String(row.repo),
    createdAt: stamp(row.created_at)!,
    createdBy: String(row.created_by),
    lastUsedAt: stamp(row.last_used_at),
    revokedAt: stamp(row.revoked_at),
    expiresAt: stamp(row.expires_at),
    purpose: row.purpose as CredentialMetadata['purpose'],
  }
}
function actor(user: string): string {
  if (!user.trim()) throw new Error('credential creator must be nonblank')
  return user.trim()
}
/** Insert a CLI-prepared digest using the caller's transaction, never a raw token. */
export async function insertPreparedCredential(
  sql: SQL,
  input: {
    id: string
    digest: string
    repo: string
    user: string
    now: Date
    purpose?: CredentialMetadata['purpose']
    expiresAt?: Date
  },
): Promise<CredentialMetadata> {
  if (!/^[a-f0-9]{32}$/.test(input.id) || !/^[a-f0-9]{64}$/.test(input.digest))
    throw new Error('invalid prepared credential')
  const repo = normalizeProjectRepository(input.repo),
    by = actor(input.user)
  const [row] =
    await sql`INSERT INTO project_credentials (id, digest, repo, created_at, created_by, purpose, expires_at)
    VALUES (${input.id}, ${input.digest}, ${repo}, ${input.now.toISOString()}, ${by}, ${input.purpose ?? 'project-owner'}, ${input.expiresAt?.toISOString() ?? null}) RETURNING *`
  return metadata(row)
}
export class PostgresCredentialStore implements CredentialStore {
  constructor(
    private readonly sql: SQL,
    private readonly projects: ProjectRegistryReader,
    private readonly ownsPool = false,
  ) {}
  async issue(
    raw: string,
    user: string,
    options: { expiresAt?: Date; purpose?: CredentialMetadata['purpose'] } = {},
  ): Promise<{ token: string; credential: CredentialMetadata }> {
    const repo = normalizeProjectRepository(raw)
    const by = actor(user)
    if (!(await this.projects.has(repo))) throw new ProjectNotRegisteredError()
    const now = new Date()
    if (
      options.expiresAt &&
      (!Number.isFinite(options.expiresAt.getTime()) || options.expiresAt <= now)
    )
      throw new Error('credential expiry must be in the future')
    const id = randomBytes(16).toString('hex')
    const secret = randomBytes(32).toString('hex')
    const credential = await projectTransaction(this.sql, async (transaction) => {
      const tx = transaction as SQL
      if (!hostedProjectContext())
        await tx`SELECT pg_advisory_xact_lock_shared(${PROJECT_LIFECYCLE_LOCK})`
      const admission = await captureProject(tx, repo)
      await admitHostedRequest(tx)
      await admitProject(tx, admission)
      return insertPreparedCredential(tx, {
        id,
        digest: hash(secret).toString('hex'),
        repo,
        user: by,
        now,
        ...options,
      })
    })
    return { token: `abp_1_${id}_${secret}`, credential }
  }

  async authenticate(token: string, now: Date): Promise<CredentialMetadata | null> {
    return projectTransaction(this.sql, async (transaction) => {
      const tx = transaction as SQL
      const parts = /^abp_1_([a-f0-9]{32})_([a-f0-9]{64})$/.exec(token)
      if (!parts) return null
      const [row] = await tx`SELECT c.* FROM project_credentials c WHERE id = ${parts[1]!}`
      if (
        !row ||
        !timingSafeEqual(hash(parts[2]!), Buffer.from(row.digest, 'hex')) ||
        row.revoked_at ||
        (row.expires_at && new Date(row.expires_at) <= now)
      )
        return null
      const admission = await captureProject(tx, row.repo).catch((error) => {
        if (error instanceof AccessError && error.status === 403)
          throw new ProjectNotRegisteredError()
        throw error
      })
      const cutoff = new Date(now.getTime() - LAST_USE_INTERVAL_MS).toISOString()
      if (
        row.last_used_at &&
        new Date(row.last_used_at).getTime() > now.getTime() - LAST_USE_INTERVAL_MS
      )
        return metadata(row)
      await admitProject(tx, admission)
      // Competing writers recheck the cutoff after waiting for the row lock.
      // An in-flight authentication may finish after revocation.
      const [used] = await tx`UPDATE project_credentials SET last_used_at = ${now.toISOString()}
      WHERE id = ${row.id} AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ${now.toISOString()})
        AND (last_used_at IS NULL OR last_used_at <= ${cutoff})
      RETURNING *`
      return metadata(used ?? row)
    }) as Promise<CredentialMetadata | null>
  }
  async list(raw: string): Promise<CredentialMetadata[]> {
    const rows = await this
      .sql`SELECT * FROM project_credentials WHERE repo = ${normalizeProjectRepository(raw)} ORDER BY created_at, id`
    return rows.map(metadata)
  }
  async revoke(raw: string, id: string, user: string): Promise<void> {
    actor(user)
    await projectTransaction(this.sql, async (transaction) => {
      const tx = transaction as SQL
      await admitHostedRequest(tx)
      await tx`UPDATE project_credentials SET revoked_at = COALESCE(revoked_at, ${new Date().toISOString()}) WHERE repo = ${normalizeProjectRepository(raw)} AND id = ${id}`
    })
  }
  async close(): Promise<void> {
    if (this.ownsPool) await this.sql.close()
  }
}
export async function openPostgresCredentialStoreFromEnv(
  env: PostgresEnv,
): Promise<CredentialStore> {
  const sql = new SQL(resolvePostgresUrl(env))
  try {
    await assertSchema(sql)
    const projects = new PostgresProjectRegistry(sql)
    await projects.initializeFromEnv(env)
    return new PostgresCredentialStore(sql, projects, true)
  } catch (error) {
    await sql.close()
    throw error
  }
}
