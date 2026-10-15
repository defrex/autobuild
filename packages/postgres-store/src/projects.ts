import { SQL } from 'bun'
import { normalizeGitRemoteUrl } from '@defrex/autobuild/origin'
import { resolvePostgresUrl, type PostgresEnv } from './env'
import { assertSchema } from './schema'

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
export function normalizeProjectRepository(raw: string): string {
  const value = raw.trim()
  // SSH's conventional git user is transport syntax; URL passwords and HTTPS
  // userinfo are never part of an identity (normalization would discard them).
  if (/[\s\\?#]/.test(value) || !value || (/^[^/]*:[^/]*@/.test(value) && !value.includes('://')))
    throw new Error('invalid repository identity')
  if (value.includes('://')) {
    let input: URL
    try {
      input = new URL(value)
    } catch {
      throw new Error('invalid repository identity')
    }
    if (input.password || (input.username && !['ssh:', 'git+ssh:'].includes(input.protocol))) {
      throw new Error('repository identity must not contain credentials')
    }
    if (input.search || input.hash) throw new Error('invalid repository identity')
  }
  const normalized = normalizeGitRemoteUrl(value)
  let url: URL
  try {
    url = new URL(normalized)
  } catch {
    throw new Error('invalid repository identity')
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname === '/' ||
    /%|\\/.test(url.pathname)
  ) {
    throw new Error('repository identity must be a normalized HTTPS repository origin')
  }
  return normalized
}

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
    const normalized = repositories.map(normalizeProjectRepository)
    if (normalized.length === 0) return
    await this.locked(async (tx) => {
      const [state] =
        await tx`SELECT legacy_imported FROM project_registry_state WHERE singleton = true`
      if (state.legacy_imported) return
      for (const repo of normalized) await this.addIn(tx, repo, 'system:AB_WEB_REPOSITORIES')
      await tx`UPDATE project_registry_state SET legacy_imported = true WHERE singleton = true`
    })
  }

  async list(): Promise<ProjectEntry[]> {
    const rows = await this.sql`SELECT repo, actor, ts FROM (
      SELECT DISTINCT ON (repo) repo, action, actor, ts FROM project_journal ORDER BY repo, seq DESC
    ) latest WHERE action = 'added' ORDER BY repo`
    return rows.map(entry)
  }

  async has(repo: string): Promise<boolean> {
    const [row] = await this
      .sql`SELECT action FROM project_journal WHERE repo = ${repo} ORDER BY seq DESC LIMIT 1`
    return row?.action === 'added'
  }

  private async addIn(tx: SQL, repo: string, user: string): Promise<ProjectEntry> {
    const [previous] =
      await tx`SELECT repo, action, actor, ts FROM project_journal WHERE repo = ${repo} ORDER BY seq DESC LIMIT 1`
    if (previous?.action === 'added') return entry(previous)
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
  const repositories = legacyProjectRepositories(env)
  const sql = new SQL(resolvePostgresUrl(env))
  try {
    await assertSchema(sql)
    const registry = new PostgresProjectRegistry(sql, true)
    await registry.initialize(repositories)
    return registry
  } catch (error) {
    await sql.close()
    throw error
  }
}
