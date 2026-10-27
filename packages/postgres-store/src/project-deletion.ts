import { SQL } from 'bun'
import { AccessError, lockAccess, type HumanActor } from './organizations'
import { normalizeProjectRepository } from './projects'
import { PROJECT_BLOB_LOCK, PROJECT_LIFECYCLE_LOCK } from './project-lifecycle'
import type { BlobMaintenance } from './blob-maintenance'

export interface ProjectDeletionPreview {
  repo: string
  token: string
  builds: number
  tickets: number
  secrets: number
  subscriptionAccounts: number
}
export interface ProjectDeletion {
  preview(actor: HumanActor, repo: string): Promise<ProjectDeletionPreview>
  delete(actor: HumanActor, repo: string, token: string | null): Promise<void>
}

/** Every candidate is retained until physical deletion succeeds. Other projects'
 * committed reservations count as references, including unpublished uploads. */
export class PostgresProjectDeletion implements ProjectDeletion {
  constructor(
    private readonly sql: SQL,
    private readonly blobs: BlobMaintenance,
  ) {}

  private async authorize(tx: SQL, actor: HumanActor, repo: string) {
    if (actor.isSuperUser()) return
    const [owner] = await tx`SELECT 1 FROM organization_emails e WHERE e.email = ${actor.email}
      AND e.role = 'owner' AND e.organization_id = COALESCE(
        (SELECT organization_id FROM project_deletions WHERE repo = ${repo}),
        (SELECT organization_id FROM project_organizations WHERE repo = ${repo}))`
    if (!owner) throw new AccessError(403, 'organization owner required')
  }

  async preview(actor: HumanActor, raw: string): Promise<ProjectDeletionPreview> {
    const repo = normalizeProjectRepository(raw)
    return this.sql.begin(async (transaction) => {
      const tx = transaction as SQL
      await lockAccess(tx)
      await this.authorize(tx, actor, repo)
      const [registration] =
        await tx`SELECT generation FROM project_generations WHERE repo = ${repo}`
      if (!registration) throw new AccessError(404, 'unknown project')
      const [counts] = await tx`SELECT
        (SELECT count(*) FROM builds WHERE repo = ${repo}) AS builds,
        (SELECT count(*) FROM ab_tickets WHERE repo = ${repo}) AS tickets,
        (SELECT count(*) FROM project_secrets WHERE repo = ${repo} AND kind = 'static') AS secrets,
        (SELECT count(*) FROM project_secrets WHERE repo = ${repo} AND kind <> 'static') AS accounts`
      return {
        repo,
        token: `"${registration.generation}"`,
        builds: Number(counts.builds),
        tickets: Number(counts.tickets),
        secrets: Number(counts.secrets),
        subscriptionAccounts: Number(counts.accounts),
      }
    }) as Promise<ProjectDeletionPreview>
  }

  async delete(actor: HumanActor, raw: string, token: string | null): Promise<void> {
    const repo = normalizeProjectRepository(raw)
    if (!token) throw new AccessError(428, 'deletion preview required')
    const match = /^"([a-zA-Z0-9-]+)"$/.exec(token)
    if (!match) throw new AccessError(412, 'project changed; refresh deletion preview')
    const generation = match[1]!
    const pending = await this.sql.begin(async (transaction) => {
      const tx = transaction as SQL
      await tx`SELECT pg_advisory_xact_lock(${PROJECT_LIFECYCLE_LOCK})`
      await lockAccess(tx)
      const [audit] =
        await tx`SELECT actor FROM project_deletion_audit WHERE repo = ${repo} AND generation = ${generation}`
      if (audit) {
        if (!actor.isSuperUser() && actor.email !== audit.actor)
          throw new AccessError(403, 'project deletion access required')
        return false
      }
      await this.authorize(tx, actor, repo)
      const [current] = await tx`SELECT generation FROM project_generations WHERE repo = ${repo}`
      if (!current || current.generation !== generation)
        throw new AccessError(412, 'project changed; refresh deletion preview')
      await tx`INSERT INTO project_deletions (repo,generation,organization_id,actor,ts)
        VALUES (${repo},${generation},(SELECT organization_id FROM project_organizations WHERE repo = ${repo}),${actor.email},now())
        ON CONFLICT (repo) DO NOTHING`
      await tx`INSERT INTO project_journal (seq,repo,action,actor,ts)
        SELECT nextval('project_journal_seq'),${repo},'removed',${actor.email},now()
        WHERE (SELECT action FROM project_journal WHERE repo = ${repo} ORDER BY seq DESC LIMIT 1) = 'added'`
      await tx`DELETE FROM project_connections WHERE repo = ${repo}`
      await tx`DELETE FROM project_credentials WHERE repo = ${repo}`
      await this.inventory(tx, repo)
      await this.purgeContent(tx, repo)
      return true
    })
    if (!pending) return
    await this.cleanupBlobs(repo, generation)
    await this.sql.begin(async (transaction) => {
      const tx = transaction as SQL
      await tx`SELECT pg_advisory_xact_lock(${PROJECT_LIFECYCLE_LOCK})`
      await lockAccess(tx)
      const [operation] =
        await tx`SELECT * FROM project_deletions WHERE repo = ${repo} AND generation = ${generation}`
      if (!operation) return // Another retry completed the same operation.
      const [remaining] =
        await tx`SELECT 1 FROM project_deletion_blobs WHERE repo = ${repo} LIMIT 1`
      if (remaining) throw new Error('project blob cleanup unfinished')
      for (const table of [
        'project_ticket_policy',
        'project_secret_audit',
        'project_secrets',
        'project_credentials',
        'project_connections',
        'operator_presence',
        'project_organizations',
        'project_journal',
        'project_blob_ownership',
        'project_generations',
      ])
        await tx.unsafe(`DELETE FROM ${table} WHERE repo = $1`, [repo])
      const [legacy] = await tx`SELECT to_regclass('ticket_team_assignments') AS present`
      if (legacy?.present) await tx`DELETE FROM ticket_team_assignments WHERE repo = ${repo}`
      // Triggers on other deletions may have recreated the position.
      await tx`DELETE FROM repo_change_positions WHERE repo = ${repo}`
      await tx`INSERT INTO project_deletion_audit (repo,generation,actor,ts)
        VALUES (${repo},${generation},${operation.actor},${operation.ts}) ON CONFLICT DO NOTHING`
      await tx`DELETE FROM project_deletions WHERE repo = ${repo}`
    })
  }

