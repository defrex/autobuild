import { findProject } from './project-lifecycle'
import { hostedProjectContext } from './request-context'
import { SQL } from 'bun'
import { randomUUID } from 'node:crypto'
import { normalizeConnectionRepository as normalizeProjectRepository } from '@defrex/autobuild/connection'
import { resolvePostgresUrl, type PostgresEnv } from './env'
import { assertSchema, PROJECT_SCHEMA_DDL, PROJECT_ADMISSION_INDEX_DDL } from './schema'

export interface ProjectEntry {
  repo: string
  addedAt: string
  addedBy: string
}
export interface ProjectRegistryReader {
  list(): Promise<ProjectEntry[]>
  has(repo: string): Promise<boolean>
}
export interface ProjectRegistry extends ProjectRegistryReader {
  add(repo: string, user: string): Promise<ProjectEntry>
  remove(repo: string, user: string): Promise<void>
  close(): Promise<void>
}

/** Repository identities use the same normalization as checkout origins. */
export { normalizeConnectionRepository as normalizeProjectRepository } from '@defrex/autobuild/connection'

export function legacyProjectRepositories(env: PostgresEnv): string[] {
  const raw = env.AB_WEB_REPOSITORIES?.trim()
  if (!raw) return []
  return [...new Set(raw.split(',').map(normalizeProjectRepository))]
}

function actor(user: string): string {
  const value = user.trim()
  if (!value) throw new Error('project administrator identity must be nonblank')
  return value
}
function entry(row: { repo: string; ts: Date | string; actor: string }): ProjectEntry {
  return { repo: row.repo, addedAt: new Date(row.ts).toISOString(), addedBy: row.actor }
}

export class PostgresProjectRegistry implements ProjectRegistry {
  constructor(
    private readonly sql: SQL,
    private readonly ownsPool = false,
  ) {}

  private async locked<T>(work: (tx: SQL) => Promise<T>): Promise<T> {
    return this.sql.begin(async (tx) => {
      await tx`INSERT INTO project_registry_state (singleton, legacy_imported)
        VALUES (true, false) ON CONFLICT (singleton) DO NOTHING`
      await tx`SELECT singleton FROM project_registry_state WHERE singleton = true FOR UPDATE`
      return work(tx as SQL)
    }) as Promise<T>
  }

  async initialize(repositories: readonly string[]): Promise<void> {
    if (repositories.length === 0) return
    await this.importOnce(() => repositories)
  }

  async initializeFromEnv(env: PostgresEnv): Promise<void> {
    await this.importOnce(() => legacyProjectRepositories(env))
  }

  /** The migration owns this transaction; do not open a nested connection. */
  async initializeFromEnvInTransaction(env: PostgresEnv): Promise<void> {
    await this.sql`INSERT INTO project_registry_state (singleton, legacy_imported)
      VALUES (true, false) ON CONFLICT (singleton) DO NOTHING`
    await this.sql`SELECT singleton FROM project_registry_state WHERE singleton = true FOR UPDATE`
    await this.importIn(this.sql, () => legacyProjectRepositories(env))
  }

  private async importOnce(source: () => readonly string[]): Promise<void> {
    await this.locked((tx) => this.importIn(tx, source))
  }

  private async importIn(tx: SQL, source: () => readonly string[]): Promise<void> {
    const [state] =
      await tx`SELECT legacy_imported FROM project_registry_state WHERE singleton = true`
    if (state.legacy_imported) return
    // Read the retired environment only until the one-time import succeeds.
    const normalized = source().map(normalizeProjectRepository)
    if (normalized.length === 0) return
    for (const repo of normalized) await this.addIn(tx, repo, 'system:AB_WEB_REPOSITORIES')
    await tx`UPDATE project_registry_state SET legacy_imported = true WHERE singleton = true`
  }

  async list(): Promise<ProjectEntry[]> {
    const rows = await this.sql`SELECT repo, actor, ts FROM (
      SELECT DISTINCT ON (repo) repo, action, actor, ts FROM project_journal ORDER BY repo, seq DESC
    ) latest WHERE action = 'added' ORDER BY repo`
    return rows.map(entry)
  }

  async has(repo: string): Promise<boolean> {
    if (hostedProjectContext()) return (await findProject(this.sql, repo)) !== null
    const [row] = await this
      .sql`SELECT action FROM project_journal WHERE repo = ${repo} ORDER BY seq DESC LIMIT 1`
    return row?.action === 'added'
  }

  private async addIn(tx: SQL, repo: string, user: string): Promise<ProjectEntry> {
    const [previous] =
      await tx`SELECT repo, action, actor, ts FROM project_journal WHERE repo = ${repo} ORDER BY seq DESC LIMIT 1`
    if (previous?.action === 'added') return entry(previous)
    const [lifecycle] = await tx`SELECT to_regclass('project_deletions') AS present`
    if (lifecycle?.present) {
      const [pending] = await tx`SELECT 1 FROM project_deletions WHERE repo = ${repo}`
      if (pending) throw new Error('project deletion is unfinished')
      await tx`INSERT INTO project_generations (repo, generation) VALUES (${repo}, ${randomUUID()})
        ON CONFLICT (repo) DO UPDATE SET generation = EXCLUDED.generation`
    }
    const [row] = await tx`INSERT INTO project_journal (seq, repo, action, actor, ts)
      VALUES (nextval('project_journal_seq'), ${repo}, 'added', ${user}, ${new Date().toISOString()})
      RETURNING repo, actor, ts`
    return entry(row)
  }

  async add(raw: string, user: string): Promise<ProjectEntry> {
    const repo = normalizeProjectRepository(raw)
    const by = actor(user)
    return this.locked((tx) => this.addIn(tx, repo, by))
  }

  async remove(raw: string, user: string): Promise<void> {
    const repo = normalizeProjectRepository(raw)
    const by = actor(user)
    await this.locked(async (tx) => {
      const [previous] =
        await tx`SELECT action FROM project_journal WHERE repo = ${repo} ORDER BY seq DESC LIMIT 1`
      if (previous?.action !== 'added') return
      await tx`INSERT INTO project_journal (seq, repo, action, actor, ts)
        VALUES (nextval('project_journal_seq'), ${repo}, 'removed', ${by}, ${new Date().toISOString()})`
    })
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.sql.close()
  }
}

export async function openPostgresProjectRegistryFromEnv(
  env: PostgresEnv,
): Promise<ProjectRegistry> {
  const sql = new SQL(resolvePostgresUrl(env))
  try {
    await assertSchema(sql)
    const registry = new PostgresProjectRegistry(sql, true)
    await registry.initializeFromEnv(env)
    return registry
  } catch (error) {
    await sql.close()
    throw error
  }
}

/** Owner recovery must work while the main-schema promotion is rolled back by
 * a stopped ticket migration. Bootstrap only the independent registry tables. */
export async function initializeProjectRegistryForRecovery(
  sql: SQL,
  env: PostgresEnv,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(470281941)`
    await tx.unsafe(PROJECT_SCHEMA_DDL)
    await tx.unsafe(PROJECT_ADMISSION_INDEX_DDL)
    await new PostgresProjectRegistry(tx as SQL).initializeFromEnvInTransaction(env)
  })
}

export async function openPostgresProjectRegistryForRecoveryFromEnv(
  env: PostgresEnv,
): Promise<ProjectRegistry> {
  const sql = new SQL(resolvePostgresUrl(env))
  try {
    await initializeProjectRegistryForRecovery(sql, env)
    return new PostgresProjectRegistry(sql, true)
  } catch (error) {
    await sql.close()
    throw error
  }
}
