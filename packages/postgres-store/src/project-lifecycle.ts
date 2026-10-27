import { hostedProjectContext } from './request-context'
import type { SQL } from 'bun'
import type { Exec } from './retry'
import { AccessError } from './organizations'

/** Lock order: lifecycle shared/exclusive, access singleton, parent rows,
 * blob shared/exclusive. Never hold the access singleton over provider I/O. */
export const PROJECT_LIFECYCLE_LOCK = 470281942
export const PROJECT_BLOB_LOCK = 470281943

/** A hosted request captures this before asynchronous work. Standalone adapters
 * do not require registration. Revalidate inside every mutation transaction. */
export interface ProjectAdmission {
  repo: string
  generation: string
}
export async function captureProject(sql: SQL | Exec, repo: string): Promise<ProjectAdmission> {
  const [row] = await sql`SELECT g.generation FROM project_generations g
    WHERE g.repo = ${repo} AND NOT EXISTS (SELECT 1 FROM project_deletions d WHERE d.repo = g.repo)
    AND (SELECT action FROM project_journal WHERE repo = g.repo ORDER BY seq DESC LIMIT 1) = 'added'`
  if (!row) throw new AccessError(403, 'project not registered')
  return { repo, generation: String(row.generation) }
}
export async function admitProject(sql: SQL | Exec, admission: ProjectAdmission): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock_shared(${PROJECT_LIFECYCLE_LOCK})`
  const current = await captureProject(sql, admission.repo)
  if (current.generation !== admission.generation)
    throw new AccessError(403, 'project not registered')
}

/** Ownership is committed before upload, separately from publication: an upload
 * whose publication rolls back must still be collected on project deletion. */
export async function reserveProjectBlobs(
  sql: SQL,
  admission: ProjectAdmission,
  refs: readonly string[],
): Promise<void> {
  await sql.begin(async (tx) => {
    await admitProject(tx as SQL, admission)
    await tx`SELECT pg_advisory_xact_lock_shared(${PROJECT_BLOB_LOCK})`
    for (const ref of new Set(refs))
      await tx`INSERT INTO project_blob_ownership (repo, blob_ref) VALUES (${admission.repo}, ${ref}) ON CONFLICT DO NOTHING`
  })
}

/** Validate captured request identities before taking any mutation row locks. */
export async function admitHostedRequest(sql: SQL | Exec): Promise<void> {
  const context = hostedProjectContext()
  if (!context) return
  for (const [repo, generation] of context) await admitProject(sql, { repo, generation })
}