  /** Remove retained references atomically with inventory, before provider I/O.
   * Pending operations retain ownership until each candidate is resolved. This
   * lets concurrent purges of shared content hand responsibility to the last
   * reservation instead of mutually preserving bytes forever. */
  private async purgeContent(tx: SQL, repo: string) {
    await tx`DELETE FROM reducer_snapshots WHERE
        (scope_kind = 'repo' AND scope_key = ${repo}) OR
        (scope_kind = 'build' AND scope_key IN (SELECT slug FROM builds WHERE repo = ${repo})) OR
        (scope_kind = 'session' AND scope_key IN (SELECT id FROM sessions WHERE repo = ${repo}))`
    await tx`DELETE FROM sessions WHERE repo = ${repo}`
    await tx`DELETE FROM builds WHERE repo = ${repo}`
    await tx`DELETE FROM repo_streams WHERE repo = ${repo}`
    // A single statement removes tree parents and children together.
    await tx`DELETE FROM ab_tickets WHERE repo = ${repo}`
    await tx`DELETE FROM ticket_assets WHERE repo = ${repo}`
    await tx`DELETE FROM ab_ticket_states WHERE repo = ${repo}`
    await tx`DELETE FROM ab_ticket_counters WHERE repo = ${repo}`
    await tx`UPDATE ticket_grants SET parent = NULL WHERE repo = ${repo}`
    await tx`DELETE FROM ticket_grants WHERE repo = ${repo}`
  }

  private async inventory(tx: SQL, repo: string) {
    await tx`INSERT INTO project_deletion_blobs (repo,blob_ref)
      SELECT ${repo}, blob_ref FROM (
        SELECT blob_ref FROM project_blob_ownership WHERE repo = ${repo}
        UNION SELECT a.blob_ref FROM artifacts a JOIN builds b ON b.slug = a.build WHERE b.repo = ${repo}
        UNION SELECT a.blob_ref FROM session_artifacts a JOIN sessions s ON s.id = a.session WHERE s.repo = ${repo}
        UNION SELECT blob_ref FROM repo_artifacts WHERE repo = ${repo}
        UNION SELECT value #>> '{}' FROM events e JOIN builds b ON b.slug = e.build,
          jsonb_path_query(e.payload, '$.**.blobRef') value WHERE b.repo = ${repo} AND jsonb_typeof(value) = 'string'
        UNION SELECT value #>> '{}' FROM session_events e JOIN sessions s ON s.id = e.session,
          jsonb_path_query(e.payload, '$.**.blobRef') value WHERE s.repo = ${repo} AND jsonb_typeof(value) = 'string'
        UNION SELECT value #>> '{}' FROM repo_events e,
          jsonb_path_query(e.payload, '$.**.blobRef') value WHERE e.repo = ${repo} AND jsonb_typeof(value) = 'string'
        UNION SELECT artifact_blob_ref FROM streams WHERE repo = ${repo}
          OR build IN (SELECT slug FROM builds WHERE repo = ${repo})
          OR session IN (SELECT id FROM sessions WHERE repo = ${repo})
      ) refs WHERE blob_ref IS NOT NULL ON CONFLICT DO NOTHING`
    // Manifests retain every asset revision, including removed assets.
    const assets = await tx`SELECT manifest FROM ticket_assets WHERE repo = ${repo}`
    for (const asset of assets) {
      const entries =
        typeof asset.manifest === 'string' ? JSON.parse(asset.manifest) : asset.manifest
      for (const entry of entries) {
        if (entry.type === 'dir') continue
        if (typeof entry.blobRef !== 'string')
          throw new Error('invalid ticket asset blob reference')
        await tx`INSERT INTO project_deletion_blobs (repo,blob_ref) VALUES (${repo},${entry.blobRef}) ON CONFLICT DO NOTHING`
      }
    }
  }

