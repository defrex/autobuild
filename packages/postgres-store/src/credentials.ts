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
    const [row] = await this
      .sql`INSERT INTO project_credentials (id, digest, repo, created_at, created_by, purpose, expires_at)
      VALUES (${id}, ${hash(secret).toString('hex')}, ${repo}, ${now.toISOString()}, ${by}, ${options.purpose ?? 'project-owner'}, ${options.expiresAt?.toISOString() ?? null}) RETURNING *`
    return { token: `abp_1_${id}_${secret}`, credential: metadata(row) }
  }
  async authenticate(token: string, now: Date): Promise<CredentialMetadata | null> {
    const parts = /^abp_1_([a-f0-9]{32})_([a-f0-9]{64})$/.exec(token)
    if (!parts) return null
    const [row] = await this.sql`SELECT * FROM project_credentials WHERE id = ${parts[1]!}`
    if (
      !row ||
      !timingSafeEqual(hash(parts[2]!), Buffer.from(row.digest, 'hex')) ||
      row.revoked_at ||
      (row.expires_at && new Date(row.expires_at) <= now)
    )
      return null
    if (!(await this.projects.has(row.repo))) throw new ProjectNotRegisteredError()
    // The conditional update also closes a revoke racing the initial read.
    const [used] = await this.sql`UPDATE project_credentials SET last_used_at = ${now.toISOString()}
      WHERE id = ${row.id} AND revoked_at IS NULL RETURNING *`
    return used ? metadata(used) : null
  }
  async list(raw: string): Promise<CredentialMetadata[]> {
    const rows = await this
      .sql`SELECT * FROM project_credentials WHERE repo = ${normalizeProjectRepository(raw)} ORDER BY created_at, id`
    return rows.map(metadata)
  }
  async revoke(raw: string, id: string, user: string): Promise<void> {
    actor(user)
    await this
      .sql`UPDATE project_credentials SET revoked_at = COALESCE(revoked_at, ${new Date().toISOString()}) WHERE repo = ${normalizeProjectRepository(raw)} AND id = ${id}`
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