  private async cleanupBlobs(repo: string, generation: string) {
    for (;;) {
      const progressed = await this.sql.begin(async (transaction) => {
        const tx = transaction as SQL
        await tx`SELECT pg_advisory_xact_lock(${PROJECT_BLOB_LOCK})`
        const candidates =
          await tx`SELECT blob_ref FROM project_deletion_blobs WHERE repo = ${repo} AND EXISTS (SELECT 1 FROM project_deletions WHERE repo = ${repo} AND generation = ${generation}) ORDER BY blob_ref LIMIT 1 FOR UPDATE`
        if (!candidates.length) return false
        const ref = candidates[0]!.blob_ref
        await tx`DELETE FROM project_blob_ownership WHERE repo = ${repo} AND blob_ref = ${ref}`
        const [shared] = await tx`SELECT 1 WHERE
          EXISTS (SELECT 1 FROM project_blob_ownership WHERE repo <> ${repo} AND blob_ref = ${ref}) OR
          EXISTS (SELECT 1 FROM project_deletion_blobs WHERE repo <> ${repo} AND blob_ref = ${ref}) OR
          EXISTS (SELECT 1 FROM artifacts a JOIN builds b ON b.slug = a.build WHERE b.repo <> ${repo} AND a.blob_ref = ${ref}) OR
          EXISTS (SELECT 1 FROM session_artifacts a JOIN sessions s ON s.id = a.session WHERE s.repo <> ${repo} AND a.blob_ref = ${ref}) OR
          EXISTS (SELECT 1 FROM repo_artifacts WHERE repo <> ${repo} AND blob_ref = ${ref}) OR
          EXISTS (SELECT 1 FROM streams s WHERE s.artifact_blob_ref = ${ref} AND (
            s.repo <> ${repo} OR s.build IN (SELECT slug FROM builds WHERE repo <> ${repo})
            OR s.session IN (SELECT id FROM sessions WHERE repo <> ${repo}))) OR
          EXISTS (SELECT 1 FROM events e JOIN builds b ON b.slug=e.build WHERE b.repo <> ${repo}
            AND jsonb_path_exists(e.payload, '$.**.blobRef ? (@ == $ref)', jsonb_build_object('ref', ${ref}::text))) OR
          EXISTS (SELECT 1 FROM session_events e JOIN sessions s ON s.id=e.session WHERE s.repo <> ${repo}
            AND jsonb_path_exists(e.payload, '$.**.blobRef ? (@ == $ref)', jsonb_build_object('ref', ${ref}::text))) OR
          EXISTS (SELECT 1 FROM repo_events e WHERE e.repo <> ${repo}
            AND jsonb_path_exists(e.payload, '$.**.blobRef ? (@ == $ref)', jsonb_build_object('ref', ${ref}::text))) OR
          EXISTS (SELECT 1 FROM ticket_assets a, jsonb_array_elements(CASE WHEN jsonb_typeof(a.manifest) = 'string' THEN (a.manifest #>> '{}')::jsonb ELSE a.manifest END) e WHERE a.repo <> ${repo} AND e->>'blobRef' = ${ref})`
        if (!shared) await this.blobs.delete(String(ref))
        await tx`DELETE FROM project_deletion_blobs WHERE repo = ${repo} AND blob_ref = ${ref}`
        return true
      })
      if (!progressed) return
    }
  }
}

export async function openPostgresProjectDeletionFromEnv(
  env: Record<string, string | undefined>,
): Promise<ProjectDeletion> {
  const { resolvePostgresUrl } = await import('./env')
  const { assertSchema } = await import('./schema')
  const { openPostgresBlobMaintenanceFromEnv } = await import('./config')
  const sql = new SQL(resolvePostgresUrl(env))
  try {
    await assertSchema(sql)
    return new PostgresProjectDeletion(sql, openPostgresBlobMaintenanceFromEnv(env))
  } catch (error) {
    await sql.close()
    throw error
  }
}
